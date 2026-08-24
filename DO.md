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
