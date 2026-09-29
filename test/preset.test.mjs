/**
 * preset 契约测试。
 *
 * `presets/paper.patch.yml` 没有 JavaScript 兜底：它的内容全靠 `--dump-config`
 * 才能看出对错。这里把两件不需要启动 DSH 就能守住的契约钉死：
 *
 *   1. persona 模板里除了 `{{cwd}}` 不得出现别的 `{{…}}`。persona 的 prefix/suffix
 *      是按已注册的提示词变量严格解析的，写一个不存在的变量会让提示词组装失败。
 *   2. persona 必须点名四个宿主工具。这是实际踩过的坑：工具注册得好好的，但提示词
 *      层完全没提它们，模型于是继续用 bash + Python 自己抽 PDF 文本。
 *
 * 刻意不做 YAML 解析：文件里有 `!!js` 标签（DSH 自己的扩展），用标准 YAML 解析器
 * 读会报错，为测试引入一套自定义 tag 得不偿失。
 */

import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const SOURCE = readFileSync(new URL('../presets/paper.patch.yml', import.meta.url), 'utf8')

/**
 * 去掉注释行后的正文。
 *
 * 文件顶部的注释本身就在讨论「`{{…}}` 会让提示词组装失败」，不排掉注释会把注释
 * 里的例子当成真的模板变量。
 */
const BODY = SOURCE.split('\n')
  .filter((line) => !/^\s*#/u.test(line))
  .join('\n')

test('persona 模板里除了 {{cwd}} 不得出现其它 {{ 变量', () => {
  const found = [...BODY.matchAll(/\{\{[^}]*\}\}/gu)].map((match) => match[0])
  assert.deepEqual([...new Set(found)], ['{{cwd}}'], `出现了未注册的模板变量：${found.join('、')}`)

  const opens = (BODY.match(/\{\{/gu) ?? []).length
  assert.equal(opens, found.length, '有未闭合的 {{，模板解析同样会失败')
})

test('preset 身份与挂载点没有被改掉', () => {
  assert.match(SOURCE, /id: preset-paper/u)
  assert.match(SOURCE, /id: paper$/mu)
  assert.match(SOURCE, /name: 论文解读/u)
  assert.match(SOURCE, /- id: paper-reader\n\s+name: 'dsh-paper-reader'/u)
})

test('persona 点名四个宿主工具与 read_image', () => {
  for (const tool of ['paper_import', 'paper_search', 'paper_read', 'paper_figure', 'read_image']) {
    assert.ok(SOURCE.includes(tool), `persona 里没有提到 ${tool}——模型不会知道它该用这个工具`)
  }
})
