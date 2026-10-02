/**
 * pdf.js — mupdf 封装：论文导入、检索、分页读取、页面渲染。
 *
 * 设计要点：
 *
 * 1. **一次导入，多处复用**。导入时把 PDF 的哈希当作 docId，把分页正文、结构化
 *    块、以及源 PDF 副本落到缓存目录。之后报告与问答共用同一份解析产物，既不
 *    重复解析、也能稳定复现锚点。源 PDF 一并复制，所以用户挪走或删掉原文件后
 *    缓存依然可用（代价是磁盘占用只增不减，这是刻意的）。
 *
 * 2. **锚点是算出来的，不是猜的**。每个块带着 bbox 与"是否标题"的判定，检索时
 *    按页内 y 坐标向上找最近的标题，跨页沿用上一个标题，于是命中项能给出
 *    `[p.7 §3.2]` 这种可核查的位置。
 *
 * 3. **幂等**。meta.json 最后写，所以它存在就意味着这次导入完整；同一份 PDF
 *    无论从哪个路径导入都命中同一份缓存。
 *
 * mupdf 是零原生依赖的 WASM 包，纯 JS 即可抽文本**和**渲染页面，因此本插件在
 * 没有 poppler/mutool 的机器上也能工作（本机实测三者都没有）。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as mupdf from 'mupdf'

/**
 * 缓存格式版本，写进 meta.json。
 *
 * 缓存按 PDF 内容哈希寻址，但**抽取逻辑本身也会变**：改一次分页/分块规则，
 * 旧缓存里的页码与块结构就不再可信，而「meta.json 存在就复用」会让它继续被
 * 当成有效数据用。所以带上版本号，对不上就原地重解析（覆盖，不删除）。
 *
 * 2：行拼接补空格（原来同一视觉行被拆开后直接用空串相接，导致章节标题识别失效、
 *    所有锚点停在 Abstract，跨行短语也搜不到）。
 * 3：标题判定加入排版信号（加粗 / 大于正文基准字号），排除「表格行以数字开头」
 *    这类误判。
 * 4：正文基准字号改为**全篇**统计。逐页统计在图表页会退化成刻度字号，让图里的
 *    文字被当成标题（ViT 实测出现两个 §0 假锚点）。
 * 5：每个块补上完整 bbox（原来是只有 y）。图片区域检测要以「图注所在栏」为界，
 *    只有 y 无法判断图注在哪一栏，双栏论文会把并排的两张图并成一张。
 * 6：标题判定收紧两处——编号标题的每一段不超过两位（参考文献条目不再被当成章
 *    节），无编号标题必须整行就是它（表格表头 "Method Score" 不再被当成章节）；
 *    并补上附录的字母编号标题（A / B.2）。
 */
const CACHE_FORMAT = 6

/** 缓存根目录。可用 DSH_HOME 覆盖；默认 `~/.dsh/paper-reader`。 */
export function defaultCacheRoot() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'paper-reader')
}

/** 页码文件名：`001.txt`。 */
function pageName(page) {
  return String(page).padStart(3, '0')
}

/** 单篇论文的缓存目录。 */
function paperDir(cacheRoot, docId) {
  return join(cacheRoot, docId)
}

/**
 * 把 mupdf 给出的若干「行」拼成一段可读文本。
 *
 * 不能简单 `join('')`。mupdf 会把同一视觉行上相隔一段距离的文本拆成两个 line
 * 元素——论文里最常见的就是章节号与标题之间那道空隙——直接用空串相接会拼出
 * `"3.2.1Scaled Dot-Product Attention"`，既没法读，也让标题识别彻底失效。
 *
 * 规则：
 *   - 两行基线相同（同一视觉行被拆开）→ 补一个空格；
 *   - 基线不同（正常折行）→ 也补一个空格；只有上一行以连字符结尾时直接相接并
 *     保留那个连字符。它可能是断词，也可能是 `state-of-the-` 这种本来就有的
 *     连字符，没有词典可分，宁可留下可见的瑕疵也不静默改写原文。
 *
 * @param {{ text?: string, y?: number, bbox?: { y?: number } }[]} lines mupdf 的行数组。
 * @returns {string} 拼接并去掉首尾空白的文本。
 */
function joinLines(lines) {
  let out = ''
  let previousBaseline = Number.NaN
  for (const line of lines ?? []) {
    const text = line?.text ?? ''
    if (text.length === 0) continue
    const baseline = line?.y ?? line?.bbox?.y ?? 0
    if (out.length === 0) {
      out = text
    } else {
      const sameBaseline = Math.abs(baseline - previousBaseline) < 1
      out += sameBaseline || !out.endsWith('-') ? ` ${text}` : text
    }
    previousBaseline = baseline
  }
  return out.trim()
}

/**
 * 取一行涉及的字体。mupdf 不同版本把 font 放在 line 上或 line.spans[] 上，
 * 两种都认，取不到就返回空数组。
 *
 * @param {object} line 结构化文本里的一个 line。
 * @returns {object[]} 字体描述对象数组。
 */
function lineFonts(line) {
  if (line?.font !== undefined) return [line.font]
  if (Array.isArray(line?.spans)) return line.spans.map((span) => span?.font).filter(Boolean)
  return []
}

/**
 * 汇总一个块的排版特征。
 *
 * 这是标题判定的第二个信号来源。真实论文里正文表格常以数字开头
 * （实测：Table 3 里一行 "1 512 512 5.29 24.9 4 128 128 …"），单看文本形态
 * 必然误判成「§1」，后面半页的锚点就全错了。而标题在排版上几乎总是加粗或
 * 明显大于正文——这个信号比文本形态可靠得多。
 *
 * @param {object} block 结构化文本里的一个 text block。
 * @returns {{ bold: boolean, size: number | undefined }} 是否加粗、最大字号。
 */
function blockStyle(block) {
  const lines = block.lines ?? []
  let boldLines = 0
  let totalLines = 0
  let size
  for (const line of lines) {
    const fonts = lineFonts(line)
    if (fonts.length === 0) continue
    totalLines += 1
    if (fonts.some((font) => font?.weight === 'bold')) boldLines += 1
    for (const font of fonts) {
      if (typeof font?.size === 'number') size = size === undefined ? font.size : Math.max(size, font.size)
    }
  }
  return { bold: totalLines > 0 && boldLines * 2 > totalLines, size }
}

/**
 * 全篇的正文基准字号：整份文档里出现次数最多的字号。
 *
 * 用「出现次数最多」而不是平均值或中位数：正文永远占篇幅的大头，而平均值会被
 * 标题和脚注拉偏。
 *
 * 关键在于是**全篇**而不是逐页。逐页统计在图表页会失效：ViT（arXiv 2010.11929）
 * 第 18 页有 83 个块，绝大多数是坐标轴刻度，于是那一页的众数字号变成了刻度字号，
 * 图里的文字反而「比正文大」，被当成标题——实测得到两个 `§0` 的假锚点。
 * 通篇统计时正文始终占绝对多数，这个失败模式就不存在。
 *
 * 代价是导入时多走一遍页面解析。本机实测（Node v24.21.0，本地 SSD）：17 页的论文首次
 * 导入 127ms、31 页 247ms，都是两遍的总和；之后命中缓存。可以接受。
 *
 * @param {object} doc mupdf Document。
 * @param {number} pageCount 页数。
 * @returns {number | undefined} 基准字号；文档完全没有字体信息时返回 undefined。
 */
function documentBodyFontSize(doc, pageCount) {
  const counts = new Map()
  for (let index = 0; index < pageCount; index += 1) {
    const parsed = JSON.parse(doc.loadPage(index).toStructuredText('preserve-whitespace').asJSON())
    for (const block of parsed.blocks ?? []) {
      for (const line of block?.lines ?? []) {
        for (const font of lineFonts(line)) {
          if (typeof font?.size !== 'number') continue
          counts.set(font.size, (counts.get(font.size) ?? 0) + 1)
        }
      }
    }
  }
  let size
  let best = 0
  for (const [candidate, count] of counts) {
    // 票数相同时取更小的字号：正文通常比标题小，取小的一侧更保守
    if (count > best || (count === best && size !== undefined && candidate < size)) {
      size = candidate
      best = count
    }
  }
  return size
}

/**
 * 判定一个块是否为章节标题。
 *
 * 论文里标题形态很集中，所以用窄规则而非泛化启发式——宁可漏判（退化成沿用上
 * 一个标题），也不要误判（把正文句当成标题，锚点就错了）。
 *
 * 两个信号必须同时成立：
 *
 *   1. **文本形态**：编号（`3.2.1 …`）或常见标题词（`Abstract` / `References` …）。
 *      这条依赖 `joinLines` 已经补好了空格：真实论文里标题常被 mupdf 拆成
 *      `3.2.1` 与 `Scaled Dot-Product Attention` 两个 line 元素，拼错就永远匹配
 *      不上，而后果不是没有锚点，是**所有锚点都停在 Abstract**——比没有更糟。
 *   2. **排版特征**：加粗，或字号大于**全篇**正文基准字号。
 *
 * 第 2 条是实测逼出来的：Attention Is All You Need 的 Table 3 里有一行正文
 * `1 512 512 5.29 24.9 …`，纯文本规则会判成「§1」，于是第 9 页后半页的锚点
 * 全错。加上排版条件后它被正确排除，而同页真正的 `6.3 English Constituency
 * Parsing`（加粗、与正文同号）仍然识别得出来。
 *
 * 页面完全没有字体信息时（少数 PDF）退回到只看文本形态；这是刻意的：宁可
 * 冒误判的风险，也好过整篇只剩 `[p.N]`。
 *
 * @param {string} text 块文本。
 * @param {{ bold: boolean, size?: number }} style 排版特征。
 * @param {number | undefined} bodySize 全篇正文基准字号。
 * @param {boolean} inAppendix 是否已经进入参考文献/附录部分。
 * @returns {string | undefined} 归一化后的章节标签，非标题时返回 undefined。
 */
function headingLabel(text, style, bodySize, inAppendix) {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > 90) return undefined
  // 编号标题：1 / 1.2 / 3.2.1 后面跟内容。
  // 编号本身还要过一道校验：参考文献条目同样以数字加点开头（实测 SHINE 抽出
  // 过 §13839 与 §2022 两个假章节），而真实章节号的每一段都是两位以内。
  // 编号后面必须跟一个**词**，不能跟等号或纯数字：显示公式同样以编号或大写字母
  // 开头（附录里那行 `A = Reshape(T[t : t + I · r])` 就被当成过 §A），表格行
  // 「1 512 512 …」也长这样。判据是「这个词里至少有一个字母」——`M2P`、`1QA`、
  // `GPT-4` 这类带数字的名字要放行，`512` 与 `=` 要拦住。
  const hasLetter = (token) => /[A-Za-z\u4e00-\u9fff]/u.test(token)
  const numbered = /^(\d+(?:\.\d+)*)\.?\s+(\S+)/.exec(trimmed)
  const numberedLabel =
    numbered !== null && numbered[1].split('.').every((part) => part.length <= 2) && hasLetter(numbered[2])
      ? numbered[1]
      : undefined
  // 附录标题：A / A.1 / B.2.3 后面跟内容。
  // 两个限制缺一不可：
  //   1. **只在参考文献/附录之后启用**。字母编号是附录的排法，正文里加粗的
  //      "A" / "B" 几乎都是插图内的面板标签（实测 SHINE 在 §3.4 与 §3.5 之间就
  //      抽出了两个假章节）；
  //   2. **只在拿到排版信息时才认**，否则「A transformer consists of …」这种
  //      句首也会被当成 §A。
  const lettered = /^([A-Z](?:\.\d+)*)\.?\s+(\S+)/.exec(trimmed)
  const letteredLabel =
    inAppendix && bodySize !== undefined && lettered !== null && hasLetter(lettered[2])
      ? lettered[1]
      : undefined
  // 无编号的常见标题：**必须整行就是它**。
  // 放宽成前缀匹配会把表格表头认成标题——Table 2 的表头行 "Method Score" 加粗、
  // 比正文大，形态上与标题无异，于是第 8 页后半页的锚点全变成 §Method。
  // 宁可漏判（退化成沿用上一个标题），不可误判，这与锚点那一整套取舍一致。
  const named =
    /^(Abstract|Introduction|Related [Ww]ork|Background|Method(?:s|ology)?|Approach|Experiments?|Results?|Discussion|Conclusions?|Limitations|References|Acknowledg\w*|Appendix)[:.]?$/.exec(
      trimmed,
    )
  const label = numberedLabel ?? letteredLabel ?? named?.[1]
  if (label === undefined) return undefined
  if (bodySize === undefined) return label
  const emphasized =
    style.bold || (style.size !== undefined && style.size > bodySize + 0.5)
  return emphasized ? label : undefined
}

/**
 * 抽取一页的正文与结构化块。
 *
 * @param {object} page mupdf 页面对象。
 * @param {number | undefined} bodySize 全篇正文基准字号，用于标题判定。
 * @param {{ inAppendix: boolean }} state 跨页状态：是否已进入参考文献/附录。
 * @returns {{ text: string, blocks: { y: number, bbox: number[], text: string, heading?: string }[] }}
 */
function extractPage(page, bodySize, state) {
  const structured = page.toStructuredText('preserve-whitespace')
  const parsed = JSON.parse(structured.asJSON())
  const blocks = []
  for (const block of parsed.blocks ?? []) {
    if (block?.type !== 'text') continue
    const text = joinLines(block.lines)
    if (text.length === 0) continue
    const heading = headingLabel(text, blockStyle(block), bodySize, state.inAppendix)
    // 参考文献之后的字母编号按附录标题处理；顺序上先置位再走下一块
    if (state.inAppendix === false && (heading === 'References' || heading === 'Appendix')) {
      state.inAppendix = true
    }
    const box = block.bbox ?? {}
    blocks.push({
      y: Math.round(box.y ?? 0),
      bbox: [
        Math.round(box.x ?? 0),
        Math.round(box.y ?? 0),
        Math.round((box.x ?? 0) + (box.w ?? 0)),
        Math.round((box.y ?? 0) + (box.h ?? 0)),
      ],
      lines: (block.lines ?? []).length,
      text,
      ...(heading === undefined ? {} : { heading }),
    })
  }
  // 正文由块拼回来，而不是用 structured.asText()。两者文本内容一致，但 asText()
  // 保留 PDF 的硬折行，词与词之间会缺空格（真实论文里实测得到
  // "expected,bigger"）：既影响可读性，也让跨行的短语检索永远搜不到。
  // 块内的空格已经由 joinLines 补好。
  return { text: blocks.map((block) => block.text).join('\n\n'), blocks }
}

/**
 * 打开一份 PDF。
 *
 * @param {Buffer} bytes PDF 字节。
 * @returns {object} mupdf Document。
 */
function openDocument(bytes) {
  return mupdf.Document.openDocument(bytes, 'application/pdf')
}

/**
 * 读 PDF 内嵌元数据。论文经常什么都不写，所以每一项都可能缺失。
 *
 * @param {object} doc mupdf Document。
 * @returns {{ pdfTitle?: string, pdfAuthor?: string }} 只保留确实取到的字段。
 */
function documentMetadata(doc) {
  let info
  try {
    info = doc.getMetaData('info')
  } catch {
    info = undefined
  }
  const pick = (key) => {
    const fromInfo = info?.[key]
    if (typeof fromInfo === 'string' && fromInfo.trim().length > 0) return fromInfo.trim()
    try {
      const direct = doc.getMetaData(key)
      return typeof direct === 'string' && direct.trim().length > 0 ? direct.trim() : undefined
    } catch {
      return undefined
    }
  }
  const pdfTitle = pick('title')
  const pdfAuthor = pick('author')
  return {
    ...(pdfTitle === undefined ? {} : { pdfTitle }),
    ...(pdfAuthor === undefined ? {} : { pdfAuthor }),
  }
}

/**
 * 导入一篇论文到缓存。
 *
 * 幂等：同一份 PDF 重复导入直接复用已有缓存，不重新解析。
 *
 * @param {string} source PDF 的绝对路径。
 * @param {{ cacheRoot?: string }} [options] 缓存根目录覆盖。
 * @returns {{ docId: string, pageCount: number, cacheDir: string, reused: boolean,
 *   sourcePath: string, pdfTitle?: string, pdfAuthor?: string }}
 * @throws {Error} 文件不存在、不是 PDF、或解析失败时。
 */
export function importPaper(source, options = {}) {
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot()
  if (!existsSync(source)) {
    throw new Error(`找不到文件：${source}`)
  }
  const bytes = readFileSync(source)
  const docId = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
  const directory = paperDir(cacheRoot, docId)
  const metaPath = join(directory, 'meta.json')

  if (existsSync(metaPath)) {
    const cached = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (cached.format === CACHE_FORMAT) return { ...cached, reused: true }
    // 版本不符：当作没缓存，往下重新解析。旧的 pages/ 与 figures/ 会被同名覆盖，
    // 不同名（例如换了 dpi）的残留文件留着不删——删除不是这里该干的事。
  }

  let doc
  try {
    doc = openDocument(bytes)
  } catch (error) {
    throw new Error(`不是可解析的 PDF（${source}）：${error instanceof Error ? error.message : String(error)}`)
  }

  const pageCount = doc.countPages()
  if (pageCount === 0) throw new Error(`PDF 没有任何页面：${source}`)

  const pagesDir = join(directory, 'pages')
  mkdirSync(pagesDir, { recursive: true })

  // 标题判定要拿全篇的正文基准字号，所以先做一趟只统计字号的轻扫描
  const bodySize = documentBodyFontSize(doc, pageCount)
  // 跨页状态：参考文献之后的字母编号才算附录标题
  const state = { inAppendix: false }

  for (let index = 0; index < pageCount; index += 1) {
    const page = doc.loadPage(index)
    const { text, blocks } = extractPage(page, bodySize, state)
    const pageNumber = index + 1
    writeFileSync(join(pagesDir, `${pageName(pageNumber)}.txt`), text, 'utf8')
    writeFileSync(join(pagesDir, `${pageName(pageNumber)}.json`), JSON.stringify(blocks), 'utf8')
  }

  // 复制源 PDF：缓存因此自包含，用户移动或删除原文件后仍可渲染页面。
  writeFileSync(join(directory, 'source.pdf'), bytes)

  const meta = {
    format: CACHE_FORMAT,
    docId,
    pageCount,
    cacheDir: directory,
    sourcePath: source,
    importedAt: new Date().toISOString(),
    ...documentMetadata(doc),
  }
  // meta.json 最后写：它存在 == 这次导入完整。
  writeFileSync(metaPath, JSON.stringify(meta, undefined, 2), 'utf8')

  return { ...meta, reused: false }
}

/**
 * 读取已导入论文的元数据。
 *
 * @param {string} docId 导入时返回的 id。
 * @param {{ cacheRoot?: string }} [options] 缓存根目录覆盖。
 * @returns {object} meta.json 内容。
 * @throws {Error} 该 docId 没有导入记录时。
 */
export function readMeta(docId, options = {}) {
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot()
  const metaPath = join(paperDir(cacheRoot, docId), 'meta.json')
  if (!existsSync(metaPath)) {
    throw new Error(`没有这篇论文的导入记录：docId=${docId}。先用 paper_import 导入。`)
  }
  return JSON.parse(readFileSync(metaPath, 'utf8'))
}

/**
 * 解析页码表达式。
 *
 * 接受 `3`、`3-5`、`3,7,9-11` 三种形态的任意组合。
 *
 * @param {string} spec 页码表达式。
 * @param {number} pageCount 总页数，用于越界检查。
 * @returns {number[]} 升序去重的 1 基页码。
 * @throws {Error} 表达式无法解析或页码越界时。
 */
export function parsePages(spec, pageCount) {
  const text = String(spec).trim()
  if (text.length === 0) throw new Error('页码不能为空')
  const pages = new Set()
  for (const part of text.split(',')) {
    const chunk = part.trim()
    if (chunk.length === 0) continue
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(chunk)
    if (range !== null) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from > to) throw new Error(`页码范围反了：${chunk}`)
      for (let page = from; page <= to; page += 1) pages.add(page)
      continue
    }
    if (/^\d+$/.test(chunk)) {
      pages.add(Number(chunk))
      continue
    }
    throw new Error(`看不懂的页码写法：${chunk}（支持 3 / 3-5 / 3,7,9-11）`)
  }
  if (pages.size === 0) throw new Error(`页码表达式没有解析出任何页：${text}`)
  const sorted = [...pages].sort((a, b) => a - b)
  for (const page of sorted) {
    if (page < 1 || page > pageCount) {
      throw new Error(`页码 ${page} 越界，这篇论文共 ${pageCount} 页`)
    }
  }
  return sorted
}

/** 读取某一页的结构化块。 */
function readBlocks(cacheRoot, docId, page) {
  const path = join(paperDir(cacheRoot, docId), 'pages', `${pageName(page)}.json`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 读取某一页的正文。 */
function readPageText(cacheRoot, docId, page) {
  const path = join(paperDir(cacheRoot, docId), 'pages', `${pageName(page)}.txt`)
  return readFileSync(path, 'utf8')
}

/** 在命中位置附近截出片段。 */
function snippet(text, index, length) {
  const window = 70
  const from = Math.max(0, index - window)
  const to = Math.min(text.length, index + length + window)
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`
}

/**
 * 在已导入的论文里检索。
 *
 * 先做短语命中（大小写不敏感），一个都没有时退化成「所有词都出现」的宽松匹配。
 * 返回结果保持文档顺序，便于模型自行判断相关性。
 *
 * `context` 决定每条命中带多少上下文，直接影响问答要几个来回：
 *
 *   - `snippet`：命中位置前后各 70 字符。最省，但只够确认「这里提到了」。
 *   - `block`：命中所在的整个块。mupdf 的块粒度很不均匀（SHINE 上中位数只有
 *     33 字符），常常仍然不够判断。
 *   - `window`：命中块连同前后各最多 2 个块，累计约 700 字符。默认值——问答里
 *     绝大多数追问都发生在「只知道提到了、不知道上下文怎么讲」这一步，多给一
 *     段通常就省掉一次整页读取。
 *
 * @param {string} docId 论文 id。
 * @param {string} query 检索词。
 * @param {number} limit 最多返回多少条。
 * @param {{ cacheRoot?: string, context?: 'snippet' | 'block' | 'window' }} [options]
 *   缓存根目录、上下文档位。
 * @returns {{ docId: string, query: string, hits: object[], mode: 'phrase' | 'all-words' }}
 */
export function searchPaper(docId, query, limit, options = {}) {
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot()
  const meta = readMeta(docId, options)
  const context = options.context ?? 'window'
  const needle = String(query).trim().toLowerCase()
  if (needle.length === 0) throw new Error('检索词不能为空')
  const words = needle.split(/\s+/).filter((word) => word.length > 0)

  /** 走一遍全文，strict=true 只认短语命中。 */
  const scan = (strict) => {
    const hits = []
    let heading
    for (let page = 1; page <= meta.pageCount; page += 1) {
      const blocks = readBlocks(cacheRoot, docId, page)
      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index]
        if (block.heading !== undefined) heading = block.heading
        const haystack = block.text.toLowerCase()
        const at = haystack.indexOf(needle)
        const matched = at >= 0 || (!strict && words.every((word) => haystack.includes(word)))
        if (!matched) continue
        hits.push({
          page,
          section: heading,
          anchor: heading === undefined ? `[p.${page}]` : `[p.${page} §${heading}]`,
          text: contextText(blocks, index, context, at, needle.length),
        })
        if (hits.length >= limit) return hits
      }
    }
    return hits
  }

  const phraseHits = scan(true)
  if (phraseHits.length > 0) {
    return { docId, query, mode: 'phrase', hits: phraseHits }
  }
  return { docId, query, mode: 'all-words', hits: scan(false) }
}

/**
 * 按上下文档位组装一条命中的正文。
 *
 * @param {object[]} blocks 该页的全部块。
 * @param {number} index 命中块的下标。
 * @param {'snippet' | 'block' | 'window'} context 档位。
 * @param {number} at 命中词在块内的下标，未命中时为 -1。
 * @param {number} length 命中词长度。
 * @returns {string} 用于展示的文本。
 */
function contextText(blocks, index, context, at, length) {
  const block = blocks[index]
  if (context === 'snippet') return snippet(block.text, at >= 0 ? at : 0, at >= 0 ? length : 0)
  if (context === 'block') return block.text
  const budget = 700
  const parts = [block.text]
  let size = block.text.length
  let reachedStart = false
  let reachedEnd = false
  for (const step of [-1, 1, -2, 2]) {
    const neighbour = blocks[index + step]
    if (neighbour === undefined || size + neighbour.text.length > budget) continue
    if (step < 0) parts.unshift(neighbour.text)
    else parts.push(neighbour.text)
    size += neighbour.text.length
    if (step < 0) reachedStart = true
    else reachedEnd = true
  }
  return `${reachedStart ? '…' : ''}${parts.join(' ')}${reachedEnd ? '…' : ''}`
}

/**
 * 分页读取正文。
 *
 * @param {string} docId 论文 id。
 * @param {string} pagesSpec 页码表达式。
 * @param {number} maxChars 累计字符上限，超出即停止并如实报告截断。
 * @param {{ cacheRoot?: string }} [options] 缓存根目录覆盖。
 * @returns {{ docId: string, pages: object[], truncated: boolean, pagesNotRead: number[] }}
 */
export function readPages(docId, pagesSpec, maxChars, options = {}) {
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot()
  const meta = readMeta(docId, options)
  const wanted = parsePages(pagesSpec, meta.pageCount)

  const pages = []
  let budget = maxChars
  let truncated = false
  const pagesNotRead = []
  for (const page of wanted) {
    if (truncated) {
      pagesNotRead.push(page)
      continue
    }
    const text = readPageText(cacheRoot, docId, page)
    if (text.length > budget) {
      // 单页就超预算：给出前缀并如实说明，而不是悄悄截断
      pages.push({ page, text: text.slice(0, Math.max(0, budget)), truncated: true })
      truncated = true
      continue
    }
    pages.push({ page, text })
    budget -= text.length
  }
  return { docId, pages, truncated, pagesNotRead }
}

/**
 * 找出页面上像图注的块。
 *
 * 只做形态匹配，不做语义判断：`Figure 3:` / `Fig. 2.` / `Table 1 ` 这类。
 *
 * @param {object[]} blocks 该页的结构化块。
 * @returns {string[]} 图注文本。
 */
export function captionsOf(blocks) {
  return captionBlocks(blocks).map((caption) => caption.text)
}

/**
 * 图注的形态。编号后必须紧跟冒号或句点：少了这个条件，正文里
 * 「Figure 7 visualizes …」这类引用也会被当成图注。
 */
const CAPTION_PATTERN = /^(Figure|Fig\.?|Table)\s*(\d+[a-z]?)\s*[:.]/i

/**
 * 找出页面上像图注的块，并解析出编号与类别。
 *
 * 比 `captionsOf` 多给三样后面要用到的东西：是图还是表（决定图形在图注的哪
 * 一侧）、编号（生成 `Fig.5` 这种锚点与文件名）、bbox（判断图注在哪一栏）。
 *
 * 还要把**折行的图注接回去**。mupdf 按视觉行分块，长的图注会被拆成两个块，第
 * 二行在下、而且是普通的文字块——不合并的话，图注自己的第二行会被当成图形内
 * 容：SHINE 第 30 页 Table 11 的「evaluation.」与第 9 页 Figure 9 的第二行都
 * 是这样，两次都把开区间算错。顺带一个好处：传给模型的图注文本是完整的。
 *
 * 合并条件四条，任何一条不满足就停：紧贴（间距 ≤ 5pt）、在同一栏（x 区间有重
 * 叠）、本身不是图注、也不是章节标题。
 *
 * @param {object[]} blocks 该页的结构化块。
 * @returns {{ kind: 'figure' | 'table', label: string, text: string, bbox: number[] }[]}
 *   按页面顺序排列的图注。
 */
export function captionBlocks(blocks) {
  const found = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const match = CAPTION_PATTERN.exec(block.text)
    if (match === null) continue
    const kind = /^Table/i.test(match[1]) ? 'table' : 'figure'
    const prefix = kind === 'table' ? 'Table' : 'Fig.'
    let bbox = Array.isArray(block.bbox) ? [...block.bbox] : [0, block.y ?? 0, 0, block.y ?? 0]
    let text = block.text
    for (let next = index + 1; next < blocks.length; next += 1) {
      const following = blocks[next]
      const followingBox = following.bbox
      if (!Array.isArray(followingBox)) break
      if (following.heading !== undefined || CAPTION_PATTERN.test(following.text)) break
      if (followingBox[1] < bbox[3] - 2 || followingBox[1] - bbox[3] > 5) break
      if (followingBox[2] < bbox[0] || followingBox[0] > bbox[2]) break
      bbox = [
        Math.min(bbox[0], followingBox[0]),
        bbox[1],
        Math.max(bbox[2], followingBox[2]),
        Math.max(bbox[3], followingBox[3]),
      ]
      text = `${text} ${following.text}`
      index = next
    }
    found.push({ kind, label: `${prefix}${match[2]}`, text, bbox })
  }
  return found
}

/* ------------------------------------------------------------------ *
 * 图形区域检测
 *
 * 目标：给定一个 `Figure N:` 图注，找出它对应的那块画面在页面上的矩形，用于
 * 裁切。做法分四步，每一步都只依赖已经落盘或可复算的信息：
 *
 *   1. **候选区域**：走一遍页面的 display list，收集所有图片与矢量路径的 bbox。
 *      论文里的插图绝大多数是矢量图（matplotlib 输出），不走这一步就只剩
 *      「整页截图」一条路——那正是这个功能要取代的东西。
 *   2. **归属**：一个图注只认「中心落在它所在栏、且在正确一侧、距离足够近」的
 *      候选区域。先按栏选，再按侧选，最后按距离选。并排的两张图因此各自得到
 *      自己那一栏，而不是被并成一张。
 *   3. **收紧**：把候选区域的并集渲染成像素，按墨迹（非白像素）的行列分布把
 *      空白边裁掉。坐标轴刻度是**文字**，不在 display list 的图形项里，收紧
 *      之前先向四周放宽一段余量，让刻度与轴标签重新落进框内。
 *   4. **排除图注**：前三步都是启发式、都会算错，算错的表现就是图的下缘挂着半行
 *      说明文字。所以最后统一按该页图注块的 bbox 削一遍（`excludeCaptions`），
 *      保证图里不出现图注文字；图注原文单独交给上层写进报告。
 *
 * 刻意不做的事：不猜语义、不识别「这是流程图还是折线图」。检测不出来就如实
 * 报告为 undetected，由上层用 `crop` 传 bbox 手动裁——宁可让人看到一次失败，
 * 也不要给一张裁掉一半的图。
 * ------------------------------------------------------------------ */

/** 检测用渲染分辨率。只用于求墨迹分布，不落盘，与最终裁切的 dpi 无关。 */
const PROFILE_DPI = 100

/**
 * figures.json 的格式版本，与 CACHE_FORMAT 分开：它只是检测结果的缓存。
 *
 * 2：检测结果开始保证「裁切框不与任何图注文字相交」，旧缓存必须重算。
 */
const FIGURES_FORMAT = 2

/** 判断「图注紧挨着的那一小段里有什么」时取的窗口高度，单位点。 */
const NEAR_WINDOW = 26

/** 裁切框与图注之间必须留出的空隙，单位点。 */
const CAPTION_GAP = 2

/** 排除图注后允许的最小裁切高度；再小就不是一张图了。 */
const MIN_CROP_HEIGHT = 8

/**
 * 把候选矩形裁到不与任何图注文字相交。
 *
 * 这是「图里不许出现图注」这条硬要求的最后一道闸：前面的归属与收紧都是启发式，
 * 会算错；而图注的 bbox 是结构化文本给的，基本不会错。所以不管上游怎么算，
 * 这里统一按图注矩形削一遍——图注在裁切框下半部就压底边，在上半部就抬顶边。
 *
 * 削不动（排除后不足 `MIN_CROP_HEIGHT`）时抛错而不是退回原框：宁可让调用方看到
 * 一次明确的失败，也不要给一张「图注占了一半」的图。
 *
 * @param {number[]} rect 候选矩形 `[x0, y0, x1, y1]`。
 * @param {{ kind: string, label: string, bbox: number[] }[]} captions 该页的图注块。
 * @returns {{ bbox: number[], clipped: object[] }} 收紧后的矩形与被排除的图注。
 * @throws {Error} 排除后剩余高度不足时。
 */
function excludeCaptions(rect, captions) {
  let [x0, y0, x1, y1] = rect
  const clipped = []
  for (const caption of captions) {
    const box = caption.bbox
    if (!Array.isArray(box)) continue
    if (Math.min(x1, box[2]) - Math.max(x0, box[0]) <= 0) continue
    if (Math.min(y1, box[3]) - Math.max(y0, box[1]) <= 0) continue
    const below = (box[1] + box[3]) / 2 >= (y0 + y1) / 2
    const nextTop = below ? y0 : Math.max(y0, box[3] + CAPTION_GAP)
    const nextBottom = below ? Math.min(y1, box[1] - CAPTION_GAP) : y1
    if (nextBottom - nextTop < MIN_CROP_HEIGHT) {
      throw new Error(
        `裁切框与图注 ${caption.label} 重叠，排除后不足 ${MIN_CROP_HEIGHT}pt，无法裁出一张不含图注的图；` +
          '请把 bbox 改到只框图形本体，或改用 pages 渲染整页。',
      )
    }
    y0 = nextTop
    y1 = nextBottom
    clipped.push(caption)
  }
  return { bbox: [x0, y0, x1, y1], clipped }
}

/**
 * 找出与给定矩形相关的图注：横向有重叠、纵向距离在 `maxGap` 以内。
 *
 * 用途是「裁切框已经排除了图注文字，但图注内容仍要写进报告」：图注原文由这个
 * 函数单独取出来交给模型，放在图片下方。图注在图形上方（表的常见排法）还是下方
 * 由 `side` 标明。
 *
 * @param {string} docId 论文 id。
 * @param {number} page 页码（1 基）。
 * @param {number[]} bbox 矩形 `[x0, y0, x1, y1]`。
 * @param {{ cacheRoot?: string, maxGap?: number }} [options] 缓存根、最大纵向距离。
 * @returns {{ label: string, kind: string, anchor: string, text: string, side: string }[]}
 *   按距离由近到远排列。
 */
export function captionsNear(docId, page, bbox, options = {}) {
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot()
  const maxGap = options.maxGap ?? 48
  return captionBlocks(readBlocks(cacheRoot, docId, page))
    .map((caption) => {
      const box = caption.bbox
      const overlap = Math.min(bbox[2], box[2]) - Math.max(bbox[0], box[0])
      const gap = box[1] >= bbox[3] ? box[1] - bbox[3] : bbox[1] - box[3]
      return { caption, overlap, gap }
    })
    .filter((item) => item.overlap > 0 && item.gap <= maxGap)
    .sort((a, b) => a.gap - b.gap)
    .map(({ caption, gap }) => ({
      label: caption.label,
      kind: caption.kind,
      anchor: `[p.${page} ${caption.label}]`,
      text: caption.text,
      side: gap >= 0 ? (caption.bbox[1] >= bbox[3] ? 'below' : 'above') : 'overlap',
    }))
}

/** 向量坐标变换：mupdf 的矩阵是 [a, b, c, d, e, f]。 */
function transformPoint(matrix, x, y) {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]
}

/** 把一个矩形经矩阵变换后，取它的轴对齐外接矩形。 */
function transformRect(matrix, [x0, y0, x1, y1]) {
  const points = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ].map(([x, y]) => transformPoint(matrix, x, y))
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** 两个矩形是否在 x 与 y 上都留有余量地相邻或相交。 */
function rectsNear(a, b, gap) {
  return !(a[2] + gap < b[0] || b[2] + gap < a[0] || a[3] + gap < b[1] || b[3] + gap < a[1])
}

/** 矩形并集。 */
function unionRect(rects) {
  return rects.reduce(
    (accumulated, rect) => [
      Math.min(accumulated[0], rect[0]),
      Math.min(accumulated[1], rect[1]),
      Math.max(accumulated[2], rect[2]),
      Math.max(accumulated[3], rect[3]),
    ],
    [...rects[0]],
  )
}

/** 矩形面积。 */
function rectArea(rect) {
  return Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1])
}

/** 把矩形夹进另一个矩形；输入 undefined 时原样返回，方便串在检测流程里。 */
function clampRect(rect, limit) {
  if (rect === undefined) return undefined
  return [
    Math.max(rect[0], limit[0]),
    Math.max(rect[1], limit[1]),
    Math.min(rect[2], limit[2]),
    Math.min(rect[3], limit[3]),
  ]
}

/**
 * 页面上所有「像图形」的矩形：图片与矢量路径的 bbox。
 *
 * 过滤掉三类必然不是插图的项：
 *   - 越过页面边界超过 5pt 的（裁剪路径会给出负坐标或超大范围）；
 *   - 覆盖整页的（很多 PDF 会画一个页面大小的白底或底色矩形）；
 *   - 又宽又薄的横线、又高又竖的竖线（页眉页脚的分隔线）。最后这条会连带
 *     丢掉某些图的坐标轴边框，但轴边框只有 1pt 粗，框的范围由其它图元决定，
 *     收紧阶段又按墨迹把边界找回来，所以没有影响。
 *
 * @param {object} page mupdf 页面对象。
 * @param {number[]} bounds 页面 bbox（点）。
 * @returns {number[][]} 候选矩形数组。
 */
function displayListBoxes(page, bounds) {
  const [pageX0, pageY0, pageX1, pageY1] = bounds
  const pageWidth = pageX1 - pageX0
  const pageHeight = pageY1 - pageY0
  const candidates = []
  const push = (rect) => {
    const clipped = [
      Math.max(pageX0, rect[0]),
      Math.max(pageY0, rect[1]),
      Math.min(pageX1, rect[2]),
      Math.min(pageY1, rect[3]),
    ]
    const overshoot = Math.max(
      pageX0 - rect[0],
      pageY0 - rect[1],
      rect[2] - pageX1,
      rect[3] - pageY1,
      0,
    )
    if (overshoot > 5) return
    const width = clipped[2] - clipped[0]
    const height = clipped[3] - clipped[1]
    if (width < 2 || height < 2) return
    if (width > 0.95 * pageWidth && height > 0.95 * pageHeight) return
    if (height <= 2 && width >= 0.5 * pageWidth) return
    if (width <= 2 && height >= 0.5 * pageHeight) return
    candidates.push(clipped)
  }
  const identity = [1, 0, 0, 1, 0, 0]
  const device = new mupdf.Device({
    fillImage(image, ctm) {
      push(transformRect(ctm, [0, 0, image.getWidth(), image.getHeight()]))
    },
    fillImageMask(image, ctm) {
      push(transformRect(ctm, [0, 0, image.getWidth(), image.getHeight()]))
    },
    fillPath(path, _evenOdd, ctm) {
      push(transformRect(ctm, path.getBounds(null, identity)))
    },
    strokePath(path, stroke, ctm) {
      push(transformRect(ctm, path.getBounds(stroke, identity)))
    },
  })
  page.toDisplayList().run(device, identity)
  return candidates
}

/**
 * 推断页面的文字分栏，返回若干条纵向条带。
 *
 * 并排的两张图靠这一步分开：图注在哪一栏，图形就在哪一栏。
 *
 * 判据是**左边缘**而不是 x 区间重叠。教训来自 SHINE 第 7 页：跨栏的标题与页眉
 * 横跨两栏，按区间归并会把整页并成一条，并排的 Figure 5 与 Figure 7 于是一起
 * 被认走，再互相挤掉可用空间，两张都判成失败。左边缘不会：两栏文字的左边缘各
 * 自聚成一簇，跨栏块只是把它们自己的左边缘投进其中一簇。
 *
 * 跨栏块不参与列宽计算（否则会把所在栏的右边界撑到页面对面），只参与定左边缘。
 * 单栏论文里窄块占比很低，会退回到整幅正文宽度。
 *
 * 另外要先把**图形内部的文字**剔出去。坐标轴刻度、轴标签在结构化文本里就是普
 * 通的文字块，SHINE 第 7 页的 x 左边缘直方图里它们比正文还多，分栏会被拆成一
 * 堆假簇。判据很直接：中心落在图形候选区域里的文字块不算分栏依据。
 *
 * @param {object[]} blocks 该页的结构化块。
 * @param {number[]} bounds 页面 bbox（点）。
 * @param {number[][]} [graphics] 该页的图形候选区域。
 * @returns {{ columns: number[][], extent: number[] }} 分栏条带，以及正文的横向范围。
 */
function textColumns(blocks, bounds, graphics = []) {
  const pageX0 = bounds[0]
  const pageX1 = bounds[2]
  const pageWidth = pageX1 - pageX0
  const insideGraphics = (bbox) => {
    const centerX = (bbox[0] + bbox[2]) / 2
    const centerY = (bbox[1] + bbox[3]) / 2
    return graphics.some(
      (box) => centerX > box[0] - 6 && centerX < box[2] + 6 && centerY > box[1] - 6 && centerY < box[3] + 6,
    )
  }
  const intervals = blocks
    .map((block) => block.bbox)
    .filter((bbox) => Array.isArray(bbox) && bbox[2] - bbox[0] > 4 && !insideGraphics(bbox))
    .map((bbox) => [bbox[0], bbox[2]])
  if (intervals.length === 0) return { columns: [[pageX0, pageX1]], extent: [pageX0, pageX1] }
  // 正文横向范围单独算，不从分栏条带推。图上文字被剔掉之后，分栏可能只剩很窄
  // 的一条（SHINE 第 26 页的分栏只剩 168pt），拿它当「整幅正文」会让跨栏的图注
  // 判定失真。
  const extent = [Math.min(...intervals.map(([x0]) => x0)), Math.max(...intervals.map(([, x1]) => x1))]

  // 单栏论文里几乎每个块都是宽块，此时不能把宽块全丢掉，否则没有块可用
  const narrow = intervals.filter(([x0, x1]) => x1 - x0 <= 0.6 * pageWidth)
  const pool = narrow.length >= Math.max(3, 0.3 * intervals.length) ? narrow : intervals

  const sorted = [...pool].sort((a, b) => a[0] - b[0])
  const groups = []
  for (const [x0, x1] of sorted) {
    const last = groups[groups.length - 1]
    // 以簇的左边缘为基准而不是「上一个块」：缩进会缓缓右移，基准跟着漂移会把
    // 两栏连起来
    if (last !== undefined && x0 <= last.left + 20) {
      last.x0 = Math.min(last.x0, x0)
      last.x1 = Math.max(last.x1, x1)
      last.count += 1
    } else {
      groups.push({ left: x0, x0, x1, count: 1 })
    }
  }

  const supported = groups.filter(
    (group) => group.count >= Math.max(2, 0.04 * pool.length) && group.x1 - group.x0 >= 0.15 * pageWidth,
  )
  if (supported.length === 0) return { columns: [[extent[0], extent[1]]], extent }
  supported.sort((a, b) => a.x0 - b.x0)
  const merged = []
  for (const group of supported) {
    const last = merged[merged.length - 1]
    if (last !== undefined && group.x0 <= last.x1 + 6) last.x1 = Math.max(last.x1, group.x1)
    else merged.push([group.x0, group.x1])
  }
  return { columns: merged, extent }
}

/**
 * 图注所属的栏：取与图注 x 区间重叠最多的那条分栏。
 *
 * @param {number[]} captionBox 图注 bbox。
 * @param {number[][]} columns 分栏条带。
 * @returns {number[]} [x0, x1]。
 */
function columnOf(captionBox, columns) {
  let best
  let bestOverlap = 0
  for (const column of columns) {
    const overlap = Math.min(captionBox[2], column[1]) - Math.max(captionBox[0], column[0])
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = column
    }
  }
  return best ?? columns[0]
}

/**
 * 渲染一页用于求墨迹分布。
 *
 * @param {object} page mupdf 页面对象。
 * @param {number} dpi 分辨率。
 * @returns {{ pixels: Uint8ClampedArray, width: number, height: number, stride: number, scale: number }}
 */
function renderProfile(page, dpi) {
  const scale = dpi / 72
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
  return {
    pixels: pixmap.getPixels(),
    width: pixmap.getWidth(),
    height: pixmap.getHeight(),
    stride: pixmap.getStride(),
    scale,
  }
}

/** 一个像素是否算「墨迹」：离纯白有足够距离，这样浅色/彩色图元也能算进来。 */
function isInk(pixels, offset) {
  return 765 - (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) > 40
}

/**
 * 按墨迹把一个矩形收紧到实际有内容的范围。
 *
 * 先向四周放宽 `margin` 点（让坐标轴刻度、轴标签这些不在 display list 图形项
 * 里的文字重新进框），再逐行逐列找第一条/最后一条墨迹，最后留 `pad` 点内边距。
 *
 * @param {number[]} box 候选矩形（点）。
 * @param {object} profile `renderProfile` 的产物。
 * @param {{ margin?: number, pad?: number, limit?: number[] }} [options]
 *   `limit` 是不许越过的 rectangle：图形不得压到图注或相邻图注上。
 * @returns {number[] | undefined} 收紧后的矩形；整框没有墨迹时返回 undefined。
 */
function trimToInk(box, profile, options = {}) {
  const margin = options.margin ?? 12
  const pad = options.pad ?? 3
  const limit = options.limit
  const scale = profile.scale
  let outer = [box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin]
  if (limit !== undefined) {
    outer = [
      Math.max(outer[0], limit[0]),
      Math.max(outer[1], limit[1]),
      Math.min(outer[2], limit[2]),
      Math.min(outer[3], limit[3]),
    ]
  }
  outer = [
    Math.max(0, outer[0]),
    Math.max(0, outer[1]),
    Math.min(profile.width / scale, outer[2]),
    Math.min(profile.height / scale, outer[3]),
  ]
  const x0 = Math.max(0, Math.floor(outer[0] * scale))
  const y0 = Math.max(0, Math.floor(outer[1] * scale))
  const x1 = Math.min(profile.width, Math.ceil(outer[2] * scale))
  const y1 = Math.min(profile.height, Math.ceil(outer[3] * scale))
  if (x1 - x0 < 2 || y1 - y0 < 2) return undefined

  const rowInk = new Int32Array(y1 - y0)
  const columnInk = new Int32Array(x1 - x0)
  let anyInk = false
  for (let y = y0; y < y1; y += 1) {
    const rowOffset = y * profile.stride
    for (let x = x0; x < x1; x += 1) {
      const offset = rowOffset + x * 3
      if (!isInk(profile.pixels, offset)) continue
      anyInk = true
      rowInk[y - y0] += 1
      columnInk[x - x0] += 1
    }
  }
  if (!anyInk) return undefined

  // 阈值取 1：抗锯齿的孤立噪点很少，而漏掉一条细轴线的代价比多留几像素大
  const firstRow = rowInk.findIndex((count) => count > 1)
  let lastRow = rowInk.length - 1
  while (lastRow > 0 && rowInk[lastRow] <= 1) lastRow -= 1
  const firstColumn = columnInk.findIndex((count) => count > 1)
  let lastColumn = columnInk.length - 1
  while (lastColumn > 0 && columnInk[lastColumn] <= 1) lastColumn -= 1
  if (firstRow < 0 || firstColumn < 0 || lastRow < firstRow || lastColumn < firstColumn) return undefined

  const trimmed = [
    (x0 + firstColumn) / scale - pad,
    (y0 + firstRow) / scale - pad,
    (x0 + lastColumn + 1) / scale + pad,
    (y0 + lastRow + 1) / scale + pad,
  ]
  return [
    Math.max(outer[0], trimmed[0]),
    Math.max(outer[1], trimmed[1]),
    Math.min(outer[2], trimmed[2]),
    Math.min(outer[3], trimmed[3]),
  ]
}

/**
 * 统计一个矩形内的墨迹像素占比。
 *
 * 用途是判断「图注紧挨着的那一小段里有没有内容」。要的是窗口内的占比而不是整
 * 个候选框：SHINE 第 23 页的 Table 6 与 Table 7 上下紧挨，看整框会把上一张表
 * 当成下一张图的图形。
 *
 * @param {object} profile `renderProfile` 的产物。
 * @param {number[]} box 矩形（点）。
 * @returns {number} 墨迹像素 / 总像素，0 到 1。
 */
function inkFraction(profile, box) {
  const scale = profile.scale
  const x0 = Math.max(0, Math.floor(box[0] * scale))
  const x1 = Math.min(profile.width, Math.ceil(box[2] * scale))
  const y0 = Math.max(0, Math.floor(box[1] * scale))
  const y1 = Math.min(profile.height, Math.ceil(box[3] * scale))
  if (x1 - x0 < 2 || y1 - y0 < 2) return 0
  let count = 0
  for (let y = y0; y < y1; y += 1) {
    const rowOffset = y * profile.stride
    for (let x = x0; x < x1; x += 1) {
      if (isInk(profile.pixels, rowOffset + x * 3)) count += 1
    }
  }
  return count / ((x1 - x0) * (y1 - y0))
}

/**
 * 检测一篇论文里所有图注对应的画面矩形。
 *
 * 结果按论文写入 `figures.json`（`FIGURES_FORMAT` 版本号不符就重算并覆盖），
 * 因为这一步要为每个带图注的页面渲染一次求墨迹分布，重复做没有意义。
 *
 * @param {string} docId 论文 id。
 * @param {{ cacheRoot?: string }} [options] 缓存根目录覆盖。
 * @returns {{ docId: string, profileDpi: number, figures: object[], undetected: object[], reused: boolean }}
 */
export function detectFigures(docId, options = {}) {
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot()
  const meta = readMeta(docId, options)
  const directory = paperDir(cacheRoot, docId)
  const cachePath = join(directory, 'figures.json')
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
    if (cached.format === FIGURES_FORMAT && cached.profileDpi === PROFILE_DPI) {
      return { ...cached, docId, reused: true }
    }
  }

  const doc = openDocument(readFileSync(join(directory, 'source.pdf')))
  const figures = []
  const undetected = []
  for (let page = 1; page <= meta.pageCount; page += 1) {
    const blocks = readBlocks(cacheRoot, docId, page)
    const captions = captionBlocks(blocks)
    if (captions.length === 0) continue
    const mupdfPage = doc.loadPage(page - 1)
    const bounds = mupdfPage.getBounds()
    const profile = renderProfile(mupdfPage, PROFILE_DPI)
    const graphics = displayListBoxes(mupdfPage, bounds)
    const { columns, extent: textX } = textColumns(blocks, bounds, graphics)
    const textWidth = Math.max(1, textX[1] - textX[0])
    const pageHeight = bounds[3] - bounds[1]

    // 页眉页脚：页面最上（最下）的一整行文字。arXiv 每页都重印一遍标题，它离
    // 图的顶边往往只有几个点，收紧时的 12pt 放宽余量必然把它带进来。
    // 候选框先夹进「正文区」，页眉就不会进入裁剪框。
    const wideBlocks = blocks.filter(
      (block) =>
        Array.isArray(block.bbox) && block.text.length >= 40 && block.bbox[2] - block.bbox[0] >= 0.6 * textWidth,
    )
    const header = wideBlocks
      .filter((block) => block.bbox[1] < bounds[1] + 0.15 * pageHeight)
      .sort((a, b) => a.bbox[1] - b.bbox[1])[0]
    const footer = wideBlocks
      .filter((block) => block.bbox[3] > bounds[3] - 0.12 * pageHeight)
      .sort((a, b) => b.bbox[3] - a.bbox[3])[0]
    const bodyTop = header === undefined ? bounds[1] : header.bbox[3]
    const bodyBottom = footer === undefined ? bounds[3] : footer.bbox[1]
    const candidates = graphics
      .map((rect) => [rect[0], Math.max(rect[1], bodyTop), rect[2], Math.min(rect[3], bodyBottom)])
      .filter((rect) => rect[3] - rect[1] >= 2)

    // 每个图注先在「整幅正文」与「图注所在栏」之间选一条 x 条带。
    // 图注自己跨度够大（占正文宽度 60% 以上）就按整幅算：纯表格页上文字块大多
    // 是数字，分栏统计本来就不可靠，而跨栏的图注自己就是最好的证据。
    const textBand = [textX[0] - 6, textX[1] + 6]
    const bands = captions.map((caption) => {
      if (caption.bbox[2] - caption.bbox[0] >= 0.6 * textWidth) return textBand
      const column = columnOf(caption.bbox, columns)
      return [column[0] - 6, column[1] + 6]
    })

    /**
     * 在指定一侧认领候选区域。
     *
     * 纵向边界只由**同一栏、且在正确一侧**的相邻图注决定。用整页宽度做 x 判断
     * 会出事：SHINE 第 7 页的 Figure 5 与 Figure 7 并排，两个图注只差 4pt，右栏
     * 的图注于是把左栏图的上界压到自己的下沿，左栏整张图被判成「没有空间」。
     */
    const claimOn = (caption, index, down, proseBound) => {
      const edge = down ? caption.bbox[3] : caption.bbox[1]
      const band = bands[index]
      let yTop = bounds[1]
      let yBottom = bounds[3]
      captions.forEach((other, otherIndex) => {
        if (other === caption) return
        const otherBand = bands[otherIndex]
        if (otherBand[1] < band[0] || otherBand[0] > band[1]) return
        if (down) {
          if (other.bbox[1] >= caption.bbox[3]) yBottom = Math.min(yBottom, other.bbox[1])
        } else if (other.bbox[3] <= caption.bbox[1]) {
          yTop = Math.max(yTop, other.bbox[3])
        }
      })
      // 兜底方向的远端不能越过一段正文或一个章节标题。惯例一侧有相邻图注当着
      // 上界（图形总在两张图注之间），而兜底那一侧要一路顶到上一个图注，中间夹
      // 着的整段正文会被一并扫进来——SHINE 第 30 页 Table 11 图注在表下方，往上
      // 找时中间隔着 E.5 那一节的两个段落。
      //
      // **只有兜底一侧才加这道边界。** 两侧都加会误伤表格：表格整行的内容块也
      // 可能满足下面的判据，边界于是落在表格中间，SHINE 上实测有 6 张表被截断或
      // 判失败。
      //
      // 「像正文」的判据是**每行字符数**，不是长度加宽度。表格的一整行会被
      // mupdf 并成一个块，它同样又长又满宽（Table 11 的行块 87 字、267pt 宽），
      // 拿长度宽度当判据会把表格自己当成正文，把可用空间压成 7pt。
      if (proseBound) {
        for (const block of blocks) {
          const bbox = block.bbox
          if (!Array.isArray(bbox)) continue
          const centerX = (bbox[0] + bbox[2]) / 2
          if (centerX < band[0] || centerX > band[1]) continue
          const charsPerLine = block.text.length / Math.max(1, block.lines ?? 1)
          const prose = block.text.length >= 60 && bbox[2] - bbox[0] >= 0.5 * textWidth && charsPerLine >= 45
          if (block.heading === undefined && !prose) continue
          if (down) {
            if (bbox[1] >= edge) yBottom = Math.min(yBottom, bbox[1])
          } else if (bbox[3] <= edge) {
            yTop = Math.max(yTop, bbox[3])
          }
        }
      }
      const reach = down ? yBottom - edge : edge - yTop
      const owned = candidates.filter((rect) => {
        const centerX = (rect[0] + rect[2]) / 2
        if (centerX < band[0] || centerX > band[1]) return false
        const centerY = (rect[1] + rect[3]) / 2
        const distance = down ? centerY - edge : edge - centerY
        if (distance < -4 || distance > reach || distance > 0.45 * (bounds[3] - bounds[1])) return false
        return true
      })
      return { caption, down, edge, band, owned, yTop, yBottom }
    }

    // 按排版惯例各认一侧：图注在图形下方（图形在上），表注在表格上方（表格在
    // 下）。惯例那一侧拿不出合格结果时才试另一侧——SHINE 第 30 页的 Table 11 就
    // 把表注放在表格下方，只认惯例会整个漏掉。
    const pairs = captions.map((caption, index) => {
      const priorDown = caption.kind === 'table'
      return {
        prior: claimOn(caption, index, priorDown, false),
        alternative: claimOn(caption, index, !priorDown, true),
      }
    })

    // 跨栏补齐：给「跨栏图形但图注较窄」补上另一半。
    // 判据是那些中心在别的栏、却与已被认领区域同一水平带、又没有被任何其它
    // 图注认领的候选。并排的两张图不会互相补，因为对方那一栏有主。
    const allClaims = pairs.flatMap((pair) => [pair.prior, pair.alternative])
    for (const claim of allClaims) {
      const spansAllColumns = claim.band[0] <= textX[0] + 6 && claim.band[1] >= textX[1] - 6
      if (spansAllColumns || claim.owned.length === 0) continue
      const claimed = new Set(
        allClaims
          .filter((other) => other.caption !== claim.caption)
          .flatMap((other) => other.owned),
      )
      const selfBox = unionRect(claim.owned)
      const neighbors = candidates.filter(
        (rect) =>
          !claimed.has(rect) &&
          !claim.owned.includes(rect) &&
          rectsNear(selfBox, rect, 25) &&
          rect[1] < selfBox[3] + 8 &&
          rect[3] > selfBox[1] - 8,
      )
      claim.owned = [...claim.owned, ...neighbors]
    }

    /** 把一次认领收紧成一个矩形；拿不出可用结果时返回 undefined。 */
    const resolve = (claim) => {
      const { down, edge, owned, band, yTop, yBottom } = claim
      // 横向边界：认领到图形就跟着图形走（允许 ±10pt 让轴标签进框），一个都没
      // 认领到就退回图注所在的 x 条带。用整幅正文当横向上界会让右栏的表把左栏
      // 的表一起框进来——SHINE 第 9 页的 Table 5 就是这么混进 Table 4 的。
      const seed = owned.length > 0 ? unionRect(owned) : undefined
      const limitBox = [
        Math.max(textX[0] - 10, Math.min(band[0], seed === undefined ? band[0] : seed[0] - 10)),
        down ? edge : yTop,
        Math.min(textX[1] + 10, Math.max(band[1], seed === undefined ? band[1] : seed[2] + 10)),
        down ? yBottom : edge,
      ]
      if (limitBox[3] - limitBox[1] <= 10) return undefined
      let trimmed = clampRect(
        trimToInk(clampRect(seed ?? limitBox, limitBox), profile, { limit: limitBox }),
        limitBox,
      )
      if (trimmed === undefined || rectArea(trimmed) < 2000) return undefined
      // 页眉/页脚：收紧后的框如果还压在页眉上，把它削掉。
      // 有图形证据时，条件是页眉整体落在图形区域之外（`seed` 之上 / 之下），这
      // 样图内部的宽标题不会被误削。没有图形证据时（纯矢量图或表格），改用「宽
      // 度接近整栏」当条件——页眉横跨整栏，而表格的表头行只跨表格宽度。
      if (header !== undefined && trimmed[1] < header.bbox[3]) {
        const outsideSeed =
          seed === undefined
            ? header.bbox[2] - header.bbox[0] >= 0.75 * textWidth
            : header.bbox[3] <= seed[1] + 3
        if (outsideSeed) trimmed[1] = header.bbox[3] + 1
      }
      if (
        seed !== undefined &&
        footer !== undefined &&
        footer.bbox[1] >= seed[3] - 3 &&
        trimmed[3] > footer.bbox[1]
      ) {
        trimmed[3] = footer.bbox[1] - 1
      }
      // 与图注之间的空档：贴不到图注上的，就不是这个图注的图形
      const gap = down ? Math.max(0, trimmed[1] - edge) : Math.max(0, edge - trimmed[3])
      return { trimmed, gap }
    }

    for (const { prior, alternative } of pairs) {
      const caption = prior.caption
      const options = [
        {
          result: resolve(prior),
          detection: prior.owned.length > 0 ? 'display-list' : 'caption-band',
        },
        {
          result: resolve(alternative),
          detection: alternative.owned.length > 0 ? 'display-list' : 'caption-band',
        },
      ]
      const rank = (option) => {
        if (option.result === undefined) return 0
        const { gap, trimmed } = option.result
        return gap <= 16 && trimmed[2] - trimmed[0] >= 0.25 * textWidth ? 2 : 1
      }
      // 用「图注紧挨着的那一小段里有什么」决定信哪一侧，而不是拿整框去比。
      // 惯例一侧（图注在下、表注在上）优先；只有另一侧明显更有料时才翻转。
      const nearEvidence = (claim) => {
        const far = claim.down ? Math.min(claim.edge + NEAR_WINDOW, claim.yBottom) : Math.max(claim.edge - NEAR_WINDOW, claim.yTop)
        const window = claim.down
          ? [claim.band[0], claim.edge, claim.band[1], far]
          : [claim.band[0], far, claim.band[1], claim.edge]
        const ownedNear = claim.owned.filter((rect) => {
          const centerY = (rect[1] + rect[3]) / 2
          return claim.down ? centerY <= far : centerY >= far
        }).length
        return { ownedNear, density: inkFraction(profile, window) }
      }
      const priorNear = nearEvidence(prior)
      const alternativeNear = nearEvidence(alternative)
      // 翻转的条件是「惯例那一侧**几乎是空的**」，不是「另一侧更密」。图注紧挨
      // 着的那一段里，正文行本来就比表格行密：合成 fixture 的 Table 1 图注下方
      // 是表体、上方是两行正文，按「谁更密」会翻到上面那两行正文去。
      const flip =
        alternativeNear.ownedNear > 0 && priorNear.ownedNear === 0
          ? alternativeNear.density >= 0.01
          : priorNear.density < 0.02 && alternativeNear.density >= 0.05
      const ordered = flip ? [options[1], options[0]] : options
      const picked = ordered.reduce((best, option) => (rank(option) > rank(best) ? option : best), ordered[0])
      if (rank(picked) === 0) {
        undetected.push({ ...caption, page, reason: '没有在附近找到可辨认的图形区域' })
        continue
      }
      let clean
      try {
        // 最后一道闸：不管上面认领与收紧算成什么样，矩形都不许压到任何一条图注
        // 的正文上。图注文字由 caption 字段单独带出去写进报告，不靠截进图里。
        clean = excludeCaptions(picked.result.trimmed, captions).bbox
      } catch (error) {
        undetected.push({ ...caption, page, reason: error.message })
        continue
      }
      figures.push({
        id: `${caption.label.replace(/[^\w]/gu, '').toLowerCase()}_p${pageName(page)}`,
        kind: caption.kind,
        label: caption.label,
        page,
        anchor: `[p.${page} ${caption.label}]`,
        caption: caption.text,
        bbox: clean.map((value) => Math.round(value * 10) / 10),
        detection: picked.detection,
      })
    }
  }

  const payload = { format: FIGURES_FORMAT, profileDpi: PROFILE_DPI, figures, undetected }
  writeFileSync(cachePath, JSON.stringify(payload, undefined, 2), 'utf8')
  return { ...payload, docId, reused: false }
}

/**
 * 裁切并渲染一块页面区域成 PNG。
 *
 * 默认**不把图注文字裁进图里**：传进来的 bbox 可能顺手把下方图注框了进去（手工
 * 定的 bbox 最容易这样），渲染前统一按该页的图注矩形削一遍；被排掉的图注连同
 * 邻近图注的原文一并返回，供报告写在图片下方。要刻意连图注一起裁，显式传
 * `avoidCaptions: false`。
 *
 * mupdf 的 JS 绑定没有「按 bbox 渲染页面」的入口，所以这里用等价做法：建一张
 * 原点与尺寸就是目标区域的 pixmap，再让 draw device 把整页画上去——画到区域外
 * 的部分会被 pixmap 自己的边界裁掉。实测与 PyMuPDF 的 `clip=` 等价。
 *
 * @param {string} docId 论文 id。
 * @param {{ page: number, bbox: number[], dpi?: number, label?: string, outputDir?: string,
 *   avoidCaptions?: boolean, maxCaptionGap?: number }} spec
 *   目标区域，`bbox` 是 `[x0, y0, x1, y1]`（PDF 点）。
 * @param {{ cacheRoot?: string }} [options] 缓存根目录覆盖。
 * @returns {{ page: number, dpi: number, bbox: number[], requestedBbox: number[], file: string,
 *   path: string, width: number, height: number, captions: object[], clippedCaptions: object[] }}
 */
export function cropFigure(docId, spec, options = {}) {
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot()
  const meta = readMeta(docId, options)
  const [page] = parsePages(String(spec.page), meta.pageCount)
  const [x0, y0, x1, y1] = spec.bbox
  if (!(x1 > x0) || !(y1 > y0)) throw new Error(`bbox 必须满足 x1>x0 且 y1>y0，收到 [${spec.bbox.join(', ')}]`)
  const requested = [x0, y0, x1, y1]
  const captionBlocksOnPage = spec.avoidCaptions === false ? [] : captionBlocks(readBlocks(cacheRoot, docId, page))
  const excluded = excludeCaptions(requested, captionBlocksOnPage)
  const [cx0, cy0, cx1, cy1] = excluded.bbox
  const dpi = spec.dpi ?? 200
  const scale = dpi / 72
  const deviceBox = [
    Math.floor(cx0 * scale),
    Math.floor(cy0 * scale),
    Math.ceil(cx1 * scale),
    Math.ceil(cy1 * scale),
  ]
  const doc = openDocument(readFileSync(join(paperDir(cacheRoot, docId), 'source.pdf')))
  const page_ = doc.loadPage(page - 1)
  const limited = page_.getBounds()
  if (cx0 < limited[0] - 1 || cy0 < limited[1] - 1 || cx1 > limited[2] + 1 || cy1 > limited[3] + 1) {
    throw new Error(`bbox 超出了第 ${page} 页的页面范围 ${limited.map((value) => Math.round(value)).join(',')}`)
  }
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, deviceBox, false)
  pixmap.clear(255)
  page_
    .toDisplayList()
    .run(new mupdf.DrawDevice(mupdf.Matrix.scale(scale, scale), pixmap), [1, 0, 0, 1, 0, 0])

  const label = spec.label ?? `crop_p${pageName(page)}`
  const file = `${label}@${dpi}.png`
  const directory = spec.outputDir ?? join(paperDir(cacheRoot, docId), 'figures')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, file)
  writeFileSync(path, pixmap.asPNG())
  return {
    page,
    dpi,
    bbox: excluded.bbox,
    requestedBbox: requested,
    file,
    path,
    width: pixmap.getWidth(),
    height: pixmap.getHeight(),
    captions: captionsNear(docId, page, excluded.bbox, {
      cacheRoot,
      maxGap: spec.maxCaptionGap ?? 48,
    }),
    clippedCaptions: excluded.clipped.map((caption) => ({
      label: caption.label,
      kind: caption.kind,
      anchor: `[p.${page} ${caption.label}]`,
      text: caption.text,
    })),
  }
}

/**
 * 从缓存里派生一份「论文地图」：章节树与图表清单。
 *
 * 纯派生、零渲染、零 LLM，因此可以随便调：它的用处是让报告与问答一开始就知道
 * 论文有哪几节、每节在哪几页、哪几页有图表，从而直接跳到该读的地方，而不是从
 * 摘要开始顺序读。章节标签沿用检索那套「向上找最近的标题」的口径。
 *
 * @param {string} docId 论文 id。
 * @param {{ cacheRoot?: string }} [options] 缓存根目录覆盖。
 * @returns {{ sections: object[], figures: object[] }}
 */
export function outlineOf(docId, options = {}) {
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot()
  const meta = readMeta(docId, options)
  const sections = []
  const figures = []
  for (let page = 1; page <= meta.pageCount; page += 1) {
    for (const block of readBlocks(cacheRoot, docId, page)) {
      if (block.heading !== undefined) {
        const last = sections[sections.length - 1]
        // 同一标题跨页重复出现、或同一页里重复出现时只记第一次
        if (last === undefined || last.label !== block.heading || last.page !== page) {
          sections.push({
            label: block.heading,
            title: block.text,
            page,
            anchor: `[p.${page} §${block.heading}]`,
          })
        }
      }
    }
    for (const caption of captionBlocks(readBlocks(cacheRoot, docId, page))) {
      figures.push({
        label: caption.label,
        kind: caption.kind,
        page,
        anchor: `[p.${page} ${caption.label}]`,
        caption: caption.text,
      })
    }
  }
  return { docId, pageCount: meta.pageCount, sourcePath: meta.sourcePath, sections, figures }
}

/**
 * 把若干页渲染成 PNG。
 *
 * 同一页同一 dpi 只渲染一次，之后复用缓存文件。默认写进缓存目录；给了
 * `outputDir` 就写进那里——报告要把图放在自己旁边，直接写出比事后再复制少一步，
 * 也免得报告引用一个随时可能被清掉的缓存路径。
 *
 * @param {string} docId 论文 id。
 * @param {string} pagesSpec 页码表达式。
 * @param {number} dpi 渲染分辨率。
 * @param {{ cacheRoot?: string, maxPages?: number, outputDir?: string }} [options]
 *   缓存根目录、单次页数上限、输出目录。
 * @returns {{ docId: string, dpi: number, outputDir?: string,
 *   figures: { page: number, file: string, path: string, captions: string[] }[] }}
 */
export function renderPages(docId, pagesSpec, dpi, options = {}) {
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot()
  const maxPages = options.maxPages ?? 8
  const meta = readMeta(docId, options)
  const wanted = parsePages(pagesSpec, meta.pageCount)
  if (wanted.length > maxPages) {
    throw new Error(`一次最多渲染 ${maxPages} 页，本次请求 ${wanted.length} 页。请分批请求。`)
  }

  const directory = options.outputDir ?? join(paperDir(cacheRoot, docId), 'figures')
  mkdirSync(directory, { recursive: true })

  const figures = []
  let doc
  for (const page of wanted) {
    const blocks = readBlocks(cacheRoot, docId, page)
    const file = `p${pageName(page)}@${dpi}.png`
    const path = join(directory, file)
    if (!existsSync(path)) {
      doc ??= openDocument(readFileSync(join(paperDir(cacheRoot, docId), 'source.pdf')))
      const pixmap = doc
        .loadPage(page - 1)
        .toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false)
      writeFileSync(path, pixmap.asPNG())
    }
    figures.push({ page, file, path, captions: captionsOf(blocks) })
  }
  return {
    docId,
    dpi,
    ...(options.outputDir === undefined ? {} : { outputDir: directory }),
    figures,
  }
}

/** 列出缓存里已有的论文，供诊断与人工检查。 */
export function listCached(cacheRoot = defaultCacheRoot()) {
  if (!existsSync(cacheRoot)) return []
  return readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const metaPath = join(cacheRoot, entry.name, 'meta.json')
      if (!existsSync(metaPath)) return undefined
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
        return { docId: meta.docId, pageCount: meta.pageCount, sourcePath: meta.sourcePath }
      } catch {
        return undefined
      }
    })
    .filter((entry) => entry !== undefined)
}
