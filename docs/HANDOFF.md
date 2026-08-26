# 交接说明：macOS 桌面控制

**这份是唯一入口。** 接手开发请只按本文执行，`docs/` 下其余文档的定位见最后一节，
不要拿它们当施工依据。

目标：**让 agent 操作 macOS 应用，不打扰用户——不抢焦点、不动用户的光标。**

---

## 一、已经建好的，不要重做

`packages/computer-macos/` 是一个可用的包，已通过测试。接手时先跑一遍确认环境正常：

```sh
pnpm run build:helper                              # 编译 Swift helper（需 Command Line Tools）
pnpm run typecheck && pnpm run test                # 28 个单测
python3 experiments/desktop-acceptance/run.py      # 9 个验收用例，应为 9/9
```

三个都绿才开始动手。任何一个红，先修环境或报告，不要在坏地基上盖。

已实现的能力（都有验收用例背书）：

| 能力 | 在哪 |
|---|---|
| 列出可操作的应用，按 bundle id 选中一个 | `src/index.ts` 的 `surfaces` / `focus` |
| 读窗口结构：可操作元素 + 名字 + 坐标 + 可用动作 | helper `snapshot` |
| 读窗口显示的文字内容 | helper `snapshot` 的 `text` 字段 |
| 按索引点击、输入、执行任意具名动作 | helper `press` / `setValue` / `action` |
| 按坐标点击（先命中测试再执行，可预检） | helper `pressAt` |
| 移动/缩放窗口 | helper `window` |
| 应用白名单（默认放行 + 六个内置拒绝项） | `src/access.ts` |
| 每个动作自检有没有打扰用户 | helper 的 `Undisturbed` |

---

## 二、四条不变量，破坏即回退

这四条不是风格偏好，每一条都对应一次真实事故或实测发现。

**1. 动作不得抢焦点、不得把用户的光标拽到目标上。**
每个动作都要回报 `focusStolen` / `cursorMoved`，验收套件逐动作校验。
注意判据问的是「这个动作有没有劫持光标」而不是「光标有没有动过」——用户在旁边用鼠标是常态，
判据必须拿动作的目标矩形去判定，否则会因为人类正常使用而假报。

**2. 动作前必须核对目标身份。**
`press`/`setValue`/`action` 都收 `expectRole`/`expectName`，与实时状态不符就拒绝执行。
桌面上点错撤不回——2026-08-26 有过一次模型瞎点误中窗口关闭按钮的实例。

**3. 索引的唯一权威是同一次枚举。**
`snapshot` 和后续动作必须走同一个遍历顺序。分开枚举必然错位。

**4. 截图按窗口截，绝不整屏。**
模型的单图像素预算是 640,000 px，4K 整屏会把 20px 的按钮压到 5.6px，没有模型认得出。

---

## 三、要你做的任务

每个任务都写了验收标准。**验收标准就是我最终会跑的东西**，不满足就是没做完。
无依赖的可以并行。

### T1 独立光标 overlay（无依赖）
用 `NSWindow` 覆盖层画 agent 的光标，让用户看得见 agent 在点哪里。
必须 `canBecomeKeyWindow=false`、`ignoresMouseEvents=true`，不参与命中测试。
**验收**：新增用例断言 overlay 不吃点击、不影响 `pressAt` 的命中结果、用户真实光标未受影响。

### T2 按窗口截图（无依赖）
`CGWindowListCreateImage` 在 macOS 15 已废弃（26 SDK 上是编译错误），必须用 ScreenCaptureKit。
**验收**：目标窗口被其它窗口完全遮挡时仍截到正确内容；返回尺寸等于窗口逻辑像素。

### T3 provider 补齐动作面（无依赖）
helper 已有但 Node 侧没暴露：`action`、`window`、`text`。
`pressKey` 和 `screenshot` 目前抛「未实现」，前者用 `CGEvent.postToPid`（实测键盘这条通道有效），
后者等 T2。
**验收**：`packages/computer-macos/tests/` 扩展覆盖新方法，`pnpm run test` 全绿。

### T4 挂进发布入口（依赖 T3）
`dsh-tool-computer` 的 `apply` 里组装 macOS provider，白名单配置透出，helper 二进制随包分发。
**验收**：三道门全绿；`pnpm -r pack --dry-run` 的 tarball 里含 helper 二进制。

### T5 验收套件扩容（依赖 T1/T2/T3）
补：多应用切换、截图、光标、应用中途退出、输入框填写。
**验收**：新用例遵守第二节第 1 条的判据写法；连跑四次结果一致（不稳定的套件不算数）。

### T6 自由拖拽攻坚（无依赖，决定 T7）
这是唯一没解决的能力缺口，也是唯一可能需要私有 API 的地方。背景与已排除的路径见
`experiments/skylight-injection/probe.swift` 的注释，参照实现的 API 图谱在同目录
`reference-api-map.txt`。
**时间盒：三轮不通就转 B 路线，不要无限期逆向。**
**验收**：拖拽用例——在目标应用里把一个元素拖到另一位置，读回应用状态确认，且不变量保持。

### T7 感知缺口（无依赖）
实测本机 18 个有窗口的应用里 11 个 AX 可用（61%）。剩下的（微信、Codex app、网易 UU）
AX 树基本为空，只能靠视觉，而视觉定位实测 macOS 单步 60.9%，五步任务成功率 8.4%。
**先做度量再谈方案**：在那批应用上实测定位精度，确认 60.9% 这个外推数字是否成立。
**验收**：给出实测数字和触发条件，不要直接上外挂模型。

### T8 模型级验收（依赖 T4/T5，须人在场）
仿 `experiments/phase2-acceptance/run.py`，判据同样只认应用状态。
**这一步必须人在场跑**，见 `AGENTS.md` 的无人值守纪律（2026-08-25 安全事件产物）。

---

## 四、我会怎么验收

按顺序，任何一步不过就退回：

1. `pnpm run typecheck && pnpm run test && pnpm run build` 三道门全绿。
2. `python3 experiments/desktop-acceptance/run.py` **连跑四次**，每次都全绿。
   跑的时候我会正常使用鼠标——这是刻意的，判据必须扛得住。
3. 抽查新增用例的判据：**能不能失败**。判据若是 `len(x) > 0` 这类恒真式，或者比对的是
   动作前后不会变的量（比如窗口标题），这个用例不算数。这条踩过两次坑，一次在浏览器套件，
   一次在这套桌面套件自己身上。
4. 抽查不变量：随便挑几个动作，确认 `focusStolen`/`cursorMoved` 有回报且判据用了目标矩形。
5. 读 commit 说明：改了什么、为什么、验证过什么。声称做完但没有验证证据的，按未完成处理。

---

## 五、`docs/` 里其它文档的定位

| 文档 | 定位 |
|---|---|
| **HANDOFF.md**（本文） | **唯一施工依据** |
| `desktop-implementation-plan.md` | 本文的详版：完整实验设计、三轮对抗审视记录。要理解「为什么这么定」时读它 |
| `capability-assessment.md` | 浏览器侧的能力评估与缺陷清单，与桌面无关，但里面的判据教训适用 |
| `master-plan.md` | 项目顶层两条主线的排序，不含桌面细节 |
| `desktop-control-plan.md` | **已作废，不要照做。** 它的核心结论「不需要任何私有 API」已被实测推翻（自由拖拽做不到），它自己写的证伪条件正好命中。保留仅供追溯 |
| `phase2-design-review.md`、`phase3-roadmap.md` | 浏览器阶段的历史记录 |

`experiments/` 下是证据，不是施工依据。要复查某个数字时按目录名找：
`skylight-injection`（注入通道实验 + 参照 API 图谱）、`input-injection`（三条通道对比）、
`macos-ax-probe`（最初的可行性探针）、`desktop-acceptance`（验收套件本身）。
