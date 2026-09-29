/**
 * tools.js — 四个宿主工具：paper_import / paper_search / paper_read / paper_figure。
 *
 * ## 为什么要自己写 defineTool 的等价物
 *
 * 官方写法是 `import { defineTool } from '@deepseek-ai/dsh-tools'`。但本包以 `link:`
 * 装进 profile，Node 按真实路径解析裸导入，`@deepseek-ai/*` 不在本包的祖先目录链
 * 上，实测直接 ERR_MODULE_NOT_FOUND（详见 lib/index.js 顶部与 README）。
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
 */

import { importPaper, readMeta, renderPages, searchPaper, readPages } from './pdf.js'

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
    properties[key] = compact({ type: field.type, description: field.description })
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

/**
 * 四个工具的定义，按注册顺序导出。
 *
 * @param {{ cacheRoot?: string }} [options] 缓存根目录覆盖，测试用。
 * @returns {object[]} 工具定义数组。
 */
export function createTools(options = {}) {
  const cacheRoot = options.cacheRoot

  const importTool = tool({
    name: 'paper_import',
    description:
      '把一篇 PDF 论文导入本地缓存，得到后续检索与读取要用的 docId。' +
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
        },
        required: ['docId', 'pageCount', 'cacheDir', 'sourcePath', 'reused'],
        additionalProperties: false,
      },
      render: (_args, value) =>
        text(
          [
            `已导入：${value.pdfTitle ?? '(PDF 未内嵌标题)'}`,
            `docId: ${value.docId}`,
            `页数: ${value.pageCount}`,
            value.pdfAuthor === undefined ? undefined : `作者(PDF 内嵌): ${value.pdfAuthor}`,
            value.reused ? '（命中已有缓存，未重新解析）' : undefined,
            '',
            '论文标题与作者请以正文首页为准，PDF 元数据经常缺失或写错。',
          ]
            .filter((line) => line !== undefined)
            .join('\n'),
        ),
    },
    async execute(args) {
      const meta = importPaper(args.source, { cacheRoot })
      return compact({
        docId: meta.docId,
        pageCount: meta.pageCount,
        cacheDir: meta.cacheDir,
        sourcePath: meta.sourcePath,
        reused: meta.reused,
        pdfTitle: meta.pdfTitle,
        pdfAuthor: meta.pdfAuthor,
      })
    },
  })

  const searchTool = tool({
    name: 'paper_search',
    description:
      '在已导入的论文里检索词句，返回命中片段及其页码/章节锚点。' +
      '回答论文相关问题时**优先用它定位依据**，而不是通读全文。' +
      '先按短语匹配，一个都没有时自动退化为"所有词都出现"的宽松匹配（结果里会标明）。',
    parameters: {
      docId: { type: 'string', required: true, description: 'paper_import 返回的 docId' },
      query: { type: 'string', required: true, description: '检索词或短语' },
      limit: {
        type: 'integer',
        description: '最多返回多少条命中，默认 8，最大 30',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          query: { type: 'string' },
          mode: { type: 'string', enum: ['phrase', 'all-words'] },
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
        required: ['docId', 'query', 'mode', 'hits'],
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
      const limit = args.limit === undefined ? 8 : args.limit
      if (limit < 1 || limit > 30) throw new Error('limit 必须在 1 到 30 之间')
      const result = searchPaper(args.docId, args.query, limit, { cacheRoot })
      return {
        docId: result.docId,
        query: result.query,
        mode: result.mode,
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
      '页数多时请分批读——一次读太多会挤占上下文，且超出上限的部分不会返回。',
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
          page.truncated === true ? `[p.${page.page}]（本页因超上限被截断）\n${page.text}` : `[p.${page.page}]\n${page.text}`,
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
        pages: result.pages.map((page) => compact({ page: page.page, text: page.text, truncated: page.truncated })),
        truncated: result.truncated,
        pagesNotRead: result.pagesNotRead,
      }
    },
  })

  const figureTool = tool({
    name: 'paper_figure',
    description:
      '把论文的若干页渲染成 PNG 图片，返回图片路径与该页的图注原文。' +
      '**判断自己能否读图**：能读图就真的看图再描述；不能读图就只能转述图注，' +
      '并必须标注「未查看图像，仅转述图注」。无论哪种情况都不要凭图注推测图中趋势。',
    parameters: {
      docId: { type: 'string', required: true, description: 'paper_import 返回的 docId' },
      pages: { type: 'string', required: true, description: '页码表达式：5 或 5-7' },
      dpi: { type: 'integer', description: '渲染分辨率，默认 120；细节看不清时再提高' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          dpi: { type: 'integer' },
          figures: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                page: { type: 'integer' },
                path: { type: 'string' },
                captions: { type: 'array', items: { type: 'string' } },
              },
              required: ['page', 'path', 'captions'],
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
                ? '（本页没找到形态匹配的图注）'
                : figure.captions.map((caption) => `  · ${caption}`).join('\n')
            return `[p.${figure.page}] ${figure.path}\n图注原文：\n${captions}`
          })
          .join('\n\n')
        return text(`${body}\n\n提示：先用 read_image 打开上面的路径再判断图像内容。`)
      },
    },
    async execute(args) {
      const dpi = args.dpi === undefined ? 120 : args.dpi
      if (dpi < 36 || dpi > 600) throw new Error('dpi 必须在 36 到 600 之间')
      const result = renderPages(args.docId, args.pages, dpi, { cacheRoot })
      return {
        docId: result.docId,
        dpi: result.dpi,
        figures: result.figures.map((figure) => ({
          page: figure.page,
          path: figure.path,
          captions: figure.captions,
        })),
      }
    },
  })

  return [importTool, searchTool, readTool, figureTool]
}

/** 供诊断用：已导入论文的元数据。 */
export { readMeta }
