/**
 * provider 契约测试。
 *
 * 覆盖三件事：
 *   1. 真实技能包（本包 `skills/`）能被正确登记与加载；
 *   2. frontmatter 的各个校验分支会**报错**而不是静默放行；
 *   3. `apply` 确实把 provider 交给了 ctx.skills。
 *
 * fixture 用 mkdtemp 建在临时目录里，按仓库规范不回收。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, createProvider, name } from '../lib/index.js'

/** 建一个临时技能根目录，写入若干技能包。 */
function fixtureRoot(skills) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-paper-reader-test-'))
  for (const [skillName, content] of Object.entries(skills)) {
    const directory = join(root, skillName)
    mkdirSync(directory, { recursive: true })
    if (content !== null) writeFileSync(join(directory, 'SKILL.md'), content, 'utf8')
  }
  return root
}

/** 一份合法的 SKILL.md。 */
const valid = (skillName, extra = '') => `---
name: ${skillName}
description: 一句话说明这个技能做什么。
${extra}---

正文第一行。

正文第二段。
`

test('默认根目录：登记本包 skills/ 下的技能包', async () => {
  const provider = createProvider()
  assert.equal(provider.name, 'dsh-paper-reader')

  const candidates = await provider.list()
  const names = candidates.map((candidate) => candidate.name)
  assert.ok(names.includes('paper-qa'), `期望包含 paper-qa，实际 ${names.join(', ')}`)

  const qa = candidates.find((candidate) => candidate.name === 'paper-qa')
  assert.equal(qa.provider, 'dsh-paper-reader')
  assert.equal(qa.source, 'bundled')
  assert.equal(qa.rank, 600)
  assert.deepEqual(qa.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(qa.resourceBase.kind, 'directory')
  // description 是目录行里模型唯一能看到的信息，必须非空且有信息量
  assert.ok(qa.description.length > 10)
})

test('三个技能都在目录里', async () => {
  const names = (await createProvider().list()).map((candidate) => candidate.name)
  assert.deepEqual(names, ['paper-qa', 'paper-report', 'paper-verify'])
})

test('每个技能正文都低于 preset 的裁剪阈值', async () => {
  // 本模式的 preset 挂了 tool-result-pruner（thresholdChars 8192，head 4096 /
  // tail 1024）。技能正文是作为 skill 工具结果进入上下文的，一旦超过阈值就会被
  // 掐掉中段——而且不会报错，只会静默丢内容。所以这条必须由测试守住。
  const provider = createProvider()
  for (const candidate of await provider.list()) {
    const { content } = await provider.get(candidate)
    assert.ok(
      content.length < 8192,
      `${candidate.name} 正文 ${content.length} 字符，超过 8192 会被 tool-result-pruner 截断`,
    )
  }
})

test('get() 返回去 frontmatter 的正文，且剥掉 rank/locator', async () => {
  const provider = createProvider()
  const [qa] = (await provider.list()).filter((candidate) => candidate.name === 'paper-qa')

  const loaded = await provider.get(qa)
  assert.equal(loaded.name, 'paper-qa')
  assert.ok(!('rank' in loaded), 'rank 不应泄漏给消费者')
  assert.ok(!('locator' in loaded), 'locator 不应泄漏给消费者')
  assert.ok(!loaded.content.startsWith('---'), '正文不应包含 frontmatter')
  assert.ok(loaded.content.includes('论文问答') || loaded.content.length > 100)
})

test('get() 每次重新读盘：改正文无需重载', async () => {
  const root = fixtureRoot({ 'live-skill': valid('live-skill') })
  const provider = createProvider(root)
  const [candidate] = await provider.list()
  assert.equal((await provider.get(candidate)).content, '正文第一行。\n\n正文第二段。')

  writeFileSync(join(root, 'live-skill', 'SKILL.md'), valid('live-skill').replace('正文第一行。', '改过的第一行。'), 'utf8')
  assert.equal((await provider.get(candidate)).content.startsWith('改过的第一行。'), true)
})

test('list() 每次重新扫描：新增技能包无需重建 provider', async () => {
  const root = fixtureRoot({ 'first': valid('first') })
  const provider = createProvider(root)
  assert.deepEqual((await provider.list()).map((c) => c.name), ['first'])

  mkdirSync(join(root, 'second'))
  writeFileSync(join(root, 'second', 'SKILL.md'), valid('second'), 'utf8')
  assert.deepEqual((await provider.list()).map((c) => c.name), ['first', 'second'])
})

test('list() 每次重新扫描：删除技能包目录也即时反映', async () => {
  const root = fixtureRoot({ 'first': valid('first'), 'second': valid('second') })
  const provider = createProvider(root)
  assert.deepEqual((await provider.list()).map((c) => c.name), ['first', 'second'])

  rmSync(join(root, 'second'), { recursive: true })
  assert.deepEqual((await provider.list()).map((c) => c.name), ['first'])
})

test('根目录下没有技能包时直接报错', () => {
  const root = fixtureRoot({})
  assert.throws(() => createProvider(root), /没有任何技能包/u)
})

test('技能包缺少 SKILL.md 时报错', () => {
  const root = fixtureRoot({ 'no-file': null })
  assert.throws(() => createProvider(root), /ENOENT|no such file/u)
})

test('缺少 frontmatter 时报错', () => {
  const root = fixtureRoot({ 'bare': '只有正文，没有 frontmatter。\n' })
  assert.throws(() => createProvider(root), /缺少 YAML frontmatter/u)
})

test('缺少 description 时报错', () => {
  const root = fixtureRoot({ 'no-desc': '---\nname: no-desc\n---\n\n正文。\n' })
  assert.throws(() => createProvider(root), /缺少 description/u)
})

test('frontmatter 的 name 与目录名不一致时报错', () => {
  const root = fixtureRoot({ 'dir-name': valid('other-name') })
  assert.throws(() => createProvider(root), /与目录名/u)
})

test('whenToUse 不是字符串时报错', () => {
  const root = fixtureRoot({ 'bad-when': valid('bad-when', 'whenToUse: [a, b]\n') })
  assert.throws(() => createProvider(root), /whenToUse 不是字符串/u)
})

test('更深的嵌套 SKILL.md 不被发现', async () => {
  const root = fixtureRoot({ 'top-level': valid('top-level') })
  // 嵌套目录：不应被当成技能
  mkdirSync(join(root, 'top-level', 'references'), { recursive: true })
  writeFileSync(join(root, 'top-level', 'references', 'SKILL.md'), valid('nested'), 'utf8')

  const names = (await createProvider(root).list()).map((candidate) => candidate.name)
  assert.deepEqual(names, ['top-level'])
})

test('apply() 把 provider 交给 ctx.skills，并注册四个工具', () => {
  const registered = []
  const tools = []
  const ctx = {
    skills: {
      registerProvider: (create) =>
        registered.push(create({ signal: new AbortController().signal, invalidate: () => {} })),
    },
    tools: { register: (definition) => tools.push(definition) },
  }

  apply(ctx)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'dsh-paper-reader')
  assert.deepEqual(
    tools.map((definition) => definition.name),
    ['paper_import', 'paper_search', 'paper_read', 'paper_figure'],
  )
})

test('插件导出契约', () => {
  assert.equal(name, 'paper-reader')
})
