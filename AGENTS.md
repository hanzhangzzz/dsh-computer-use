# AGENTS.md

dsh-computer-use：DeepSeek Harness 的 computer use 插件。单发布包 `dsh-tool-computer`
（npm），源码三角色目录。GitHub: hanzhangzzz/dsh-computer-use；npm 发布账号 hanzhangz，
提交身份 huajuan404。

## 布局与角色

- `packages/computer/` — Service Definition（`ctx.computer` seam）。发布形态已并入单包，源码保留分层。
- `packages/computer-playwright/` — provider：launch 本地 Chrome 或 `cdpEndpoint` attach Electron 应用。
- `packages/tool-computer/` — Consumer：`computer_*` 工具 + bundle manifest（`cordis.patch.yml` 单 entry）。
  它的 `apply` 组装式挂载另两个角色（service + provider），**这是唯一发布入口**。
- `experiments/` — 验收套件（`phase2-acceptance/run.py`，可移植）、tracer/wechat overlay、断连验证脚本。
- `docs/` — 设计评审、Phase 3 触发制路线图（新功能必须先看触发条件）。
- `DO.md` — 循环工作日志与事件复盘（含 2026-08-25 安全事件，必读）。

## 关键约定（代码里看不出来的）

- 插件内部读取 seam 一律走 `ctx.get('computer')`（seam() helper），不用属性代理——postmortem 0001。
- attach 模式的断连是终态：所有调用报 report-and-wait 指引，绝不自动重启宿主（安全事件产物）。
- 跨"包"导入用相对路径（`../computer/src/index.ts`）——发布是单包，无跨包名解析。
- 测试：`pnpm run test`（13 个，含真实 Chrome 的 provider 测试与 detach 围栏回归）。

## 常用命令

```sh
pnpm run typecheck && pnpm run test && pnpm run build   # 改动后的最小验证
pnpm --filter dsh-tool-computer publish --access public --no-git-checks  # 发布（版本号先改）
# 本地 profile 升级：cd ~/.dsh/profiles/web && pnpm add dsh-tool-computer@<ver>
# headless 装载插件用绝对路径 entry（见 experiments/*/cordis.patch.yml）
```

## 无人值守纪律

DO.md 2026-08-25 事件后：无人值守（do-something 循环等）只做代码/文档/测试；
模型任务（验收、演示、验证脚本）必须人在场。log 级核验是模型任务汇报的前置。
