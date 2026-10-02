/**
 * provider 契约测试。
 *
 * 覆盖三件事：
 *   1. 真实技能包（本包 `skills/`）能被正确登记与加载；
 *   2. frontmatter 的各个校验分支会**报错**而不是静默放行；
 *   3. `apply` 按 `config.role` 分派：代理面注册模型可见面，控制面只注册端点。
 *
 * fixture 用 mkdtemp 建在临时目录里，按仓库规范不回收。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LEVEL_ROUTE, apply, createProvider, name } from '../lib/index.js'
import { levelStoreAt } from '../lib/level-store.js'

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

/**
 * 一个记账用的假宿主 ctx。
 *
 * `inject` 模拟 Cordis 的延迟注入：依赖齐全就**立即**回调（真实宿主在服务已经在位
 * 时也是同步回调），缺任何一个就不回调。`systemPrompt` / `connection` 可以用开关
 * 拿掉，用来覆盖「精简装配里没有这个服务」的分支。
 *
 * @param {{ systemPrompt?: boolean, connection?: boolean, extra?: object }} [options]
 * @returns {{ host: object, seen: { providers: object[], tools: object[], sections: object[], routes: object[] } }}
 */
function fakeHost(options = {}) {
  const seen = { providers: [], tools: [], sections: [], routes: [] }
  const host = {
    ...options.extra,
    skills: {
      registerProvider: (create) =>
        seen.providers.push(create({ signal: new AbortController().signal, invalidate: () => {} })),
    },
    tools: { register: (definition) => seen.tools.push(definition) },
    get: (service) => host[service],
    inject: (deps, callback) => {
      if (deps.every((dep) => host[dep] !== undefined)) callback(host)
    },
  }
  if (options.systemPrompt !== false) host.systemPrompt = { section: (section) => seen.sections.push(section) }
  if (options.connection !== false) host.connection = { fetch: { register: (route) => seen.routes.push(route) } }
  return { host, seen }
}

/** 建一个临时缓存根，避免测试读到这台机器上真实的档位。 */
function cacheRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-paper-cache-'))
}

test('代理面：注册 provider、五个工具与档位提示词段', () => {
  const { host, seen } = fakeHost()

  apply(host, { role: 'agent', cacheRoot: cacheRoot() })

  assert.equal(seen.providers.length, 1)
  assert.equal(seen.providers[0].name, 'dsh-paper-reader')
  assert.deepEqual(
    seen.tools.map((definition) => definition.name),
    ['paper_import', 'paper_search', 'paper_read', 'paper_figure', 'paper_figures'],
  )
  assert.deepEqual(
    seen.sections.map((section) => section.name),
    ['paper-reader:level'],
  )
  // 代理面不注册端点：端点是控制面的事，两行各管一面。
  assert.deepEqual(seen.routes, [])
})

test('代理面：没有 systemPrompt 的装配里只少一个提示词段，工具照常注册', () => {
  const { host, seen } = fakeHost({ systemPrompt: false })

  apply(host, { role: 'agent', cacheRoot: cacheRoot() })

  assert.equal(seen.tools.length, 5, '缺 systemPrompt 不该把五个工具一起拖掉')
  assert.equal(seen.providers.length, 1)
  assert.deepEqual(seen.sections, [])
})

test('控制面：只注册档位端点，一件模型可见的东西都不注册', () => {
  const { host, seen } = fakeHost()

  apply(host, { role: 'control', cacheRoot: cacheRoot() })

  assert.deepEqual(seen.providers, [], '根层不得注册技能 provider')
  assert.deepEqual(seen.tools, [], '根层不得注册模型可见的工具')
  assert.deepEqual(seen.sections, [], '根层不得注册提示词段')
  assert.equal(seen.routes.length, 1)
  assert.equal(seen.routes[0].path, LEVEL_ROUTE)
  assert.deepEqual(seen.routes[0].methods, ['GET', 'POST'])
})

test('控制面：没有 connection 服务（tui / headless）时静默跳过，不抛错', () => {
  const { host, seen } = fakeHost({ connection: false })

  apply(host, { role: 'control', cacheRoot: cacheRoot() })

  assert.deepEqual(seen.routes, [])
})

test('role 缺失或取值不认识时直接报错，不猜默认值', () => {
  const { host } = fakeHost()
  assert.throws(() => apply(host), /config\.role/u)
  assert.throws(() => apply(host, {}), /config\.role/u)
  assert.throws(() => apply(host, { role: 'root' }), /config\.role/u)
})

test('档位段不做门控：按会话取当前档，拿不到会话给空串', () => {
  const root = cacheRoot()
  // 预置一个非默认档，确认段里读的是**这个会话的**档位而不是默认档。
  levelStoreAt(root).set('paper-session', 'deep')

  const { host, seen } = fakeHost()
  apply(host, { role: 'agent', cacheRoot: root })

  // 段名带插件前缀，不会与 persona 的 `deployment:persona-*` 撞名。
  const [section] = seen.sections
  assert.equal(section.name, 'paper-reader:level')
  assert.ok(Number.isFinite(section.order))

  // 隔离由 preset scope 提供，所以这里对「哪个会话」不做任何判断：
  // 能走到这一段的 agent 必然属于本模式。
  const text = section.text({ agent: { session: { id: 'paper-session' } } })
  assert.ok(text.includes('当前档位'))
  assert.ok(text.includes('深读'))

  const other = section.text({ agent: { session: { id: 'another-session' } } })
  assert.ok(other.includes('解读'), '别的会话没设过档位，应当拿到默认档')

  assert.equal(section.text({}), '', '拿不到 agent 时给空串，不替模型猜档')
  assert.equal(section.text({ agent: {} }), '')
})

test('档位端点：只有本模式的会话能读写；冷会话（回到旧会话）也要认，失败一律 200 + ok:false', async () => {
  const root = cacheRoot()
  // 归还租借的记录：冷会话的判定要把 `observeSession` 拿到的 lease 还回去，否则那份
  // 恢复出来的 Session 会被 observation 缓存一直钉住。
  const disposed = []
  const cold = {
    'cold-paper': { projections: { values: { agentPreset: 'paper' } } },
    'cold-code': { projections: { values: { agentPreset: 'standard' } } },
    'cold-noproj': { projections: undefined },
  }
  const { host, seen } = fakeHost({
    extra: {
      sessions: {
        get: (id) =>
          id === 'paper-session' || id === 'code-session' ? { id, header: { id } } : undefined,
      },
      sessionProjections: {
        stateOf: (session) => (session?.id === 'paper-session' ? 'paper' : 'standard'),
      },
      // 冷会话的真相在这里：Web 里点开历史会话不会激活 Agent，`sessions.get()` 给的是
      // undefined，只能靠 sessionQuery 读一次持久化日志算出 projection。
      sessionQuery: {
        observeSession: async (id) => {
          const lease = cold[id]
          if (lease === undefined) {
            throw Object.assign(new Error(`session "${id}" not found`), {
              code: 'SESSION_QUERY_SESSION_NOT_FOUND',
            })
          }
          return { ...lease, dispose: () => disposed.push(id) }
        },
      },
    },
  })
  apply(host, { role: 'control', cacheRoot: root })
  const [route] = seen.routes

  /** 发一个请求并读回 JSON。 */
  const call = async (method, url, body) => {
    const response = await route.fetch(
      new Request(`http://x${url}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    // 客户端只需要一条分支：业务失败也是 200，用 code 区分。
    assert.equal(response.status, 200)
    return response.json()
  }

  assert.deepEqual(await call('GET', LEVEL_ROUTE), {
    ok: false,
    code: 'BAD_REQUEST',
    message: '缺少 sessionId',
  })
  // 会话不存在与不是本模式合流成同一个 code：两种情况下控件都不该出现。
  assert.equal((await call('GET', `${LEVEL_ROUTE}?sessionId=ghost`)).code, 'NOT_PAPER')
  assert.equal((await call('GET', `${LEVEL_ROUTE}?sessionId=code-session`)).code, 'NOT_PAPER')
  assert.equal((await call('POST', LEVEL_ROUTE, { sessionId: 'code-session', level: 'deep' })).code, 'NOT_PAPER')
  assert.equal((await call('GET', `${LEVEL_ROUTE}?sessionId=cold-code`)).code, 'NOT_PAPER')
  assert.equal((await call('GET', `${LEVEL_ROUTE}?sessionId=cold-noproj`)).code, 'NOT_PAPER')

  // 本模式：默认档、写档、再读回。
  const initial = await call('GET', `${LEVEL_ROUTE}?sessionId=paper-session`)
  assert.equal(initial.ok, true)
  assert.equal(initial.level, 'standard', '没设过时应当是默认档')
  assert.deepEqual(initial.levels, ['brief', 'standard', 'deep'])

  assert.equal((await call('POST', LEVEL_ROUTE, { sessionId: 'paper-session', level: 'nope' })).code, 'BAD_LEVEL')
  assert.deepEqual(await call('POST', LEVEL_ROUTE, { sessionId: 'paper-session', level: 'brief' }), {
    ok: true,
    sessionId: 'paper-session',
    level: 'brief',
  })
  assert.equal((await call('GET', `${LEVEL_ROUTE}?sessionId=paper-session`)).level, 'brief')
  assert.equal(levelStoreAt(root).levelOf('paper-session'), 'brief', '写档必须落到文件存储')

  // 写档不影响别的会话。
  assert.equal(levelStoreAt(root).levelOf('code-session'), 'standard')

  // 冷会话：读得到、也写得进——「回到之前的会话」时控件不该报「档位读取失败」。
  const coldRead = await call('GET', `${LEVEL_ROUTE}?sessionId=cold-paper`)
  assert.equal(coldRead.ok, true)
  assert.equal(coldRead.level, 'standard')
  assert.deepEqual(await call('POST', LEVEL_ROUTE, { sessionId: 'cold-paper', level: 'deep' }), {
    ok: true,
    sessionId: 'cold-paper',
    level: 'deep',
  })
  assert.equal(levelStoreAt(root).levelOf('cold-paper'), 'deep')
  assert.ok(disposed.includes('cold-paper'), '冷会话判定后必须归还 observation 租借')
})

test('插件导出契约', () => {
  assert.equal(name, 'paper-reader')
})
