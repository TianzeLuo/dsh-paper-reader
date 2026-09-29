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
 */
const CACHE_FORMAT = 4

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
 * @returns {string | undefined} 归一化后的章节标签，非标题时返回 undefined。
 */
function headingLabel(text, style, bodySize) {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > 90) return undefined
  // 编号标题：1 / 1.2 / 3.2.1 后面跟内容
  const numbered = /^(\d+(?:\.\d+)*)\.?\s+\S/.exec(trimmed)
  // 无编号的常见标题
  const named =
    /^(Abstract|Introduction|Related [Ww]ork|Background|Method(?:s|ology)?|Approach|Experiments?|Results?|Discussion|Conclusions?|Limitations|References|Acknowledg\w*|Appendix)\b/.exec(
      trimmed,
    )
  const label = numbered?.[1] ?? named?.[1]
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
 * @returns {{ text: string, blocks: { y: number, text: string, heading?: string }[] }}
 */
function extractPage(page, bodySize) {
  const structured = page.toStructuredText('preserve-whitespace')
  const parsed = JSON.parse(structured.asJSON())
  const blocks = []
  for (const block of parsed.blocks ?? []) {
    if (block?.type !== 'text') continue
    const text = joinLines(block.lines)
    if (text.length === 0) continue
    const heading = headingLabel(text, blockStyle(block), bodySize)
    blocks.push({
      y: Math.round(block.bbox?.y ?? 0),
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

  for (let index = 0; index < pageCount; index += 1) {
    const page = doc.loadPage(index)
    const { text, blocks } = extractPage(page, bodySize)
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
 * 先做短语命中（区分大小写的原文匹配不区分大小写），一个都没有时退化成
 * "所有词都出现"的宽松匹配。返回结果保持文档顺序，便于模型自行判断相关性。
 *
 * @param {string} docId 论文 id。
 * @param {string} query 检索词。
 * @param {number} limit 最多返回多少条。
 * @param {{ cacheRoot?: string }} [options] 缓存根目录覆盖。
 * @returns {{ docId: string, query: string, hits: object[], mode: 'phrase' | 'all-words' }}
 */
export function searchPaper(docId, query, limit, options = {}) {
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot()
  const meta = readMeta(docId, options)
  const needle = String(query).trim().toLowerCase()
  if (needle.length === 0) throw new Error('检索词不能为空')
  const words = needle.split(/\s+/).filter((word) => word.length > 0)

  /** 走一遍全文，strict=true 只认短语命中。 */
  const scan = (strict) => {
    const hits = []
    let heading
    for (let page = 1; page <= meta.pageCount; page += 1) {
      for (const block of readBlocks(cacheRoot, docId, page)) {
        if (block.heading !== undefined) heading = block.heading
        const haystack = block.text.toLowerCase()
        const at = haystack.indexOf(needle)
        const matched = at >= 0 || (!strict && words.every((word) => haystack.includes(word)))
        if (!matched) continue
        hits.push({
          page,
          section: heading,
          anchor: heading === undefined ? `[p.${page}]` : `[p.${page} §${heading}]`,
          text: snippet(block.text, at >= 0 ? at : 0, at >= 0 ? needle.length : 0),
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
  return blocks
    .filter((block) => /^(Figure|Fig\.?|Table)\s*\d+/i.test(block.text))
    .map((block) => block.text)
}

/**
 * 把若干页渲染成 PNG。
 *
 * 同一页同一 dpi 只渲染一次，之后复用缓存文件。
 *
 * @param {string} docId 论文 id。
 * @param {string} pagesSpec 页码表达式。
 * @param {number} dpi 渲染分辨率。
 * @param {{ cacheRoot?: string, maxPages?: number }} [options] 缓存根目录与单次页数上限。
 * @returns {{ docId: string, dpi: number, figures: { page: number, path: string, captions: string[] }[] }}
 */
export function renderPages(docId, pagesSpec, dpi, options = {}) {
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot()
  const maxPages = options.maxPages ?? 8
  const meta = readMeta(docId, options)
  const wanted = parsePages(pagesSpec, meta.pageCount)
  if (wanted.length > maxPages) {
    throw new Error(`一次最多渲染 ${maxPages} 页，本次请求 ${wanted.length} 页。请分批请求。`)
  }

  const figuresDir = join(paperDir(cacheRoot, docId), 'figures')
  mkdirSync(figuresDir, { recursive: true })

  const figures = []
  let doc
  for (const page of wanted) {
    const blocks = readBlocks(cacheRoot, docId, page)
    const path = join(figuresDir, `p${pageName(page)}@${dpi}.png`)
    if (!existsSync(path)) {
      doc ??= openDocument(readFileSync(join(paperDir(cacheRoot, docId), 'source.pdf')))
      const pixmap = doc
        .loadPage(page - 1)
        .toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false)
      writeFileSync(path, pixmap.asPNG())
    }
    figures.push({ page, path, captions: captionsOf(blocks) })
  }
  return { docId, dpi, figures }
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
