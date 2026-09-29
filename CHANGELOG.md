# Changelog

本文件记录本插件的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
