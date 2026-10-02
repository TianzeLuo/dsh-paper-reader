/**
 * pdf.js 的行为测试。
 *
 * 这是第 3 期的主战场：`lib/pdf.js` 承载导入、检索、分页读取、渲染四件事，
 * 而它们全都依赖 mupdf 这层外部 API。之前只有 provider 的契约测试，等于这些
 * 工具的行为完全没被守过。这里用合成 PDF 把每条分支都钉住。
 *
 * fixture 用 mkdtemp 建在临时目录里，按仓库规范不回收。
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { syntheticPaper } from './helpers/synthetic-paper.mjs'
import {
  captionBlocks,
  captionsOf,
  cropFigure,
  defaultCacheRoot,
  detectFigures,
  importPaper,
  listCached,
  outlineOf,
  parsePages,
  readMeta,
  readPages,
  renderPages,
  searchPaper,
} from '../lib/pdf.js'

/** PNG 文件头，用来证明渲染出来的确实是一张 PNG 而不是别的字节。 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 建一套 fixture：一个临时目录、一份合成论文、一个空的缓存根。
 *
 * @returns {{ dir: string, pdfPath: string, cacheRoot: string }} 路径集合。
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-paper-reader-pdf-'))
  const pdfPath = join(dir, 'paper.pdf')
  writeFileSync(pdfPath, syntheticPaper())
  return { dir, pdfPath, cacheRoot: join(dir, 'cache') }
}

/** 导入 fixture 论文并返回 meta，省掉每个测试重复三行。 */
function imported() {
  const paths = fixture()
  return { ...paths, meta: importPaper(paths.pdfPath, { cacheRoot: paths.cacheRoot }) }
}

/** 读缓存里某一页的结构化块。 */
function blocksOf(paths, page) {
  const name = `${String(page).padStart(3, '0')}.json`
  return JSON.parse(readFileSync(join(paths.meta.cacheDir, 'pages', name), 'utf8'))
}

test('导入：页数、docId、缓存目录与落盘产物', () => {
  const { meta, pdfPath, cacheRoot } = imported()

  assert.equal(meta.pageCount, 3)
  assert.match(meta.docId, /^[0-9a-f]{12}$/u)
  assert.equal(meta.reused, false)
  assert.equal(meta.sourcePath, pdfPath)
  assert.equal(meta.cacheDir, join(cacheRoot, meta.docId))

  // 分页正文、结构化块、源 PDF 副本、meta 都必须落盘
  assert.ok(existsSync(join(meta.cacheDir, 'meta.json')))
  assert.ok(existsSync(join(meta.cacheDir, 'source.pdf')))
  for (const page of [1, 2, 3]) {
    assert.ok(existsSync(join(meta.cacheDir, 'pages', `${String(page).padStart(3, '0')}.txt`)))
    assert.ok(existsSync(join(meta.cacheDir, 'pages', `${String(page).padStart(3, '0')}.json`)))
  }
})

test('导入：源 PDF 被完整复制进缓存', () => {
  const { meta, pdfPath } = imported()
  assert.deepEqual(readFileSync(join(meta.cacheDir, 'source.pdf')), readFileSync(pdfPath))
})

test('导入：同一份 PDF 从另一个路径导入命中同一份缓存', () => {
  const { dir, pdfPath, cacheRoot, meta } = imported()

  const copyPath = join(dir, 'renamed-copy.pdf')
  copyFileSync(pdfPath, copyPath)

  const again = importPaper(copyPath, { cacheRoot })
  assert.equal(again.docId, meta.docId, 'docId 是内容哈希，换个路径不应变成另一篇')
  assert.equal(again.reused, true)
  assert.equal(again.pageCount, 3)
  // 复用时不重解析：sourcePath 仍是首次导入时记下的那个
  assert.equal(again.sourcePath, pdfPath)
})

test('导入：PDF 内嵌元数据缺失时字段直接不出现，而不是空串', () => {
  const { meta } = imported()
  // 合成 PDF 没写 /Info，所以正常情况两项都没有。真有值时必须是去空白的非空串——
  // 空串会被工具输出 schema 当成「有个字段」，而渲染出来是一行空标题。
  for (const key of ['pdfTitle', 'pdfAuthor']) {
    if (key in meta) {
      assert.equal(typeof meta[key], 'string')
      assert.ok(meta[key].trim().length > 0, `${key} 不应为空串`)
    }
  }
})

test('导入：文件不存在时报错', () => {
  const { cacheRoot } = fixture()
  assert.throws(() => importPaper('/tmp/绝对不存在的论文.pdf', { cacheRoot }), /找不到文件/u)
})

test('导入：不是 PDF 时报错，且报错里带路径', () => {
  const { dir, cacheRoot } = fixture()
  const bogus = join(dir, 'not-a-pdf.pdf')
  writeFileSync(bogus, '这不是 PDF，只是一段文字。\n', 'utf8')
  assert.throws(() => importPaper(bogus, { cacheRoot }), /不是可解析的 PDF/u)
})

test('readMeta：没导入过时报错并提示先导入', () => {
  const { cacheRoot } = fixture()
  assert.throws(() => readMeta('deadbeefcafe', { cacheRoot }), /先用 paper_import 导入/u)
})

test('readMeta：导入后能读回同一份 meta', () => {
  const { meta, cacheRoot } = imported()
  assert.deepEqual(readMeta(meta.docId, { cacheRoot }), {
    format: meta.format,
    docId: meta.docId,
    pageCount: meta.pageCount,
    cacheDir: meta.cacheDir,
    sourcePath: meta.sourcePath,
    importedAt: meta.importedAt,
  })
})

test('缓存格式版本不符时重新解析，而不是继续用旧抽取结果', () => {
  const { meta, pdfPath, cacheRoot } = imported()
  const metaPath = join(meta.cacheDir, 'meta.json')
  const cached = JSON.parse(readFileSync(metaPath, 'utf8'))

  writeFileSync(metaPath, JSON.stringify({ ...cached, format: cached.format - 1 }), 'utf8')
  const again = importPaper(pdfPath, { cacheRoot })

  assert.equal(again.reused, false, '版本不符的缓存必须重新解析')
  assert.equal(again.format, cached.format)
  assert.equal(JSON.parse(readFileSync(metaPath, 'utf8')).format, cached.format)
})

test('searchPaper：短语命中并给出章节锚点', () => {
  const { meta, cacheRoot } = imported()
  const result = searchPaper(meta.docId, 'projected', 5, { cacheRoot })

  assert.equal(result.mode, 'phrase')
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].page, 2)
  assert.equal(result.hits[0].section, '3.2')
  assert.equal(result.hits[0].anchor, '[p.2 §3.2]')
  assert.match(result.hits[0].text, /projected/u)
})

test('searchPaper：命中标题本身时锚点就是该标题', () => {
  const { meta, cacheRoot } = imported()
  const [hit] = searchPaper(meta.docId, 'Multi-Head', 5, { cacheRoot }).hits
  assert.equal(hit.anchor, '[p.2 §3.2]')
})

test('searchPaper：大小写不敏感', () => {
  const { meta, cacheRoot } = imported()
  const lower = searchPaper(meta.docId, 'multi-head', 5, { cacheRoot })
  assert.equal(lower.mode, 'phrase')
  assert.equal(lower.hits.length, 1)
})

test('searchPaper：标题之前的块沿用上一个标题，没有标题时退化成纯页码锚点', () => {
  const { meta, cacheRoot } = imported()

  // 第 1 页「1 Introduction」之后的正文 → §1
  const intro = searchPaper(meta.docId, 'Recurrent models', 5, { cacheRoot }).hits[0]
  assert.equal(intro.anchor, '[p.1 §1]')

  // 论文标题在所有标题之前 → 没有章节可标
  const title = searchPaper(meta.docId, 'Attention Is All You Need', 5, { cacheRoot }).hits[0]
  assert.equal(title.anchor, '[p.1]')
})

test('searchPaper：一个数字能在多处命中，各自的页码与章节都对', () => {
  const { meta, cacheRoot } = imported()
  const hits = searchPaper(meta.docId, '28.7', 5, { cacheRoot }).hits
  assert.deepEqual(
    hits.map((hit) => hit.anchor),
    ['[p.1 §Abstract]', '[p.3 §3]'],
  )
})

test('searchPaper：短语不中时退化为「所有词都出现」的宽松匹配', () => {
  const { meta, cacheRoot } = imported()
  const result = searchPaper(meta.docId, 'architecture bleu', 5, { cacheRoot })

  assert.equal(result.mode, 'all-words', '这两个词不在同一处相邻，不该算短语命中')
  assert.ok(result.hits.length >= 1)
  assert.equal(result.hits[0].page, 1)
})

test('searchPaper：完全没有命中时如实返回空数组', () => {
  const { meta, cacheRoot } = imported()
  const result = searchPaper(meta.docId, 'zzz-不存在-zzz', 5, { cacheRoot })
  assert.deepEqual(result.hits, [])
})

test('searchPaper：limit 生效', () => {
  const { meta, cacheRoot } = imported()
  const result = searchPaper(meta.docId, 'e', 2, { cacheRoot })
  assert.equal(result.hits.length, 2)
})

test('searchPaper：空检索词报错', () => {
  const { meta, cacheRoot } = imported()
  assert.throws(() => searchPaper(meta.docId, '   ', 5, { cacheRoot }), /检索词不能为空/u)
})

test('parsePages：单页、区间、逗号组合都解析成升序去重的 1 基页码', () => {
  assert.deepEqual(parsePages('1', 3), [1])
  assert.deepEqual(parsePages('1-3', 3), [1, 2, 3])
  assert.deepEqual(parsePages('3,1', 3), [1, 3])
  assert.deepEqual(parsePages('1-2,2-3', 3), [1, 2, 3])
  assert.deepEqual(parsePages(' 2 ', 3), [2])
})

test('parsePages：各种非法写法都报错而不是静默给出空集', () => {
  assert.throws(() => parsePages('', 3), /页码不能为空/u)
  assert.throws(() => parsePages('2-1', 3), /页码范围反了/u)
  assert.throws(() => parsePages('1;2', 3), /看不懂的页码写法/u)
  assert.throws(() => parsePages('0', 3), /越界/u)
  assert.throws(() => parsePages('4', 3), /越界/u)
  assert.throws(() => parsePages('1-9', 3), /越界/u)
})

test('readPages：按页返回正文与页码', () => {
  const { meta, cacheRoot } = imported()
  const result = readPages(meta.docId, '1-3', 100_000, { cacheRoot })

  assert.equal(result.truncated, false)
  assert.deepEqual(result.pagesNotRead, [])
  assert.deepEqual(
    result.pages.map((page) => page.page),
    [1, 2, 3],
  )
  assert.match(result.pages[0].text, /Attention Is All You Need/u)
  assert.match(result.pages[2].text, /NVIDIA P100/u)
})

test('readPages：超出字符预算时如实报告截断与未读页', () => {
  const { meta, cacheRoot } = imported()
  const result = readPages(meta.docId, '1-3', 30, { cacheRoot })

  assert.equal(result.truncated, true)
  assert.equal(result.pages.length, 1)
  assert.equal(result.pages[0].page, 1)
  assert.equal(result.pages[0].truncated, true)
  assert.equal(result.pages[0].text.length, 30)
  assert.deepEqual(result.pagesNotRead, [2, 3], '没读的页必须列出来，否则模型会以为读完了')
})

test('readPages：预算刚好够第一页时，第二页给出空片段并标截断', () => {
  const { meta, cacheRoot } = imported()
  const firstPageLength = readPages(meta.docId, '1', 100_000, { cacheRoot }).pages[0].text.length
  const result = readPages(meta.docId, '1-2', firstPageLength, { cacheRoot })

  assert.equal(result.truncated, true)
  assert.deepEqual(
    result.pages.map((page) => page.page),
    [1, 2],
  )
  assert.equal(result.pages[0].truncated, undefined)
  assert.equal(result.pages[1].truncated, true)
  assert.equal(result.pages[1].text, '')
})

test('readPages：页码越界时报错', () => {
  const { meta, cacheRoot } = imported()
  assert.throws(() => readPages(meta.docId, '9', 1000, { cacheRoot }), /越界/u)
})

test('captionsOf：只认图注/表注的形态，不把正文当图注', () => {
  const paths = imported()
  assert.deepEqual(captionsOf(blocksOf(paths, 2)), ['Figure 1: The Transformer architecture.'])
  assert.deepEqual(captionsOf(blocksOf(paths, 3)), ['Table 1: BLEU scores on WMT 2014.'])
  assert.deepEqual(captionsOf(blocksOf(paths, 1)), [])
})

test('renderPages：渲染出真实 PNG，并带回该页图注原文', () => {
  const { meta, cacheRoot } = imported()
  const result = renderPages(meta.docId, '2', 72, { cacheRoot })

  assert.equal(result.dpi, 72)
  assert.equal(result.figures.length, 1)
  const [figure] = result.figures
  assert.equal(figure.page, 2)
  assert.deepEqual(figure.captions, ['Figure 1: The Transformer architecture.'])

  const bytes = readFileSync(figure.path)
  assert.deepEqual(bytes.subarray(0, 8), PNG_MAGIC, '输出必须是 PNG')
  assert.ok(bytes.length > 1000, '渲染结果不该是空图')
})

test('renderPages：文件名带 dpi，同一页不同 dpi 是两份缓存', () => {
  const { meta, cacheRoot } = imported()
  const at72 = renderPages(meta.docId, '1', 72, { cacheRoot }).figures[0].path
  const at144 = renderPages(meta.docId, '1', 144, { cacheRoot }).figures[0].path

  assert.notEqual(at72, at144)
  assert.match(at72, /p001@72\.png$/u)
  assert.match(at144, /p001@144\.png$/u)
})

test('renderPages：重复渲染同一页同一 dpi 复用同一个文件', () => {
  const { meta, cacheRoot } = imported()
  const first = renderPages(meta.docId, '3', 72, { cacheRoot }).figures[0].path
  const second = renderPages(meta.docId, '3', 72, { cacheRoot }).figures[0].path
  assert.equal(first, second)
})

test('renderPages：超过单次页数上限时报错并说清上限', () => {
  const { meta, cacheRoot } = imported()
  assert.throws(() => renderPages(meta.docId, '1-3', 72, { cacheRoot, maxPages: 2 }), /一次最多渲染 2 页/u)
})

test('listCached：空缓存返回空数组，导入后能列出该篇', () => {
  const empty = fixture()
  assert.deepEqual(listCached(empty.cacheRoot), [])

  const paths = imported()
  const [entry] = listCached(paths.cacheRoot)
  assert.equal(entry.docId, paths.meta.docId)
  assert.equal(entry.pageCount, 3)
  assert.equal(entry.sourcePath, paths.pdfPath)
})

/**
 * 一页刻意复刻真实论文（Attention Is All You Need）里踩到的几个版面坑。
 *
 * 每一行都对应一个真实故障，不是凭空造的边界：见下方各条测试的说明。
 */
const TRICKY_PAGE = [
  { text: 'A Study Of Things', size: 18 },
  // 章节号与标题之间隔着一段空隙，mupdf 会拆成两个 line 元素
  { parts: [[60, '4.2'], [110, 'Ablation Study']], size: 14 },
  // 折行：两行相距很近，会被并进同一个 block
  { text: 'Queries keys and values are', size: 11, advance: 12 },
  { text: 'projected h times in this section.', size: 11 },
  // 表格里以数字开头的正文行：形态像「§1」，但既不加粗也不比正文大
  { text: '1 512 512 5.29 24.9 4.92', size: 11 },
  { text: 'Plain body text, plainly.', size: 11 },
  // 与正文同号、但加粗：真实的子节标题常常就长这样
  { text: '5 Conclusion', size: 11, bold: true },
  { text: 'The transduc-', size: 11, advance: 12 },
  { text: 'tion is hyphenated.', size: 11 },
]

/** 用自定义版面建 fixture 并导入。 */
function fixtureWith(pages) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-paper-reader-pdf-'))
  const pdfPath = join(dir, 'paper.pdf')
  writeFileSync(pdfPath, syntheticPaper(pages))
  const cacheRoot = join(dir, 'cache')
  return { dir, pdfPath, cacheRoot, meta: importPaper(pdfPath, { cacheRoot }) }
}

test('同一视觉行被拆开时补上空格，章节号因此能被识别成标题', () => {
  // 真实论文里「3.2.1」与标题之间隔着空隙，mupdf 给出两个 line 元素。
  // 用空串相接会拼出 "4.2Ablation Study"，标题规则匹配不上，
  // 于是后面整页的锚点都会停在上一个标题上。
  const { meta, cacheRoot } = fixtureWith([TRICKY_PAGE])
  const result = searchPaper(meta.docId, 'Ablation', 5, { cacheRoot })

  assert.equal(result.mode, 'phrase')
  assert.equal(result.hits[0].anchor, '[p.1 §4.2]')
})

test('折行处补空格：跨行的短语搜得到，读出来的也是正常行文', () => {
  const { meta, cacheRoot } = fixtureWith([TRICKY_PAGE])

  const result = searchPaper(meta.docId, 'values are projected', 5, { cacheRoot })
  assert.equal(result.mode, 'phrase', '跨行的短语必须能命中，否则检索会漏掉大量真实依据')
  assert.equal(result.hits.length, 1)

  const text = readPages(meta.docId, '1', 100_000, { cacheRoot }).pages[0].text
  assert.match(text, /Queries keys and values are projected h times in this section\./u)
})

test('行尾连字符按原样保留，不在中间插入空格', () => {
  const { meta, cacheRoot } = fixtureWith([TRICKY_PAGE])
  const text = readPages(meta.docId, '1', 100_000, { cacheRoot }).pages[0].text
  // 是断词还是本就连字符，没有词典可分；保留连字符是保守做法，
  // 但不能在它后面插一个空格，那会把一个词劈成两半且看不出来。
  assert.match(text, /The transduc-tion is hyphenated\./u)
})

test('标题必须加粗或比正文大：表格里以数字开头的行不会被误判成章节', () => {
  const { meta, cacheRoot } = fixtureWith([TRICKY_PAGE])

  // 这一行文本形态完全像标题（"1 512 …"），但排版上是正文。
  // 判成 §1 的话，它之后半页的锚点会全部错标。
  const table = searchPaper(meta.docId, '512 512', 5, { cacheRoot })
  assert.equal(table.hits[0].anchor, '[p.1 §4.2]', '应沿用上一个真标题，而不是把表格行当标题')

  // 反过来：与正文同号但加粗的真标题必须仍然识别得出来
  const heading = searchPaper(meta.docId, 'hyphenated', 5, { cacheRoot })
  assert.equal(heading.hits[0].anchor, '[p.1 §5]')
})

test('标题靠字号放大来标识（不加粗）时同样能识别', () => {
  const { meta, cacheRoot } = fixtureWith([
    [
      { text: 'Body line one is here.', size: 10 },
      { text: '1 Introduction', size: 16 },
      { text: 'More body text follows.', size: 10 },
    ],
  ])
  const hit = searchPaper(meta.docId, 'follows', 5, { cacheRoot }).hits[0]
  assert.equal(hit.anchor, '[p.1 §1]')
})

test('正文基准字号按全篇统计：图表页的刻度字号不会让图内文字变成标题', () => {
  // ViT（arXiv 2010.11929）第 18 页有 83 个块，绝大多数是坐标轴刻度。逐页统计
  // 时那一页的众数字号变成刻度字号，图里 9pt 的文字于是「比正文大」，被当成
  // 标题，实测产生两个 §0 的假锚点。这里把那页复刻出来。
  const textPage = [
    { text: 'A Paper About Things', size: 16 },
    { parts: [[60, '1'], [95, 'Introduction']], size: 14 },
    // 正文页必须真的「占篇幅的大头」，否则全篇众数也会被图表页带偏——
    // 这篇 fixture 刻意让正文行数明显多于刻度行数，与真实论文的比例一致。
    // 行距收紧到 14，否则 40 行会超出页面高度被裁掉，统计出来的样本就不是 40 行。
    ...Array.from({ length: 40 }, (_, index) => ({
      text: `Body line number ${index} of the paper.`,
      size: 11,
      advance: 14,
    })),
  ]
  const chartPage = [
    ...Array.from({ length: 24 }, (_, index) => ({ text: String(index), size: 4 })),
    // 刻度数字与图标题挨得很近，会被并进同一个块；块内最大字号是 9
    { text: '0 5 10 15 20', size: 4, advance: 5 },
    { text: 'Network depth (layer)', size: 9 },
  ]
  const { meta, cacheRoot } = fixtureWith([textPage, chartPage])

  const hit = searchPaper(meta.docId, 'Network depth', 5, { cacheRoot }).hits[0]
  assert.equal(hit.page, 2)
  assert.equal(hit.anchor, '[p.2 §1]', '图表页应沿用上一页的 §1，而不是把刻度数字当成 §0')
})

test('defaultCacheRoot：跟随 DSH_HOME', () => {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/dsh-home-override'
    assert.equal(defaultCacheRoot(), '/tmp/dsh-home-override/paper-reader')
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

/* ------------------------------------------------------------------ *
 * 论文地图与图形区域检测
 * ------------------------------------------------------------------ */

test('结构化块带完整 bbox 与行数：分侧、正文判定、图片区域都要用', () => {
  const { meta } = imported()
  const caption = blocksOf({ meta }, 2).find((block) => block.text.startsWith('Figure 1:'))

  assert.ok(Array.isArray(caption.bbox), '块必须带 bbox，只有 y 无法判断它在哪一栏')
  assert.equal(caption.bbox.length, 4)
  assert.ok(caption.bbox[2] > caption.bbox[0] && caption.bbox[3] > caption.bbox[1])
  assert.equal(caption.lines, 1)
})

test('captionBlocks：给出编号与类别，并把折行的图注接回同一个图注', () => {
  // 直接喂块数组：mupdf 把折行图注拆成几个块取决于字号与行距的组合，靠合成
  // PDF 去凑这个边界很脆，而这里要验的是合并规则本身
  const blocks = [
    { y: 100, bbox: [60, 100, 300, 110], lines: 1, text: 'Figure 3: A long caption that wraps onto' },
    { y: 112, bbox: [60, 112, 120, 122], lines: 1, text: 'a second line.' },
    { y: 126, bbox: [60, 126, 300, 138], lines: 1, text: 'Figure 4: A different caption entirely.' },
    { y: 160, bbox: [60, 160, 300, 175], lines: 1, text: 'Body text after the caption.' },
  ]
  const captions = captionBlocks(blocks)

  assert.equal(captions.length, 2, '折行的图注算一个，另一条图注各自算一个')
  assert.equal(captions[0].label, 'Fig.3')
  assert.equal(captions[0].kind, 'figure')
  assert.equal(captions[0].text, 'Figure 3: A long caption that wraps onto a second line.')
  assert.equal(captions[0].bbox[3], 122, '合并后的 bbox 要盖住续行')
  // 间距超过阈值（这里 4pt→合并、下方 22pt→不合并）就停
  assert.equal(captions[1].text, 'Figure 4: A different caption entirely.')
  assert.equal(captions[1].label, 'Fig.4')
  assert.equal(captions[1].bbox[3], 138, '正文不该被并进图注')
})

test('captionBlocks：正文里的「Figure 7 visualizes …」不算图注', () => {
  const page = [
    { text: 'Figure 7 visualizes computation costs across lengths.', size: 11 },
    { text: 'Figure 7. Computation costs across lengths.', size: 10 },
  ]
  const { meta } = fixtureWith([page])
  const captions = captionBlocks(blocksOf({ meta }, 1))
  assert.deepEqual(
    captions.map((caption) => caption.text),
    ['Figure 7. Computation costs across lengths.'],
  )
})

test('detectFigures：裁出图注对应的矢量图，并缓存检测结果', () => {
  const { meta, cacheRoot } = imported()
  const detection = detectFigures(meta.docId, { cacheRoot })

  assert.equal(detection.reused, false)
  assert.deepEqual(detection.undetected, [])
  const figure = detection.figures.find((item) => item.label === 'Fig.1')
  assert.ok(figure !== undefined, '合成 fixture 第 2 页有一张矢量图')
  assert.equal(figure.page, 2)
  assert.equal(figure.kind, 'figure')
  assert.equal(figure.detection, 'display-list', '有矢量图元时应当走图形证据这条路')
  // 合成页里那块矩形是 x 60–280、y 690–740（PDF 用户空间），mupdf 的 bbox 上下
  // 翻转后约 y 102–152；收紧后应当落在这附近
  assert.ok(figure.bbox[0] <= 65 && figure.bbox[2] >= 275, `横向没框住：${figure.bbox}`)
  assert.ok(figure.bbox[1] <= 105 && figure.bbox[3] >= 148, `纵向没框住：${figure.bbox}`)

  // 表注在图上方：惯例一侧（表在下方）找不到就往另一侧找
  const table = detection.figures.find((item) => item.label === 'Table1')
  assert.ok(table !== undefined, '表体在图注下方的表也要能裁出来')
  assert.equal(table.kind, 'table')

  const again = detectFigures(meta.docId, { cacheRoot })
  assert.equal(again.reused, true, '第二次必须命中缓存，不重新渲染求墨迹')
  assert.deepEqual(again.figures, detection.figures)
})

test('detectFigures：裁切矩形不与同页任何图注文字相交', () => {
  const { meta, cacheRoot } = imported()
  const detection = detectFigures(meta.docId, { cacheRoot })
  assert.ok(detection.figures.length > 0)

  for (const figure of detection.figures) {
    for (const caption of captionBlocks(blocksOf({ meta }, figure.page))) {
      const horizontal = Math.min(figure.bbox[2], caption.bbox[2]) - Math.max(figure.bbox[0], caption.bbox[0])
      const vertical = Math.min(figure.bbox[3], caption.bbox[3]) - Math.max(figure.bbox[1], caption.bbox[1])
      assert.ok(
        horizontal <= 0 || vertical <= 0,
        `${figure.label} 的裁切框 ${figure.bbox} 压到了图注 ${caption.label} ${caption.bbox}`,
      )
    }
  }
})

test('cropFigure：手工 bbox 压到图注时会被收紧，并带回图注原文', () => {
  const { meta, cacheRoot, dir } = imported()
  const outputDir = join(dir, 'assets')
  // 合成 fixture 第 2 页：图形约在 y 98–155，图注「Figure 1: …」在 y 155–168。
  // 这个 bbox 是典型的「顺手把图注也框进来」——底边 170 越过了图注顶边 155。
  const crop = cropFigure(
    meta.docId,
    { page: 2, bbox: [60, 100, 280, 170], dpi: 144, outputDir },
    { cacheRoot },
  )

  assert.equal(crop.requestedBbox[3], 170, '原始请求要原样保留，便于调用方判断被改了哪里')
  assert.equal(crop.bbox[3], 153, '底边应收到图注顶边（155）减去 2pt 空隙')
  assert.equal(crop.height, 106, '(153-100) * 144/72 = 106')
  assert.deepEqual(crop.clippedCaptions.map((caption) => caption.label), ['Fig.1'])
  assert.equal(crop.captions[0].label, 'Fig.1')
  assert.equal(crop.captions[0].side, 'below')
  assert.match(crop.captions[0].text, /Transformer architecture/u)

  // 显式关掉才允许连图注一起裁——默认必须是排除
  const whole = cropFigure(
    meta.docId,
    { page: 2, bbox: [60, 100, 280, 170], dpi: 144, outputDir, avoidCaptions: false },
    { cacheRoot },
  )
  assert.deepEqual(whole.bbox, [60, 100, 280, 170])
  assert.deepEqual(whole.clippedCaptions, [])
})

test('cropFigure：bbox 整个落在图注上时直接报错，不给一张只剩图注的图', () => {
  const { meta, cacheRoot } = imported()
  assert.throws(
    () => cropFigure(meta.docId, { page: 2, bbox: [60, 155, 234, 168], dpi: 144 }, { cacheRoot }),
    /与图注 Fig\.1 重叠/u,
  )
})

test('cropFigure：没被图注挡住时原样裁切，且仍带回邻近图注', () => {
  const { meta, cacheRoot, dir } = imported()
  const crop = cropFigure(
    meta.docId,
    { page: 2, bbox: [60, 100, 280, 150], dpi: 144, outputDir: join(dir, 'assets') },
    { cacheRoot },
  )

  assert.deepEqual(crop.bbox, [60, 100, 280, 150])
  assert.deepEqual(crop.clippedCaptions, [])
  assert.equal(crop.captions.length, 1, '图注就在下方，报告需要它的原文')
  assert.equal(crop.captions[0].label, 'Fig.1')
})

test('cropFigure：按 bbox 渲染出真实 PNG，越界时报错', () => {
  const { meta, cacheRoot, dir } = imported()
  const outputDir = join(dir, 'assets')
  const crop = cropFigure(
    meta.docId,
    { page: 2, bbox: [60, 100, 280, 150], dpi: 144, outputDir },
    { cacheRoot },
  )

  assert.equal(crop.width, 440)
  assert.equal(crop.height, 100)
  assert.equal(crop.file, 'crop_p002@144.png')
  assert.ok(existsSync(crop.path))
  assert.deepEqual(readFileSync(crop.path).subarray(0, 8), PNG_MAGIC)

  assert.throws(
    () => cropFigure(meta.docId, { page: 2, bbox: [0, 0, 900, 900] }, { cacheRoot }),
    /超出了第 2 页/u,
  )
  assert.throws(
    () => cropFigure(meta.docId, { page: 2, bbox: [10, 10, 10, 50] }, { cacheRoot }),
    /bbox 必须满足/u,
  )
})

test('outlineOf：给出章节树与图表清单，问答与报告据此直接跳页', () => {
  const { meta, cacheRoot } = imported()
  const outline = outlineOf(meta.docId, { cacheRoot })

  assert.equal(outline.pageCount, 3)
  assert.equal(outline.sourcePath, meta.sourcePath)
  assert.deepEqual(
    outline.sections.map((section) => section.anchor),
    ['[p.1 §Abstract]', '[p.1 §1]', '[p.2 §2]', '[p.2 §3.2]', '[p.3 §3]'],
  )
  assert.deepEqual(
    outline.figures.map((figure) => `${figure.label}@${figure.page}`),
    ['Fig.1@2', 'Table1@3'],
  )
  assert.match(outline.figures[0].caption, /Figure 1: The Transformer architecture\./u)
})

test('标题判定：表头、参考文献编号、公式行、正文里的面板字母都不算章节', () => {
  // 这一页的每一行都加粗，专门让「排版特征」这一关全部通过——只有文本形态的
  // 那几条规则能拦住它们，这正是不带字体信息的 PDF 会遇到的情形
  const referencePage = [
    { text: 'A Study Of Things', size: 18 },
    { text: 'References', size: 11, bold: true },
    { text: '13839. URL https://doi.org/10.48550/arX iv.2605.13839.', size: 11, bold: true },
  ]
  const appendixPage = [
    { text: 'A. Architecture Details', size: 11, bold: true },
    { text: 'A = Reshape(T[t : t + I · r])', size: 11, bold: true },
    { text: 'B.4. 1QA Collection Datasets', size: 11, bold: true },
    { text: 'Method Score', size: 11, bold: true },
    { text: '1 512 512 5.29 24.9', size: 11, bold: true },
    { text: 'Plain body text, so that the body size vote settles on 11.', size: 11 },
  ]
  const { meta, cacheRoot } = fixtureWith([referencePage, appendixPage])
  const labels = outlineOf(meta.docId, { cacheRoot }).sections.map((s) => s.label)

  assert.deepEqual(labels, ['References', 'A', 'B.4'], `标题判定不对：${labels.join(' ')}`)
})

test('标题判定：正文里的加粗面板字母不算章节，参考文献之后的才算', () => {
  const body = [
    { text: 'A Study Of Things', size: 18 },
    { text: '3 Method', size: 11, bold: true },
    { text: 'A', size: 11, bold: true },
    { text: 'B', size: 11, bold: true },
    { text: 'Body text after the panels.', size: 11 },
    { text: 'References', size: 11, bold: true },
    { text: 'C. Appendix Section', size: 11, bold: true },
  ]
  const { meta, cacheRoot } = fixtureWith([body])
  const labels = outlineOf(meta.docId, { cacheRoot }).sections.map((s) => s.label)

  assert.deepEqual(labels, ['3', 'References', 'C'], `附录之前的字母不该算章节：${labels.join(' ')}`)
})
