/**
 * 合成一篇「像论文」的 PDF，供测试当 fixture。
 *
 * 为什么手写 PDF 而不是引入 pdf-lib：
 *
 *   1. 本包只有 mupdf / yaml 两个运行时依赖，测试不该为此再拉一个依赖树；
 *   2. fixture 必须**完全确定**——PDF 里带创建时间/生成器版本时，字节哈希会变，
 *      而 docId 就是字节哈希，幂等那条测试立刻变成假绿；
 *   3. 正文内容要能被断言（标题、图注、数字、页码锚点），手写才能精确控制。
 *
 * 输出是未压缩的经典 xref 结构。mupdf 能正常解析（测试里就是这么用的），
 * 但这不是一个通用 PDF 生成器：只支持 Helvetica 的纯 ASCII 单行文本。
 */

/** 转义 PDF 字面字符串里的三个特殊字符。 */
function escapeText(value) {
  return value.replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)')
}

/**
 * 生成一页的内容流。
 *
 * 一行可以写成 `{ text, size }`，也可以用 `parts: [[x, text], …]` 在同一基线上
 * 画多段——真实论文里「3.2.1」与标题之间往往隔着一段空隙，mupdf 会把它们拆成
 * 两个 line 元素，这正是最容易拼错、也最容易让标题识别失效的形态。
 *
 * `advance` 覆盖默认行距：默认留得很大，让每行各自成为一个 block；调小就能
 * 造出「同一段落的折行」，用来验证折行处的空格补齐。
 *
 * @param {{ text?: string, parts?: [number, string][], size: number, advance?: number, bold?: boolean }[]} lines
 *   自上而下的若干行。
 * @returns {string} PDF 内容流正文。
 */
function contentStream(lines) {
  let y = 780
  let out = 'BT\n'
  for (const line of lines) {
    const font = line.bold === true ? '/F2' : '/F1'
    for (const [x, text] of line.parts ?? [[60, line.text]]) {
      out += `1 0 0 1 ${x} ${y} Tm ${font} ${line.size} Tf (${escapeText(text)}) Tj\n`
    }
    // 行距刻意留大：mupdf 会把挨得太近的行并进同一个 block，而锚点、图注、
    // 检索片段都建立在 block 之上，并成一块会让断言失去意义。
    y -= line.advance ?? line.size + 20
  }
  return `${out}ET\n`
}

/**
 * 这篇合成论文的正文。
 *
 * 刻意覆盖这些形态，每一种都对应 pdf.js 里的一条判定：
 *   - 编号标题（`1 Introduction` / `2 Method` / `3.2 Multi-Head Attention`）
 *   - 无编号标题（`Abstract`）
 *   - 图注（`Figure 1:`）与表注（`Table 1:`）
 *   - 一个到处出现的数字（28.7）与真实论文里常被追问的配置（8 张 P100）
 */
export const PAPER_PAGES = [
  [
    { text: 'Attention Is All You Need', size: 18 },
    { text: 'Ashish Vaswani, Noam Shazeer', size: 11 },
    { text: 'Abstract', size: 13 },
    { text: 'We propose a new architecture that reaches 28.7 BLEU.', size: 11 },
    { text: '1 Introduction', size: 14 },
    { text: 'Recurrent models are slow and hard to parallelize.', size: 11 },
  ],
  [
    { text: '2 Method', size: 14 },
    { text: 'Figure 1: The Transformer architecture.', size: 10 },
    { text: 'We use eight attention heads.', size: 11 },
    { text: '3.2 Multi-Head Attention', size: 12 },
    { text: 'Queries, keys and values are projected h times.', size: 11 },
  ],
  [
    { text: '3 Experiments', size: 14 },
    { text: 'Table 1: BLEU scores on WMT 2014.', size: 10 },
    { text: 'Our model reaches 28.7 BLEU as well.', size: 11 },
    { text: 'We trained on 8 NVIDIA P100 GPUs.', size: 11 },
  ],
]

/**
 * 拼出一份完整的 PDF 字节。
 *
 * @param {{ text: string, size: number }[][]} [pages] 每页的行，默认用 PAPER_PAGES。
 * @returns {Buffer} PDF 字节。
 */
export function syntheticPaper(pages = PAPER_PAGES) {
  // 对象编号固定：1 目录、2 页树、3/4 字体（常规 / 加粗），之后每页占两个
  // （页对象 + 内容流）。加粗字体是必需的：标题判定会看排版特征。
  const objects = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  const kids = pages.map((_, index) => `${5 + index * 2} 0 R`)
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'
  pages.forEach((lines, index) => {
    const pageNumber = 5 + index * 2
    const streamNumber = pageNumber + 1
    objects[pageNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamNumber} 0 R >>`
    const stream = contentStream(lines)
    objects[streamNumber] = `<< /Length ${stream.length} >>\nstream\n${stream}endstream`
  })

  let out = '%PDF-1.4\n'
  const offsets = []
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = out.length
    out += `${index} 0 obj\n${objects[index]}\nendobj\n`
  }
  const startxref = out.length
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let index = 1; index < objects.length; index += 1) {
    out += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`

  // 内容全部是 ASCII，所以 latin1 与 UTF-8 的字节完全一致；用 latin1 是为了
  // 让 /Length 的字符数严格等于字节数。
  return Buffer.from(out, 'latin1')
}
