# dsh-paper-reader

DSH 插件：**论文解读模式**。精读一篇具体论文并生成解读报告，同时基于同一份解析产物回答关于这篇论文的问题。

## 这个插件解决什么

三件事，都放在一个只在需要时出现的模式里：

1. **解读报告** —— 给定一篇论文，产出结构固定、证据可追溯的中文报告。
2. **论文问答** —— 针对同一篇论文提问，答案带页/章节锚点，并分清作者主张与推断。
3. **输出风格** —— 术语首现给中英对照加白话解释、缩写首现展开、同一概念只用一个名字、不写空转句。

## 为什么是 agent preset，而不是全局 skill

DSH 的 skill 目录只在上下文里放「名字 + 描述」，正文按需加载——但目录行、persona、工具仍然是每个
session 都要背的成本。本插件把这部分整个放进一个 agent preset：在 Web 的新任务模式选择器里选
「论文解读」才生效，其他模式（standard / ptc / …）的会话里看不到这些 skill、persona 和工具。

这不是约定，是 DSH 的原生隔离：`ctx.skills.registerProvider` 的注册落到调用上下文的 scope 层。
取舍与实测细节见 [设计与取舍](docs/design.md)。

## 安装

本包**自带运行时依赖**（`mupdf`、`yaml`），且 `node_modules/` 不入库，所以在装进 profile 之前必须先在
本包目录里装一次依赖：

```sh
cd <本包目录>
pnpm install

dsh plugin --profile web add <本包目录>
```

装完重启 `dsh web`（preset 属启动期组装）。

> 别用 scp 风格的 URL 让 pnpm 去装（`git@github.com:...`）——pnpm 会把它误解析成「包名 `git` +
> 版本」，插件不会生效。本插件目前只验证过本地路径安装；远端安装的写法与注意事项见
> [开发文档](docs/development.md#安装本地路径)。

Windows 与 Linux 都能用：preset 里 bash / pwsh 两行按平台互相 `disabled`，与官方 `preset-standard`
的写法一致。

## 四个工具

| 工具 | 做什么 | 关键参数 |
|---|---|---|
| `paper_import` | 把 PDF 导入本地缓存，返回 `docId` | `source`（绝对路径） |
| `paper_search` | 检索词句，返回命中片段与 `[p.7 §3.2]` 锚点 | `docId` `query` `limit`(默认 8，≤30) |
| `paper_read` | 按页读正文，超出字符预算就如实报告截断 | `docId` `pages`(如 `3,7,9-11`) `maxChars`(默认 24000) |
| `paper_figure` | 把页面渲染成 PNG，并附该页图注原文 | `docId` `pages`(单次≤8 页) `dpi`(默认 120，36–600) |

设计上值得说明的三点：

- **一次导入，多处复用。** 报告与问答共用同一份解析产物，所以锚点在同一篇论文里始终一致。
  `docId` 是 PDF 字节的 sha256 前 12 位，同一份文件换路径导入仍然命中同一份缓存。
- **检索优先于通读。** `paper_search` 先按短语匹配，一个都不中才退化成「所有词都出现」的宽松匹配，
  并在结果里标明是哪种模式——避免模型把宽松命中当成精确依据。
- **锚点是算出来的。** 每个文本块带 bbox 与「是否标题」判定，命中项因此能给出 `[p.7 §3.2]` 这种
  可核查的位置。判定同时看文本形态与排版特征（加粗，或字号大于**全篇**正文基准字号），宁可漏判
  让锚点变粗，也不误判让锚点指错章节。算法与两个失败模式见
  [设计与取舍](docs/design.md#锚点位置是算出来的不是猜的)。

## 数据放在哪

缓存默认落在 `$DSH_HOME/paper-reader/<docId>/`：

```
<docId>/
├── meta.json        页数、源路径、导入时间、PDF 内嵌标题/作者（常常没有）
├── source.pdf       源文件副本——缓存因此自包含，原文件被移走也能继续渲染
├── pages/001.txt    分页正文
├── pages/001.json   结构化块（y / text / heading），锚点由它算出来
└── figures/p002@120.png
```

`meta.json` **最后写**，所以它存在就意味着这次导入完整；中断的导入不会留下「看起来能用」的半份
缓存。缓存根可以在 preset 的 `paper-reader` 行加 `config.cacheRoot` 覆盖：

```yaml
- id: paper-reader
  name: 'dsh-paper-reader'
  config:
    cacheRoot: /path/to/paper-cache
```

它里面的 `format` 是缓存格式版本：抽取逻辑改进后旧缓存里的页码与块结构就不再可信，版本对不上会
**重新解析并覆盖**。因此**改了抽取逻辑必须抬 `CACHE_FORMAT`**，见
[维护纪律](docs/design.md#维护纪律改了抽取逻辑就必须抬-cache_format)。

## 技能

`skills/<name>/SKILL.md` 三个技能包，随模式一起生效：

| 技能 | 什么时候用 |
|---|---|
| `paper-report` | 要求解读、精读、写阅读报告 |
| `paper-qa` | 针对某一篇论文提问 |
| `paper-verify` | 成稿自审（报告或较长答案交付前） |

技能名的来源、frontmatter 约定与「改正文不需要重载 preset」的机制见
[开发文档](docs/development.md#技能包格式)。

## 验证

```sh
node --test          # 80 条：provider 契约 + preset 契约 + pdf 行为 + tools 行为
```

不改任何 profile、验证 bundle 与 preset 组装的方法见
[开发文档](docs/development.md#验证-bundle-与-preset-组装)。

## 已知限制

首次导入会把每页解析两遍（实测 17 页约 127ms、31 页约 247ms，之后命中缓存）；缓存只增不减；公式的
上下标在纯文本抽取里会丢；章节锚点的粒度取决于论文模板（ICLR 的小型大写 `\subsection` 只能标到
`§5`）；图注只按形态识别。逐条说明与实测记录见 [已知限制](docs/limitations.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。仓库：<https://github.com/s11phere/dsh-paper-reader>（私有）。
