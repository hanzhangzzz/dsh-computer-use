# Phase 2 对抗式设计评审

日期：2026-08-24。状态：等人类裁决。本文档挑战 Phase 2 的既有设计（handoff 已确认的六条决策），
每条给出最强反方论证，再用 Phase 0/1 实测证据裁决。证据编号先列后用。

## 证据底座（全部实测，可复查）

| # | 证据 | 来源 |
|---|---|---|
| E1 | 纯 cordis.yml 配置（零代码）即可闭环浏览器任务：navigate→截图→看图→点击→再截图 | Phase 1 run3，session log 含 2 个持久化 image 块 |
| E2 | Playwright `browser_snapshot` 的 element-ref 模式即"结构优先"的成熟实现；三次 click（ref 寻址）零失误 | Phase 1 三次 run 的 click 调用 |
| E3 | 传 `filename` 参数会让 Playwright-MCP 存盘返回文本链接，静默绕过整条图像链路；模型偏好传该参数 | Phase 1 run1（模型第一次调用就传了） |
| E4 | `~/.dsh/settings.yaml` 的模型目录覆盖 adapter 默认，缺 `inputModalities` 时图像准入正确地拒绝截图 | Phase 1 run2（拿到精确诊断文本） |
| E5 | 主仓无桌面/输入 seam；E2B 包未含 `@e2b/desktop`，桌面路径需新增依赖且验证成本高（沙箱内拉起桌面） | repo-scan 调研 |
| E6 | 模型在"看不到图"时不会停，会创造性迂回（自己写像素分析脚本 + OCR），产出看似可信的分析 | Phase 1 run1 |
| E7 | 视觉坐标单步 grounding 61.8%，中位误差 60px；两步区域放大净负收益 | Phase 0 ScreenSpot-v2，200 样本 |
| E8 | 结构优先路径（ref 点击）的真实任务成功率从未测过；现有证据只有 demo 级 3/3 | Phase 0 测的是裸视觉，未测 ref 路径 |

## Q1 存在性：E1 证明零代码可闭环，为什么还要自建 capability seam？

**反方（最强质疑）**：Phase 1 已把浏览器 use 变成配置问题。自建 seam = 自己维护 provider、
approval、工具集、测试，违反 dsh 的"prefer maintained dependencies"原则；插件的价值若只是
"帮你配好了 Playwright-MCP"，一个 README 就能替代；E2B 若 MCP 化，桌面路径也能走 mcp-client。

**正方**：(a) 项目目的是 computer use（浏览器 + 桌面），MCP 生态只覆盖浏览器且质量不可控；
(b) E3/E6 显示裸 MCP 的工具面暴露了错误参数面（filename）且无结构化的 verify-retry 约束，
模型在能力缺口处会自由发挥跑偏；(c) snapshot 全量返回的 token 成本无法在 client 侧裁剪；
(d) approval/审计/风险分层在 MCP 协议层无处安放；(e) 分发形态要求单包安装即得完整能力。

**裁决：保留 seam，但砍掉它第一版的一半承诺。** seam 的存在性由 (a)(b)(d) 支撑——它管的是
策略与投影，不是重新实现浏览器驱动。E1 的正确读法不是"不需要 seam"，而是"seam 之下可以直接
复用 playwright-core，provider 层很薄"。

## Q2 provider 顺序：E2B Desktop 第一个，还是 Playwright 第一个？

**原决策**（handoff）：E2B Desktop 第一 provider，Playwright 其后。

**推翻**：首个 provider 改为 **Playwright（本地 Chrome，CDP 连接）**。依据：
- E5：E2B Desktop 需给 e2b 包加依赖、在沙箱内验证桌面拉起，反馈环长且贵；本地 Chrome 秒级启动。
- E2：结构优先的实现细节（snapshot 格式、ref 语义、auto-wait）直接从 Playwright 语义继承，第一 provider 用它等于站在成熟实现上定义 Service Definition 接口——接口不会被 E2B 的能力缺口倒逼变形。
- E1：图像链路已在本地 Chrome 上验证，第一 provider 换成 E2B 意着重验一遍。

E2B Desktop 降为第二 provider，其独特价值（云端隔离桌面、无本机依赖）在插件发布后的托管场景才兑现。
同一目的本日首次推翻，代价已付：被推翻的原判断与新证据均已记录。

## Q3 动作 schema：Anthropic per-action 坐标姿态 vs element-ref 姿态

**原决策**：参照 `computer_toolset_20260801`（per-action 独立 tool，不带屏幕尺寸声明）。

**裁决：保留 per-action 独立 tool 的外层姿态，内部参数双态分层。**
`computer_click` 接受 `element`（ref，description 标注首选）或 `x`+`y`（坐标，标注兜底）。
依据：E7 证明坐标不可靠（61.8%/60px），E2 证明 ref 可靠；E8 警告 ref 路径的成功率未实测，
所以坐标兜底不能删——但降级到 Phase 3 实现（先让 `element` 路径长出 verify-retry，再补坐标）。
screenshot 独立成 tool 且**不暴露 filename 类参数**（E3：参数面即陷阱面）。

## Q4 approval 粒度：每个动作都批？

**反方**：逐动作审批会把多步任务变成审批地狱，demo 根本跑不完。

**裁决：第一版 `approval: 'never'`（demo 模式全放行），seam 上预留 `'on-sensitive'`。**
sensitive 的判定第一版不做，仅留 config 位与事件点。依据：Codex 的分层权限（read-only/
interactive/full）是成熟先例，但 E8 说明当前连基线成功率都没有——先测能力，再管风险。
接口上 approval 检查点放在 tool Consumer 的 execute 前侧（dsh interaction seam），不放 provider。

## Q5 token/KV 成本：snapshot 全量返回会不会撑爆上下文？

snapshot 全量投影（Playwright 默认行为）在 IANA 级页面约数千 token/步。裸 MCP 无法裁剪。

**裁决：Phase 2 先全量（与 Playwright 行为对齐，先正确再优化）；diff 式 snapshot 投影
（只返回变更 + 按需全量）列为 seam 的核心增值，Phase 3 做并实测 token 曲线。**
截图保持显式工具触发（不逐步自动附图），KV prefix 失效只发生在模型主动看图的回合。

## Q6 E6 的含义：能力落差下模型会编造路线

run1 的教训要写进 tool description：当图像不可用时，工具应返回明确的诊断文本（dsh 已如此，
E4 的诊断文本质量很好），且 persona/consumer 描述要禁止"写代码分析截图"的迂回。
这是零成本的全赢项，Phase 2 的 tool Consumer 文案直接吸收。

## 修正后的 Phase 2 实施方案

```
packages/
  computer/             capability Service Definition：ComputerProvider 接口
                        （snapshot/navigate/click/type/scroll/key/screenshot）+ 事件声明
  computer-playwright/  第一 provider：playwright-core 连本地 Chrome（CDP 或 launch）
  tool-computer/        tool Consumer：computer_* 工具集，element-ref 首选，
                        approval 检查点，E6 教训写进 description
cordis.patch.yml        bundle patch（三包 insert）
```

**Tracer bullet（第一个端到端切片）**：`computer_snapshot` + `computer_click(element)` +
`computer_screenshot` 三个工具，在 Phase 1 同款任务上跑通，session log 出现 image 块。

**验收（不可绕过）**：10 个真实浏览器任务小实测（E8 补账），成功率与失败模式入 README。
全部跑在本地 composition（`--patch` 指向本地源，Phase 1 流程），包化（npm 发包）最后做。

**明确不做**（本阶段）：坐标兜底、diff snapshot、approval 判定逻辑、E2B Desktop、OSWorld。
