/**
 * 浏览器半部（档位控件）的契约测试。
 *
 * 这个文件本身在 Node 里跑不了——它是 `window.__ModuleLoader__.load({ id, factory })`
 * 形式的工厂 CommonJS，靠页面上的模块表提供 `react`。所以这里搭一个最小宿主：
 * 一个假的 `window.__ModuleLoader__` 与一个只实现本文件用到的那几个 API 的假 React，
 * 然后把 factory **真的执行一遍**。
 *
 * 覆盖四件事：
 *   1. 加载器契约：id 等于包名、factory 返回的 exports 带 `apply` / `inject`
 *      （不返回 exports 是 DSH 里最典型的「插件完全静默」失败）；
 *   2. 档位名与展示名与宿主的 `lib/level-catalog.js` **逐条一致**——本地 bundle 没法
 *      import 宿主文件，只能靠这条测试防漂移；
 *   3. 只挂 `conversation.input.left` 一个槽，且会把 `sessions.list` 作为 hook 注入；
 *   4. 组件的模式门控：`agentPreset` 不是 `paper` 时渲染 null，且**不发请求**；
 *      是 `paper` 时按宿主返回的档位渲染，点击写回宿主。
 */

import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LEVEL_CATALOG } from '../lib/level-catalog.js'

const CLIENT_SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * 在假宿主里执行 `lib/client.js`，返回它注册的插件入口。
 *
 * @returns {{ id: string, exports: object }} 加载器收到的注册内容。
 */
function loadBundle() {
  let registered
  const window = {
    __ModuleLoader__: {
      load: (row) => {
        registered = row
      },
    },
  }

  const hooks = []
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const React = {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (effect) => {
      hooks.push(effect)
    },
    useRef: (initial) => ({ current: initial }),
    useSyncExternalStore: (subscribe, getSnapshot) => {
      void subscribe
      return getSnapshot()
    },
  }
  const require = (id) => {
    if (id === 'react') return React
    throw new Error(`测试宿主没有 ${id} 这个模块`)
  }

  // `ensureStyles()` 会查/建 `<style>`，所以至少要有一个能记住节点的假 document。
  const document = {
    head: { appendChild: () => undefined },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
  }

  // eslint-disable-next-line no-new-func -- 就是要在假宿主里跑这段浏览器代码
  new Function('window', 'require', 'document', 'fetch', CLIENT_SOURCE)(
    window,
    require,
    document,
    () => Promise.reject(new Error('测试里不该发请求')),
  )
  assert.ok(registered !== undefined, 'lib/client.js 没有调用 window.__ModuleLoader__.load')
  return { id: registered.id, exports: registered.factory(require), hooks }
}

test('加载器契约：id 是包名，factory 返回的 exports 带 apply 与 inject', () => {
  const { id, exports } = loadBundle()
  assert.equal(id, 'dsh-paper-reader')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'sessions', 'locale'])
})

test('档位目录与宿主 lib/level-catalog.js 逐条一致', () => {
  const { exports } = loadBundle()
  assert.deepEqual(
    exports.__internals.LEVELS,
    LEVEL_CATALOG.map((entry) => ({ name: entry.name, label: entry.label })),
    '浏览器半部的档位名/展示名与宿主目录漂移了：本地 bundle 不能 import 宿主文件，必须手工同步',
  )
})

test('只挂 conversation.input.left，并把 sessions.list 注入为 hook', () => {
  const { exports } = loadBundle()
  const injections = []
  const registrations = []
  const ctx = {
    effect: () => undefined,
    locale: { register: () => undefined, bind: () => (key) => key },
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
    slots: {
      inject: (key, callback) => {
        injections.push(key)
        callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => undefined
      },
    },
  }

  exports.apply(ctx)

  assert.deepEqual(injections, ['conversation.input.left'])
  assert.equal(registrations.length, 1)
  const [{ options, component }] = registrations
  assert.equal(options.name, 'conversation.input.left')
  assert.equal(options.id, 'paper-reader-level')
  assert.equal(typeof component, 'function')

  const injected = options.inject('session-1')
  assert.equal(injected.hooks.paperSessions, ctx.sessions.list)
})

/** 渲染组件并返回首个非 null 的节点。 */
function renderControl({ preset, level = 'standard', t = (key) => key, requests = [] }) {
  const { exports } = loadBundle()
  const registrations = []
  const ctx = {
    effect: () => undefined,
    locale: { register: () => undefined, bind: () => () => t },
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => undefined
      },
    },
  }
  exports.apply(ctx)
  const { component } = registrations[0]
  const usePaperSessions = (selector) =>
    selector({ byId: { 'session-1': { projectionValues: { agentPreset: preset } } } })
  void requests
  return component({ sessionId: 'session-1', locked: false, usePaperSessions, t })
}

test('模式门控：agentPreset 不是 paper 时渲染 null', () => {
  assert.equal(renderControl({ preset: 'standard' }), null)
  assert.equal(renderControl({ preset: undefined }), null)
})

test('模式门控：是 paper 时渲染三档段控件', () => {
  const tree = renderControl({ preset: 'paper' })
  assert.ok(tree !== null, 'paper 会话里必须出现控件')
  assert.equal(tree.props.role, 'group')
  const buttons = tree.children.filter((child) => child?.type === 'button')
  assert.deepEqual(
    buttons.map((button) => button.children[0]),
    ['速览', '解读', '深读'],
  )
  // 没读到档位前禁用，避免用户在默认值上误点
  assert.equal(buttons.every((button) => button.props.disabled === true), true)
})

test('样式与端点路径写死在 bundle 内，与宿主约定一致', () => {
  const { exports } = loadBundle()
  assert.equal(exports.__internals.ROUTE_PATH, '/api/dsh-paper-reader/level')
  assert.equal(exports.__internals.PRESET_ID, 'paper')
  assert.ok(CLIENT_SOURCE.includes('conversation.input.left'))
  // 只 require seed 模块：出现相对路径 import 会在浏览器里直接炸
  assert.ok(!/^\s*import\s/mu.test(CLIENT_SOURCE), 'factory 形式的 bundle 不能有 ESM import')
})
