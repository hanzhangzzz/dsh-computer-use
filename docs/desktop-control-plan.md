# 桌面控制方案：对标 Codex app，用公开 API 走得更远

日期：2026-08-26（2026-08-26 修订：目标升级为人机共驾，见「目标」节）。状态：待人类裁决。读者：接手实施的 AI 或人。

本文回答一个问题：**dsh-computer-use 要怎么获得 Codex app 级别的桌面控制能力。**
结论先行——不需要任何 macOS 私有 API，而且在 Electron 应用这一类上本插件的架构本来就比
Codex 更准。理由全部落在下面的实测证据上。

## 目标：人机共驾

由人类确定的终极判据，本文的一切裁决服从它：

1. **agent 有自己的可见光标**——用户能实时看到 agent 在点哪里，而不是屏幕上无缘无故地变化。
2. **不与用户争抢当前活跃环境**——用户的系统光标不动、frontmost 不变、不被拖过 Space；
   人和 agent 同时用一台机器互不干扰。

两条合起来就是「人机共驾」：不是 agent 接管电脑，是人和 agent 各有一套输入通道共用一块屏幕。
D16–D21 表明这个目标**可以零私有 API 达成**，前提是主路径坚持 element-index grounding
（见裁决 2 修订版与裁决 10）。

阅读顺序建议：先看「证据底座」和「一句话结论」，再看「架构裁决」，实施时看「接口改造」
和「实施路线」。**不要跳过证据底座直接实施**——本文每条裁决都绑定了证据编号，证据被推翻
则裁决作废，这是本仓库既有的工作制度（见 docs/phase2-design-review.md、docs/phase3-roadmap.md）。

## 一句话结论

Codex 在 macOS 上用私有 API（SkyLight `SLEventPostToPid`、`SLPSPostEventRecordTo`、私有 AX SPI）
换来了「后台操作任意应用」；本插件用公开的 `AXUIElementPerformAction` 就能得到同一个效果
（D1 实测），因为本插件走结构优先路线、不需要在屏幕坐标上合成鼠标事件——**Codex 需要私有 API，
是它保留坐标姿态的代价，不是桌面控制的固有成本。**

## 证据底座

D1–D5、D12 是**本机实测**（macOS 26.5.2 / arm64 / 2026-08-26），探针代码在
`experiments/macos-ax-probe/probe.swift`，可重跑。D6 是**一手源码**。D7–D11、D13 是文献调研，
按可靠度标注。

| # | 证据 | 来源 |
|---|---|---|
| D1 | **公开 API `AXUIElementPerformAction(kAXPressAction)` 可操作后台应用**：对未激活的计算器（`active=false`）连按 8/×/7/=，4 次全部 success，耗时 3–24ms，动作后从 AX 树回读显示区得到 `8×7` 与 `56`（即动作真实生效，不是只返回了 success）；目标应用全程未激活，frontmost 未变，光标未移动 | 本机实测，`probe press` |
| D2 | **AX 树 pull 读取在后台可用且够快**：计算器 150 个可按节点 / 240ms，备忘录 327 / 968ms，VS Code 845 / 1255ms | 本机实测，`probe walk` |
| D3 | **Electron 应用在后台仍暴露可用的 AX 树**：VS Code（`active=false`）845 个可按节点，名称语义完整（"打开快速访问"、"切换聊天"） | 本机实测 |
| D4 | **AX 覆盖率因应用而异，自绘 UI 基本不可达**：微信仅 123 个可按节点，前若干个是空名 `AXButton`，其余多为系统菜单栏项 | 本机实测 |
| D5 | **`CGWindowListCreateImage` 在 macOS 15.0 已废弃**，macOS 26 SDK 上是编译错误而非警告；遮挡窗口截图必须走 ScreenCaptureKit | 本机实测（编译失败原文：`obsoleted in macOS 15.0`） |
| D6 | **Codex 只开源了策略框架，未开源实现**：`codex-rs/config/src/browser_use.rs` 定义 per-origin 策略 `{access, downloads, uploads, full_cdp_access}`；`codex-rs/config/src/computer_use.rs` 定义 `ComputerUseMacosConfigToml { bundle_ids: BTreeMap<String, AllowDenyRequirementToml> }`（per-bundle-id 三态准入）；`codex-rs/core/src/tools/approvals.rs` 是通用审批枚举。工具 schema、AX 实现、CDP 实现均不在开源仓库 | github.com/openai/codex 源码检索 |
| D7 | 键盘事件用公开的 `CGEventPostToPid` 定向到 pid 即可，无需私有 API；**鼠标不行**——Chromium 在渲染器 IPC 边界过滤合成鼠标事件，需要 SkyLight 的信任戳 | cua 逆向分析（可靠度高，一手逆向） |
| D8 | 「focus-without-raise」需要私有 `SLPSPostEventRecordTo`（yabai 的 `window_manager_focus_window_without_raise`） | 同上 |
| D9 | **已运行的 Electron 应用无法事后开启 CDP**，必须重启并带 `--remote-debugging-port`；目前没有任何 Electron fuse 能禁用该端口（需求见 electron/fuses#2，未实现） | Electron 官方文档 + issue |
| D10 | **CDP 到不了 Electron 的原生部分**：菜单栏、系统托盘、`dialog.showOpenDialog` 原生文件选择器均不可达；仅 HTML `<input type=file>` 可经 `Page.fileChooserOpened` 拦截 | CDP 官方文档 |
| D11 | TCC 权限绑定 bundle id + 代码签名（`csreq`），并按 **responsible process** 归属；ad-hoc 签名每次构建变化会使授权失效 | 多来源，可靠度中，**部分已被 D12 就地验证** |
| D12 | **responsible-process 继承确实发生**：本次新编译的 Swift 裸二进制由终端拉起，`AXIsProcessTrusted()` 直接为 true，`CGPreflightScreenCaptureAccess()` 为 true，未出现任何授权弹窗——权限继承自宿主终端 | 本机实测，`probe apps` |
| D13 | 开源复刻件：trycua/cua（MIT，21.9k star，活跃，Python/Swift，无 Node SDK）、OpenCodexLabs/open-codex-computer-use（MIT，Swift MCP server，已停更）、iFurySt/open-codex-computer-use（MIT，npm 包但依赖外部二进制）。**Node 生态没有成熟的 AX 绑定**（robotjs 过时、ffi-napi 停维护） | 仓库调研 |
| D14 | **attach 模式下截图尺寸元数据是错的，且刚落地的坐标兜底依赖它**：以 900×600 窗口起 Chrome 并 attach，真实 PNG 为 **1800×1026**（Retina DPR=2，对应 900×513 CSS 像素），而 provider 向模型报告 `1280×800`（配置默认值）。`page.mouse.click(x, y)` 吃的是 CSS 像素，模型却按错误尺寸的图推坐标 | 本机实测，见「已知缺陷」节的复现脚本 |
| D15 | **`page.screenshot({ scale: 'css' })` 使截图像素与点击坐标空间同一**：同一场景下产出 900×513，恰等于 `innerWidth/innerHeight` | 本机实测 |
| D16 | **CDP 鼠标派发在 attach 的 Electron 上完全可靠，此前的"不可靠"是坐标空间错配的误诊**：微信开发者工具实测 CSS 视口 711×700 / DPR 2 / PNG 1422×1400 / provider 报告 1280×800（三者互不相同）。模型在 1422×1400 的图上读到图标在 (28,143)，`page.mouse.click` 吃 CSS 像素，落在 `span`（死区），前后截图字节相同。改 `scale:'css'` 后同一宿主 `page.mouse.click(14,72)` 命中 `div "小程序"`，页面切换 | 本机实测，`cdp-coord-verify.spec.ts`（`WECHAT_CDP=1`），修复见 commit `6a9ea06` |
| D17 | **可见 agent 光标是纯呈现层，与输入注入无关**：Codex 的 `SkyComputerUseService` 用 `NSWindow`/`CALayer` 画光标，路径是分段三次 Bezier（每次移动生成 20 条候选路径按长度/转角能量加权评分）+ VelocityVerlet 弹簧物理（response 1.4 / damping 0.9 / 1&#47;240s 定步长）。**这套全部是公开 API**；cua 的 `cursor-overlay` crate 同样"渲染 agent 光标而不移动硬件光标" | 逆向文档 + cua 文档，可靠度中高 |
| D18 | **cua 的主 grounding 也是 element_index 而非像素**：`get_window_state` 返回结构化 AX 树，`click({pid, window_id, element_index})` 直接触发 AX 动作，**对隐藏/被遮挡窗口有效且不涉及坐标**。默认 capture 模式 `som` = AX 树 + 截图 | cua DeepWiki，可靠度高 |
| D19 | **私有 API 的必要性可逐格拆解，且只剩一格与我们相关**：`SLEventPostToPid` 只在**往 Chromium 渲染器注入像素坐标鼠标**时必需（Chromium 的渲染器 IPC 过滤掉缺少 HID 遥测字段的合成事件；还需 (-1,-1) 诱饵点击过 user-activation gate）；`SLPSPostEventRecordTo` 只用于 focus-without-raise；键盘 `CGEvent.postToPid` 即可，**无需任何 SkyLight 包装** | cua 一手技术博客，可靠度高 |
| D20 | **另有纯 `CGEventPostToPid` 的公开路线存在**：`mac-cua` 的设计铁律是"CGEventPostToPid, never CGEventPost — 所有输入按进程定向"，配合 ScreenCaptureKit 按 window ID 免激活截图。**但它不万能**：Apple 开发者论坛记录了模态对话框必须先获得焦点才响应的失败案例 | 仓库调研 + Apple 论坛，可靠度中 |
| D21 | **公开 AX 路线的已知失败面**（另一个公开 API 复刻件实测记录）：日历类与 Catalyst 应用 AX 支持太薄需降级前台；游戏与 canvas 无真实 AX 树；跨 Space 的被遮挡窗口截不到（系统没有那些像素）。其架构为守权限的 daemon + Unix socket 上的长度前缀 JSON-RPC，返回"一个窗口的截图 + 该窗口带编号的 AX 树" | 第三方一手实现记录，可靠度中高 |

### D3 的关键辨析：pull 与 push 不是一回事

cua 的逆向文章说「Electron 应用窗口被遮挡时会暂停更新无障碍树，需要私有
`_AXObserverAddNotificationAndCheckRemote`」。D3 实测看似矛盾，其实不矛盾：

- 文章讲的是 **push 模型**——`AXObserver` 的**通知**被 Blink 短路了（没有"远程观察者"标记就不发通知）。
- D3 测的是 **pull 模型**——每次调用现场遍历 `AXUIElementCopyAttributeValue`，这条路径不依赖通知。

**本插件的 `snapshot()` 天生是 pull 模型**（每次调用现取，见 `computer-playwright/src/index.ts`
的 `interactiveHandles`）。因此那个私有 AX SPI 对本方案**不必要**。这条辨析是「零私有 API」
结论能成立的第二根支柱，实施时不要因为看到那篇文章就去引私有符号。

## Codex app 的实现事实（三层，互相独立）

| 层 | 实现 | 覆盖 | 限制 |
|---|---|---|---|
| 桌面 background computer use | AX 树作语义上下文 + SkyLight `SLEventPostToPid` 后台注入鼠标 + focus-without-raise；Swift 写的 localhost HTTP server；实体是 app 包内的 "Codex Computer Use.app"，需 Screen Recording + Accessibility 双授权 | 全部 macOS 应用 | **仅 macOS**；Windows 版无此能力；依赖多个私有 API（D7/D8） |
| 内置浏览器 | 桌面 app 内嵌浏览器，独立 profile（cookie 与用户浏览器隔离），可选开启 full CDP access（查 DOM/样式、性能 trace、网络） | 网页 | **CLI 与 IDE 插件里没有**；无法操作需登录的站点；不支持文件上传自动化 |
| Codex for Chrome | 浏览器扩展，驱动用户本地 Chrome，复用已登录 cookie 与标签页，按任务建标签组，支持 allowlist/blocklist | 已登录的网页 | 需装扩展；受扩展 API 限制 |

权限模型（D6，一手源码）：浏览器 **per-origin** 三态，桌面 **per-bundle-id** 三态。
敏感动作（提交、付款、改权限、删数据）二次确认；登录凭证走专用表单**绕过模型**。

## 现状盘点与差距

本插件当前（**0.4.0**，含本次会话期间落地的坐标兜底 `f34eea6`）的能力，来自源码与
README/DO.md 的实测记录：

- 结构优先已是既定路线且有实测背书：视觉坐标 grounding 实测 61.8% / 中位误差 60px（E7），
  所以主路径走 DOM 元素索引；15 个验收任务里结构路径零失败。
- Playwright provider 双形态：launch 本地 Chrome，或 `cdpEndpoint` attach 已运行的
  Chromium 应用（微信开发者工具实测通过）。
- 动作面：`navigate / snapshot / click / type / press_key / screenshot`。`computer_click` 自 0.4.0
  起接受 `index`（结构优先，首选）**或** `x`+`y` 视口坐标（兜底），二选一由 `parseClickArgs` 强制。
- 安全 DNA：attach 断连是**终态**，所有后续调用返回「报告并等待，不要自行重启宿主」，
  已有回归测试与模型行为级验证（bash 调用 0 次，对比安全事件时的 40+ 次）。
- token 治理：unchanged-since-N 折叠、click 附带 post-click 快照、枚举降噪 −52%。

| 能力 | Codex app | 本插件现状 | 判定 |
|---|---|---|---|
| 原生 macOS 应用控制 | ✅ | ❌ 零 | **真差距，本方案主体** |
| 应用/窗口发现与切换 | ✅ | ❌ 只有单一 page | **真差距** |
| 菜单栏 / 托盘 / 原生对话框 | ✅ | ❌ | **真差距**（D10：CDP 永远到不了） |
| 后台不抢焦点 | ✅（私有 API） | 部分（headless 天然后台） | 需在原生侧兑现（D1 已证可行） |
| Chromium 桌面应用的 DOM 精度 | ⚠️ 走 AX，需私有信任戳绕过渲染器过滤（D7） | ✅ CDP 直达渲染器 | **本插件已领先** |
| 跨平台 | ❌ 桌面能力仅 macOS | ✅ CDP 路径三平台通用 | **本插件已领先** |
| 坐标兜底 | ✅ | ✅ 0.4.0 已落地（浏览器/CDP 侧） | 已补齐，但**元数据有承重缺陷**（D14） |
| 滚动 | ✅ | ❌（roadmap #3） | 真差距 |
| 权限/审批模型 | ✅ per-origin + per-bundle-id 三态 | ❌ `approval: never`，仅留 seam | **真差距，桌面上不可再拖** |
| 断连/失控围栏 | 公开材料无对应设计 | ✅ 终态语义 + 回归测试 + 行为级验证 | **本插件已领先** |
| 统一工具面 | ❌ 三套产品（内置浏览器/扩展/桌面） | ✅ 单一 seam | **本插件已领先** |

## 架构裁决

### 裁决 1：主路径走公开 AX 动作，私有 API 不进方案

依据 D1。`AXUIElementPerformAction` 在后台应用上直接生效、不动光标、不抢焦点、毫秒级。
Codex 之所以必须上 SkyLight，是因为它要在**屏幕坐标**上合成鼠标事件；本插件的结构优先路线
（由 E7 的 61.8% 实测决定）根本不走那条路。

**实施约束**：任何引入 `SLEventPostToPid` / `SLPSPostEventRecordTo` / `_AXObserverAdd...` 的
PR 默认拒绝，除非附带「AX 动作路径在真实任务上失败」的实测数据。

### 裁决 2：不劫持用户的**真实**光标与焦点；agent 用自己的光标

**2026-08-26 修订**：本裁决初版隐含了"不做光标"，那是错的推论。人机共驾要的是
**两套光标**——系统光标属于用户，永不被动；agent 另有一套渲染出来的光标，让用户看得见
agent 在做什么。D17 表明这两件事在实现上本就无关（Codex 也是分开的：`NSWindow`/`CALayer`
画光标，SkyLight 注入事件）。不变量因此精确化为：**不得移动系统光标、不得改变 frontmost**，
而不是"不得出现光标"。具体形态见裁决 10。

这既是安全 DNA 的延续，也机械地把实现锁死在公开 API 上：一旦允许 `CGEventPost`（进 HID 流），
就会移动用户真实光标（D7），于是就需要私有 API 去规避，于是裁决 1 失守。

**契约措辞**（写进 `ComputerProvider` 的 doc comment）：provider 的任何动作都不得改变
frontmost 应用、不得移动系统光标。破坏该不变量的实现必须显式标注并只在 exclusive 模式下启用。
`experiments/macos-ax-probe/probe.swift` 的 `Undisturbed` 结构即该不变量的可执行断言形式。

**已落地的坐标兜底不违反本裁决**：0.4.0 的 `clickAt` 走 `page.mouse.click`，它经 CDP 的
`Input.dispatchMouseEvent` 派发进渲染器，不进 HID 事件流，因此不动系统光标。
这条区分很关键——**同样是"点坐标"，在 CDP 通道上是免费的，在原生 AX 通道上就要付私有 API 的代价**
（D7：Chromium 过滤合成鼠标；进 HID 流则移动真实光标）。裁决 9 的分层顺序即由此而来。

### 裁决 3：AX 是通用底座，CDP 是 Chromium 应用的精度增强，二者并存而非二选一

这是本方案最容易做错的地方。直觉上"Electron 应用走 CDP、原生应用走 AX"是二选一路由，
**但证据不支持**：

- D9：CDP 要求应用**重启**并带 `--remote-debugging-port`。对用户已经开着的应用，这条路当场不可用。
- D10：即便开了 CDP，菜单栏、托盘、原生文件选择器仍然到不了。
- D3：Electron 应用的 AX 树在后台是可用的。

所以正确结构是：

```
AX provider      = 通用底座。任何已运行应用，零前置条件，覆盖原生外壳（菜单/托盘/对话框）。
CDP provider     = 可选增强。用户愿意带 flag 重启的 Chromium 应用，获得精确 DOM 语义。
同一个应用可以同时有两个 surface：app:com.foo（AX）与 app:com.foo/webview（CDP）。
```

「本插件在 Electron 上比 Codex 准」的论据也在这里：Codex 点 Chrome 系应用必须靠 SkyLight 的
信任戳绕过渲染器过滤（D7），而 CDP 的 `Input.dispatchMouseEvent` 是渲染器的一等输入路径，
根本不经过那道过滤；元素语义也是真 DOM 而非 AX 投影。

### 裁决 4：seam 从「单 surface」改为「多 surface 显式路由」

当前 `resolveProvider()` 在有多个可用 provider 时抛 `COMPUTER_PROVIDER_AMBIGUOUS`
（`packages/computer/src/index.ts`）。浏览器 provider 与桌面 provider 必然同时可用，
**这是架构级阻塞，必须先改**。

改法保留原设计意图（永不依赖注册顺序）：路由依据从"恰好一个可用"变为"调用方显式给出
surface"。聚合列举按 `providerId + surfaceId` 排序，结果确定。

### 裁决 5：AX 快照从第一版就必须裁剪

D2 显示 VS Code 有 845 个可按节点。按本仓库已实测的 token 曲线（833 个元素 ≈ 5.2k token），
一次全量 AX 快照就是 5k+ token。裁剪规则（第一版）：

1. 只枚举**当前聚焦窗口**的子树，菜单栏按需单独取（`computer_menu` 或 target 参数）。
2. 只保留同时满足：有 `AXPress`/`AXConfirm`/可设值、`AXEnabled == true`、`AXSize` 非零、
   未被 `AXHidden` 标记的节点。
3. 复用已有的 `unchangedSince` 指纹折叠与 post-action 快照嵌入（两者已在浏览器侧验证）。

### 裁决 6：权限准入采用 Codex 的形状，但只做白名单，不做审批逻辑

D6 是一手先例：桌面 per-bundle-id、浏览器 per-origin、三态（允许/拒绝/需审批）。

桌面控制的风险面比浏览器大一个量级（能操作用户的任何应用，含邮件、聊天、银行客户端），
而 2026-08-25 的安全事件已经证明模型在受阻时会越界自救。因此**白名单从第一版就要有**——
注意这不是 approval 逻辑（roadmap #7 仍待触发），只是"哪些 bundle id 允许被枚举和操作"的
静态准入，默认空列表即默认不可用，成本极低。

```yaml
provider:
  macos:
    bundleIds:
      com.apple.calculator: allow
      com.microsoft.VSCode: allow
      # 未列出的一律拒绝，错误信息里提示用户显式添加
```

### 裁决 7：helper 用 Swift 常驻子进程 + stdio JSON-RPC，不用 localhost HTTP

Codex 用的是 localhost HTTP server。本方案选 stdio，理由：

- 生命周期天然绑定 cordis fiber——`ctx.effect` 释放即关闭 stdin，子进程退出，无孤儿进程
  （对比本仓库已踩过的「kill node 留孤儿 Chrome」坑，见 DO.md 2026-08-26 09:30）。
- 无监听端口 = 无未鉴权的本地攻击面。CDP 端口已经是一个暴露面了，不要再加一个。
- 无端口占用与探测逻辑。

D13：Node 生态没有成熟的 AX 绑定（robotjs 过时、ffi-napi 停维护、无 node-swift），
现有开源件要么是 Python（cua）要么依赖外部二进制（iFurySt），都不适合作为 npm 单包依赖。
**自己写 Swift helper 是唯一干净选项**，好在裁决 1 让它的实现面很小（只用公开 API）。

### 裁决 8：第一版用裸二进制继承宿主授权，`.app` 打包与签名推迟

D12 实测：新编译的 Swift 裸二进制由终端拉起时，Accessibility 与 Screen Recording 权限
**直接可用**，无弹窗——权限归属到 responsible process（宿主终端）。

这意味着第一版不需要碰代码签名、公证、quarantine 属性这一整套（D11 列出的坑），
用户只需给自己的终端授权一次。

**如实记录代价**：这个权限粒度是粗的——给终端授权等于给终端里跑的一切授权。
`.app` 打包能把权限收敛到 helper 自身，但要处理签名稳定性（D11：ad-hoc 签名每次构建变化会
使授权失效，需自签名固定证书）与 npm 分发的 quarantine/可执行位问题。
列为触发制开放项，触发信号：用户抱怨权限粒度，或出现宿主不同导致授权不一致的报告。

### 裁决 9：坐标兜底已落地，但它是分层里的最后一层，前三层仍然欠着

**状态更正（写作期间发生的变化）**：本文起草时坐标兜底尚未实现；写作过程中并行的
do-something 循环提交了 `f34eea6`（0.4.0），`computer_click` 现已接受 `x`+`y`。
因此本裁决从「要不要做坐标」改为「坐标已有，缺的是什么」。

DO.md 2026-08-26 10:40 记录的微信开发者工具盲区（React 合成事件 div 无 role/onclick，
截图可见但 snapshot 不可达）与 D4（微信原生端 AX 覆盖差）是**同一个根因的两面**：
结构枚举漏元素。坐标兜底缓解了症状，没有消除根因——用 61.8% 精度的通道去做本该由
结构通道零失误完成的事，是能力降级。四层的完整形态：

| 层 | 手段 | 解决什么 | 状态 |
|---|---|---|---|
| 1 | 浏览器侧枚举扩充：把计算样式 `cursor: pointer` 纳入交互元素判据 | 直击 React 合成事件根因——`cursor:pointer` 是开发者给用户的「此处可点」信号，合成事件应用几乎必然设置 | **欠着，需先测量** |
| 2 | 桌面侧枚举扩充：AX 从「有 AXPress」放宽到 AXRole 白名单 + 可见性过滤 | D4 的空名按钮与自绘控件 | 欠着 |
| 3 | snapshot 附几何信息（DOM `getBoundingClientRect` / AX `AXFrame`） | 让模型把截图里看到的东西映射回索引；给坐标点击提供**命中验证**手段 | 欠着，两侧都近乎免费 |
| 4 | 纯坐标点击兜底 | 前三层都够不着的自绘/canvas UI | ✅ 0.4.0 已落地（但见 D14 缺陷） |

第 3 层现在比落地前更值钱：坐标点击一旦成为常规路径，「点完之后怎么知道点对了」就成了
刚需，而几何信息正是那个反查手段（拿点击坐标去查它落在哪个已知元素的矩形里）。
当前 `clickAt` 只能靠 post-click 快照做事后比对，点错了也只是"页面没变"。

第 1 层必须先测量再决定，不许直接实施——本仓库已有先例：DO.md 2026-08-25 11:40 记录的
「role 噪音假设被推翻，真噪音是 interwiki 链接」。度量口径：在 Wikipedia 主页与微信开发者
工具两个页面上，比较启用前后的元素总数、新增元素中真正可点的比例、以及父子重复命中率
（父 div 与子 span 同时有 `cursor:pointer` 时的去重规则需要实测定夺）。

**桌面侧的顺序与浏览器侧相反**：浏览器上第 4 层便宜（裁决 2：CDP 派发不动光标），
所以先落地无妨；原生应用上第 4 层昂贵（需合成 HID 鼠标 → 私有 API 或劫持光标），
所以桌面 provider **必须**把第 2、3 层做在前面，不能照抄浏览器侧的顺序。

### 裁决 10：可见 agent 光标是独立的呈现层，绑在 surface 上，公开 API 实现

人机共驾的第 1 条要求（用户看得见 agent 在点哪）由此裁决兑现。核心认识来自 D17：
**光标是渲染，不是输入。** Codex 把两者绑在一起，是因为它的 grounding 就是屏幕坐标——
既然事件已经按坐标注入了，顺手照着同一坐标画个光标是零额外成本。我们的 grounding 是
element index（与 cua 同构，D18），但元素有几何（裁决 9 第 3 层的 `rect`），照样能算出
"光标该飞到哪"。**这正是第 3 层几何字段的第三个理由**——除了让模型对齐视觉、给坐标点击做
命中验证，它还是可见光标的输入。

两个 surface 类各用自己的渲染器，同一套语义：

| surface | 渲染 | 不动系统光标的理由 |
|---|---|---|
| `browser` | 页面内注入一个 `position:fixed; pointer-events:none; z-index:2147483647` 的 overlay 节点 | 它只是 DOM，压根不碰输入系统 |
| `app` | `NSWindow`（`.screenSaver` 级、`isOpaque=false`、`ignoresMouseEvents=true`）里放 `CALayer` | 窗口透明且不接受鼠标事件，用户的点击穿透过去 |

动效第一版**不抄** Codex 的 20 候选 Bezier + 弹簧物理（D17）——那是拟人化打磨，
先做直线插值 + 点击涟漪，够用即止。何时升级由"用户看不清 agent 在干什么"的真实反馈触发。

**这一层是可关的**：`cursor: false` 时 provider 行为完全不变（渲染层不参与任何动作路径）。
自动化/无人值守场景不需要它，回归测试也不该依赖它。

### 裁决 11：私有 API 的必要性逐格拆解，与我们相关的格子为零

D19 把「Codex 需要私有 API」拆成了具体格子。逐格对照本插件：

| 能力格 | 手段 | 私有？ | 本插件 |
|---|---|---|---|
| 原生应用元素点击（后台、被遮挡也行） | `AXUIElementPerformAction` | 公开 | 主路径（D1） |
| 键盘输入到指定进程 | `CGEvent.postToPid` | 公开（D19 明说无需 SkyLight 包装） | 采用 |
| 原生应用坐标点击 | `CGEventPostToPid` | 公开 | 兜底，**有边界**（D20：模态框可能需焦点） |
| **Chromium/Electron 内容操作** | **CDP** | 公开 | **已有，且比 SkyLight 路线更准** |
| 被遮挡窗口截图 | ScreenCaptureKit 按 window ID | 公开 | 片 5（D5 已判定必经） |
| 可见 agent 光标 | `NSWindow` + `CALayer` | 公开 | 裁决 10 |
| Chromium **像素**坐标注入 | `SLEventPostToPid` + (-1,-1) 诱饵点击 | **私有** | **不需要**——这一格 CDP 全覆盖 |
| focus-without-raise | `SLPSPostEventRecordTo` | **私有** | **不需要**——AX 动作不要求 AppKit-active（D1） |
| 遮挡时的 Electron AX 通知 | `_AXObserverAddNotificationAndCheckRemote` | **私有** | **不需要**——我们是 pull 模型（D3 辨析） |

**结论**：Codex 必须用私有 API 的那一格（往 Chromium 渲染器打像素鼠标）恰好是我们唯一
已经有更好解法的格子。人机共驾的两条要求在公开 API 上全部可兑现。

**留在台面上的真实代价**（不粉饰）：D21 记录的公开 AX 路线失败面依然存在——日历类/Catalyst
应用 AX 太薄、游戏与 canvas 无 AX 树、跨 Space 被遮挡窗口无像素可截。这些场景下要么降级
前台（破坏共驾承诺），要么承认不支持。届时是重新评估私有 API 的**唯一**正当触发点。

## 接口改造

以下是对 `packages/computer/src/types.ts` 的具体改造。这是 breaking change，但插件处于 0.3.x、
仅一个 provider 已发布，代价可控；**模型可见的工具 schema 保持向后兼容**（surface 参数可选）。

```ts
/** 一个可被驱动的界面：一个浏览器页面、一个桌面应用、或应用里的一个 webview。 */
export interface ComputerSurface {
  /** 全局唯一，形如 `playwright:page` / `macos:com.apple.finder` / `macos:com.foo/webview`。 */
  readonly id: string
  /** browser = 网页；app = 桌面应用外壳。 */
  readonly kind: 'browser' | 'app'
  /** 窗口标题或文档标题。 */
  readonly title: string
  /** 浏览器是 URL，桌面是 bundle id。 */
  readonly locator: string
  /** 该 surface 当前是否是系统 frontmost。仅用于告知模型，不作为操作前提。 */
  readonly focused: boolean
}

export interface ComputerProvider {
  readonly id: string
  available(): boolean

  /** 此 provider 此刻能驱动的全部 surface。桌面 provider 在此返回白名单内的已运行应用。 */
  surfaces(signal?: AbortSignal): Promise<readonly ComputerSurface[]>

  /**
   * 把一个 target 纳入可操作范围并返回它的 surface。
   * 浏览器：`https://…`。桌面：`app:<bundle-id>`（未运行则拉起，且必须以不抢焦点的方式）。
   */
  open(target: string, signal?: AbortSignal): Promise<ComputerSurface>

  // 以下动作全部带 surface 参数；索引仅在 (surface, 该次快照) 内有效。
  snapshot(surface: string, signal?: AbortSignal): Promise<ComputerSnapshot>
  click(surface: string, index: number, signal?: AbortSignal): Promise<ComputerClickResult>
  type(surface: string, index: number, text: string, signal?: AbortSignal): Promise<ComputerTypeResult>
  pressKey(surface: string, key: string, signal?: AbortSignal): Promise<ComputerKeyPressResult>
  screenshot(surface: string, signal?: AbortSignal): Promise<ComputerScreenshot>
  close(): Promise<void>
}
```

`ComputerSnapshot` 增加几何字段（裁决 9 第 3 层）与 surface 回执：

```ts
export interface ComputerElement {
  readonly index: number
  readonly role: string
  readonly name: string
  /** 可见矩形，surface 局部坐标，CSS 像素 / AX point。缺省表示 provider 无法提供。 */
  readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}
```

seam 侧路由（替换 `resolveProvider` 的单例语义）：

```ts
/** surface id 的前缀即 provider id，路由因此是纯函数，不依赖注册顺序。 */
function routeSurface(providers: ReadonlyMap<string, ComputerProvider>, surfaceId: string): ComputerProvider {
  const [providerId] = surfaceId.split(':')
  const provider = providers.get(providerId)
  if (provider === undefined) throw new ComputerError(`no provider owns surface "${surfaceId}"`, 'COMPUTER_SURFACE_UNROUTABLE')
  if (!provider.available()) throw new ComputerError(`provider "${providerId}" is unavailable`, 'COMPUTER_PROVIDER_CONFIGURED_UNAVAILABLE')
  return provider
}
```

省略 surface 时的默认值：seam 记住「最近一次成功动作的 surface」；若尚无，则在只有一个
surface 时用它，多个则抛错并把 `surfaces()` 列表放进错误信息（让模型自己选，而不是猜）。
这样既保住现有单浏览器任务的工具调用形状不变，又让多 surface 可用。

新增的模型可见工具（按 E3 教训，参数面即陷阱面，宁可多工具少参数）：

- `computer_surfaces()` — 列出可操作的应用/页面，是桌面任务的入口。
- `computer_open_app(bundleId)` — 纳入一个应用（受白名单约束）。
- `computer_scroll(surface?, direction, amount)` — roadmap #3，桌面侧同样需要。

## helper 的 JSON-RPC 契约

Node 侧 provider 与 Swift helper 之间的协议。请求/响应各一行 JSON，`\n` 分隔（NDJSON）。
方法与 `ComputerProvider` 一一对应，**不要在 helper 里放策略**（白名单、审批、裁剪一律在
Node 侧做，helper 只做机械的 AX 操作），理由是策略要随插件配置走，且 TS 侧更好测。

```
→ {"id":1,"method":"surfaces"}
← {"id":1,"result":[{"bundleId":"com.apple.finder","pid":123,"title":"下载","focused":false}]}

→ {"id":2,"method":"snapshot","params":{"bundleId":"com.apple.finder","scope":"focusedWindow"}}
← {"id":2,"result":{"title":"下载","elements":[{"index":0,"role":"AXButton","name":"前往","rect":{...}}]}}

→ {"id":3,"method":"press","params":{"bundleId":"com.apple.finder","index":0}}
← {"id":3,"result":{"ok":true,"focusStolen":false,"cursorMoved":false}}
```

`focusStolen` / `cursorMoved` 是**裁决 2 的运行时自检**，每次动作都回报；Node 侧一旦收到
true 就当作缺陷上报而不是静默通过。这样不变量不靠人记，靠协议兜住。

句柄稳定性：AX element 引用不能跨调用缓存（应用重绘后失效）。helper 每次动作前重新遍历并
按 index 定位——这与浏览器侧 `interactiveHandles` 是索引唯一权威的做法同构，
**必须保持一致，否则会重演 DO.md 2026-08-25 11:40 的索引错位事故**。

## 已修：截图尺寸元数据（曾阻塞坐标兜底的正确性）

**2026-08-26 已修复（commit `6a9ea06`）**：`screenshot()` 改 `scale:'css'` 并回报 PNG 自身
尺寸，截图像素、报告尺寸、点击坐标三者收敛为同一空间。同时 D16 证伪了"CDP 派发在 attach 的
Electron 上不可靠"这一误诊，据此写的 `elementFromPoint` + `.click()` 变通已回退为
`page.mouse.click`（真实鼠标事件序列，会发 pointer 事件，比 `element.click()` 忠实）。
回归网：attach 一个 900×600 且 `--force-device-scale-factor=2` 的宿主，断言报告尺寸 ==
真实 PNG 尺寸。以下为修复前的现象记录，保留作为"三个坐标空间"这类缺陷的样本。

**这条独立于桌面控制，但必须先修**——它让刚落地的坐标兜底在 attach 模式（也就是触发该
功能的微信开发者工具场景）下系统性偏移。

现象（D14 实测）：`PlaywrightProvider.screenshot()` 返回的 `width`/`height` 直接取配置值
`viewportWidth`/`viewportHeight`（默认 1280×800），而 attach 模式压根没有设置 viewport
（`getPage()` 的 attach 分支复用应用自己的 context）。以 900×600 窗口起 Chrome 实测：

```
CSS viewport (innerWidth/innerHeight, DPR): [900, 513, 2]
真实 PNG                                  : 1800 x 1026
provider 报告给模型                        : 1280 x 800
```

后果：`computer_click(x, y)` 走 `page.mouse.click`，吃的是 **CSS 像素**；模型看到的图是
**设备像素**（Retina 上 2 倍）；而它被告知的尺寸两者都不是。模型据此做任何比例换算都会错。

根因修法（D15 实测验证）：`page.screenshot({ type: 'png', scale: 'css' })` 产出的 PNG 恰为
CSS 像素尺寸（900×513），**使截图坐标系与点击坐标系成为同一个**，从根上消掉这类换算错误；
再把返回的 `width`/`height` 改为该图的真实尺寸，而不是配置值。这比"补一个 DPR 字段让模型
自己换算"更好——不给模型留算术题。

复现脚本（需在仓库根目录跑，因为要解析 `playwright-core`）：

```js
import { chromium } from 'playwright-core'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')  // 宿主需带 --window-size=900,600
const page = browser.contexts().find(c => c.pages().length > 0).pages()[0]
const dims = b => [b.readUInt32BE(16), b.readUInt32BE(20)]              // PNG IHDR
console.log('default :', dims(await page.screenshot({ type: 'png' })))
console.log('css     :', dims(await page.screenshot({ type: 'png', scale: 'css' })))
console.log('viewport:', await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]))
```

本文作者未直接修复：写作期间有并行 session 正在改动同一批文件（`f34eea6` 刚落地，
`pnpm dsh` 任务在跑），按仓库的并行任务纪律不做竞争性编辑。**接手者请先修这条再往下走。**

## 实施路线

按 tracer bullet 切片，每片自带验收。**每片验收必须包含 log 级核验**——本仓库已两次被
「模型自证」误导（DO.md 2026-08-24 23:50 判分脚本 bug、2026-08-25 21:30 模型自己写 CDP 脚本
伪装工具输出），log 级核验是汇报的唯一可信前置。

| 片 | 内容 | 验收 | 状态 |
|---|---|---|---|
| 0 | 可行性探针 | `probe press` 在后台应用上动作成功、焦点光标未动 | ✅ 完成（D1） |
| 0.5 | 修截图尺寸元数据（见「已修」节） | attach 一个非 1280×800 的宿主，断言报告尺寸 == 真实 PNG 尺寸 == CSS 视口尺寸 | ✅ 完成（`6a9ea06`，D16） |
| 1 | seam 多 surface 路由 + Playwright provider 适配 | 现有单测全绿、10 任务验收套件重跑 10/10（纯重构，行为不许变） | 待做 |
| 2 | 几何字段 `rect`（浏览器侧，裁决 9 第 3 层） | `getBoundingClientRect` 进 snapshot；坐标点击的命中验证跑通 | 待做，**提前到片 4 之前**：裁决 10 的光标依赖它 |
| 3 | 可见 agent 光标（浏览器 surface，裁决 10） | 人眼可见：光标移到目标元素中心、点击涟漪、`cursor:false` 时行为零差异 | 待做 |
| 4 | Swift helper 最小可用（surfaces/snapshot/press/setValue/key）+ Node 侧 macOS provider + bundle 白名单 | 单测：对计算器做 snapshot→press→回读断言；helper 每次回报 focusStolen=false / cursorMoved=false | 待做 |
| 5 | 可见 agent 光标（app surface，`NSWindow`+`CALayer`） | 后台操作计算器时用户看得见光标飞过去，系统光标全程不动 | 待做 |
| 6 | 模型级桌面验收套件 | 仿 `experiments/phase2-acceptance/run.py` 建桌面任务集，log 核验工具真实调用 + 零越界 bash | 待做 |
| 7 | 枚举启发式扩充（裁决 9 第 1、2 层） | 先出度量数据再改代码；Wikipedia 与微信开发者工具双页面对比 | 待做 |
| 8 | ScreenCaptureKit 截图（含被遮挡窗口） | D5 决定的必经之路；验收=遮挡状态下截到正确内容 | 待做 |

触发制开放项（沿用 docs/phase3-roadmap.md 的制度，未触发不做）：

| 项 | 触发信号 |
|---|---|
| **原生侧**坐标点击（需合成 HID 鼠标，即私有 API 或劫持光标） | 裁决 9 第 2、3 层在桌面 provider 上落地后，仍有实测任务因元素不可达而失败。浏览器侧不适用——那边坐标已经免费拿到了 |
| helper `.app` 打包 + 签名 | 用户抱怨权限粒度，或宿主不同导致授权不一致 |
| Windows UIA provider | 有 Windows 用户请求桌面控制。注：Codex 在 Windows 上没有桌面能力，这是可领先项 |
| approval 三态（roadmap #7） | 白名单不足以覆盖风险，或出现涉及付款/发送的真实任务 |
| E2B Desktop provider（roadmap #8） | 托管/无本机的部署需求 |

## 明确不做

- **不引私有 API**（裁决 1/2）。这不是洁癖：私有符号在 macOS 大版本升级时无预警失效，
  而本插件是 npm 分发的，用户升级系统后插件挂掉的排障成本落在维护者身上。
- **不做视觉主路径**。E7 实测 61.8% 已经否决过一次，桌面上不重来。
- **不追 Codex 的三产品形态**。单一 seam 统一浏览器与桌面是本插件的结构优势，不要拆散。
- **不在 helper 里放策略**。白名单、审批、token 裁剪全部在 TS 侧。
- **不在无人值守下跑桌面模型任务**（AGENTS.md 纪律，2026-08-25 安全事件产物）。桌面 provider
  落地后这条纪律更重要，因为可操作面从一个浏览器扩大到了整台机器。

## 给执行者的须知

实施前请确认你理解这些不变量，它们在代码里看不出来：

1. **索引唯一权威**：snapshot/click/type 必须共用同一次枚举的结果。浏览器侧是
   `interactiveHandles`，桌面侧是 helper 内的同一次遍历。分开枚举必然错位。
2. **动作不许改变 frontmost 与光标位置**，helper 每次动作回报自检结果。
3. **attach 断连是终态**，不许自动重启宿主应用；桌面 provider 遇到目标应用退出时同样适用
   （返回同款「报告并等待」指引）。
4. **pull 不是 push**：不要引 AXObserver 相关的私有符号（见 D3 辨析）。
5. **seam 一律走 `ctx.get('computer')`**，不用属性代理（postmortem 0001）。
6. **跨"包"导入用相对路径**，发布是单包。
7. **log 级核验是验收的前置**，不是可选项。

复现本文实测：

```sh
cd experiments/macos-ax-probe
swiftc -O probe.swift -o probe
./probe apps                              # 权限状态与运行中应用
open -g -a Calculator                     # -g 关键：后台启动，不抢焦点
./probe walk com.apple.calculator         # 后台读 AX 树
./probe press com.apple.calculator 8 乘 7 等于   # 后台动作 + 不变量自检
```

现有回归：`pnpm run typecheck && pnpm run test && pnpm run build`。

## 什么数据会推翻本方案

- D1 在其它原生应用上不成立（AX 动作对后台应用无效或抢焦点）→ 裁决 1 失守，
  须重新评估私有 API，整个「零私有 API」论点作废。
- 裁决 9 第 1 层实测显示 `cursor:pointer` 启发式噪音过高（新增元素中真正可点的比例过低）
  → 结构通道补不全，坐标兜底从"降级路径"变成常规路径；那就必须为 61.8% 的精度补上强制的
  命中验证与重试预算，而不是任由模型盲点。
- 白名单机制在真实任务里造成大量摩擦（模型反复撞拒绝）→ 说明准入粒度选错，
  应改为「首次使用时交互式授权」而非静态配置。
- 桌面任务的验收成功率显著低于浏览器的 15/15 → 说明 AX 语义质量不足以支撑结构优先路线，
  这是最根本的证伪，须回到 Phase 0 那种先测量后设计的模式。
