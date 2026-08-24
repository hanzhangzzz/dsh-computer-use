# 目的

给 DeepSeek Harness 加 computer use 能力，做成独立可安装插件（dsh plugin add 即用），
让 DeepSeek 模型驱动浏览器与桌面完成任务。终极判据：真实任务成功率，而非工具数量。

# 约束

- 所有产物在 dsh-computer-use 仓库；绝不改 deepseek-harness 主仓（读可以，写禁止）。
- GitHub 提交身份 huajuan404；远端归属未定（hanzhangzzz / huajuan404），push 前必须先问用户。
- 主 session 高智能模型定方案；subagent 一律低档模型。
- Phase 2 动工前过对抗式设计审查（本 do/main 分支上的 review 文档即该审查的产出，人类可否决）。

# 日志

- 2026-08-24 15:20（do-something #1）：完成 Phase 2 对抗式设计评审，见
  docs/phase2-design-review.md。核心裁决：保留 computer capability seam，但首个 provider
  从 E2B Desktop 改为 Playwright/CDP（推翻 handoff 决策，依据 = Phase 1 的 E1/E2/E5 三条实测
  证据）；approval 第一版 `never` 只留 seam；element-ref 与坐标双姿态分层暴露，坐标兜底降级到
  Phase 3。产出已 commit 于本分支，等人类收割或否决。验证：文档内每条裁决都引用了 Phase 0/1
  的实测证据编号，无凭空断言。下一步（若续做）：按评审的 tracer-bullet 切片起 packages/ 骨架。
- 2026-08-24 16:50（do-something #2）：tracer bullet 前半段完成——三包骨架（dsh-computer
  Service Definition / dsh-computer-playwright provider / dsh-tool-computer Consumer）全部
  typecheck 通过（对齐主仓 cordis+dsh-tools+dsh-llm+dsh-attachment 真实类型，link: 到主仓零
  复制）；真实 Chrome 组合测试全绿（vitest 挂 Cordis Context，navigate→snapshot→click by
  index→screenshot 5.75s，example.com 唯一链接被 ref 命中跳转 iana.org，PNG 1280x800）。
  验证命令：pnpm run typecheck && pnpm run test。遗留：①tool-computer 的 Consumer 组合测试
  （需挂主仓 tools/systemPrompt/attachments service）未写；②插件装载进 dsh 跑模型闭环未做
  （需解决未构建 workspace 包在 dsh Loader 里的解析，候选路径：dsh plugin add file: 装进
  $DSH_HOME/profiles 或 tsx alias）；③playwright-core 1.62.1 与主仓 Playwright-MCP 用的
  1.61.1 并存（无冲突但可对齐）。
