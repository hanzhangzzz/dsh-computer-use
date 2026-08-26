# 目的

给 DeepSeek Harness 加 computer use 能力，做成独立可安装插件（`dsh plugin add` 即用），
让 DeepSeek 模型驱动浏览器与桌面完成任务。

**终极判据：真实任务成功率，而非工具数量。**

# 约束

## 怎么工作

- **允许直改当前分支**（不新建 `do/` 分支）。理由：无人值守连续多轮，每轮各起一条从 master
  切出的分支，第二轮就看不见第一轮的成果，会重复劳动甚至互相冲突。逐轮 commit，不 push。
- **任务清单在 [docs/HANDOFF.md](docs/HANDOFF.md)**，按它的依赖关系挑一件。别自己发明任务，
  也别挑最容易的——挑当前能做且杠杆最高的。
- **数字依据在 [docs/EVIDENCE.md](docs/EVIDENCE.md)**。要引用某个结论先去那里核对，
  别凭记忆。你要是测出与它矛盾的数据，**以新数据为准并更新它**，同时在日志写清楚推翻了哪条。
- 每轮只做**一件**完整的事。预估这半小时做不完就换小一号的。宁可做完一个小的，
  不要留半个大的。

## 无人值守的硬边界（2026-08-25 失控事件产物，不可协商）

- **禁止任何模型级任务**：不跑 `dsh` 带模型的任务、不做 T8、不做任何需要 agent 实际操作
  应用的验证。这类必须人在场。
- **禁止运行会移动真实光标或抢焦点的脚本**：`experiments/input-injection/probe.swift`、
  `experiments/skylight-injection/probe.swift` 都会。**T6（自由拖拽攻坚）因此不可无人值守做**，
  跳过它。
- **禁止操作用户的真实应用**：微信、飞书、Chrome、终端、编辑器一律不碰。
  需要目标应用时只用 Calculator（用完 quit）。
- 禁止 push、禁止改写历史、禁止碰 `deepseek-harness` 主仓（只读）。

**可以跑的**：`pnpm run typecheck / test / build`、`experiments/desktop-acceptance/run.py`、
`experiments/enumeration-coverage/*.mjs`、`experiments/pixel-budget/budget.py`、
`experiments/screenspot-grounding/miss_anatomy.py`。

## 提交前必须过的门

1. `pnpm run typecheck && pnpm run test && pnpm run build` 三道全绿。
2. 动了桌面侧就跑 `python3 experiments/desktop-acceptance/run.py`，要 9/9。
3. 新写的判据**必须能失败**。`len(x) > 0` 这类恒真式、或者比对动作前后不会变的量
   （窗口标题就是），都不算数。这个坑本仓库踩过两次。
4. `git add` 只加本轮实际改动的文件，逐个按路径加。**禁止 `git add -A` / `git add .`**。
5. 提交说明写：改了什么、为什么、**验证命令与结果**。没有验证证据的按未完成处理。

## 已知会咬人的地方

- **批量改代码后必须 grep 确认命中数**。python 的 `str.replace` 静默不匹配，
  会造成"改了个寂寞但 typecheck 用旧代码通过"的假完成——本仓库踩过三次。
- **模型会伪装工具输出、也会靠自愈掩盖基础设施缺陷**，两者都实际发生过。
  所以任何涉及模型的结论都要 log 级核验——而这正是无人值守不做模型任务的原因。
- 三道门里 `test` 会起真实 Chrome，`desktop-acceptance` 会起 Calculator。这是正常的。

# 该读什么

| 要什么 | 去哪 |
|---|---|
| 做什么、怎么被验收 | [docs/HANDOFF.md](docs/HANDOFF.md) |
| 某个数字哪来的、某条为什么不能改 | [docs/EVIDENCE.md](docs/EVIDENCE.md) |
| 仓库布局与代码里看不出的不变量 | `AGENTS.md` |
| 某次改动的来龙去脉 | `git log` |

# 日志

写结论和它改变了什么，不写流水账。一轮一行，格式：

`- <日期时间> <做完的任务编号与名字>：<改变了什么> | 验证：<命令与结果> | 遗留：<下一轮该接哪里>`

此前 30 条循环日志已删除：记录的工作全部已落进代码，实测结论已抽进 `docs/EVIDENCE.md`，
过程本身 `git log` 里有更准确的版本。

- 2026-08-26 09:35 T3（provider 动作面）第一片：**模型此前能操作桌面应用却读不到它显示什么**——helper 早已返回窗口文本，但 seam 没有字段承载、工具层没有投影。现已贯通到渲染层（`showing: ...` 行）。同函数第二个缺陷：未变折叠只按控件指纹，导致「动作刚产生结果」的那一刻被报成「无变化」（连按两次 7，控件逐字节相同而显示 7→77，实测复现）；文本已纳入指纹。附带解掉一处测试耦合：新单测把计算器留在 77，算术用例于是算出 4662——一次真实的 8/9，重跑三次会被当成抖动放过。| 验证：typecheck + 28 单测 + build + 桌面验收连跑三次 9/9，再故意弄脏计算器后仍 9/9 | 遗留：T3 还剩 action/window 未透出到 provider，pressKey 待用 CGEvent.postToPid 实现，screenshot 等 T2
