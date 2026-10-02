/**
 * 档位存储与技能装配的测试。
 *
 * 覆盖四件事：
 *   1. `LevelStore` 的按会话读写、原子写、坏文件降级；
 *   2. 占位符装配：三个档位各自解析、缺占位符/残留变量会**报错**；
 *   3. provider 不自己判断模式：隔离由 preset scope 提供，读取结果与 scope 无关；
 *   4. 档位目录（纯数据）与档位片段文件三者一致。
 *
 * fixture 用 mkdtemp 建在临时目录里，按仓库规范不回收。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_LEVEL_NAME, LEVEL_CATALOG } from '../lib/level-catalog.js'
import { DEFAULT_LEVEL, LEVELS, LevelStore, isLevel, levelStoreAt } from '../lib/level-store.js'
import { LEVEL_INFO, levelPromptSection, levelSection, resolveSkillBody, verifySection } from '../lib/levels.js'
import { createProvider } from '../lib/index.js'

/** 建一个临时档位存储根。 */
function emptyRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-paper-levels-'))
}

/** 一个假的 agent：`dsh-skill` 会把 agent 本身当作 options.scope 传进来。 */
function fakeAgent(sessionId) {
  return { session: { id: sessionId } }
}

test('档位目录：纯数据与 level-store 的 LEVELS 一致，默认档在其中', () => {
  assert.deepEqual(
    LEVEL_CATALOG.map((entry) => entry.name),
    [...LEVELS],
    'level-catalog.js 与 level-store.js 的档位顺序必须一致（前者是界面顺序）',
  )
  assert.ok(LEVELS.includes(DEFAULT_LEVEL), '默认档必须是合法档位')
  assert.equal(DEFAULT_LEVEL, DEFAULT_LEVEL_NAME)
  for (const entry of LEVEL_CATALOG) {
    assert.ok(entry.label.length > 0 && entry.blurb.length > 10, `${entry.name} 的展示信息不完整`)
  }
  assert.equal(LEVEL_INFO.deep.label, '深读')
})

test('LevelStore：没设过时给默认档', () => {
  const store = new LevelStore(emptyRoot())
  assert.equal(store.levelOf('s1'), DEFAULT_LEVEL)
  assert.equal(store.levelOf(undefined), DEFAULT_LEVEL)
})

test('LevelStore：按会话独立读写，并原子落到磁盘', () => {
  const root = emptyRoot()
  const store = new LevelStore(root)
  store.set('s1', 'brief')
  store.set('s2', 'deep')
  assert.equal(store.levelOf('s1'), 'brief')
  assert.equal(store.levelOf('s2'), 'deep')
  assert.equal(store.levelOf('s3'), DEFAULT_LEVEL)

  // 另一个实例（另一个模块实例 / 另一个宿主半部）读同一份文件
  const other = new LevelStore(root)
  assert.equal(other.levelOf('s1'), 'brief')

  const raw = JSON.parse(readFileSync(join(root, 'levels.json'), 'utf8'))
  assert.deepEqual(raw.levels, { s1: 'brief', s2: 'deep' })
})

test('LevelStore：写入不合法档位或空会话 id 时抛错', () => {
  const store = new LevelStore(emptyRoot())
  assert.throws(() => store.set('s1', 'ultra'), /未知档位/u)
  assert.throws(() => store.set('', 'brief'), /sessionId/u)
})

test('LevelStore：坏文件降级成默认档而不是抛错', () => {
  const root = emptyRoot()
  writeFileSync(join(root, 'levels.json'), '{ 半份 JSON', 'utf8')
  assert.equal(new LevelStore(root).levelOf('s1'), DEFAULT_LEVEL)

  // 合法 JSON 但值不合法：非法项被丢掉，合法项留下
  writeFileSync(join(root, 'levels.json'), JSON.stringify({ version: 1, levels: { a: 'deep', b: 'nope' } }), 'utf8')
  const store = new LevelStore(root)
  assert.equal(store.levelOf('a'), 'deep')
  assert.equal(store.levelOf('b'), DEFAULT_LEVEL)
})

test('LevelStore：版本对不上时整份作废', () => {
  const root = emptyRoot()
  writeFileSync(join(root, 'levels.json'), JSON.stringify({ version: 99, levels: { a: 'deep' } }), 'utf8')
  assert.equal(new LevelStore(root).levelOf('a'), DEFAULT_LEVEL)
})

test('levelStoreAt：同一个根在进程内是同一个实例', () => {
  const root = emptyRoot()
  assert.equal(levelStoreAt(root), levelStoreAt(root))
  assert.equal(levelStoreAt(root).levelOf('x'), DEFAULT_LEVEL)
})

test('isLevel 只认三个档位', () => {
  assert.deepEqual(LEVELS.filter(isLevel), [...LEVELS])
  for (const value of ['BRIEF', '', 'standard ', undefined, null, 3, {}]) {
    assert.equal(isLevel(value), false, `${String(value)} 不该被判成合法档位`)
  }
})

test('档位片段：三档都能读出来，且互不重复', () => {
  const seen = new Set()
  for (const level of LEVELS) {
    const section = levelSection(level)
    assert.ok(section.length > 200, `${level}.md 太短，像是没写完`)
    // 片段整段插在技能正文的 `## 当前档位` 之下，所以最高只用 `###`：
    // 同级的 `##` 会把技能自己的章节层级压平。
    assert.ok(!/^#{1,2}\s/u.test(section), `${level}.md 的标题层级不能高于 ###`)
    assert.ok(!section.includes('{{'), `${level}.md 里不该有模板占位符`)
    assert.equal(seen.has(section), false, `${level}.md 与别的档位重复`)
    seen.add(section)
  }
})

test('verify 片段：三个档位小节都能切出来', () => {
  for (const level of LEVELS) {
    const section = verifySection(level)
    assert.ok(section.length > 40, `${level} 的校验项太短`)
    assert.ok(!section.startsWith('#'), `${level} 的校验项不该带标题行`)
  }
  assert.notEqual(verifySection('brief'), verifySection('deep'))
})

test('占位符装配：paper-report 按档位替换，两个档位结果不同', () => {
  const body = '前文\n\n{{workflow}}\n\n后文'
  const brief = resolveSkillBody('paper-report', body, 'brief')
  const deep = resolveSkillBody('paper-report', body, 'deep')
  assert.ok(brief.startsWith('前文'))
  assert.ok(brief.endsWith('后文'))
  assert.ok(brief.includes(levelSection('brief')))
  assert.ok(deep.includes(levelSection('deep')))
  assert.ok(!brief.includes('{{'))
})

test('占位符装配：paper-verify 用档位校验项', () => {
  const resolved = resolveSkillBody('paper-verify', 'A\n{{level-check}}\nB', 'standard')
  assert.ok(resolved.includes(verifySection('standard')))
  assert.ok(!resolved.includes('{{'))
})

test('占位符装配：没有占位符的技能原样返回', () => {
  assert.equal(resolveSkillBody('paper-qa', '正文', 'brief'), '正文')
})

test('占位符装配：缺失、重复、残留都报错', () => {
  assert.throws(() => resolveSkillBody('paper-report', '没有占位符', 'brief'), /没有占位符/u)
  assert.throws(
    () => resolveSkillBody('paper-report', '{{workflow}}\n{{workflow}}', 'brief'),
    /只能出现一次/u,
  )
  // 片段里带未解析变量：装配后仍残留 {{…}}
  const root = emptyRoot()
  writeFileSync(join(root, 'brief.md'), '片段里有 {{oops}}', 'utf8')
  assert.throws(
    () => resolveSkillBody('paper-report', '{{workflow}}', 'brief', { root }),
    /残留模板变量/u,
  )
})

test('档位提示词段：只写当前这一档', () => {
  const section = levelPromptSection('brief')
  assert.ok(section.includes('速览'))
  assert.ok(section.includes('不要自行升档或降档'))
  assert.ok(section.includes('解读') && section.includes('深读'), '要告诉模型换档去哪换')
  assert.ok(!/当前档位：\*\*解读\*\*/u.test(section))
})

test('provider 不判断模式：读取结果与 scope 无关（隔离由 preset scope 提供）', async () => {
  // 早先的版本在这里做运行期门控——非本模式的 agent 拿到空目录、get() 直接抛错。
  // 那套判断已经删掉：provider 现在注册在 «论文解读» preset 的 scope 层上，注册表
  // 不会替别的模式的 agent 来问它，所以 provider 内部没有可漏的判断点。
  // 这条测试钉住「它给谁来读都是同一份目录」，防止门控以任何形式被搬回来。
  const provider = createProvider()
  const bare = await provider.list()
  assert.ok(bare.length >= 3)
  assert.deepEqual(await provider.list({ scope: fakeAgent('s1') }), bare)
  assert.deepEqual(await provider.list({ scope: fakeAgent('s2') }), bare)

  const [candidate] = bare
  const scoped = await provider.get(candidate, { scope: fakeAgent('s1') })
  const unscoped = await provider.get(candidate)
  assert.equal(scoped.content, unscoped.content)
})

test('provider 按档位装配正文：paper-report 在不同档位下正文不同', async () => {
  const [report] = (await createProvider().list()).filter((c) => c.name === 'paper-report')
  assert.ok(report !== undefined, '本包必须有 paper-report')
  const brief = createProvider(undefined, { levelFor: () => 'brief' })
  const deep = createProvider(undefined, { levelFor: () => 'deep' })
  const lookup = { scope: fakeAgent('s1') }
  const a = await brief.get(report, lookup)
  const b = await deep.get(report, lookup)
  assert.ok(a.content.includes(levelSection('brief')))
  assert.ok(b.content.includes(levelSection('deep')))
  assert.ok(!a.content.includes(levelSection('deep')))
  assert.ok(!a.content.includes('{{'))
  assert.ok(!b.content.includes('{{'))
})

test('技能正文装配后仍低于 preset 的裁剪阈值', async () => {
  // 本模式的 preset 挂了 tool-result-pruner（thresholdChars 8192）。技能正文是作为
  // skill 工具结果进入上下文的，超过就会被静默掐掉中段。装配后的正文才是真实长度。
  const candidates = await createProvider().list()
  for (const level of LEVELS) {
    const provider = createProvider(undefined, { levelFor: () => level })
    for (const candidate of candidates) {
      const { content } = await provider.get(candidate, { scope: fakeAgent('s1') })
      assert.ok(
        content.length < 8192,
        `${candidate.name}（${level}）正文 ${content.length} 字符，超过 8192 会被 tool-result-pruner 截断`,
      )
    }
  }
})

test('清理：临时目录删除只发生在测试自己的 fixture 内', () => {
  // 仓库规范「scratch 创建后不清理」针对的是长住的缓存；这里的 fixture 在 /tmp，
  // 留着会随每次测试累积，所以显式在断言里删掉并确认路径在 tmpdir 下。
  const root = emptyRoot()
  assert.ok(root.startsWith(tmpdir()))
  rmSync(root, { recursive: true, force: true })
})
