# 桌面控制方案：对标 Codex app，用公开 API 走得更远

日期：2026-08-26。状态：待人类裁决。读者：接手实施的 AI 或人。

本文回答一个问题：**dsh-computer-use 要怎么获得 Codex app 级别的桌面控制能力。**
结论先行——不需要任何 macOS 私有 API，而且在 Electron 应用这一类上本插件的架构本来就比
Codex 更准。理由全部落在下面的实测证据上。

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
| D1 | **公开 API `AXUIElementPerformAction(kAXPressAction)` 可操作后台应用**：对未激活的计算器（`active=false`）连按 8/×/7/=，4 次全部 success，耗时 4–23ms，显示区回读 `56` 正确；目标应用全程未激活，frontmost 未变，光标未移动 | 本机实测，`probe press` |
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

本插件当前（0.3.2）的能力，来自源码与 README/DO.md 的实测记录：

- 结构优先已是既定路线且有实测背书：视觉坐标 grounding 实测 61.8% / 中位误差 60px（E7），
  所以主路径走 DOM 元素索引；15 个验收任务里结构路径零失败。
- Playwright provider 双形态：launch 本地 Chrome，或 `cdpEndpoint` attach 已运行的
  Chromium 应用（微信开发者工具实测通过）。
- 动作面：`navigate / snapshot / click / type / press_key / screenshot`。
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
| 坐标兜底 | ✅ | ❌（roadmap #4 已触发） | 真差距，但优先级低于枚举补全 |
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

### 裁决 2：不劫持用户的真实光标与焦点，写进 provider 契约

这既是安全 DNA 的延续，也机械地把实现锁死在公开 API 上：一旦允许 `CGEventPost`（进 HID 流），
就会移动用户真实光标（D7），于是就需要私有 API 去规避，于是裁决 1 失守。

**契约措辞**（写进 `ComputerProvider` 的 doc comment）：provider 的任何动作都不得改变
frontmost 应用、不得移动系统光标。破坏该不变量的实现必须显式标注并只在 exclusive 模式下启用。
`experiments/macos-ax-probe/probe.swift` 的 `Undisturbed` 结构即该不变量的可执行断言形式。

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

### 裁决 9：roadmap #4（坐标兜底）改为「先补枚举，再谈坐标」

DO.md 2026-08-26 10:40 记录的微信开发者工具盲区（React 合成事件 div 无 role/onclick，
截图可见但 snapshot 不可达）与 D4（微信原生端 AX 覆盖差）是**同一个根因的两面**：
结构枚举漏元素。当时留了三个备选，本方案的裁决是分层而非三选一：

| 层 | 手段 | 解决什么 | 状态 |
|---|---|---|---|
| 1 | 浏览器侧枚举扩充：把计算样式 `cursor: pointer` 纳入交互元素判据 | 直击 React 合成事件根因——`cursor:pointer` 是开发者给用户的「此处可点」信号，合成事件应用几乎必然设置 | **待实测**，度量见下 |
| 2 | 桌面侧枚举扩充：AX 从「有 AXPress」放宽到 AXRole 白名单 + 可见性过滤 | D4 的空名按钮与自绘控件 | 待实测 |
| 3 | snapshot 附几何信息（DOM `getBoundingClientRect` / AX `AXFrame`） | 让模型把截图里看到的东西映射回索引；给坐标点击提供**命中验证**手段 | 两侧都近乎免费 |
| 4 | 纯坐标点击兜底 | 前三层都够不着的自绘/canvas UI | 最后一层，必须带命中反查 |

第 1 层必须先测量再决定，不许直接实施——本仓库已有先例：DO.md 2026-08-25 11:40 记录的
「role 噪音假设被推翻，真噪音是 interwiki 链接」。度量口径：在 Wikipedia 主页与微信开发者
工具两个页面上，比较启用前后的元素总数、新增元素中真正可点的比例、以及父子重复命中率
（父 div 与子 span 同时有 `cursor:pointer` 时的去重规则需要实测定夺）。

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

## 实施路线

按 tracer bullet 切片，每片自带验收。**每片验收必须包含 log 级核验**——本仓库已两次被
「模型自证」误导（DO.md 2026-08-24 23:50 判分脚本 bug、2026-08-25 21:30 模型自己写 CDP 脚本
伪装工具输出），log 级核验是汇报的唯一可信前置。

| 片 | 内容 | 验收 | 状态 |
|---|---|---|---|
| 0 | 可行性探针 | `probe press` 在后台应用上动作成功、焦点光标未动 | ✅ 本次完成（D1） |
| 1 | seam 多 surface 路由 + Playwright provider 适配 | 现有 13 个单测全绿、10 任务验收套件重跑 10/10（纯重构，行为不许变） | 待做 |
| 2 | Swift helper 最小可用（surfaces/snapshot/press/setValue/key）+ Node 侧 macOS provider + bundle 白名单 | 单测：对计算器做 navigate-free 的 snapshot→press→回读断言；helper 每次回报 focusStolen=false | 待做 |
| 3 | 模型级桌面验收套件 | 仿 `experiments/phase2-acceptance/run.py` 建桌面任务集，log 核验工具真实调用 + 零越界 bash | 待做 |
| 4 | 几何字段 + 枚举启发式（裁决 9 第 1–3 层） | 先出度量数据再改代码；Wikipedia 与微信开发者工具双页面对比 | 待做 |
| 5 | ScreenCaptureKit 截图（含被遮挡窗口） | D5 决定的必经之路；验收=遮挡状态下截到正确内容 | 待做 |

触发制开放项（沿用 docs/phase3-roadmap.md 的制度，未触发不做）：

| 项 | 触发信号 |
|---|---|
| 坐标合成鼠标（可能需私有 API） | 裁决 9 前三层落地后，仍有实测任务因元素不可达而失败 |
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
  → 回到坐标兜底，但需要为 61.8% 的精度设计强制的命中验证与重试预算。
- 白名单机制在真实任务里造成大量摩擦（模型反复撞拒绝）→ 说明准入粒度选错，
  应改为「首次使用时交互式授权」而非静态配置。
- 桌面任务的验收成功率显著低于浏览器的 15/15 → 说明 AX 语义质量不足以支撑结构优先路线，
  这是最根本的证伪，须回到 Phase 0 那种先测量后设计的模式。
