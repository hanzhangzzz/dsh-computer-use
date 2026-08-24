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
- 2026-08-24 20:45（do-something #3）：tracer bullet 终点达成——插件装载进 dsh、模型闭环
  跑通。关键发现：①loader 的 baseUrl 是 $DSH_HOME/profiles/<name> 而非进程 cwd，相对路径
  name 会解析错位，本机 overlay 用绝对路径（experiments/phase2-tracer/cordis.patch.yml）；
  ②tsc 无法 emit `.ts` 后缀导入的 js，构建链改用 tsdown（与 dsh-diagram 同款）；③补了缺失的
  computer_navigate 工具。验证：log 里 computer_navigate→computer_snapshot→computer_click
  {index:0}→computer_screenshot 顺序调用 + 1 个持久化 image 块，模型输出含纯视觉事实（teal
  IANA logo）。pnpm run typecheck/test 全绿。遗留：Consumer 组合测试、10 任务验收（E8）、
  snapshot token 成本实测、包化发布（届时 patch 改回包名）。
- 2026-08-24 23:50（do-something #4）：E8 验收完成——10 任务全过（experiments/
  phase2-acceptance/，median ~16s/任务，全部 click 走 snapshot 索引零坐标，含 multi-hop 和
  403 落点的诚实报告）。重大过程教训：判分脚本两个 bug（json.dumps 带空格导致 tool-call
  匹配永不命中；session log 是多帧 zstd，oneshot 解压只出第一帧）一度制造"模型不调工具纯编造"
  的假象，险些把错误结论写进 README——靠手动反查 log 推翻。已在 run.py 修复（结构化遍历 +
  stream_reader read_across_frames + 判分大小写不敏感）。教训入 README：log 推导的结论需要
  与模型声明同级的对抗式核查。遗留：重页面 snapshot token 成本实测、npm 包化、以及"先验可
  知页面的捷径行为"仅被 prompt 弱缓解（本轮硬约束重跑时统计 bug 未修，缓解效果实际未测，
  但干净数据下 10/10 未出现捷径行为——风险存疑但未证伪，生产前需重审）。
- 2026-08-25 01:10（do-something #5）：snapshot token 成本实测完成（数据来自验收 run 的
  session log，零新跑）：example 14 tok / HN 1.5k / go.dev 1.9k / Wikipedia Main Page
  833 元素 5.2k tok；观测到同页重复 snapshot 全额重复成本（3×5.2k）。结论入 README：单次
  可接受，重页面重复 snapshot 是 Phase 3 diff 投影的实证依据（unchanged-since-N + 大列表
  分页截断）。#3 捷径风险降级：干净数据未观测到（此前"编造"读数是判分 bug），仅复发时重审。
  遗留：npm 包化（本地部分可做，发布动作留给人类）；Phase 3 方向已有两条实证依据（E7 坐标
  兜底 + 本轮 diff 投影）。
- 2026-08-25 02:20（do-something #6）：npm 包化本地部分完成——三包（dsh-computer /
  dsh-computer-playwright / dsh-tool-computer，npm 名全空闲）补齐 LICENSE/author/files，
  tool-computer 携带 bundle manifest（dsh.bundle.patch → cordis.patch.yml，包名 entry，
  显式 headless+1280x800），pnpm -r pack --dry-run 验证三 tarball 内容正确（lib+LICENSE+
  README+patch）。发现：npm 上 dsh-computer-use 名被无关第三方 jerryweizhihao 占用（也是
  dsh computer use 插件，屏幕坐标姿态）——竞品信号入 README。发布留人类：选 npm 账号与
  GitHub 远端、补 repository 字段、pnpm -r publish。Phase 2 本地工作全部收口。
- 2026-08-25 03:30（do-something #7）：Phase 3 第一片落地——unchanged-since-N 快照去重。
  provider 对每次全量 snapshot 记指纹（URL + 元素 role/name 列表），同页重复 snapshot 返回
  `unchanged since snapshot #N` + 空 elements + 索引仍有效语义；schema/render/execute 全链
  更新。验证三层：typecheck+build 0 错；真实浏览器测试断言 unchangedSince=2/elements=[]
  （6.75s 过）；模型级（snapshot-index-stability 验收任务重跑 passed，模型正确引用标记回答
  索引一致性）。仍开放：部分变化页的元素级 diff、超大列表分页截断。
- 2026-08-25 04:40（do-something #8）：Phase 3 第二片——click 附带 post-click 快照。
  click 返回扩展 after 字段（domcontentloaded + 300ms settle 后的元素列表，unchanged 语义
  复用），click 循环省一次 snapshot 往返。排障记录：首版 300ms 不够 IANA 渲染（elements=0，
  模型级任务靠模型自补 snapshot 兜住），加 waitForLoadState('domcontentloaded', 3s) 修复；
  测试 seq 断言两次改错（先 3 后 2），根因是自己没先推演完整 seq 流——写断言前先走一遍
  计数路径。验证：单测全绿（click.after 含 iana 元素 + unchangedSince=2 折叠）；模型级
  multi-hop 16.9s pass，两次 click 的 result 均携带完整 post-click 列表，第二次 click 直接
  用第一次附带列表的 About Us。开放：部分变化页元素级 diff、超大列表分页。
