# 能力边界评估：dsh-computer-use 用 DeepSeek 视觉模型能做到什么程度

日期：2026-08-26。产出方式：16 个 subagent 的并发调研（扫描开源/闭源实现 → 三视角裁决 →
对抗式证伪 → 合成），叠加主 session 的本机实测与独立复核。

## 主 session 的独立复核记录

本文正文由调研工作流合成。以下是主 session **自己动手验证过**的部分，以及本轮被推翻的说法
（含我自己犯的错），供判断可信度：

**独立复核通过（我自己跑过或读过源码确认）**

- **坐标协议错配**：`bench.py:54` 要求模型输出 0–1000 归一化坐标，而出厂工具
  `tool-computer/src/index.ts:184` 收的是绝对视口 CSS 像素。**61.8% 没有测过生产坐标路径**。
- **`httpbin-elements` 假通过**：`passed=true`，判据 `text_any:["1"]` 命中的是模型回答里
  编号列表的 "1."，而非实质答案。判分不成立（模型答的 "0" 是否正确另说）。
- **枚举遍历盲区**：构造含 1 个 light DOM 按钮、2 个 open shadow root 按钮、2 个 iframe 按钮的
  页面，provider 原语只枚举到 **1/5**。playwright 的 locator 本身能穿 shadow、`page.frames()`
  能进 iframe，是 provider 没用。
- **命名质量**：独立复算 4 站 1181 元素——重名 **32.1%**（github 47.7%），无名 6.3% 且
  **97% 可从 title/alt/svg title/aria-labelledby/href 救回**。脚本：`experiments/enumeration-coverage/naming.mjs`。
- **失败形态**：73 次 grounding 失败里 **63% 是近失**（偏离 < 目标自身半对角线），仅 16% 找错区域。
  脚本：`experiments/screenspot-grounding/miss_anatomy.py`。
- **任务步数**：15 个验收任务步数中位 3、均值 4.7、最长 17（hn-two-stories，222.9s）。
- **像素预算公式**：`scale = min(1, sqrt(640000/(w·h)))`，源码位置
  `attachment-local/src/request-image.ts:51`。4K 全屏 scale 0.278。

**本轮被推翻的说法（含主 session 自己的错误）**

- ~~"结构枚举覆盖率漏洞 ≈ 0"~~ —— **我自己的实验结论，已撤回**。第一版 `measure.mjs` 用
  `document.querySelectorAll('*')` 做候选宇宙，而这正是被测代码的盲区（不进 shadow root、
  不跨 iframe），它在结构上不可能发现这类漏枚举。修正后的真实数字是 **1.7%**（全部来自
  shadow DOM），但这 6 个站点恰好没有子 frame，**iframe 是整片不可见，属于类别性缺口而非百分比**。
- ~~"歧义包装元素吞掉 19.8% 的可点子元素"~~ —— **我自己的中间结论，已杀掉**。`cursor` 是继承
  属性，被"吞掉"的全是按钮内部的 `svg`/`path`/`kbd` 装饰节点，不是独立目标。
- ~~"640k 像素预算解释了桌面平台得分低"~~ —— **我自己的因果解释，被数据推翻**。Windows 样本
  960×540、scale 1.000、完全没降采样，却得分最低（52.0%）；shop 与 tool 分辨率缩放完全相同
  却差 31 个百分点。**绑定因素是 UI 密度与目标尺寸，不是分辨率**。像素预算是另一条未被
  Phase 0 样本触及的独立风险。

---

# dsh-computer-use 能力边界评估

> 口径声明：全文对每条结论标注证据等级——**【实测】**= 本仓库跑出来的数据或本次对抗探针在真机复现；**【公开】**= 他人论文/排行榜数字，仅作对照，不可与实测混算；**【推测】**= 无测量支撑的外推，给出区间只为排优先级，不作为能力承诺。
> 版本口径：坐标兜底是 0.4.0 才落地的，Phase 2 那 15 个验收任务跑在它之前。任何"视觉参与度"的说法必须带版本。

---

## 一、结论

**dsh-computer-use 今天真正被证明的能力只有一格：浏览器内、以语义 HTML 元素为目标的 1-3 跳任务 + 简单表单，在 6 个静态站点上 15/15 通过，中位 16.6s（长链中位 41.5s、最长 222.9s）。**【实测】这一格的 95% 单侧下界是 81.9%，但样本自选、约一半判据无区分力（详见第五节），所以诚实表述是"**在这类任务上未观测到结构路径失败**"，而不是"成功率 >80%"。

往外每走一步，证据强度断崖式下跌：

| 任务类别 | 估计 | 证据等级 | 绑定约束 |
|---|---|---|---|
| 语义 HTML 的 MPA（文档/资讯/代码托管），1-3 跳 | 85-95% | 【实测】15/15 + 【推测】区间 | 环境韧性（bot 墙、超时） |
| 同类 4-10 跳 | 70-85% | 【推测】 | 每步复利 + 无验证层 |
| 主流 SPA（React/Vue，语义 HTML 为主） | 55-75% | 【推测，零样本】 | 后置快照硬编码 300ms 早读 + 索引在 click 时按位置重取 |
| 含 iframe / shadow DOM 的页面 | 10-30%（只读子集） | 【实测：机制】+【推测：区间】 | 枚举完全失明；且 `computer_type` 无坐标形态 → iframe 内输入是**能力缺口不是精度问题** |
| 需滚动读取的长页 / 密集列表 / 电商 | 25-45% | 【推测】 | 无 `scroll` 工具；实测视口内元素占比低至 12%（react.dev 14/116）、25%（MDN）、39%（wikipedia） |
| canvas 自绘（Figma / 地图 / 图表 / 游戏） | 0-10%，建议不接 | 结构性事实 | DOM 里只有一个 `<canvas>`；且缺 drag / hover / 右键 / scroll |
| Electron CDP attach（微信开发者工具类） | 不给区间 | 【实测：0 个完整多步任务成功】 | 两次真机任务均未完成；唯一正面证据是坐标兜底一次命中 (28,143) |
| 原生桌面（AX） | **今天 0%**，provider 未建 | 事实 | 建成后：AX 语义完整的应用 60-80%、自绘应用（微信）5-15%【推测】 |
| 任意类别 ≥10 步长链 | ≤35% | 【推测】+【公开】对照 OSWorld 2.0 SOTA 20.6% | 无验证层、无重试预算、无审批 |

一句话概括绑定约束：**不是 grounding 精度，而是（1）元素根本不在枚举里，（2）索引在 snapshot→click 之间失效，（3）没有验证层因此错误不可观测。** 三者都在代码里可定位、大部分可修。

---

## 二、61.8% 到底意味着什么

**结论：它现在既不是致命短板，也不是无关紧要——它是一个口径上不能直接使用的数字。**分三层说。

### 2.1 口径层：这个数不能按现在的样子引用

三处必须修正，都是【实测】级的核对结果：

1. **分母**。`summary-20260824-101238.json`: n=200 / completed=191 / hits=118。61.8% 是 118/191，扔掉了 9 个未完成样本。在任务链里"没返回可用坐标"等价于失败，端到端口径应为 **59.0%（118/200）**。两步实验同理：53.5% 是 93/174，全样本口径 **46.5%**。61.8% vs 53.5% 是两个不同分母（191 与 174）在对比。
2. **协议错配（最严重的一条）**。`bench.py` 的 PROMPT 把坐标协议硬编码成 0-1000 归一化，再由 `norm_to_pixels` 反算；而出厂工具 `packages/tool-computer/src/index.ts` 收的是**绝对视口 CSS 像素**。归一化输出对缩放天然不变，所以 640k 降采样在这个基准里数学上是中性的，在生产路径上则不是。**结论：61.8%（或 59.0%）不代表出厂坐标兜底路径的精度。** 生产坐标路径的精度目前是**零实测**。而 `bench.py` 没有绝对像素模式，PROMPT 是单条硬编码字符串——"先跑一下"这个动作目前不存在，得先写。
3. **误差单位**。`median_err_px` 是原图像素，而图宽从 windows 的 960 跨到 shop/tool 的 2560。换成尺度无关的 `err_norm`，排序反转：**windows 0.0524 最差、ios 0.0504 次差、shop 0.0411 中游、tool 0.0181 最好**。"密集电商页误差 97px 最大"是图更大造成的假象；成立的只有"shop 命中率最低 48.7%"。同理，分平台 n 只有 15-40（95% CI 约 ±20pp），"桌面明显差于移动端"应降级为"在这 200 样本上呈此趋势，需扩样确认"。

### 2.2 流量层：它的重要性随目标平台单调上升，不是全局常数

- **浏览器 + 语义 HTML**：视觉承载流量很低。15 个验收任务全部走 snapshot 索引，坐标兜底被调用 0 次【实测】。但**不是零**——`example-screenshot-visual` 本身就是纯视觉判读任务。
- **Electron / 自绘 UI**：视觉已经是**唯一通路**。DO.md 2026-08-26 10:40 实测：微信开发者工具左侧分类导航截图可见而 snapshot 不可达（React 合成事件 div 无语义标记），模型被迫瞎点未命名元素、**误中窗口关闭按钮**；12:00 记录坐标兜底落地后真机走通截图定位。在第一个非玩具目标上，grounding 精度就是那一步的直接决定变量。
- 所以"grounding 无关紧要"这个说法只在已验证的浏览器切片上成立，**且该切片已经过期**。

### 2.3 代价层：真正危险的不是 61.8%，是误差代价不对称

浏览器里点错一个链接可以退回来；桌面上点错可能是关窗口、删文件、发消息。微信那次误点窗口关闭按钮就是现场。**所以坐标兜底路径需要的不是更高精度，是提交前确认。**

### 2.4 它比看起来更可救

`miss_anatomy.py`【实测】：73 个 miss 里 46 个（63%）落在目标框半对角线内，只有 12 个（16%）是找错区域。这意味着大部分失败是"近失"而非"理解错"。本插件手里有 snapshot 的元素几何——**把预测点吸附到最近的已枚举元素矩形**是零模型开销的改进，可能吃掉大部分误差。注意 `miss_anatomy.py` 自己写明的限制：ScreenSpot 只给目标框，无法证明最近元素就是正确元素，这条必须在真实页面上补测。

**给用户的一句话回答**：61.8% 是"裸单步、归一化协议、点直接判 in-bbox"的下界口径。对当前已交付的浏览器主路径，它是边缘变量；对项目下一站（Electron / 桌面 / canvas），它是绑定约束——但在投钱提升它之前，先把口径修对（绝对像素模式重测）、把便宜的结构侧改进做完（吸附、命名、枚举穿透），因为这些都不需要视觉。

---

## 三、两步 refine（61.8% → 53.5%）的正确解读

原始结论"裁剪放大是净负收益、主因是丢失全局上下文"**方向对，但归因未被证实**：

- 【实测】两步 26 个失败里有 **17 个是 `parse_failure_step1`**——那一步的请求与单步模式完全相同，属于模型空回复的跑次噪音，不能记在两步法头上。`bench.py` 的 `max_tokens=2000` 注释写明 thinking token 计入该预算，parse failure 极可能是难样本上的思考截断。
- 【实测】配对复算（两模式都完成的 168 样本）：single-only-hit 42、twostep-only-hit 27、both 63、neither 36。配对口径是 62.5% vs 53.6%，**McNemar p≈0.09，5% 水平上不显著**。说"方向为负"可以，当成坐实结论不行。
- 【实测】"windows 未降采样却受益"这个反例不成立，是分母漂移：配对的 21 个样本上两步救回 2 打断 3，净 −1（p=1.0）。
- 【实测】排除了一个替代解释：42 个被打断的样本里只有 3 个目标框完全在裁剪外——**不是把目标裁掉了**。
- 剩下的数据形状更像"**分辨率是绑定约束时裁剪才有用**"：净正的是 android(+2)、ios(+2)，恰是降采样最重的两个平台（2.59M / 2.96M px）；windows 960×540 已在 640k 预算内、裁剪无分辨率增益，略负。

**所以"单请求同时给全图+裁剪图"这条改进值得试（1M 上下文 + 600 图配置让它零成本），但它目前是【推测】**，重跑必须：同 seed 配对、空回复自动重试后再入统计、按配对子集报 McNemar、把 windows 显式设为对照组。

---

## 四、代码层已定位的缺陷（本次对抗探针全部在真机复现）

用 `packages/computer-playwright/src/index.ts` 的 `INTERACTIVE_SELECTOR` 原文和 `interactiveHandles / describeElement / click` 顺序写的独立探针，在本机真实 Chrome 一次跑通：

| # | 缺陷 | 探针输出 | 性质 | 披露状态 |
|---|---|---|---|---|
| 1 | 不穿 open shadow root | `MISSING SHADOW-BUTTON` | 确定性 | 全仓 grep 零披露 |
| 2 | 不遍历 `page.frames()` | `MISSING IN-IFRAME-BUTTON` | 确定性 | 全仓 grep 零披露 |
| 3 | 无 CSS 可见性过滤（只过滤 `aria-hidden`） | `FOUND HIDDEN-LINK` / `FOUND COLLAPSED-LINK`，click 卡满 5006ms 抛错 | 确定性；docstring "Hidden regions are skipped" 与代码不符 | 零披露 |
| 4 | React 合成事件 div 不可枚举 | `MISSING REACT-DIV-BUTTON` | 确定性 | **已披露已缓解**（roadmap #4 Triggered，坐标兜底已 ship） |
| 5 | click 时按**位置**重取 handle，校验在动作之后 | 800ms 后 prepend 横幅 → `click(0)` 实际命中 `link "COOKIE-BANNER"` | 确定性机制 | 零披露 |
| 6 | 后置快照硬编码 300ms | 真页面 SPA 路由：settle 仅 503ms，模型收到 `["button GO"]`，1.1s 后真实是 `["button GO","a DETAIL-ACTION"]` | 确定性 | roadmap 自列为证伪条件 |

关于 #5 的准确表述：**不是"完全静默"**——`click` 返回体里的 `clicked: 'role "name"'` 会交给模型，事后可见。缺陷是**校验发生在动作之后，错点已经打出去了**。在浏览器里可回退，在桌面上不可回退。而且它的暴露窗口不小：15 个任务的 `elapsed_s ÷ tool_calls` 中位数是 **6.1 秒**【实测】，长链任务 13.1s / 13.3s——不是想当然的 1-2 秒。

关于 #6：这条**不需要频率测量**。同文档 SPA 路由跳转里 `waitForLoadState('domcontentloaded')` 立即 resolve，留给重渲染的预算就是硬编码 300ms，"渲染 >300ms 的 SPA 全中"。

另一条设计分歧（不是 bug）：`navigate` 在 `!response.ok()` 时抛错。实测 github 404 页 `status=404 / title="Page not found"`、页面已完整加载且有 152 个可交互元素，工具却报失败——工具报错但浏览器状态已变，产生状态失同步。403/429/401 是同机制推断，未实测。README 把"hostile-403 landing reported honestly"当预期行为，所以这条需要先决定语义再改。

---

## 五、验收数据里必须修的地方

1. **一个确凿假通过**【实测】：`httpbin-elements` 判据是 `text_any:["1"]`，模型 output 白纸黑字写"可交互元素总数为 **0**"，靠回答里的编号"1. **页面加载**"命中子串，`passed=true`。
2. **约一半判据无区分力**（不是"主要靠弱判据"，这点要校准）：`url_contains` 实现为"匹配模型自然语言输出"的或分支，而 `iana-back-link` 的判据 `"iana.org"` 就在 prompt 里，复述一次即通过；`hn-first-story(["报道","文章","http"])`、`snapshot-index-stability(["0"])` 同理。另一半（`go-docs` "go.dev/doc/tutorial"、`multi-hop` "iana.org/about"、`wikipedia-contents` "Wikipedia:Contents"）要求具体落点 URL，不走到那步写不出来——**这部分是有效的**。
3. **README 的"零失误"被自家 log 推翻**【实测，log 级】：解 `~/.dsh/sessions` 的 zstd session log，至少 5 个独立 session 里模型 reasoning 明写 `The previous click failed because the element "is not visible"` / `resolved to <a href="/wiki/Wikipedia:Contents"> but is not visible because the sidebar is...`。这正是缺陷 #3 的现场，被模型自愈掩盖，`summary.json` 只记 `passed:true`。
4. **`hn-two-stories` 是半失败计成功**：8 次 navigate / 222.9s，模型自述 x.com 拒绝 headless 渲染、第二条标题绕道取得，判据是 prompt 原词。
5. **覆盖率实验是自我预言**【实测复现】：`measure.mjs` 的 pointer 基线是 `document.querySelectorAll('*')`，与被测的 provider 共享同一盲区。我构造含 light DOM 按钮 + open shadow root(2 可点) + iframe(2 可点) 的页面，provider 原语只枚举到 1/5，而该脚本对同一页面报 `missRate=0`。**`totalNew=0 / missRate=0` 在结构上不可能发现 shadow/iframe 漏枚举**，因此它不能被引用为"结构路径覆盖率≈100%"。它能支撑的最强说法是：*在 6 个语义化静态页、用 cursor:pointer 单一启发式、不穿 shadow DOM/iframe 的口径下未发现漏检*。
6. **结构步 0.98 本身也偏乐观**：那 40+ 零失误动作来自同 15 个任务脚本在同 6 站的多次重跑，独立试验数远小于 40；按 rule of three，n≈25 时 0 失败的 95% 下界只有 0.89。而 0.98^10=0.82 与 0.89^10=0.31 是两个世界。

---

## 六、优先级建议

### P0 — 先修测量口径（不修的话后面所有数字都在测混淆变量）

| # | 动作 | 预期收益 | 成本 |
|---|---|---|---|
| 0.1 | 给 `bench.py` 加**绝对像素模式**（当前不存在，PROMPT 是硬编码归一化字符串），在 1280×800 档同 200 样本对跑 | 拿到出厂坐标兜底路径的**真实**精度。这是所有"视觉能救几成"判断的地基 | 1 天 |
| 0.2 | 修验收判据：`url_contains` 只认实际落点 / `page.url()`，`text_any` 禁用 prompt 原词与裸数字；重跑 15 任务并核对 `httpbin-elements` | 把 10/10 变成可信数字 | 半天 + 15 分钟机时 |
| 0.3 | 对外统一口径：单步 **59.0%（118/200）**、两步 **46.5%（93/200）**、误差用 `err_norm`；三个分母（191/174/168）各自标注 | 消除系统性乐观偏差与假的平台排序 | 0 |

### P0 — 便宜且防不可逆错误的代码改动

| # | 动作 | 预期收益 | 成本 |
|---|---|---|---|
| 0.4 | **click/type 索引身份校验**：snapshot 时记 role+name，动作前比对，不一致抛错要求重新 snapshot（而不是点完再回报） | 消除"错误动作已执行"这一整类。桌面上不可回滚，微信误点窗口关闭按钮已是现场 | 半天 |
| 0.5 | `interactiveHandles` 加 `el.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})`，并改正 docstring | 消除 5s 超时假阳性（wikipedia-contents 多花 10s + 2 次 click 的根因） | 1 小时 |
| 0.6 | `describeElement` 补全 name 链：`title` / `aria-labelledby` 解引用 / 子 `img[alt]` / svg title / 关联 `<label>` / href 尾段，最后才 textContent | 【实测】4 站 962 元素中 58 个（6.0%）无名，其中 **58/58 可救**。收益不依赖模型 | 极小 |
| 0.7 | 快照**重名限定**：同名元素追加判别式后缀（最近 heading/section 祖先、行序号、href 尾段） | 【实测】357/962（37.1%）名字与其他元素完全重复（github 47.7%）。这是密集页任务的主约束，且不需要截图 | 小-中 |

### P1 — 打开新类别

| # | 动作 | 预期收益 | 成本 |
|---|---|---|---|
| 1.1 | 枚举穿透 **open shadow root** + 遍历 **`page.frames()`**，索引空间扩成 frame-aware；click/type/press_key 三入口同改 | 打开两大类应用。iframe 尤其关键：`computer_type` 无坐标形态，iframe 内输入现在是**能力缺口** | 3-5 天 |
| 1.2 | post-action settle 由固定 300ms 改 **DOM 静默检测**（MutationObserver 静默 N ms，上限 2-3s）；或至少把"这份 after 可能不完整"暴露给模型 | 消除 SPA 后置快照确定性早读，同时缩小索引漂移窗口 | 1-2 天 |
| 1.3 | 补 `computer_scroll` + fullPage 截图选项，snapshot 输出带滚动位置 | 打开需读折叠内容的类别。实测视口内元素占比低至 12% | 1-2 天 |
| 1.4 | 坐标兜底加**几何吸附**（预测点吸附到最近已枚举元素 rect）+ **提交前单轮 marker 确认**（把拟点击点画回截图让模型确认/修正一次） | 吸附是零模型开销，63% 的 miss 是近失；提交前确认针对不可逆代价（事后 verify 救不回关窗口）。结构主路径不付任何代价 | 吸附小；确认中（多一轮 2-4s，对 16s 中位可接受） |
| 1.5 | 640k 预算层的坐标空间对齐：截图后显式缩到预算内并以缩放后尺寸为坐标系，或给 screenshot 加 `region/clip` 参数 | DPR 层已由 `scale:'css'` 修好，**640k 层未修**：默认 1280×800=1.02M px，模型实际看 1012×632 却被告知 1280×800。budget.py【实测】4K 全屏 scale 0.278（20px 按钮→5.6px）、MacBook 内屏 0.328、Electron 窗口 0.589 | 小 |
| 1.6 | 评审 DO.md 已挂起的 **snapshot 附 bounding box** 方案（Playwright-MCP `--snapshot-boxes` 先例） | 把"哪一个同名元素"这个视觉问题直接转成结构问题，成本远低于外挂模型或全局 SoM | 评审 0，实现小 |

### P1 — 把外推变实测（这些实验的价值高于再多写 MPA 任务）

| # | 实验 | 回答什么 |
|---|---|---|
| 1.7 | **换外部 ground truth 重测枚举覆盖**：对目标页截图，由人/模型标注"用户能点的目标"，与 snapshot 枚举的 rect 求差集。样本扩到 SPA、web-component 站、含支付 iframe 的页、真实电商列表、至少 1 个 Electron attach 目标 | DOM 派生的 missRate 不能自证 DOM 的盲区。注意决策规则：`genuineNew` 大 ⇒ 先做 selector 扩充（最便宜）；`genuineNew≈0` 但外部标注显示大量目标不可达 ⇒ 才是外挂 grounding 的触发条件 |
| 1.8 | **索引漂移频率实测**：跑真实 SPA 站点，统计 `clicked` 与 snapshot 该索引 role+name 的不一致率 | 不需要模型，一跑就有。定量化 0.4 的紧迫性（虽然它便宜到无论如何都该做） |
| 1.9 | **验收套件补三类**：SPA、iframe、强制走坐标兜底的任务（各 5 个）；Electron 上做 model-level acceptance | 当前坐标兜底在验收套件里被调用 0 次；SPA 样本数为 0 |
| 1.10 | **两步 refine 重跑**：单请求同时给全图+裁剪图；同 seed 配对、空回复重试、McNemar、windows 设对照组 | 验证 1M/600 图配置的第一条独特打法；同时把 parse failure 噪音从归因里剥离 |

### 暂缓 / 降级（附可判定的触发条件）

- **外挂 UI-TARS / GUI-Actor 类专用 grounding 权重**：**暂不做**（不是"永不做"）。理由：2-8GB 权重 + torch/vLLM 运行时与 AGENTS.md 的单 npm 包分发硬约束冲突；引入逐模型权重许可，破坏当前干净 MIT；7B 本地推理单次即秒级，而当前 16s 是整任务耗时。将来的正确形态是 `ctx.computer` 下的可选 grounding 子 seam + 远端 endpoint、默认关闭、绝不打包。**触发条件**：在判据修好后的真实任务套件上，落到坐标兜底的步骤占比 >10% **且** 兜底步骤成功率 <70%。两个条件目前都没有数据。
- **全局 Set-of-Mark 叠框**：暂不做，先做 1.6 的 bounding box 方案。理由：对可枚举元素冗余（有 box 就能 index 点击，100% 高于读数字）；对需要它的非枚举元素画不出框；强制每步出截图。风险提示【公开】：SoM 在 GPT-4V 上是正收益，在 LLaVA 上是 −6.8% ~ −16.2%，DeepSeek-v4-flash-vision 对 SoM 的响应**无任何数据**，上产品前必须自测。**定向 SoM**（只给 k 个歧义候选叠编号）是唯一不冗余的用法，但排在 0.7 命名限定之后。
- **roadmap #5 元素级 diff 快照、#6 大列表分页**：降级。330 元素约 2.4k token 对 1M 上下文是噪音级开销，而 #5 自述"diff semantics risk index misalignment"——它是唯一能破坏 single-handle-array 不变式的改动。预算转给枚举与命名。
- **AX provider 落地时**：照搬同一分层（AX 树枚举为主路径、命名补全同样适用、视觉只做验证），并**硬性规定按窗口截图、绝不整屏**（budget.py 实测 4K 整屏 scale 0.278，20px 按钮只剩 5.6px）。可行性【实测】：AX 探针显示计算器 150 节点、VS Code 845 节点语义完整、微信仅 123 且多为空名 AXButton——**这是应用差异不是路线问题**。

---

## 七、不确定性清单

### 稳的（可直接引用）

- 15 个验收任务的通过情况、耗时分布、tool_calls 明细【实测，可复算】。
- 单步 grounding 在 ScreenSpot-v2 上的 118/200 与分平台分布【实测，与 run jsonl 逐项吻合，无外部分数混入，无 ScreenSpot-Pro/OSWorld 口径污染】。
- 六个代码层缺陷的**存在性**【实测，探针在真机复现 + 代码原文可定位】。
- 640k 预算下各分辨率的 scale 与有效像素【确定性公式】。
- macOS AX 三个应用的节点数与语义质量【实测】。
- 原生桌面今天可达 0%（provider 未建，`experiments/macos-ax-probe` 只有 Swift 探针）——**事实，不是估算**。

### 外推的（不要当承诺用）

- 第一节表格里除第一行外的**所有区间**。SPA 一行的样本数是 0；Electron 一行的完整任务成功数是 0；iframe/shadow DOM 一行有机制实测但无频率数据。
- 六个缺陷的**发生频率**。机制证据确凿，但真实任务里因枚举缺失导致的失败目前有据可查的只有微信 devtools 一例（外加 wikipedia 折叠侧栏这一例假阳性），15 个评分任务里 0 例。
- "结构步单动作 ≈0.98"外推到静态文档站之外。这是最危险的单一假设：0.98^10=0.82 与 0.90^10=0.35 相差一倍以上，且随步数指数放大。
- "单请求全图+裁剪能恢复精度"的机制假设——归因未被消融证明。

### 最快把外推变实测的三件事（按性价比排序）

1. **1.8 索引漂移频率**：不需要模型，跑一遍真实 SPA 站点统计 `clicked` 与快照身份的不一致率，当天出数。
2. **0.1 绝对像素模式重测**：一次 200 样本运行，直接决定"要不要投 grounding"这个最大的资源分配问题。
3. **1.7 外部 ground truth 覆盖率**：目前所有"结构路径够不够"的判断都建立在一把量自己的尺子上；换尺子之前，枚举覆盖的乐观和悲观都没有依据。

---

## 八、被本次核验剔除的说法（避免再流通）

- ~~"结构路径实测 0 miss"~~ → 只在 0.4.0 之前的 15 个浏览器任务上成立；微信 devtools 已是一次真实 miss，且 wikipedia-contents 的 session log 记录了可见性导致的 click 失败。
- ~~"标准 DOM 网页覆盖 70-95% / Electron 15-65% / canvas 0-10%"~~ → 这三个区间在仓库里 grep 不到出处，且方向上比自家唯一的度量更悲观。只报有度量的那一格，其余标"未测"。
- ~~"15/15 是短链任务"~~ → 长链集里 5 个任务全部是 2+ 跳或表单，含 HN、httpbin POST、Wikipedia 自动补全搜索框。
- ~~"密集电商页误差最大（97px）"~~ → 尺度混算的假象，`err_norm` 下 windows 与 ios 更差。
- ~~"两步的 windows 反例证明机制是消歧上下文丢失"~~ → 分母漂移造成，配对后净 −1（p=1.0）。
- ~~"坐标空间对齐是待办"~~ → DPR 层已由 `scale:'css'` 交付（代码注释记录了 WeChat host 2× DPR bug 的修复）；未对齐的是 harness 侧的 640k 降采样层。
- ~~"外挂 grounding 小模型 / 全局 SoM 明确不做"~~ → 改为"暂不做 + 可判定触发条件"，且应先评审成本低得多的 snapshot bounding box 方案。
- ~~"索引漂移是完全静默的错点"~~ → `clicked` 字段事后可见；准确表述是"校验发生在动作之后"。
- ~~"navigate 抛错覆盖 Cloudflare 403 / 429 / 401"~~ → 只实测了 github 404，其余是同机制推断；且 README 把 403 报错当预期行为，这是设计分歧待决而非已证 bug。

---

**相关文件（绝对路径）**

- `/Users/doing/Desktop/code/github/dsh-computer-use/packages/computer-playwright/src/index.ts` — 枚举选择器、`interactiveHandles`、click 按位置重取 handle、300ms settle、navigate HTTP 状态抛错
- `/Users/doing/Desktop/code/github/dsh-computer-use/packages/tool-computer/src/index.ts` — `computer_click` 收绝对 CSS 像素、screenshot 尺寸上报
- `/Users/doing/Desktop/code/github/dsh-computer-use/experiments/screenspot-grounding/{bench.py,miss_anatomy.py,results/summary-20260824-101238.json}`
- `/Users/doing/Desktop/code/github/dsh-computer-use/experiments/enumeration-coverage/{measure.mjs,results/coverage.json}`
- `/Users/doing/Desktop/code/github/dsh-computer-use/experiments/phase2-acceptance/{run.py,tasks.json,longchain-tasks.json,results/}`
- `/Users/doing/Desktop/code/github/dsh-computer-use/experiments/pixel-budget/budget.py`
- `/Users/doing/Desktop/code/github/dsh-computer-use/docs/{phase3-roadmap.md,desktop-control-plan.md}`
- `/Users/doing/Desktop/code/github/dsh-computer-use/DO.md` — 2026-08-25 安全事件、2026-08-26 微信 devtools 两次真机记录