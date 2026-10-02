/**
 * preset 契约测试。
 *
 * `presets/paper.patch.yml` 没有 JavaScript 兜底：它的内容全靠 `--dump-config`
 * 才能看出对错。这里把几件不需要启动 DSH 就能守住的契约钉死：
 *
 *   1. persona 模板里除了 `{{cwd}}` 不得出现别的 `{{…}}`。persona 的 prefix/suffix
 *      是按已注册的提示词变量严格解析的，写一个不存在的变量会让提示词组装失败。
 *   2. persona 必须点名五个宿主工具。这是实际踩过的坑：工具注册得好好的，但提示词
 *      层完全没提它们，模型于是继续用 bash + Python 自己抽 PDF 文本。
 *   3. 两个挂载点各就各位：根层是控制面（只为浏览器半部而存在），preset 里是代理面
 *      （技能、工具、提示词段——模型可见的东西全在这里，隔离靠 scope 层）。
 *
 * 刻意不做 YAML 解析：文件里有 `!!js` 标签（DSH 自己的扩展），用标准 YAML 解析器
 * 读会报错，为测试引入一套自定义 tag 得不偿失。
 */

import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ROLE_AGENT, ROLE_CONTROL } from '../lib/roles.js'

const SOURCE = readFileSync(new URL('../presets/paper.patch.yml', import.meta.url), 'utf8')
const PATCH = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

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

test('preset 身份没有被改掉', () => {
  assert.match(SOURCE, /id: preset-paper/u)
  assert.match(SOURCE, /id: paper$/mu)
  assert.match(SOURCE, /name: 论文解读/u)
})

test('两个挂载点各就各位：根层是控制面，preset 里是代理面', () => {
  // 根层 bundle 行：浏览器半部（档位控件）只有走到这里才会被组装进页面。
  assert.match(
    PATCH,
    /- id: paper-reader\n\s+name: 'dsh-paper-reader'\n\s+config:\n(?:\s*#[^\n]*\n)*\s+role: control/u,
    '根层那一行必须是 role: control',
  )
  assert.match(MANIFEST.dsh.bundle.patch.join('\n'), /cordis\.patch\.yml/u)

  // preset 里那一行：模型可见面必须挂在这里，否则工具会回到根层、泄漏到别的模式。
  assert.match(
    SOURCE,
    /- id: paper-reader-agent\n\s+name: 'dsh-paper-reader'\n\s+config:\n(?:\s*#[^\n]*\n)*\s+role: agent/u,
    'preset 里必须有 role: agent 的那一行——技能与五个工具都靠它隔离',
  )

  // 两个角色各出现一次，且不能互换：role 写错会静默泄漏或在预设里静默失效。
  const roles = [...`${BODY}\n${PATCH}`.matchAll(/^\s*role: (\S+)$/gmu)].map((match) => match[1])
  assert.deepEqual(
    roles.sort(),
    [ROLE_AGENT, ROLE_CONTROL],
    `本包应当恰好声明两次 role（根层 control + preset 里 agent），实际 ${roles.join('、') || '一次都没有'}`,
  )
})

test('preset 里的代理面声明在 persona 之后、标准工具集之前', () => {
  // 工具在提示词里的顺序由注册顺序决定。保持与初版一致，避免每次装配都对不上。
  const persona = SOURCE.indexOf('- id: persona')
  const agentRow = SOURCE.indexOf('- id: paper-reader-agent')
  const instructions = SOURCE.indexOf('- id: agent-instructions')
  assert.ok(persona >= 0 && agentRow >= 0 && instructions >= 0)
  assert.ok(persona < agentRow && agentRow < instructions)
})

test('persona 点名五个宿主工具与 read_image', () => {
  for (const tool of [
    'paper_import',
    'paper_search',
    'paper_read',
    'paper_figure',
    'paper_figures',
    'read_image',
  ]) {
    assert.ok(SOURCE.includes(tool), `persona 里没有提到 ${tool}——模型不会知道它该用这个工具`)
  }
})

test('package.json 声明了浏览器半部', () => {
  assert.equal(MANIFEST.exports['./client'], './lib/client.js')
  assert.equal(MANIFEST.dsh.client.platform, 'web')
  assert.ok(MANIFEST.files.includes('levels'), 'levels/ 会被技能正文装配读盘，必须随包发布')
})
