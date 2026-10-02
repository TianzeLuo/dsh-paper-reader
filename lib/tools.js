/**
 * tools.js — 五个宿主工具：paper_import / paper_search / paper_read /
 * paper_figure / paper_figures。
 *
 * ## 为什么要自己写 defineTool 的等价物
 *
 * 官方写法是 `import { defineTool } from '@deepseek-ai/dsh-tools'`。但本包以 `link:`
 * 装进 profile，Node 按真实路径解析裸导入，`@deepseek-ai/*` 不在本包的祖先目录
 * 链上，实测直接 ERR_MODULE_NOT_FOUND（详见 lib/index.js 顶部与 README）。
 *
 * 所以这里实现一个极简等价物。读源码确认过 `defineTool` 的实际产物契约：
 *
 *     { name, description, parameters(JSON Schema), output: { schema, render },
 *       async execute(args, exec) { 校验参数；不合法则抛错 } }
 *
 * 关键一点：**参数校验是 defineTool 自己生成的 execute 闭包做的，注册表不做**。
 * 而输出侧相反——注册表会拿 `output.schema` 校验返回值，不合规会抛 ToolOutputError。
 * 因此这里必须自己校验入参（下面 parameters()/validateArgs()），并且把返回值严格
 * 投影成 schema 声明的形状。
 *
 * 受支持的 schema 关键字只有
 * `type / oneOf / properties / required / additionalProperties / items / enum / const`
 * 加注解 `description / title / default / examples`——**没有 minimum/maximum**，
 * 所以范围限制只能写在代码里并在错误信息里说清楚。
 *
 * ## render 才是模型看到的东西
 *
 * 注册表把 `render` 的文本交给模型，JSON 返回值只用于校验与 UI。所以凡是模型需
 * 要读的信息（论文地图、图表清单、裁切后的路径）都必须出现在 render 里，光放进
 * JSON 等于没给。
 */

import { isAbsolute, resolve } from 'node:path'

import {
  cropFigure,
  detectFigures,
  importPaper,
  outlineOf,
  parsePages,
  readMeta,
  readPages,
  renderPages,
  searchPaper,
} from './pdf.js'

/** 丢掉值为 undefined 的键：undefined 不是合法 JSON，会被输出校验判违规。 */
function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

/**
 * 由参数规格生成 JSON Schema。
 *
 * @param {Record<string, { type: string, required?: boolean, description: string }>} spec 参数规格。
 * @returns {object} 对象根、显式 required、禁止未知键的 JSON Schema。
 */
function parameters(spec) {
  const properties = {}
  const required = []
  for (const [key, field] of Object.entries(spec)) {
    properties[key] = compact({
      type: field.type,
      description: field.description,
      ...(field.enum === undefined ? {} : { enum: field.enum }),
    })
    if (field.required === true) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * 按 schema 校验实参。
 *
 * 与 defineTool 的做法一致：返回违规列表而不是抛错，由调用方决定怎么报。
 *
 * @param {object} schema `parameters()` 的产物。
 * @param {unknown} args 模型给的实参。
 * @returns {string[]} 违规描述，空数组表示通过。
 */
function validateArgs(schema, args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return ['arguments 必须是一个对象']
  }
  const violations = []
  for (const key of schema.required) {
    if (!Object.hasOwn(args, key)) violations.push(`缺少必填参数 ${key}`)
  }
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key]
    if (field === undefined) {
      violations.push(`不认识参数 ${key}`)
      continue
    }
    if (value === undefined || value === null) continue
    if (field.type === 'integer') {
      if (!Number.isInteger(value)) violations.push(`${key} 必须是整数`)
    } else if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${key} 必须是数字`)
    } else if (Array.isArray(value) ? field.type !== 'array' : typeof value !== field.type) {
      violations.push(`${key} 必须是 ${field.type}`)
    }
    // enum 不在上面的类型检查里，单独兜一下：schema 支持 enum，但校验闭包是我
    // 们自己的，不补这一句模型传了错值也只会静默走默认分支
    if (Array.isArray(field.enum) && !field.enum.includes(value)) {
      violations.push(`${key} 只能是 ${field.enum.join(' / ')}`)
    }
  }
  return violations
}

/**
 * 组装一个注册表可用的工具定义。
 *
 * @param {{ name: string, description: string, parameters: object, output: object,
 *   execute: (args: object, exec: object) => Promise<object> }} options 工具声明。
 * @returns {object} 工具定义。
 */
function tool(options) {
  const schema = parameters(options.parameters)
  return {
    name: options.name,
    description: options.description,
    parameters: schema,
    output: options.output,
    async execute(args, exec) {
      const violations = validateArgs(schema, args)
      if (violations.length > 0) {
        throw new Error(`${options.name} 参数不合法：${violations.join('；')}`)
      }
      return options.execute(args, exec)
    },
  }
}

/** 纯文本内容块。 */
function text(value) {
  return [{ type: 'text', text: value }]
}

/** 渲染成带锚点的引用块，供检索与读取结果共用。 */
function renderAnchored(header, items) {
  const body = items.map((item) => `${item.anchor}\n${item.text}`).join('\n\n')
  return text(`${header}\n\n${body}`)
}

/** Windows 盘符路径，用来拦「在 Linux 上收到 C:\…」这类平台错配。 */
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/
/** POSIX 绝对路径。 */
const POSIX_PATH = /^\//

/**
 * 解析 `outputDir`：绝对路径直接用；相对路径接到会话工作目录上。
 *
 * 拿不到会话工作目录时**不猜**——报错让模型传绝对路径，好过写到一个莫名其妙
 * 的地方去。跨平台的路径写法也在这里拦下：宿主是 Linux 却收到 `C:\…`、或者反
 * 过来，都是不会有好结果的组合。
 *
 * @param {string | undefined} value 模型给的 outputDir。
 * @param {object} exec 工具执行上下文。
 * @returns {string | undefined} 绝对路径，未提供时返回 undefined。
 */
function resolveOutputDir(value, exec) {
  if (value === undefined) return undefined
  const mismatched =
    process.platform === 'win32' ? POSIX_PATH.test(value) && !WINDOWS_PATH.test(value) : WINDOWS_PATH.test(value)
  if (mismatched) {
    throw new Error(`outputDir 的路径写法与当前平台（${process.platform}）不符：${value}`)
  }
  if (isAbsolute(value)) return value
  const cwd = exec?.agent?.session?.meta?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return resolve(cwd, value)
  throw new Error(`outputDir 用了相对路径「${value}」，但当前上下文里拿不到会话工作目录。请传绝对路径。`)
}

/**
 * 五个工具的定义，按注册顺序导出。
 *
 * @param {{ cacheRoot?: string }} [options] 缓存根目录覆盖，测试用。
 * @returns {object[]} 工具定义数组。
 */
export function createTools(options = {}) {
  const cacheRoot = options.cacheRoot

  const importTool = tool({
    name: 'paper_import',
    description:
      '把一篇 PDF 论文导入本地缓存，得到后续检索与读取要用的 docId，同时返回这份论文的' +
      '章节树与图表清单（论文地图）。' +
      '**先看地图再决定读哪几页**，不要从摘要开始顺序读。' +
      '同一份文件重复导入会直接复用已有缓存，不会重新解析。' +
      'source 用文件的绝对路径（例如用户上传的附件路径或本地路径）。',
    parameters: {
      source: { type: 'string', required: true, description: 'PDF 文件的绝对路径' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: '后续工具要用的论文 id' },
          pageCount: { type: 'integer' },
          cacheDir: { type: 'string' },
          sourcePath: { type: 'string' },
          reused: { type: 'boolean', description: '是否命中了已有缓存' },
          pdfTitle: { type: 'string', description: 'PDF 内嵌标题，论文常常没有' },
          pdfAuthor: { type: 'string' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                title: { type: 'string' },
                page: { type: 'integer' },
                anchor: { type: 'string' },
              },
              required: ['label', 'title', 'page', 'anchor'],
              additionalProperties: false,
            },
          },
          figures: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                kind: { type: 'string', enum: ['figure', 'table'] },
                page: { type: 'integer' },
                anchor: { type: 'string' },
                caption: { type: 'string' },
              },
              required: ['label', 'kind', 'page', 'anchor', 'caption'],
              additionalProperties: false,
            },
          },
          omittedSections: { type: 'integer', description: '因上限没有列出的章节数' },
          omittedFigures: { type: 'integer', description: '因上限没有列出的图表数' },
        },
        required: [
          'docId',
          'pageCount',
          'cacheDir',
          'sourcePath',
          'reused',
          'sections',
          'figures',
          'omittedSections',
          'omittedFigures',
        ],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const sections = value.sections.map((section) => `  ${section.anchor} ${section.title}`)
        const figures = value.figures.map((figure) => `  ${figure.anchor} ${figure.caption}`)
        if (value.omittedSections > 0) sections.push(`  …另有 ${value.omittedSections} 节未列出`)
        if (value.omittedFigures > 0) figures.push(`  …另有 ${value.omittedFigures} 个图表未列出`)
        return text(
          [
            `已导入：${value.pdfTitle ?? '(PDF 未内嵌标题)'}`,
            `docId: ${value.docId}`,
            `页数: ${value.pageCount}`,
            `原文: ${value.sourcePath}`,
            `缓存: ${value.cacheDir}`,
            value.pdfAuthor === undefined ? undefined : `作者(PDF 内嵌): ${value.pdfAuthor}`,
            value.reused ? '（命中已有缓存，未重新解析）' : undefined,
            '',
            '论文标题与作者请以正文首页为准，PDF 元数据经常缺失或写错。',
            `章节（${value.sections.length + value.omittedSections}）:`,
            ...sections,
            `图表（${value.figures.length + value.omittedFigures}）:`,
            ...figures,
            '',
            '接下来：需要正文就用 paper_read 按页读（页数见上面的锚点），' +
              '需要图就用 paper_figures 裁图；不要凭印象猜页码。',
          ]
            .filter((line) => line !== undefined)
            .join('\n'),
        )
      },
    },
    async execute(args) {
      const meta = importPaper(args.source, { cacheRoot })
      const outline = outlineOf(meta.docId, { cacheRoot })
      const sectionLimit = 60
      const figureLimit = 40
      const captionLimit = 140
      // 地图是给模型当索引用，超长的论文截断比灌满上下文好；截断量如实报出来
      return compact({
        docId: meta.docId,
        pageCount: meta.pageCount,
        cacheDir: meta.cacheDir,
        sourcePath: meta.sourcePath,
        reused: meta.reused,
        pdfTitle: meta.pdfTitle,
        pdfAuthor: meta.pdfAuthor,
        sections: outline.sections.slice(0, sectionLimit),
        figures: outline.figures.slice(0, figureLimit).map((figure) => ({
          ...figure,
          caption: figure.caption.length > captionLimit ? `${figure.caption.slice(0, captionLimit)}…` : figure.caption,
        })),
        omittedSections: Math.max(0, outline.sections.length - sectionLimit),
        omittedFigures: Math.max(0, outline.figures.length - figureLimit),
      })
    },
  })

  const searchTool = tool({
    name: 'paper_search',
    description:
      '在已导入的论文里检索词句，返回命中片段及其页码/章节锚点。' +
      '回答论文相关问题时**优先用它定位依据**，而不是通读全文。' +
      '先按短语匹配，一个都没有时自动退化为"所有词都出现"的宽松匹配（结果里会标明）。' +
      'context 决定每条的上下文量：window（默认，命中处前后各约两段）通常够直接作答，' +
      'snippet 最省，block 居中。',
    parameters: {
      docId: { type: 'string', required: true, description: 'paper_import 返回的 docId' },
      query: { type: 'string', required: true, description: '检索词或短语' },
      limit: {
        type: 'integer',
        description: '最多返回多少条命中，默认 6，最大 30',
      },
      context: {
        type: 'string',
        enum: ['snippet', 'block', 'window'],
        description: '每条命中带多少上下文，默认 window',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          query: { type: 'string' },
          mode: { type: 'string', enum: ['phrase', 'all-words'] },
          context: { type: 'string', enum: ['snippet', 'block', 'window'] },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                page: { type: 'integer' },
                anchor: { type: 'string' },
                text: { type: 'string' },
                section: { type: 'string' },
              },
              required: ['page', 'anchor', 'text'],
              additionalProperties: false,
            },
          },
        },
        required: ['docId', 'query', 'mode', 'context', 'hits'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.hits.length === 0) {
          return text(
            `没有找到 “${value.query}”。换个近义说法或更短的片段再试；` +
              '也可以先用 paper_read 读摘要与引言确认论文里的实际用词。',
          )
        }
        const note =
          value.mode === 'phrase' ? '' : '\n\n（未命中完整短语，以下是所有词都出现的宽松结果）'
        return renderAnchored(`命中 ${value.hits.length} 处：${value.query}${note}`, value.hits)
      },
    },
    async execute(args) {
      const limit = args.limit === undefined ? 6 : args.limit
      if (limit < 1 || limit > 30) throw new Error('limit 必须在 1 到 30 之间')
      const context = args.context ?? 'window'
      const result = searchPaper(args.docId, args.query, limit, { cacheRoot, context })
      return {
        docId: result.docId,
        query: result.query,
        mode: result.mode,
        context,
        hits: result.hits.map((hit) =>
          compact({ page: hit.page, anchor: hit.anchor, text: hit.text, section: hit.section }),
        ),
      }
    },
  })

  const readTool = tool({
    name: 'paper_read',
    description:
      '按页读取已导入论文的正文，返回带页码锚点的原文。' +
      '用于精读某一节、或核对具体数字与实验设置。' +
      '**只在 paper_search 的上下文不足以回答时才用**——整页很占上下文。' +
      '页数多时请分批读，一次读太多会挤占上下文，且超出上限的部分不会返回。',
    parameters: {
      docId: { type: 'string', required: true, description: 'paper_import 返回的 docId' },
      pages: {
        type: 'string',
        required: true,
        description: '页码表达式：3 或 3-5 或 3,7,9-11（1 基）',
      },
      maxChars: {
        type: 'integer',
        description: '累计返回字符上限，默认 24000',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          pages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                page: { type: 'integer' },
                text: { type: 'string' },
                truncated: { type: 'boolean' },
              },
              required: ['page', 'text'],
              additionalProperties: false,
            },
          },
          truncated: { type: 'boolean' },
          pagesNotRead: { type: 'array', items: { type: 'integer' } },
        },
        required: ['docId', 'pages', 'truncated', 'pagesNotRead'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const parts = value.pages.map((page) =>
          page.truncated === true
            ? `[p.${page.page}]（本页因超上限被截断）\n${page.text}`
            : `[p.${page.page}]\n${page.text}`,
        )
        if (value.truncated && value.pagesNotRead.length > 0) {
          parts.push(`（以下页未读取，需要时再请求：${value.pagesNotRead.join(', ')}）`)
        }
        return text(parts.join('\n\n'))
      },
    },
    async execute(args) {
      const maxChars = args.maxChars === undefined ? 24_000 : args.maxChars
      if (maxChars < 1) throw new Error('maxChars 必须为正整数')
      const result = readPages(args.docId, args.pages, maxChars, { cacheRoot })
      return {
        docId: result.docId,
        pages: result.pages.map((page) =>
          compact({ page: page.page, text: page.text, truncated: page.truncated }),
        ),
        truncated: result.truncated,
        pagesNotRead: result.pagesNotRead,
      }
    },
  })

  const figureTool = tool({
    name: 'paper_figure',
    description:
      '把论文的若干页渲染成 PNG，或按 bbox 裁出一块区域，返回图片路径与邻近图注原文。' +
      '不能读图时只能转述图注并标注「未查看图像，仅转述图注」，不要凭图注推测图中趋势。' +
      '整页图用于自己看清细节；要放进报告请优先用 paper_figures 自动裁好图。' +
      '裁得不对时用 bbox 传 "x0,y0,x1,y1"（PDF 点，原点左上）手动裁；' +
      '**bbox 压到图注时会被自动收紧到图注之外**（结果与邻近图注原文都在返回值里）——' +
      '图注原文写在报告里图片的下方，不要靠放大 bbox 把它带进图里。',
    parameters: {
      docId: { type: 'string', required: true, description: 'paper_import 返回的 docId' },
      pages: { type: 'string', required: true, description: '页码表达式：5 或 5-7；给了 bbox 时只能是单页' },
      dpi: { type: 'integer', description: '渲染分辨率，默认 120；细节看不清时再提高' },
      bbox: {
        type: 'string',
        description: '只裁这一块：x0,y0,x1,y1（PDF 点）。给了它就忽略 dpi 之外的整页渲染',
      },
      label: { type: 'string', description: '裁剪图的文件名前缀，默认 crop_p<页码>' },
      outputDir: {
        type: 'string',
        description: '把 PNG 写进这个目录（绝对路径，或相对会话工作目录）。默认写进论文缓存',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          dpi: { type: 'integer' },
          outputDir: { type: 'string' },
          figures: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                page: { type: 'integer' },
                file: { type: 'string' },
                path: { type: 'string' },
                captions: { type: 'array', items: { type: 'string' } },
                clippedCaptions: { type: 'array', items: { type: 'string' } },
                bbox: { type: 'array', items: { type: 'number' } },
                width: { type: 'integer' },
                height: { type: 'integer' },
              },
              required: ['page', 'file', 'path', 'captions', 'clippedCaptions'],
              additionalProperties: false,
            },
          },
        },
        required: ['docId', 'dpi', 'figures'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const body = value.figures
          .map((figure) => {
            const captions =
              figure.captions.length === 0
                ? '（附近没找到形态匹配的图注）'
                : figure.captions.map((caption) => `  · ${caption}`).join('\n')
            const size = figure.width === undefined ? '' : ` ${figure.width}×${figure.height}`
            const region = figure.bbox === undefined ? '' : ` 裁自 [${figure.bbox.join(', ')}]`
            const excluded =
              figure.clippedCaptions.length === 0
                ? ''
                : `\n已把裁切框收紧到图注之外，排除了：\n${figure.clippedCaptions
                    .map((caption) => `  · ${caption}`)
                    .join('\n')}`
            return `[p.${figure.page}]${size}${region}\n${figure.path}${excluded}\n图注原文（写在报告里图片的下方，不要裁进图里）：\n${captions}`
          })
          .join('\n\n')
        return text(`${body}\n\n提示：先用 read_image 打开上面的路径再判断图像内容。`)
      },
    },
    async execute(args, exec) {
      const dpi = args.dpi === undefined ? 120 : args.dpi
      if (dpi < 36 || dpi > 600) throw new Error('dpi 必须在 36 到 600 之间')
      const outputDir = resolveOutputDir(args.outputDir, exec)
      if (args.bbox !== undefined) {
        const numbers = args.bbox.split(',').map((part) => Number(part.trim()))
        if (numbers.length !== 4 || numbers.some((value) => !Number.isFinite(value))) {
          throw new Error(`bbox 要写成 "x0,y0,x1,y1" 四个数字，收到「${args.bbox}」`)
        }
        const pages = args.pages
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
        if (pages.length !== 1 || !/^\d+$/.test(pages[0])) {
          throw new Error('用 bbox 裁切时 pages 只能给一页（例如 "7"）')
        }
        const crop = cropFigure(
          args.docId,
          {
            page: Number(pages[0].trim()),
            bbox: numbers,
            dpi,
            label: args.label,
            outputDir,
          },
          { cacheRoot },
        )
        return {
          docId: args.docId,
          dpi,
          ...(outputDir === undefined ? {} : { outputDir }),
          figures: [
            {
              page: crop.page,
              file: crop.file,
              path: crop.path,
              captions: crop.captions.map(
                (caption) => `${caption.anchor}（${caption.side === 'above' ? '在图形上方' : '在图形下方'}）${caption.text}`,
              ),
              clippedCaptions: crop.clippedCaptions.map((caption) => `${caption.anchor} ${caption.text}`),
              bbox: crop.bbox,
              width: crop.width,
              height: crop.height,
            },
          ],
        }
      }
      const result = renderPages(args.docId, args.pages, dpi, { cacheRoot, outputDir })
      return {
        docId: result.docId,
        dpi: result.dpi,
        ...(result.outputDir === undefined ? {} : { outputDir: result.outputDir }),
        figures: result.figures.map((figure) => ({
          page: figure.page,
          file: figure.file,
          path: figure.path,
          captions: figure.captions,
          clippedCaptions: [],
        })),
      }
    },
  })

  const figuresTool = tool({
    name: 'paper_figures',
    description:
      '把论文里的图与表按图注自动裁出来，一张图一个 PNG，并返回图注与页码锚点。' +
      '**报告里要放图就用它**：裁出来的是图本身，不是整页截图；图注会一并返回，' +
      '放进报告时可以写在图下方。' +
      '先用 read_image 确认裁切对不对，裁歪了再用 paper_figure 传 bbox 手动裁。' +
      '未能自动裁切的项会列在最后。',
    parameters: {
      docId: { type: 'string', required: true, description: 'paper_import 返回的 docId' },
      pages: { type: 'string', description: '只处理这几页：5 或 5-7 或 5,9。默认全篇' },
      dpi: { type: 'integer', description: '裁切分辨率，默认 200；报告里看不清再提高' },
      max: { type: 'integer', description: '最多裁多少个，默认 24' },
      outputDir: {
        type: 'string',
        description: '把 PNG 写进这个目录（绝对路径，或相对会话工作目录）。报告用图请指向报告同级的资源目录',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          dpi: { type: 'integer' },
          outputDir: { type: 'string' },
          reused: { type: 'boolean', description: '检测结果是否命中了缓存' },
          figures: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                kind: { type: 'string', enum: ['figure', 'table'] },
                page: { type: 'integer' },
                anchor: { type: 'string' },
                caption: { type: 'string' },
                bbox: { type: 'array', items: { type: 'number' } },
                detection: { type: 'string', enum: ['display-list', 'caption-band'] },
                file: { type: 'string' },
                path: { type: 'string' },
                width: { type: 'integer' },
                height: { type: 'integer' },
              },
              required: ['id', 'label', 'kind', 'page', 'anchor', 'caption', 'bbox', 'detection', 'file', 'path'],
              additionalProperties: false,
            },
          },
          undetected: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                kind: { type: 'string', enum: ['figure', 'table'] },
                page: { type: 'integer' },
                anchor: { type: 'string' },
                caption: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['label', 'kind', 'page', 'anchor', 'caption', 'reason'],
              additionalProperties: false,
            },
          },
          omitted: { type: 'integer', description: '因 max 上限没有裁的图表数' },
        },
        required: ['docId', 'dpi', 'reused', 'figures', 'undetected', 'omitted'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const lines = value.figures.map(
          (figure) =>
            `${figure.anchor}（${figure.kind === 'table' ? '表' : '图'}，${figure.width}×${figure.height}）\n` +
            `  ${figure.file}\n  图注：${figure.caption}`,
        )
        if (value.omitted > 0) lines.push(`（还有 ${value.omitted} 个图表没裁，需要时用 pages 分批）`)
        const failed = value.undetected.map(
          (item) => `${item.anchor} ${item.reason}；用 paper_figure 的 bbox 手动裁`,
        )
        return text(
          [
            `已裁出 ${value.figures.length} 个图表${
              value.outputDir === undefined
                ? '（写在论文缓存里——报告要用图请传 outputDir，不要引用缓存路径）'
                : `，写在 ${value.outputDir}`
            }`,
            '裁切框已排除图注文字；图注原文在下面，报告里请写在图片**下方**的斜体行。',
            '',
            ...lines,
            ...(failed.length === 0 ? [] : ['', '未能自动裁切：', ...failed]),
            '',
            '提示：用 read_image 看一眼裁切结果再放进报告；报告里引用时用相对报告文件的路径。' +
              '若画面底部仍残留半行说明文字，用 paper_figure 传 bbox 重裁（它会自动把图注排除在外）。',
          ].join('\n'),
        )
      },
    },
    async execute(args, exec) {
      const dpi = args.dpi === undefined ? 200 : args.dpi
      if (dpi < 36 || dpi > 600) throw new Error('dpi 必须在 36 到 600 之间')
      const max = args.max === undefined ? 24 : args.max
      if (max < 1 || max > 64) throw new Error('max 必须在 1 到 64 之间')
      const outputDir = resolveOutputDir(args.outputDir, exec)
      const detection = detectFigures(args.docId, { cacheRoot })
      let selected = detection.figures
      if (args.pages !== undefined) {
        // 复用解析正文页码的那套解析器：写法非法或越界都会给出可读的报错，而不是
        // 静默筛成空集——那会让人以为「这篇论文这几页没有图」
        const wanted = new Set(parsePages(args.pages, readMeta(args.docId, { cacheRoot }).pageCount))
        selected = selected.filter((figure) => wanted.has(figure.page))
      }
      const rendered = []
      for (const figure of selected.slice(0, max)) {
        const crop = cropFigure(
          args.docId,
          { page: figure.page, bbox: figure.bbox, dpi, label: figure.id, outputDir },
          { cacheRoot },
        )
        rendered.push({
          ...figure,
          file: crop.file,
          path: crop.path,
          width: crop.width,
          height: crop.height,
        })
      }
      return {
        docId: args.docId,
        dpi,
        ...(outputDir === undefined ? {} : { outputDir }),
        reused: detection.reused,
        figures: rendered,
        undetected: detection.undetected,
        omitted: Math.max(0, selected.length - max),
      }
    },
  })

  return [importTool, searchTool, readTool, figureTool, figuresTool]
}

/** 供诊断用：已导入论文的元数据。 */
export { readMeta }
