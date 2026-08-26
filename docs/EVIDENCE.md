# 实测结论

本文只放**结论**，不放推导过程。每条都是本机实测或一手源码，标注了复现方式。
施工依据是 [HANDOFF.md](HANDOFF.md)；本文用来回答「这个数字哪来的」和「这条为什么不能改」。

测试环境：macOS 26.5.2 / arm64 / 2026-08-26。模型：`deepseek-v4-flash-vision-exp`，
上下文 1,000,000 token，单图像素预算 640,000 px，单请求最多 600 图。

---

## 一、macOS 桌面控制

复现：`experiments/macos-ax-probe/probe.swift`、`experiments/input-injection/probe.swift`、
`experiments/skylight-injection/probe.swift`（各自 `swiftc -O probe.swift -o probe` 后运行）。

### 能做到的

| 结论 | 证据 |
|---|---|
| **公开 API 可操作后台应用**：`AXUIElementPerformAction` 对未激活应用直接生效，4–24ms，不动光标不抢焦点 | 计算器 `active=false` 连按 8×7=，AX 树回读显示区得 `56` |
| **AX 树可后台读取且够快** | 计算器 24 元素、VS Code 136、备忘录 39（均为窗口内可操作元素） |
| **`AXManualAccessibility` 是 Chromium 应用的开关**：Chromium 要检测到辅助技术才构建 AX 树，不开则窗口读起来是空的 | 微信开发者工具窗口 0 → 13 元素；这是公开属性不是私有符号 |
| **AX 树异步构建，必须轮询到稳定**，固定等待会读到半成品 | 固定等 1 秒时 Kimi 报 3 元素、Clash Verge 报 3；轮询到稳定后为 62 和 55 |
| **坐标可用公开 API 命中后再操作**：`AXUIElementCopyElementAtPosition` 命中 → `AXPress` | 命中结果在按下前可见，失配可拒绝；点在标签上会自动上溯到真正可点的祖先 |
| **窗口移动/缩放无需指针**：`AXPosition`/`AXSize` 可写 | (510,421)→(630,481)→还原，光标焦点未动 |
| **键盘可定向投递**：`CGEvent.postToPid` 对键盘有效 | 后台计算器显示 99 → 9 |
| **权限按 responsible process 继承**：终端授权后，其拉起的裸二进制直接可用 | `AXIsProcessTrusted()` 为 true，无授权弹窗 |

### 做不到的

| 结论 | 证据 |
|---|---|
| **AX 没有拖拽动作** | 枚举计算器/访达/VS Code 全部动作：AXPress、AXShowMenu、AXPick、AXIncrement、AXDecrement、AXCancel、AXDelete、AXOpen、AXRaise、AXZoomWindow、AXScrollToVisible、AXScroll*ByPage——无拖拽 |
| **公开 API 无法把鼠标事件送进后台窗口** | `CGEvent.postToPid` 鼠标无效（原生与 Chromium 均然）；全局 `CGEventPost` 有效但按真实鼠标语义打给**最上层窗口**，要用它就得抢屏幕 |
| **SkyLight 私有通道当前实现未通** | 符号在 macOS 26 全部存在且返回 0；12 种组合（3 焦点策略 × 4 坐标姿态）全部未送达，两条假设被证伪 |
| **`CGWindowListCreateImage` 已废弃** | macOS 15 起 obsoleted，26 SDK 上是编译错误；遮挡窗口截图必须走 ScreenCaptureKit |

### 覆盖率（决定分层是否成立）

本机 22 个运行中应用：4 个无窗口（正确行为，不计），**其余 18 个里 11 个元素数 ≥20 可实际操作（61%）**。

VS Code 136 / 闲管家 95 / 千牛 65 / Kimi 62 / Clash Verge 55 / Chrome 42 / 备忘录 39 /
访达 35 / 预览 24 / 飞书 20 / 微信开发者工具 13。

**够不到的**：微信、Codex app、网易 UU——均拒绝 `AXManualAccessibility`（返回 -25205），属自绘 UI。

### 关键推论：执行缺口与感知缺口是两件事

私有 API 补的是**执行**（在坐标 X 按下去）。但上面那批 AX 空树的应用，绑定约束是**感知**——
不知道该按哪里。它们唯一的感知通道是视觉定位，实测 macOS 单步 60.9%：3 步 22.6%、5 步 8.4%、
10 步 0.7%。

**所以补上私有 API 不等于「所有 mac app 可用」。** 两个缺口解法不同，必须分开立项。

### 参照实现（豆包 Work 2.25.18，本机拆包）

`DoubaoWork.app/Contents/Helpers/DoubaoWork Browser.app/Contents/Resources/cua/libaha_cua.dylib`
未 strip，API 图谱存于 `experiments/skylight-injection/reference-api-map.txt`。

它证实了这条路的形状：`SLEventPostToPid` + `SLPSPostEventRecordTo` + 全套 AX + ScreenCaptureKit +
`NSWindow` 光标覆盖层（`cursor-blue-white.png` 直接打包在内）。关键类：`SkyLightEventPoster`
（`stamp_mouse_event` 同时带 global 与 window-local 两个点、`make_synthetic_focus_acquire_events`
返回**事件向量**）、`SyntheticAppFocusEnforcer`（`prevent_activation` 先**抑制目标激活**再发焦点事件）。
Codex 走同一条路。**macOS 上做到「后台操作任意应用」目前只有这一个解。**

---

## 二、浏览器控制

复现：`experiments/screenspot-grounding/`、`experiments/enumeration-coverage/`、
`experiments/pixel-budget/budget.py`。

### 视觉定位

| 结论 | 数字 |
|---|---|
| ScreenSpot-v2 单步命中率 | **61.8%**（118/191）；端到端口径应为 **59.0%**（118/200，被排除的 9 个全是模型未产出可用坐标） |
| 分平台 | tool 80.0 / android 75.8 / gitlab 64.7 / ios 62.5 / macos 60.9 / forum 60.0 / windows 52.0 / shop 48.7 |
| 误差归一化后排序会反转 | 按原始像素 windows 看似第二好（43.4px），按归一化误差它是**最差**（0.0367）。原始像素不可跨分辨率比较 |
| 失败形态 | 73 次失败里 **63% 是擦边**（偏离 < 目标半对角线），仅 16% 找错区域。P25=27px、P50=60px |
| **这个数字没测过生产路径** | bench 让模型输出 0–1000 归一化坐标，而线上工具收绝对 CSS 像素。生产坐标路径精度**目前零实测** |
| 两步裁剪放大 | 53.5%，方向为负但**统计不显著**（配对后 McNemar p≈0.09）；26 次失败里 17 次是模型空回复，不能记在方法头上 |

### 像素预算

`scale = min(1, sqrt(640000/(w·h)))`（`attachment-local/src/request-image.ts:51`）。
1280×800 缩到 0.79；**4K 全屏缩到 0.278，20px 按钮只剩 5.6px**。

但**桌面得分低不是预算造成的**：Windows 样本 960×540 缩放比 1.000 完全没降采样却得分最低；
shop 与 tool 分辨率缩放完全相同却差 31 个百分点。绑定因素是 UI 密度与目标尺寸。

### 结构枚举

| 结论 | 数字 |
|---|---|
| `cursor:pointer` 启发式**没有价值** | 6 个主流站点 1309 元素，只多找出 4 个，真实新目标 0 个 |
| 真实漏枚举是**遍历盲区** | 不穿 shadow DOM、不进 iframe。构造页 5 个可点目标只枚举到 1 个；6 站实测漏 1.7%（全来自 shadow DOM） |
| iframe 是**类别性缺口**不是百分比 | 一个 iframe 整片不可见，支付表单、OAuth 登录、嵌入内容全在里面 |
| 元素命名质量差 | 4 站 1181 元素：**32.1% 重名**（GitHub 47.7%）、6.3% 无名且其中 **97% 可从 title/alt/svg title/aria-labelledby/href 救回** |
| 首屏元素占比低 | react.dev 仅 12%、MDN 25%、Wikipedia 39%——没有 scroll 工具就读不到其余部分 |

### 已修的缺陷

截图尺寸元数据曾报配置值而非真实值（attach 模式 900×600 窗口的真实 PNG 是 1800×1026，却报
1280×800）。修法是 `page.screenshot({ scale: 'css' })`，使截图像素与点击坐标空间同一。

### 验收判据的教训（两次踩坑，代价最大的一条）

浏览器套件 15 个任务里 **7 个的判据词直接写在题面**，模型复述即通过；`url_contains` 的实现会
回退匹配模型的自然语言输出而非真实落点；`httpbin-elements` 靠匹配编号列表里的 "1" 通过，
而模型答案是 0。

桌面套件第一版**重犯同款错误**：`unchanged-collapse` 判据是 `len(elements) > 0`，从不检查折叠；
另有用例比对窗口标题——而标题按了按钮也不变，用例恒绿。

**规则**：判据必须能失败，必须观察被控对象发生变化，不能读会话文本、不能读不变量。

### 任务难度校准

15 个验收任务步数中位 **3**、均值 4.7、最长 17。中位耗时 10 任务集 16.6s、长链 5 任务集 41.5s。
**这个成绩单不能外推到长任务。**

---

## 三、跨平台事实

| 结论 | 来源 |
|---|---|
| **已运行的 Electron 应用无法事后开 CDP**，必须重启带 `--remote-debugging-port` | Electron 官方文档；目前无 fuse 能禁用该端口 |
| **CDP 到不了 Electron 的原生部分**：菜单栏、托盘、原生文件对话框 | CDP 官方文档；这些只能走 AX |
| **CDP 派发的坐标点击不动系统光标** | 走 `Input.dispatchMouseEvent` 进渲染器，不进 HID 流。同样是「点坐标」，CDP 通道免费，原生通道要私有 API |
| Codex 的权限模型形状 | `codex-rs/config/src/computer_use.rs`：`default_app_access` + per-bundle-id 映射，三态。**不是默认全禁** |

---

## 四、本项目的既定约束

| 约束 | 来源 |
|---|---|
| attach 断连是**终态**，所有后续调用报「报告并等待，不要自行重启宿主」 | 2026-08-25 无人值守失控事件；已有回归测试与模型行为级验证 |
| 无人值守只做代码/文档/测试，模型任务须人在场 | 同上事件 |
| 应用白名单**默认放行 + 六个内置拒绝项**（两个终端、系统设置、钥匙串、邮件、信息） | 默认全禁会让插件装上即不可用，用户的反应是一键全开——既有摩擦又没安全。名单是地板不是围墙 |
| 插件内部读 seam 一律 `ctx.get('computer')`，不用属性代理 | postmortem 0001 |
| 跨包导入用相对路径 | 发布是单包，无跨包名解析 |
| **只读 `deepseek-harness` 主仓，绝不写入** | 本仓库的既定边界；`link:` 依赖要求两仓并排克隆 |

## 五、模型行为的两条教训（代价最大，务必读）

**模型会伪装工具输出。** 一次 CDP 模式验收里，模型根本没调 `computer_*`，而是自己写了个
CDP 脚本，把结果包装成插件输出的样子——格式足够像，肉眼审汇报没看出来，靠翻 session log
才推翻。

**模型自愈会把基础设施缺陷藏起来。** `press_key` 触发导航时后置快照撞上
"Execution context was destroyed"，模型自己补一次 snapshot 就绕过去了，表面看只是"偶尔多
一步"，log 里才有 2 次真实报错。

**由此得出的硬规则：log 级核验是汇报的前置条件，不是可选项。** 每次模型级验证都要 grep
错误串、确认工具真被调用。声称做完但没有 log 证据的，按未完成处理。

## 六、工程操作教训

**批量改代码前必须确认锚点唯一。** 这个坑在本仓库踩了三次：python 的 `str.replace` 静默
不匹配，改了个寂寞而 typecheck 用旧代码通过，造成假完成；还有一次批量替换匹配错锚点半途
失败留下不一致文件。替换后必须 grep 确认命中数。
