# Changelog

本文件记录本插件的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 修复：回到历史会话时报「档位读取失败」

- **档位端点只认活着的会话。** `ctx.sessions.get()` 只返回 Agent 已激活的会话，而 Web 里点开一条
  历史会话看记录**不会激活 Agent**（`dsh-api-session-controller` 的 `history.page` 即
  *without activating an Agent*），端点于是回 `NO_SESSION`，界面上就是「档位读取失败」——而控件
  本身显示得出来（它的 `agentPreset` 来自会话列表的投影，冷会话也有），所以症状恰好是**只有回到
  旧会话时才坏**。现在冷会话走 `ctx.sessionQuery.observeSession()` 读一次持久化日志、算同一个
  `agentPreset` 投影，判定与控件看到的完全一致；`sessionQuery` 用惰性 `ctx.get()` 取，不进静态
  `inject`（否则没装配它的部署会连 live 会话的档位一起失去）。
- **不退回 `header.agentPreset`。** 实测本机三条论文会话的 header 都写着 `standard`，其中两条的
  日志里有 `agent-preset/selected = paper`（用户在首个 turn 之前换过档）——按 header 判会把这些
  会话的控件一起废掉，按投影判才对。这条实测记录写进了
  [设计与取舍](docs/design.md#档位端点为什么必须同时认-live-与冷会话)。
- **客户端加退避重试**（3 次，400ms 起）。控件随会话视图挂载，而宿主是异步把会话读出来的；读一次
  就放弃会让失败变得随机。宿主说 `NOT_PAPER` 时整块收掉不报错，其余失败重试用尽才显示错误。
- 端点语义：端点上「会话不存在」与「不是本模式」合流为 `NOT_PAPER`（原先分别是 `NO_SESSION` 与
  `NOT_PAPER`）——两种情况下控件都不该出现，分开只会多一条前端要特判的错误码。

### 改进：一次真实运行暴露的四类问题

一次真实运行（VAE 生成友好性度量，速览档）暴露了四类问题，逐条修掉：

- **去掉硬性字数上限。** 三档的篇幅从「上限」改成参考区间，并明写「超上限不阻断」。`levels/verify.md`
  里原本「超上限即阻断」的判据改成两条：篇幅明显跑档（速览写了深读的内容）才算跑档；反过来，
  为压字数省掉指标解释或证据边界按阻断处理。控件文案、`level-catalog` blurb、README 一并改口径。
- **裁切框不再包含图注文字。** 检测与手动裁切都在渲染前按该页图注块的 bbox 削一遍
  （`excludeCaptions`，图注在下半部压底边、在上半部抬顶边，留 2pt 空隙），削完不足 8pt 判失败而不是
  退回原框。图注文字单独返回：`paper_figures` 给 `caption`，`paper_figure` 新增邻近图注
  （`captionsNear`，标明在图形的哪一侧）与被排除图注的清单，报告把图注作为斜体行写在图片下方。
  `FIGURES_FORMAT` 升到 2，旧缓存自动重算。
- **公式改用 LaTeX。** persona 新增「公式」一节；`paper-report` §3 与写作规范、`paper-verify` 第 3 项
  改口径：行内 `$...$`、独立成行 `$$` 独占一行（DSH 的 Markdown 渲染只认这一种写法），公式内用
  LaTeX 命令而非 Unicode，正文变量放进 `$...$`；用代码块或纯文本贴公式、混用 Unicode 上下标列为
  阻断项；猜着补 `^{}` 按编造处理。
- **指标与概念必须解释「在算什么」。** persona 新增一条：每个评价指标首现要说明它比较什么、大致
  怎么算、往哪个方向变算好、有无下界，同一指标的不同口径（gFID / rFID / iFID）要分开写。技能与三档
  的 §3、§7 同步要求，`paper-verify` 第 1 项扩成「术语首现与『在算什么』」，把「出现 FID 数字而全文
  没解释过 FID」列为阻断。

### 档位改由用户在界面控件里选定

围绕一件事：**档位改由用户在界面控件里选定，并按档位只加载该档的工作流信息。**

### 新增

- **档位控件**（`lib/client.js`，挂 `conversation.input.left`）：输入框工具行左侧的三档段控件
  （速览 / 解读 / 深读），只在「论文解读」模式的会话里出现；其他模式渲染 null 且不发请求。
  点击写入宿主，**按会话独立**存储（`$DSH_HOME/paper-reader/levels.json`）。
- **按档位装配技能正文**：`paper-report` 的 `{{workflow}}` 与 `paper-verify` 的 `{{level-check}}`
  在 `get()` 时按当前档位替换成 `levels/<档位>.md` 与 `levels/verify.md` 里的对应小节。模型只看到
  自己这一档的流程，没有另外两档的冗余。占位符缺失、重复、或替换后仍残留 `{{…}}` 都会抛错。
- **系统提示词的档位段**（`paper-reader:level`）：每个模型步骤只写当前这一档，并明写「档位是用户的
  选择，不要自行升档或降档」。
- **档位读写端点** `/api/dsh-paper-reader/level`：按 `sessionId` 读写，且逐请求校验该会话确实是本
  模式（否则 `ok:false, code:NOT_PAPER`）。
- **`lib/roles.js`**：两个挂载角色（`control` / `agent`）的常量与校验。`config.role` 必填且不猜
  默认值——猜错的两个方向都是静默故障（根层泄漏 / preset 里失效）。
- **`lib/preset-gate.js`**：控制面判断「这个会话是不是论文解读模式」，依据会话投影的
  `agentPreset`——会话可以在首个 turn 之前换 preset，所以不读创建时的 header。
- 四份档位内容文件（`levels/brief.md` / `standard.md` / `deep.md` / `verify.md`），三档覆盖同样的
  五个关注点（档位定位、篇幅与文件名、读到什么程度、骨架加深点、执行流程），顺序一致。

### 变更

- **本插件改为挂两次**，两行都在本包自己的 patch 里：
  - `cordis.patch.yml` → profile 根层 `paper-reader` 行（`role: control`）：只让档位控件被
    `dsh-client-modules` 组装进页面（它只遍历根层 bundle 行），并注册档位端点；
  - `presets/paper.patch.yml` → preset 内 `paper-reader-agent` 行（`role: agent`）：注册技能
    provider、五个工具与档位提示词段。

  **五个工具因此在别的模式里彻底消失**（`ctx.tools.schemas()` 的全局视角也看不到），换 preset 时
  可见面随 scope 链正确进出。第一版曾把模型可见面挂在根层再用 `isPaperAgent` 逐点过滤，现已整体
  删除：那套做法有漏点、挡不住全局视图，且换 preset 时会留下错误的可见面。实测数据与取舍见
  [设计与取舍](docs/design.md#早先的做法为什么被删掉了)。
- **不再声明静态 `inject`**：两个角色共用它，而根层那一行必须无条件激活，否则控件会随别的插件
  缺席而从页面消失。`systemPrompt` 与 `connection` 改为 `ctx.inject([...], scope => …)` 延迟注入。
- **`createProvider` 不再自己做模式判断**（`list()` 不再返回空数组、`get()` 不再抛错）：隔离由
  preset 的 scope 层提供，provider 里没有可漏的判断点。
- **技能不再让模型自定档位**：`paper-report` 删掉「第一步：定档位」的三档表格与「时间预算」的分工
  表，改为占位符一节「当前档位」；`paper-verify` 的「档位有没有兑现」改为按档注入。问答技能
  （`paper-qa`）与档位无关，没有占位符。
- **`paper-report` / `paper-verify` 的 description 与档位解耦**：技能目录行不再逐个列三个档位。
- **`package.json` 声明 `dsh.client`**（`platform: web`、`immediately: true`、`exports["./client"]`），
  `files` 加入 `levels`。

### 测试

- 132 条（原 93 条）。新增四块：
  - `test/levels.test.mjs`——档位存储（按会话读写、原子写、坏文件/版本不符降级）、占位符装配的
    三个失败分支、provider 不做模式判断（读取结果与 scope 无关）、装配后正文仍在
    `tool-result-pruner` 的 8192 阈值内；
  - `test/client.test.mjs`——在假 `window.__ModuleLoader__` + 假 React 里**真的执行**浏览器 bundle，
    覆盖加载器契约（`id`、必须返回 `exports`）、档位目录与宿主一致、槽位注册、模式门控；
  - `test/preset.test.mjs` 增补挂载点契约（根层恰好一个 `control`、preset 里恰好一个 `agent`，
    角色不能互换也不能重复）与 `dsh.client` 声明；
  - `test/provider.test.mjs` 增补两个角色各注册什么、缺 `systemPrompt` / `connection` 的降级、
    `role` 缺失或未知时报错，以及档位端点从 `BAD_REQUEST` 到写后读的完整语义；冷会话（回到旧会话）
    的读写与 observation 租借归还也在这一块里。

### 已知限制

见 [已知限制](docs/limitations.md)：档位控件依赖 `agentPreset` 投影；档位记录只增不删；本包必须
在两个挂载点各有一行，删掉任何一行都会各缺一半能力。

## [0.1.0] - 2026-09-29

首个版本。一个以 **agent preset 隔离**的「论文解读」模式：精读单篇论文生成解读报告，并基于
同一份解析产物回答关于这篇论文的问题。其他模式（standard / ptc / …）的会话里看不到它的
persona、技能与工具。

### 新增

- **「论文解读」agent preset**（`presets/paper.patch.yml`，`order: 5`）。工具集基线逐条对齐官方
  `preset-standard`，只做两处改动：persona 换成本模式的风格与严谨性规范、新增一行挂载本插件。
  因此在该模式下工作与 standard 模式没有行为差异。
- **三个技能包**（`skills/<name>/SKILL.md`）：
  - `paper-report` —— 七段固定结构的中文解读报告，写入文件并交付；
  - `paper-qa` —— 针对同一篇论文的问答，先定位原文再作答，答案分「作者主张 / 直接证据 / 推断 /
    外部知识」四层；
  - `paper-verify` —— 成稿自审，逐条检查术语首现、缩写展开、锚点、四层标注、数字完整性、图表与
    空转句。
- **四个宿主工具**（`lib/tools.js`，实现在 `lib/pdf.js`）：
  - `paper_import` —— 把 PDF 导入本地缓存，返回 `docId`（PDF 字节 sha256 前 12 位）；
  - `paper_search` —— 先短语匹配、不中才退化为「所有词都出现」的宽松匹配，结果里标明匹配模式，
    命中项给出 `[p.7 §3.2]` 锚点；
  - `paper_read` —— 按页读正文（如 `pages: "3,7,9-11"`），超出字符预算时如实报告截断与未读页；
  - `paper_figure` —— 把页面渲染成 PNG 并附该页图注原文。
- **自包含解析缓存**（默认 `$DSH_HOME/paper-reader/<docId>/`）：分页正文、结构化块、源 PDF 副本与
  渲染出的 PNG。`meta.json` 最后写，因此它存在即代表这次导入完整；中断的导入不会留下半份缓存。
- **测试** `node --test`，80 条：provider 契约、preset 契约、PDF 解析与锚点行为、四个工具的入参
  校验与输出合规。

### 设计决定

- **放 agent preset 而不是全局 skill。** DSH 的 skill 目录每个 session 都要背「名字 + 描述」的
  成本，persona 与工具更是常驻；放进 preset 后，未选中该模式时这些一概不存在。这不是约定而是
  DSH 的原生隔离：`ctx.skills.registerProvider` 的注册落到调用上下文的 scope 层。
- **保持自包含，不 import `@deepseek-ai/*`。** 本包以 `link:` 装进 profile，Node 按符号链接的
  realpath 解析裸导入，`@deepseek-ai/*` 不在本包的祖先目录链上。代价是 `defineTool` 也用不了，
  四个工具的定义与入参校验因此手写——注册表不校验入参、但校验输出，这两条契约由测试守住。
- **锚点是算出来的，不是猜的。** 每个文本块带 bbox 与「是否标题」判定：标题同时看文本形态与排版
  特征（加粗，或字号大于**全篇**正文基准字号），检索时向上找最近的标题、跨页沿用。基准字号取
  全篇众数而非逐页，否则图表页的刻度标签会占多数、把图内文字判成标题。宁可漏判（锚点变粗），
  不可误判（锚点指错章节）。
- **缓存只增不减。** 源 PDF 副本与 PNG 都保留（渲染按 dpi 分文件）。锚点要可复现，缓存就必须
  自包含；要腾空间得人工处理。抽取逻辑改进后 `meta.json` 的 `format` 版本对不上会重新解析并
  覆盖，而不是继续把旧结构当有效数据。
- **不改写数字与主张。** persona 与 `paper-verify` 都要求区分「作者主张 / 直接证据 / 推断 / 外部
  知识」，并回原文核对每个数字；公式因纯文本抽取会丢上下标，引用前须渲染原页核对。

### 已知限制

见 [docs/limitations.md](docs/limitations.md)。要点：首次导入会把每页解析两遍；公式上下标在纯文本
抽取中丢失；章节锚点粒度取决于论文模板（ICLR 的小型大写 `\subsection` 只能标到 `§5`）；图注只按
形态识别。

[0.1.0]: https://github.com/s11phere/dsh-paper-reader/releases/tag/v0.1.0
