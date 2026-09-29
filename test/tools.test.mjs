/**
 * 四个宿主工具的定义与行为测试。
 *
 * 重点是注册表契约——工具定义是**手写**的（不能 import `defineTool`，理由见
 * `lib/tools.js` 顶部），所以「schema 只用了受支持的关键字」「入参校验真的会拦」
 * 「返回值真的满足自己声明的 schema」这三件事没有任何框架替我们兜底，必须由
 * 测试守住。最后一条尤其关键：输出不合规时注册表会抛 ToolOutputError，而那是
 * 运行时才炸、且发生在 agent 已经拿到半截结果之后。
 *
 * fixture 用 mkdtemp 建在临时目录里，按仓库规范不回收。
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { syntheticPaper } from './helpers/synthetic-paper.mjs'
import { unsupportedKeywords, validateSchema } from './helpers/schema.mjs'
import { createTools } from '../lib/tools.js'

/**
 * 建一套 fixture：临时目录、合成论文路径、缓存根，以及接到该缓存根的工具集。
 *
 * @returns {{ dir: string, pdfPath: string, cacheRoot: string, tools: Map<string, object> }}
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-paper-reader-tools-'))
  const pdfPath = join(dir, 'paper.pdf')
  writeFileSync(pdfPath, syntheticPaper())
  const cacheRoot = join(dir, 'cache')
  const tools = new Map(createTools({ cacheRoot }).map((definition) => [definition.name, definition]))
  return { dir, pdfPath, cacheRoot, tools }
}

/** 断言工具返回值满足它自己声明的输出 schema。 */
function assertOutput(definition, value) {
  assert.deepEqual(
    validateSchema(value, definition.output.schema),
    [],
    `${definition.name} 的返回值不符合 output.schema`,
  )
}

/** 导入 fixture 论文，返回 { docId }。 */
async function importFixture(paths) {
  const result = await paths.tools.get('paper_import').execute({ source: paths.pdfPath })
  return result
}

test('四个工具：名字与注册顺序固定', () => {
  const { tools } = fixture()
  assert.deepEqual([...tools.keys()], ['paper_import', 'paper_search', 'paper_read', 'paper_figure'])
})

test('每个工具的定义形状符合注册表契约', () => {
  const { tools } = fixture()
  for (const definition of tools.values()) {
    assert.equal(typeof definition.name, 'string')
    assert.ok(definition.description.length > 20, `${definition.name} 的 description 太短，模型无法判断何时用它`)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false)
    assert.ok(Array.isArray(definition.parameters.required))
    assert.equal(typeof definition.output.schema, 'object')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
  }
})

test('所有 schema 只使用注册表支持的关键字', () => {
  const { tools } = fixture()
  for (const definition of tools.values()) {
    assert.deepEqual(unsupportedKeywords(definition.parameters), [], `${definition.name} 的入参 schema`)
    assert.deepEqual(
      unsupportedKeywords(definition.output.schema),
      [],
      `${definition.name} 的输出 schema`,
    )
  }
})

test('每个工具的必填参数与文档一致', () => {
  const { tools } = fixture()
  assert.deepEqual(tools.get('paper_import').parameters.required, ['source'])
  assert.deepEqual(tools.get('paper_search').parameters.required, ['docId', 'query'])
  assert.deepEqual(tools.get('paper_read').parameters.required, ['docId', 'pages'])
  assert.deepEqual(tools.get('paper_figure').parameters.required, ['docId', 'pages'])
  // 可选参数不能出现在 required 里，否则模型每次都得编一个值
  assert.deepEqual([...tools.get('paper_search').parameters.required].includes('limit'), false)
  assert.deepEqual([...tools.get('paper_read').parameters.required].includes('maxChars'), false)
  assert.deepEqual([...tools.get('paper_figure').parameters.required].includes('dpi'), false)
})

test('入参校验：缺必填、多出未知参数、类型不对都会被拦下', async () => {
  const { tools, pdfPath } = fixture()
  const importTool = tools.get('paper_import')

  await assert.rejects(importTool.execute({}), /缺少必填参数 source/u)
  await assert.rejects(importTool.execute({ source: pdfPath, 多余的: 1 }), /不认识参数 多余的/u)
  await assert.rejects(importTool.execute({ source: 123 }), /source 必须是 string/u)
  await assert.rejects(importTool.execute(null), /arguments 必须是一个对象/u)
  await assert.rejects(importTool.execute([]), /arguments 必须是一个对象/u)
})

test('入参校验：整数参数不接受小数', async () => {
  const { tools } = fixture()
  await assert.rejects(
    tools.get('paper_search').execute({ docId: 'x', query: 'y', limit: 1.5 }),
    /limit 必须是整数/u,
  )
  await assert.rejects(
    tools.get('paper_read').execute({ docId: 'x', pages: '1', maxChars: 1.5 }),
    /maxChars 必须是整数/u,
  )
})

test('paper_import：导入成功，返回值合规，render 给出 docId', async () => {
  const paths = fixture()
  const definition = paths.tools.get('paper_import')
  const result = await definition.execute({ source: paths.pdfPath })

  assertOutput(definition, result)
  assert.equal(result.pageCount, 3)
  assert.equal(result.reused, false)
  assert.equal(result.sourcePath, paths.pdfPath)
  assert.equal(result.cacheDir, join(paths.cacheRoot, result.docId))

  const rendered = definition.output.render({ source: paths.pdfPath }, result)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, new RegExp(result.docId, 'u'))
  assert.match(rendered[0].text, /页数: 3/u)
  // 元数据缺失时必须说清楚，而不是留一行空白
  assert.match(rendered[0].text, /PDF 未内嵌标题|未内嵌/u)
})

test('paper_import：重复导入复用缓存，返回值仍然合规', async () => {
  const paths = fixture()
  const definition = paths.tools.get('paper_import')
  const first = await definition.execute({ source: paths.pdfPath })
  const second = await definition.execute({ source: paths.pdfPath })

  assert.equal(second.docId, first.docId)
  assert.equal(second.reused, true)
  assertOutput(definition, second)
  assert.match(definition.output.render({}, second)[0].text, /命中已有缓存/u)
})

test('paper_import：文件不存在时抛错，错误信息带路径', async () => {
  const { tools } = fixture()
  await assert.rejects(
    tools.get('paper_import').execute({ source: '/tmp/根本没有这篇论文.pdf' }),
    /找不到文件/u,
  )
})

test('paper_search：命中项带页码与章节锚点，返回值合规', async () => {
  const paths = fixture()
  const { docId } = await importFixture(paths)
  const definition = paths.tools.get('paper_search')
  const result = await definition.execute({ docId, query: 'projected' })

  assertOutput(definition, result)
  assert.equal(result.mode, 'phrase')
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].anchor, '[p.2 §3.2]')

  const rendered = definition.output.render({}, result)
  assert.match(rendered[0].text, /\[p\.2 §3\.2\]/u)
})

test('paper_search：宽松匹配时在结果里标明', async () => {
  const paths = fixture()
  const { docId } = await importFixture(paths)
  const definition = paths.tools.get('paper_search')
  const result = await definition.execute({ docId, query: 'architecture bleu' })

  assert.equal(result.mode, 'all-words')
  assert.match(definition.output.render({}, result)[0].text, /宽松结果/u)
})

test('paper_search：无命中时 render 指出下一步，而不是给一个空列表', async () => {
  const paths = fixture()
  const { docId } = await importFixture(paths)
  const definition = paths.tools.get('paper_search')
  const result = await definition.execute({ docId, query: 'zzz-不存在-zzz' })

  assertOutput(definition, result)
  assert.deepEqual(result.hits, [])
  assert.match(definition.output.render({}, result)[0].text, /没有找到/u)
})

test('paper_search：limit 越界时抛错（schema 里没有 minimum/maximum，只能靠代码）', async () => {
  const paths = fixture()
  const { docId } = await importFixture(paths)
  const definition = paths.tools.get('paper_search')

  await assert.rejects(definition.execute({ docId, query: 'e', limit: 0 }), /limit 必须在 1 到 30 之间/u)
  await assert.rejects(definition.execute({ docId, query: 'e', limit: 31 }), /limit 必须在 1 到 30 之间/u)
  // 边界值要放行
  const result = await definition.execute({ docId, query: 'e', limit: 1 })
  assert.equal(result.hits.length, 1)
})

test('paper_read：按页返回正文，返回值合规', async () => {
  const paths = fixture()
  const { docId } = await importFixture(paths)
  const definition = paths.tools.get('paper_read')
  const result = await definition.execute({ docId, pages: '1-2' })

  assertOutput(definition, result)
  assert.deepEqual(
    result.pages.map((page) => page.page),
    [1, 2],
  )
  assert.equal(result.truncated, false)
  assert.deepEqual(result.pagesNotRead, [])

  const rendered = definition.output.render({}, result)[0].text
  assert.match(rendered, /\[p\.1\]/u)
  assert.match(rendered, /\[p\.2\]/u)
})

test('paper_read：截断时「未读页」必须出现在返回值与渲染里', async () => {
  const paths = fixture()
  const { docId } = await importFixture(paths)
  const definition = paths.tools.get('paper_read')
  const result = await definition.execute({ docId, pages: '1-3', maxChars: 30 })

  assertOutput(definition, result)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.pagesNotRead, [2, 3])

  const rendered = definition.output.render({}, result)[0].text
  assert.match(rendered, /被截断/u)
  assert.match(rendered, /2, 3/u)
})

test('paper_read：maxChars 非正时抛错', async () => {
  const paths = fixture()
  const { docId } = await importFixture(paths)
  await assert.rejects(
    paths.tools.get('paper_read').execute({ docId, pages: '1', maxChars: 0 }),
    /maxChars 必须为正整数/u,
  )
})

test('paper_read：页码写法非法或越界时抛错', async () => {
  const paths = fixture()
  const { docId } = await importFixture(paths)
  const definition = paths.tools.get('paper_read')

  await assert.rejects(definition.execute({ docId, pages: '9' }), /越界/u)
  await assert.rejects(definition.execute({ docId, pages: 'abc' }), /看不懂的页码写法/u)
})

test('paper_figure：渲染出 PNG 路径并带回图注原文，返回值合规', async () => {
  const paths = fixture()
  const { docId } = await importFixture(paths)
  const definition = paths.tools.get('paper_figure')
  const result = await definition.execute({ docId, pages: '2' })

  assertOutput(definition, result)
  assert.equal(result.dpi, 120, '未指定 dpi 时用默认值')
  assert.deepEqual(result.figures[0].captions, ['Figure 1: The Transformer architecture.'])
  assert.match(result.figures[0].path, /p002@120\.png$/u)

  const rendered = definition.output.render({}, result)[0].text
  assert.match(rendered, /read_image/u, '必须提示先真的打开图片再判断内容')
})

test('paper_figure：dpi 越界时抛错', async () => {
  const paths = fixture()
  const { docId } = await importFixture(paths)
  const definition = paths.tools.get('paper_figure')

  await assert.rejects(definition.execute({ docId, pages: '1', dpi: 35 }), /dpi 必须在 36 到 600 之间/u)
  await assert.rejects(definition.execute({ docId, pages: '1', dpi: 601 }), /dpi 必须在 36 到 600 之间/u)
})

test('paper_figure：请求页数超过单次上限时抛错', async () => {
  // 单次上限默认 8 页。合成一篇 9 页的论文，否则这个分支根本走不到。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-paper-reader-tools-'))
  const pdfPath = join(dir, 'long.pdf')
  const page = [{ text: '1 Introduction', size: 14 }, { text: 'Body text.', size: 11 }]
  writeFileSync(pdfPath, syntheticPaper(Array.from({ length: 9 }, () => page)))
  const tools = new Map(
    createTools({ cacheRoot: join(dir, 'cache') }).map((definition) => [definition.name, definition]),
  )
  const { docId } = await tools.get('paper_import').execute({ source: pdfPath })

  await assert.rejects(
    tools.get('paper_figure').execute({ docId, pages: '1-9', dpi: 72 }),
    /一次最多渲染 8 页/u,
  )
  // 拆成两批就都该成功——错误信息里那句「请分批请求」必须真的可行
  const first = await tools.get('paper_figure').execute({ docId, pages: '1-5', dpi: 72 })
  const second = await tools.get('paper_figure').execute({ docId, pages: '6-9', dpi: 72 })
  assert.equal(first.figures.length + second.figures.length, 9)
})

test('docId 不存在时四个工具都报出可读的错误', async () => {
  const { tools } = fixture()
  await assert.rejects(tools.get('paper_search').execute({ docId: 'nope', query: 'x' }), /没有这篇论文的导入记录/u)
  await assert.rejects(tools.get('paper_read').execute({ docId: 'nope', pages: '1' }), /没有这篇论文的导入记录/u)
  await assert.rejects(tools.get('paper_figure').execute({ docId: 'nope', pages: '1' }), /没有这篇论文的导入记录/u)
})

test('缓存根可被 config 覆盖，且四个工具共用同一个根', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-paper-reader-tools-'))
  const pdfPath = join(dir, 'paper.pdf')
  writeFileSync(pdfPath, syntheticPaper())
  const cacheRoot = join(dir, 'custom-cache')
  const tools = new Map(createTools({ cacheRoot }).map((definition) => [definition.name, definition]))

  const imported = await tools.get('paper_import').execute({ source: pdfPath })
  assert.equal(imported.cacheDir, join(cacheRoot, imported.docId))

  const searched = await tools.get('paper_search').execute({ docId: imported.docId, query: 'Method' })
  assert.equal(searched.hits.length, 1, '检索必须落在同一个缓存根上')
})
