# 设计与取舍

这份文档面向要改这个插件的人。README 讲怎么用、怎么装；这里讲为什么这么做，以及哪些地方看起来
可以简化、实际上不行。

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

preset 的工具集基线逐条对齐官方 `preset-standard`（`order: 1`），只改两处：`persona.prefix` 换成
本模式的风格与严谨性规范，以及新增 `paper-reader` 一行。逐行 diff 下来，其余部分（`agent-instructions`
的 `maxBytes`、`tool-fs-search` 的 `sampleOverCapGlobResults`、各组的 `isolate`、
`tool-result-pruner` 的阈值、`tool-ralph` / `tool-plugin-manager` 的 `disabled`）都与 standard
逐字一致——所以在「论文解读」模式下工作与用户已经习惯的 standard 模式没有行为差异。

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

代价是 `defineTool` 也用不了，四个工具的定义因此是**手写**的（`lib/tools.js`）。手写要守三条契约：

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

**取舍是单向的：宁可漏判，不可误判。** 漏判只是锚点变粗，读者仍能核对；误判会让锚点指向错误的
章节，而看报告的人无法察觉。这也是 ICLR 小型大写 `\subsection` 只能标到 `§5` 的原因，见
[已知限制](limitations.md#章节锚点的粒度取决于论文模板)。

检索据此分成两段：先按短语匹配；一个都不中，才退化成「所有词都出现」的宽松匹配，并在结果里标明
是哪种模式——避免模型把宽松命中当成精确依据。

## 缓存：内容寻址、自包含、带版本

- `docId` 是 PDF 字节的 sha256 前 12 位，所以同一份文件换路径导入仍命中同一份缓存；
- `source.pdf` 是源文件副本，缓存因此自包含，原文件被移走或删掉也能继续渲染；
- `meta.json` **最后写**，所以它存在就意味着这次导入完整；中断的导入不会留下「看起来能用」的半份缓存；
- `format` 是缓存格式版本，对不上就重新解析并**覆盖**（不是继续把旧结构当有效数据，也不是先删干净
  再写——不同 dpi 的历史 PNG 会留着）。

### 维护纪律：改了抽取逻辑就必须抬 `CACHE_FORMAT`

缓存按内容哈希寻址，但**抽取逻辑本身也会变**。改一次分页、分块、行拼接或标题判定规则，旧缓存里的
页码与块结构就不再可信——而「`meta.json` 存在就复用」会让它继续被当成有效数据用，症状是锚点悄悄错
掉而不是报错。所以 `lib/pdf.js` 顶部的 `CACHE_FORMAT` 每逢这类改动都要 +1，版本历史写在同一个注释块里：

| 版本 | 改了什么 | 不改会怎样 |
|---|---|---|
| 2 | 行拼接补空格 | 章节标题识别失效，**所有锚点停在 Abstract**；跨行短语也搜不到 |
| 3 | 标题判定加入排版信号 | 表格行被当成 `§1`，那半页锚点全错 |
| 4 | 正文基准字号从逐页改为全篇 | 图表页图内文字被当成标题，出现 `§0` 假锚点 |

只改 persona、技能正文、README 不用抬版本；只改**读**缓存的代码路径也不用。

缓存只增不减（源 PDF 与渲染出的 PNG 都保留），这是刻意的取舍：锚点要可复现，缓存就必须自包含。
