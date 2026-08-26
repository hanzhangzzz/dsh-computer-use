# 目的

给 DeepSeek Harness 加 computer use 能力，做成独立可安装插件（`dsh plugin add` 即用），
让 DeepSeek 模型驱动浏览器与桌面完成任务。

**终极判据：真实任务成功率，而非工具数量。**

# 约束

- 所有产物在本仓库；**只读 `deepseek-harness` 主仓，绝不写入**。
- GitHub 提交身份 huajuan404，远端 hanzhangzzz/dsh-computer-use。
- 主 session 高智能模型定方案；subagent 一律低档模型。
- 无人值守（do-something 循环等）只做代码/文档/测试。**模型任务必须人在场**，
  这是 2026-08-25 失控事件的产物。
- **log 级核验是汇报的前置条件。** 模型能伪装工具输出、也能靠自愈掩盖基础设施缺陷，
  两者都实际发生过。声称做完但没有 log 证据的，按未完成处理。

# 该读什么

| 要什么 | 去哪 |
|---|---|
| 做什么、怎么被验收 | [docs/HANDOFF.md](docs/HANDOFF.md) |
| 某个数字哪来的、某条为什么不能改 | [docs/EVIDENCE.md](docs/EVIDENCE.md) |
| 仓库布局与代码里看不出的不变量 | `AGENTS.md` |
| 某次改动的来龙去脉 | `git log`——提交说明里写了改什么、为什么、验证了什么 |

# 日志

此前 30 条循环日志已删除：它们记录的工作全部已经落到代码里，其中的实测结论已抽进
`docs/EVIDENCE.md`，过程本身 `git log` 里有更准确的版本。留着只会让人以为要读。

新循环从这里往下写。写结论和它改变了什么，不写流水账。
