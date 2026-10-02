# 设计与取舍

这份文档面向要改这个插件的人。README 讲怎么用、怎么装；这里讲为什么这么做，以及哪些地方看起来
可以简化、实际上不行。

## 档位是用户选的，不是模型猜的

最初的版本把「速览 / 解读 / 深读」写进技能正文，让模型自己定档。这有三个问题：

- **模型会猜错档。** 用户说「快速看一下」，模型可能给一份 3000 字的报告；反过来也一样。
- **技能正文背着无关档位的规则。** 写速览的会话也要读深读档的「梯度怎么回传」那几段，纯浪费上下文。
- **档位没有可核查的记录。** 事后看不出这次到底是按哪一档产出的。

现在档位是**输入框工具行左侧的一个段控件**（`lib/client.js`，挂在 `conversation.input.left`），
按会话独立存储（`lib/level-store.js` → `$DSH_HOME/paper-reader/levels.json`）。
它影响两处模型可见面，都在 `lib/levels.js` 里装配：

| 面 | 怎么变 | 代价 |
|---|---|---|
| 系统提示词的档位段 | 每个模型步骤只写当前这一档（这一段本身挂在 preset 的 scope 上，别的模式看不到它） | 无（段很短） |
| `paper-report` / `paper-verify` 正文 | 占位符 `{{workflow}}` / `{{level-check}}` 在 `get()` 时按档位替换 | 技能目录的 description 于是与档位无关，这一点写在技能里说明 |

技能名**刻意保持稳定**（不拆成 `paper-report-brief` / `standard` / `deep`）：`/paper-report` 这种手势
与用户自己的同名技能覆盖都依赖名字稳定，而且三个候选意味着三行目录成本。代价是技能目录行看不到
档位差异——所以提示词段里明写「以 `paper-report` 正文为准，那份正文已经按本档装配过」。

档位由控件写入**文件**而不是 session 事件：

- `Session.append()` 无法给事件打 `ignorable` 标记，而持久化读到未知事件类型会**拒绝整条日志**
  （`dsh-session-persistence`：`unknown to this harness and not marked ignorable`）。也就是
  一个仓库外插件往会话日志里写自定义事件会让会话之后读不出来。这是一条硬约束，实测确认。
- 借用已存在的 `command/run` 事件 + projection 是可行的替代（`dsh-plan-mode` 就是这么做的），
  但它要求控件写状态时先解析 session → agent，且要占用一个 projection key；对「一个 UI 偏好」
  这个体量来说，文件更直接，也让宿主与浏览器半部完全解耦。

## 档位控件为什么挂在 profile 根层

**起因是一个硬约束：浏览器半部只有挂在 profile 根层才会被加载。**

`@deepseek-ai/dsh-client-modules` 组装 boot graph 时只遍历 `ctx.loader.entries()`——也就是
**profile 根层的 bundle 行**（`lib/index.js` 的 `processOne`）。agent preset 的 `plugins` 是一棵
独立的 in-memory Loader 树（`dsh-agent-preset-registry` 的 `PresetTree`），**不在**这份扫描里：
`PresetTree` 的构造函数 `super(ctx)` 之后会把自己从 owner entry 的 `subtree` 上摘掉，所以
`EntryTree.entries()` 的递归永远走不到 preset 的行。挂在 preset 里的插件即使声明了 `dsh.client`，
它的浏览器半部也不会被加载——preset 挂载的插件拿不到 UI，代码层面无解。

反过来，**模型可见面只有挂在 preset 里才有原生隔离**。这两件事落在不同的挂载点上，所以本包被
**挂两次**，用 `config.role` 说明哪一行负责哪一面（`lib/roles.js`）：

| 挂载点 | 行 id / role | 注册什么 | 隔离方式 |
|---|---|---|---|
| `cordis.patch.yml`（profile 根层） | `paper-reader` / `control` | 档位端点（`/api/dsh-paper-reader/level`）；`dsh.client` 声明生效 | 端点按会话的 `agentPreset` 逐请求校验；**这里没有任何模型可见的注册** |
| `presets/paper.patch.yml`（preset 内） | `paper-reader-agent` / `agent` | 技能 provider、五个工具、档位提示词段 | DSH 的 scope 层：agent 的 scope key 以 preset 的 standing key 为父，别的模式不在那条链上 |

两行都在本包自己的 patch 文件里，`dsh plugin add` 一并带上，用户不需要手写。角色必须显式声明、
未知值直接报错：猜错的两种方向（根层注册模型可见面 → 静默泄漏；preset 里不注册 → 静默失效）
都是最难排查的那一类故障。

### 为什么没有静态 `inject`

根层那一行必须**无条件激活**：`dsh-client-modules` 只认活着的 loader 行（`processOne` 里
`entry.fiber === void 0` 会被跳过）。同一个模块的静态 `inject` 是两个角色共用的，而控制面不需要任何
服务，所以 `lib/index.js` **不声明静态 `inject`**，需要的服务都在各自的注入回调（`ctx.inject`）里取。
代价是缺服务时不再 fail-fast，换来的是「浏览器半部绝不会因为别的插件没就位而消失」。

### 档位端点为什么必须同时认 live 与冷会话

档位端点挂在 profile 根层，靠 `agentPreset` 投影确认「这个 sessionId 属于本模式」。最初的实现只查
`ctx.sessions.get(sessionId)`，症状是**只有回到一条旧会话时才坏**：控件显示出三个档位按钮，读取却报
「档位读取失败」。

原因是 DSH 的两种「会话在不在」不是一回事：

- `ctx.sessions.get()` 只返回**活着的**会话（Agent 已激活）。Web 里点开一条历史会话看记录**不会
  激活 Agent**——`dsh-api-session-controller` 的 `history.page` 明确写着 *without activating an
  Agent*。于是 `get()` 给 `undefined`，端点回 `NO_SESSION`，而客户端那边的 `agentPreset` 来自会话
  列表的投影（冷会话也有），两边打架。
- 冷会话的真相在持久化日志里：`ctx.sessionQuery.observeSession(id, { projectionMode: 'all' })`
  读一次日志、算出同一个 `agentPreset` 投影定义（`init` 读 header、`apply` 吃
  `agent-preset/selected`），而且**同样不激活 Agent**（prepared session 是脱离 live store 的
  对象，`get()` 依旧拿不到它）。判定因此与控件看到的完全一致。

三条由此定下来的规矩：

1. **不退回 `header.agentPreset`。** 那是创建时的事实。实测本机三条论文会话的 header 都写着
   `standard`，其中两条的日志里有 `agent-preset/selected = paper`（用户在首个 turn 之前用模式
   选择器换过档）——按 header 判会把它们全部拒掉，按投影判才对。
2. **`observeSession` 的租借必须归还。** 它是 lease（`dispose()`），不还就会把那份恢复出来的
   Session 一直钉在 observation 缓存里。
3. **`sessionQuery` 用 `ctx.get()` 惰性取，不进静态 `inject`。** 加进 `inject` 会让没有装配
   `sessionQuery` 的部署整行不激活，连 live 会话的档位也一起失去。

「会话不存在」与「不是本模式」在端点上合流成同一个 `NOT_PAPER`：两种情况下控件都不该出现，分开
只会多一条前端要特判的错误码。客户端那边另加了退避重试：控件是随会话视图挂载的，而宿主是异步把
会话读出来的，读一次就放弃会让失败变得随机。

### 早先的做法为什么被删掉了

第一版把模型可见面也挂在根层，再用 `isPaperAgent` 在每个消费点手工过滤（技能目录返回空、
`get()` 抛错、提示词段返回空串）。那套做法有三处硬伤，现已整体删除：

1. **逐点过滤 = 逐点可漏。** 新增一个注册点就多一个漏点，而漏点不会有任何报错。
2. **挡不住全局视图。** 工具仍在根层注册表里，`ctx.tools.schemas()`（不带 scope 的全局视角）
   照样列得出来；工具清单、插件清单这类页面看到的也是这一份。
3. **换 preset 会错。** DSH 允许在首个 turn 之前换模式（Web 客户端的模式选择器就是这么做的），
   `bindings` 会把 agent 的 scope 父链 `rebind` 到新 generation。agent 的 scope 注册随之进出；
   而一次性装在 agent scope 上的 `tools.restrict({ deny })` 限制**不会**被撤掉——从别的模式切进
   论文解读，工具会一直缺席；反向切换则一直泄漏。

现在的做法没有判断点：注册落在 preset 的 scope 层，`ScopedLayers.merge` 只沿 scope 链合并，
全局层与别的 preset 都看不到它。

实测（临时 `DSH_HOME` + 探针插件，逐个 agent 调 `ctx.tools.schemas(agent)` 与
`ctx.skills.snapshot({ scope: agent })`）：

| 视角 | 看得见的 `paper_*` 工具 | 看得见的本插件技能 |
|---|---|---|
| 论文解读模式的 agent | 5 | 3 |
| standard 模式的 agent | 0 | 0 |
| standard → 切到论文解读 | 5 | 3 |
| 论文解读 → 切到 standard | 0 | 0 |
| 全局视角（`schemas()` 不带 scope） | **0** | **0** |

第三、四行是 `tools.restrict` 那套方案做不到的；最后一行是「全局视图」那一处泄漏的直接反证。

模式身份也仍然只属于 preset：`persona` 在 `presets/paper.patch.yml` 里，没选这个模式就没有它。
根层那一行不等于「论文解读模式全局存在」——它只是把控件送进页面的一根线。

## 为什么是 agent preset，而不是全局 skill

DSH 的 skill 目录只把「名字 + 描述」放进上下文，正文按需加载——但目录行本身、persona、工具仍然是
每个 session 都要背的成本。本插件把这三样整个放进一个 agent preset：

- 在 Web 的新任务模式选择器里选中「论文解读」才生效；
- preset 的 `plugins` 列表是该 preset 的 **standing composition**，其中注册的 skill 与工具落在
  **本 preset 自己的 scope 层**；
- 其他模式（standard / ptc / minimal / …）的会话里看不到这些 skill、persona 和工具。

这不是约定，是 DSH 的原生隔离：`ctx.skills.registerProvider` 的注册落到调用上下文的 scope 层，
而全局的 `skill-filesystem` / `tool-skill` 行在 web profile 里本身就是 `disabled: true`，由每个
preset 各自挂一套。

> 注：技能与工具的隔离靠 scope，而**注册必须发生在 preset 的挂载上下文里**。所以
> `presets/paper.patch.yml` 里那一行（`role: agent`）不是可有可无的装饰：删掉它，五个工具与三个
> 技能会整体消失。`test/preset.test.mjs` 钉住了两行同时存在且角色不能互换。

preset 的工具集基线逐条对齐官方 `preset-standard`（`order: 1`），只改一处：`persona.prefix` 换成
本模式的风格与严谨性规范。逐行 diff 下来，其余部分（`agent-instructions` 的 `maxBytes`、
`tool-fs-search` 的 `sampleOverCapGlobResults`、各组的 `isolate`、`tool-result-pruner` 的阈值、
`tool-ralph` / `tool-plugin-manager` 的 `disabled`）都与 standard 逐字一致——所以在「论文解读」
模式下工作与用户已经习惯的 standard 模式没有行为差异。

## 硬约束 1：不得 import `@deepseek-ai/*`

本包以 `link:` 装进 profile，Node 按符号链接的 **realpath** 解析裸导入。`@deepseek-ai/*` 只存在于
`profiles/node_modules`（DSH 为 profile 铺的 symlink 农场），不在本包的祖先目录链上；启动器也没有开
`--preserve-symlinks`。实测：

```sh
$ cd <本包目录>
$ node --input-type=module -e "await import('@deepseek-ai/dsh-skill')"
ERR_MODULE_NOT_FOUND
```

所以本包与既有四个插件一样**保持自包含**：`dependencies` 只有 `mupdf` 与 `yaml`，装在包自己的
`node_modules` 里。`BUNDLED_SKILL_RANK = 600` 是内联的常量副本——同一 scope 层内重名技能按 rank
抢位、rank 小的赢，600 高于本地各层（project 100/200、custom 300、user 400/500），也就是**用户自己
的同名技能会覆盖本插件提供的版本**，这正是要的语义。

代价是 `defineTool` 也用不了，五个工具的定义因此是**手写**的（`lib/tools.js`）。手写要守三条契约：

1. **入参没有兜底。** 注册表不校验入参（校验是 `defineTool` 生成的闭包做的），必须自己校验：
   `limit` 1–30、`dpi` 36–600、`maxChars` ≥ 1、页码表达式可解析且不越界、`paper_figure` 单次 ≤ 8 页。
2. **输出会被校验。** 不合规抛 `ToolOutputError`，所以每个工具的 `output.schema` 必须与 `execute`
   的实际返回值一一对应（并且 `additionalProperties: false`）。
3. **schema 关键字是子集。** 约束关键字只有
   `type / oneOf / properties / required / additionalProperties / items / enum / const`，
   注解关键字只有 `description / title / default / examples`。**没有 `minimum` / `maximum`**——
   范围限制只能写在代码里，schema 里写不下。

这三条都由 `test/tools.test.mjs` 守着；`test/helpers/schema.mjs` 里那份关键字白名单与官方
`@deepseek-ai/dsh-tools` 的 `CONSTRAINT_KEYWORDS` / `ANNOTATION_KEYWORDS` 逐字符一致。

还有一条不属于契约、但同样重要：**注册表把 `render` 的文本交给模型，JSON 返回值只用于校验与 UI。**
所以凡是模型需要读的信息——论文地图、图表清单、裁切后的路径——都必须出现在 `render` 里，光放进
JSON 等于没给。

## 硬约束 2：`persona.prefix` 里不得出现 `{{`

persona 的 `prefix` / `suffix` 是模板，`{{…}}` 会严格按已注册的提示词变量解析，未注册的变量会让
提示词组装失败。目前只有 `suffix` 用了 `{{cwd}}`。`test/preset.test.mjs` 会把整份 preset 里除
`{{cwd}}` 以外的 `{{…}}`、以及未闭合的 `{{` 全部拦下——这条必须机械守住，靠肉眼看很容易漏。

## 锚点：位置是算出来的，不是猜的

报告与问答都要求 `[p.7 §3.2]` 这种可核查的位置，所以每个文本块都带 bbox 与「是否标题」判定；
检索时按页内 y 坐标向上找最近的标题、跨页沿用上一个标题（`lib/pdf.js` 的 `searchPaper`）。

标题判定要求**两个信号同时成立**：

| 信号 | 内容 | 为什么需要 |
|---|---|---|
| 文本形态 | 编号（`3.2.1 …`）或常见标题词（`Abstract` / `References` …） | 论文里标题形态很集中，窄规则足够 |
| 排版特征 | 加粗，或字号大于**全篇**正文基准字号 | 排除「以数字开头的表格行被当成 §1」 |

只看形态会在 Attention Is All You Need 的 Table 3 上出错：正文行 `1 512 512 5.29 24.9 …` 被读成
`§1`，于是第 9 页后半页的锚点全错。加上排版条件后被正确排除，而同页真正的
`6.3 English Constituency Parsing`（加粗、与正文同号）仍然识别得出来。

基准字号取**全篇**的众数而不是逐页（`lib/pdf.js` 的 `documentBodyFontSize`）：图表页上刻度标签会占
多数，逐页统计会让图内文字「比正文大」而被当成标题——ViT 上实测出现过两个 `§0` 假锚点。代价是
导入时多走一遍页面解析，见 [已知限制](limitations.md#首次导入有解析成本)。

页面完全没有字体信息时（少数 PDF）退回只看文本形态：宁可冒误判风险，也好过整篇只剩 `[p.N]`。
两个信号都不满足时宁可不标章节，只给 `[p.7]`。

文本形态这一侧还有四道窄规则，都是实测逼出来的（缓存格式 6）。它们的共同点是**只拦不加识**，
把「看起来像标题的别的东西」排除掉，代价是漏判：

| 规则 | 拦下什么 | 不拦会怎样 |
|---|---|---|
| 编号每段不超过两位 | 参考文献条目 `13839. URL …`、`2022. doi: …` | 抽出 `§13839`、`§2022` 两个假章节，其后所有锚点跟着错 |
| 无编号标题必须**整行就是它** | 表格表头行 `Method Score`（加粗、比正文大，形态与标题无异） | 第 8 页后半页的锚点全变成 `§Method` |
| 编号后必须跟「含字母的词」 | 显示公式 `A = Reshape(T[t : t + I · r])`、表格行 `1 512 512 …` | 公式被当成 `§A`；带上这条，PDF 没有字体信息时也不会误判 |
| 附录字母编号只在参考文献之后启用 | 正文插图里的面板标签 `A` / `B` | 第 4–5 页之间抽出两个假章节 |

附录的字母编号（`A` / `B.2` / `E.1`）是刻意补上的：AI 方向论文的细节几乎都在附录里，不认字母
编号，附录所有内容的锚点都会停在 `§References`。

**取舍是单向的：宁可漏判，不可误判。** 漏判只是锚点变粗，读者仍能核对；误判会让锚点指向错误的
章节，而看报告的人无法察觉。这也是 ICLR 小型大写 `\subsection` 只能标到 `§5` 的原因，见
[已知限制](limitations.md#章节锚点的粒度取决于论文模板)。

检索据此分成两段：先按短语匹配；一个都不中，才退化成「所有词都出现」的宽松匹配，并在结果里标明
是哪种模式——避免模型把宽松命中当成精确依据。

返回的上下文量是问答快不快的主要变量。每条命中默认带 `window` 档：命中块连同前后各最多两块、
累计约 700 字符。原来的前后各 70 字只够确认「这里提到了」，模型往往还得再读一整页（约 24k 字符），
问答因此多花一到两轮。三档的分工见 README。

## 图形区域是按图注找出来的

报告里的图要是「图本身」，不是「那一页的截图」。这件事在 `lib/pdf.js` 里分四步，每一步都只依赖
已经落盘或可复算的信息：

1. **候选区域**：走一遍页面的 display list，收集所有图片与矢量路径的 bbox。论文插图绝大多数是
   矢量图（matplotlib 输出），不走这一步就只剩整页截图一条路。
2. **归属**：一个图注只认「中心落在它所在栏、且在正确一侧、距离够近」的候选。先按栏（页面文字块
   的**左边缘**聚类得到分栏，跨栏块只参与定左边缘），再按侧，最后按距离。
3. **收紧**：把候选并集渲染成像素，按墨迹的行列分布裁掉空白边。坐标轴刻度是**文字**、不在
   display list 的图形项里，所以收紧前先向四周放宽 12pt，让刻度与轴标签重新落进框内。
4. **排除图注**：前三步都是启发式，会算错；算错的表现就是「图的下缘挂着半行说明文字」——既没给出
   完整的图注，又占掉了图像的空间。所以最后统一按该页**图注块的 bbox** 削一遍（`excludeCaptions`）：
   图注落在下半部就压底边，落在上半部就抬顶边，各自留 2pt 空隙。削完不足 8pt 就判失败、进
   `undetected`，不退回原框——宁可让人看到一次失败，也不要给一张混着图注的图。这道闸对
   `paper_figure` 的**手动 bbox** 同样生效：手工框住图注是最常见的失误来源。

图注文字因此不进图，但也不丢：`paper_figures` 把图注原文放在返回值的 `caption` 里，`paper_figure`
另外用 `captionsNear` 把裁切框附近的图注（含在图的哪一侧）一并返回，报告把它作为斜体行写在图片
**下方**。这样「图」与「图注」各归其位——图是画面，图注是可检索、可复制的文字。

几个具体的坑，都是实测出来的：

- **图注会折行**。mupdf 按视觉行分块，长图注的第二行是独立的块，不接回去就会被当成图形内容——
  SHINE 第 30 页 Table 11 的「evaluation.」与第 9 页 Figure 9 的第二行都踩过。`captionBlocks`
  因此在「紧贴（≤5pt）+ 同栏 + 本身不是图注也不是标题」三条同时成立时把它接回上一个图注。
- **显示列表里有离群图元**。同一张图里几百个图元落在 y 60 以下，却有一个裁剪路径一路探到 y 27
  的页眉上方。取并集会被这一个图元拽到页顶，于是页眉进了裁剪框。解法是把候选框先夹进「正文区」，
  再在收紧后削掉压在页眉上的那一行。
- **正文与表格块不好分**。兜底方向（与排版惯例相反的那一侧）允许一路顶到上一个图注，中间夹着的
  正文会被扫进来。判据是「每行字符数」：表格一整行会被 mupdf 并成一个块，它同样又长又满宽
  （Table 11 的行块 87 字、267pt 宽），拿长度宽度当判据会把表格自己当成正文。**这道边界只加在
  兜底一侧**，两侧都加会误伤表格（实测 6 张表被截断或判失败）。
- **翻转条件要严**。判定用哪一侧，看的是「惯例那一侧**几乎是空的**」（近旁 26pt 内墨迹占比 < 0.02），
  而不是「另一侧更密」——图注紧挨着的那一段里，正文行本来就比表格行密。

诚实地说，这是启发式：会漏、也会多框。所以 `paper_figures` 把失败项列进 `undetected`，`paper_figure`
留了 `bbox` 手动裁的后路，而技能要求每张放进报告的图先 `read_image` 看一眼。宁可让模型复核一次，
也不要给一张裁掉一半的图。唯一不打折扣的是第 4 步：**「图里不含图注文字」是硬保证**（除非显式传
`avoidCaptions: false`），因为它不依赖任何启发式判断，用的就是图注块自己的 bbox。

## 提速：把阅读分出去（按档位分）

报告生成的耗时几乎全在两件事上：把论文读进上下文，以及每一轮工具调用都要等一次模型。所以
`paper-report` 不再让主智能体从头读到尾，而是把正文分节派给并行的子智能体。**这份分工现在按档位
不同**，具体写在 `levels/<档位>.md` 里（宿主装配技能正文时注入）：

| 档位 | 分工 |
|---|---|
| 速览 | 不起编排：只读 3–5 页，派子智能体反而更慢 |
| 解读 | 一次 `workflow` 起 3–6 个分节子智能体读正文 + 1 个图表子智能体；附录只读与主张相关处 |
| 深读 | 正文逐节 + 1–2 个附录子智能体（超参 / 梯度与损失 / 算力与数据配比 / 消融）+ 图表子智能体 |

三档共同的骨架：

- 主智能体只做四件事——导入并读地图、读摘要与引言、成稿、核对；
- 子智能体各自只读自己那几页，回结构化笔记（主张 + 锚点 + 数字 + 未交代项），不写文章；
- 「图表解读」子智能体逐张 `read_image` 看过图再回话；
- 数字核对再起一个子智能体，逐条回原文比对（速览档不做这一步，见下）。

这条设计成立的前提是**子智能体与主智能体在同一个 preset scope 上**：`subagent`（spawn）与
`workflow` 的子智能体都跑在同一个 cordis 上下文里，因此 `paper_search` / `paper_read` /
`paper_figures` 对它们同样可见，技能也不需要在 prompt 里教它们怎么找论文。代价是子智能体看不到
本会话（spawn 不继承对话），所以每个 prompt 必须自包含——`docId` 和分节信息要写在 prompt 里，
模板已经把这些占位标出来了。

速览档刻意**不做**数字核对子智能体：它的定位是「判断值不值得细读」，多一轮编排换来的精度在这个
用途上不值。

问答走的是同一套思路，但更克制，且**与档位无关**（`paper-qa` 正文没有档位占位符）：单问只做
「一次检索 + 必要时读一两页」，跨多节的大问才起 `workflow` 并行定位，合成仍由主智能体做——四层
归属与全局一致性需要全局视角，不适合分出去。

## 缓存：内容寻址、自包含、带版本

- `docId` 是 PDF 字节的 sha256 前 12 位，所以同一份文件换路径导入仍命中同一份缓存；
- `source.pdf` 是源文件副本，缓存因此自包含，原文件被移走或删掉也能继续渲染；
- `meta.json` **最后写**，所以它存在就意味着这次导入完整；中断的导入不会留下「看起来能用」的半份缓存；
- `format` 是缓存格式版本，对不上就重新解析并**覆盖**（不是继续把旧结构当有效数据，也不是先删干净
  再写——不同 dpi 的历史 PNG 会留着）。

图形区域检测的结果单独缓存在 `figures.json`，带自己的 `FIGURES_FORMAT` 与检测用的 `profileDpi`。
它只依赖块结构，所以判据变了就抬 `FIGURES_FORMAT`，而不必动 `CACHE_FORMAT`。

### 维护纪律：改了抽取逻辑就必须抬 `CACHE_FORMAT`

缓存按内容哈希寻址，但**抽取逻辑本身也会变**。改一次分页、分块、行拼接或标题判定规则，旧缓存里的
页码与块结构就不再可信——而「`meta.json` 存在就复用」会让它继续被当成有效数据用，症状是锚点悄悄错
掉而不是报错。所以 `lib/pdf.js` 顶部的 `CACHE_FORMAT` 每逢这类改动都要 +1，版本历史写在同一个注释块里：

| 版本 | 改了什么 | 不改会怎样 |
|---|---|---|
| 2 | 行拼接补空格 | 章节标题识别失效，**所有锚点停在 Abstract**；跨行短语也搜不到 |
| 3 | 标题判定加入排版信号 | 表格行被当成 `§1`，那半页锚点全错 |
| 4 | 正文基准字号从逐页改为全篇 | 图表页图内文字被当成标题，出现 `§0` 假锚点 |
| 5 | 每个块补完整 bbox | 图注分不清在哪一栏，双栏论文并排的两张图被并成一张 |
| 6 | 标题判定四道窄规则 + 附录字母编号 | 参考文献条目、表头行、公式行、插图面板字母全被当成章节 |

只改 persona、技能正文、README 不用抬版本；只改**读**缓存的代码路径也不用。

### 维护纪律：档位相关的东西有三处必须同步

档位的机器名与展示名分散在三个地方，`test/levels.test.mjs` 与 `test/client.test.mjs` 会拦下漂移，
但改之前最好先知道它们在哪：

| 在哪 | 是什么 | 谁读它 |
|---|---|---|
| `lib/level-catalog.js` | 档位名、展示名、一句话说明（**纯数据，不 import node 内置**） | 宿主与浏览器半部都读 |
| `lib/level-store.js` | `LEVELS` / `DEFAULT_LEVEL`（从目录派生）、存储格式 | 宿主 |
| `levels/<档位>.md`、`levels/verify.md` | 该档的工作流、该档的自审项 | 技能装配 |

加一个档位要同时：加目录项、加 `levels/<名>.md`、在 `levels/verify.md` 里加 `### <名>（中文）` 小节，
并在 `lib/client.js` 的 `LEVELS` 里加展示名（那份是本地 bundle 的副本，只能手工同步）。
`lib/level-store.js` 的 `STORE_FORMAT` 只在**存储结构**变化时抬，加减档位不用——值不合法会被
当成「没设过」从而回落到默认档。

档位存储**只增不删**（会话结束后那条记录会留着），与缓存同一个取舍：记录小、可复现比省几字节重要。
要清就人工删 `$DSH_HOME/paper-reader/levels.json`。

### 维护纪律：新增模型可见的东西，只能注册在代理面

这是本插件最容易写错的一处。**凡是模型能看见的注册（`tools.register`、`skills.registerProvider`、
`systemPrompt.section`、将来的 `commands.register`）都必须发生在 `role: agent` 那一侧**，也就是
`applyAgentPlane` 里。注册在控制面（根层）会立刻泄漏到所有模式，而且不会有任何报错。

与之配套的三条：

1. 别给 `lib/index.js` 加静态 `inject`——两个角色共用它，而控制面必须无条件激活（见上一节）。
   要用服务就在对应的 `ctx.inject([...], scope => …)` 回调里取。
2. 别在 `createProvider` 或档位段里加回运行期模式判断。隔离是 scope 给的；加回判断只会制造
   「看起来更安全、实际仍有漏点」的假象，并让换 preset 的行为变错。
3. `test/preset.test.mjs` 钉住「根层恰好一个 `role: control`、preset 里恰好一个 `role: agent`，
   且都没有第二份」；`test/provider.test.mjs` 钉住两个角色各自注册什么。改动挂载点时这两条会先响。

缓存只增不减（源 PDF 与渲染出的 PNG 都保留），这是刻意的取舍：锚点要可复现，缓存就必须自包含。
