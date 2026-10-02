/**
 * client.js — dsh-paper-reader 的浏览器半部：**档位控件**。
 *
 * 界面上只有一个东西：输入框工具行左侧的一段三档选择器（速览 / 解读 / 深读），
 * 点一下就把档位写进宿主。它只在「论文解读」模式的会话里出现。
 *
 * ## 为什么挂在 profile 根层却只服务一个模式
 *
 * `@deepseek-ai/dsh-client-modules` 只扫描 `ctx.loader.entries()`（profile 根层的
 * bundle 行）来组装 boot graph，**preset 的子行不在其中**——所以想让浏览器拿到
 * 这个控件，本包就必须出现在根层的 bundle 列表里，于是它的 bundle 对每个页面都
 * 加载。模式隔离因此改由运行期判断：组件读当前会话的 `agentPreset`，不是
 * `paper` 就渲染 null（连请求都不发）。取舍见 `docs/design.md`。
 *
 * ## 约束（dsh 0.2.0-rc.1，见 dsh-client-modules 的加载契约）
 *
 *   - 客户端 bundle 必须以 `window.__ModuleLoader__.load({ id, factory })` 形式注册，
 *     `id` 等于包名，factory 必须**返回** `module.exports`（不返回等于插件没导出）。
 *   - 只能 require seed 静态模块（react / react-dom / cordis / store / ui-slots /
 *     ui-primitives / ui-dockkit）。**相对路径 import 不行**——这里是工厂形式的
 *     CommonJS，没有打包器把本地文件内联进来。所以档位名与展示名在本文件里各存
 *     一份，由 `test/client.test.mjs` 钉死与 `lib/level-catalog.js` 一致。
 *   - 只挂一个插槽：`conversation.input.left`（session 作用域的 list 槽，输入框
 *     工具行左侧的紧凑控件位）。它由 ui-conversation 声明，所以必须用
 *     `ctx.slots.inject` 等声明出现。
 */

window.__ModuleLoader__.load({
  id: 'dsh-paper-reader',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const module = { exports: {} }
    const exports = module.exports

    /** 宿主半部注册的精确路径。两侧必须逐字一致。 */
    const ROUTE_PATH = '/api/dsh-paper-reader/level'
    /** 本插件独占的 locale 命名空间。 */
    const NS = 'paper-reader-level'
    /** 注入样式的 <style> 标识，用于幂等检查。 */
    const STYLE_ID = 'dsh-paper-reader-level-style'
    /** 只有这个 preset 的会话才显示控件。必须与 lib/preset-gate.js 的 PRESET_ID 一致。 */
    const PRESET_ID = 'paper'

    /**
     * 档位展示名。顺序即控件顺序，必须与 `lib/level-catalog.js` 一致
     * （`test/client.test.mjs` 守着）。档位设置本身从宿主读，这里只负责怎么显示。
     */
    const LEVELS = [
      { name: 'brief', label: '速览' },
      { name: 'standard', label: '解读' },
      { name: 'deep', label: '深读' },
    ]

    /** 文案。走 locale 服务而不是写死在组件里。 */
    const DICT = {
      zh: {
        group: '解读档位',
        hint: '报告写多深。由你选定，助手不会自行改档。',
        error: '档位读取失败',
        brief: '速览：通常 800–1500 字（不设上限），只看摘要、引言、方法开头与主结果',
        standard: '解读：通常 3000–6000 字（不设上限），并行分节读正文',
        deep: '深读：参考 8000 字以上（不设上限），读全文加附录的超参、梯度与算力',
      },
      en: {
        group: 'Reading depth',
        hint: 'How deep the report goes. You choose; the agent never changes it on its own.',
        error: 'Could not read the depth',
        brief: 'Brief: usually 800–1500 characters (no hard cap), abstract + intro + method opening + main results',
        standard: 'Standard: usually 3000–6000 characters (no hard cap), parallel per-section reading',
        deep: 'Deep: 8000+ characters as a reference (no hard cap), full text + appendix hyperparameters, gradients, compute',
      },
    }

    /**
     * 读档位失败时的重试次数与退避基数。
     *
     * 控件是随会话视图挂载的，而**打开一条历史会话时宿主是异步把会话读出来的**：
     * 挂载那一刻宿主可能还没准备好回答这条会话的档位。读一次就放弃会让「回到之前
     * 的会话」随机地报「档位读取失败」——同一份数据，刷新一次又好了。所以这里退避
     * 重试几次，把「还没准备好」与「真的坏了」分开。
     */
    const RETRIES = 3
    const RETRY_DELAY_MS = 400

    /**
     * 样式。
     *
     * 逐条对齐 DSH 原生控件：28px 高、圆角、透明底、hover 只换背景不换前景色，
     * 颜色一律走主题别名变量（`--dsw-alias-*`），所以亮暗主题都跟得上。
     * 窄容器下只留当前档的名字，靠 container query 收掉另外两个——与
     * ui-agent-preset 的会话头标签同一手法。
     */
    const CSS = `
.prl-group{display:inline-flex;align-items:center;flex:none;height:28px;padding:2px;
  box-sizing:border-box;border-radius:8px;background:var(--dsw-alias-fill-tsp-secondary,#8881)}
.prl-btn{display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 8px;
  border:0;background:0 0;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-tertiary);
  font-family:inherit;font-size:12px;line-height:16px;white-space:nowrap;
  transition:background 120ms ease,color 120ms ease}
.prl-btn:not(:disabled):hover{color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-interactive-bg-hover)}
.prl-btn[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-3,#fff);
  color:var(--dsw-alias-label-primary);font-weight:500;
  box-shadow:0 1px 2px var(--dsw-alias-bg-mask-drop,rgba(0,0,0,.12))}
.prl-btn:disabled{cursor:default;opacity:.6}
.prl-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:24px;padding:0 6px}
@container (width<=540px){.prl-btn:not([aria-pressed="true"]){display:none}}
`

    /** 幂等注入样式。 */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /**
     * 带 sessionId 调宿主端点。
     *
     * @param {'GET'|'POST'} method 方法。
     * @param {string} sessionId 会话 id。
     * @param {string} [level] POST 时要写的档位。
     * @returns {Promise<object>} 宿主响应体。
     */
    async function callHost(method, sessionId, level) {
      const url = method === 'GET' ? `${ROUTE_PATH}?sessionId=${encodeURIComponent(sessionId)}` : ROUTE_PATH
      const response = await fetch(url, {
        method,
        headers: method === 'GET' ? { accept: 'application/json' } : { 'content-type': 'application/json' },
        credentials: 'same-origin',
        ...(method === 'GET' ? {} : { body: JSON.stringify({ sessionId, level }) }),
      })
      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'HTTP', status: response.status })
      }
      return await response.json()
    }

    /**
     * 档位段控件。
     *
     * @param {object} props 插槽组合出的属性。
     * @param {string} props.sessionId 本会话 id。
     * @param {boolean} props.locked 输入被锁时禁用（与原生控件一致）。
     * @param {Function} props.usePaperSessions 读 `sessions.list` 快照的选择器 hook。
     * @param {Function} props.t 本命名空间的文案函数。
     */
    function LevelControl({ sessionId, locked, usePaperSessions, t }) {
      // 是不是论文解读模式：读会话投影里的 agentPreset。不是就整块不渲染，
      // 一个请求都不发——根层 bundle 对每个页面都加载，这里必须自己收住。
      const preset = usePaperSessions((state) => {
        const value = state?.byId?.[sessionId]?.projectionValues?.agentPreset
        return typeof value === 'string' ? value : undefined
      })
      const active = preset === PRESET_ID

      // status：loading（还没读到，按钮禁用）/ ready / failed / hidden（宿主说不是本模式）。
      const [status, setStatus] = React.useState('loading')
      const [level, setLevel] = React.useState(undefined)

      React.useEffect(() => {
        if (!active) {
          // 切走模式：把状态复位，免得切回来时先闪一下上一轮的档位或错误。
          setStatus('loading')
          setLevel(undefined)
          return undefined
        }
        let cancelled = false
        let timer
        let attempt = 0
        const load = () => {
          callHost('GET', sessionId)
            .then((body) => {
              if (cancelled) return
              if (body?.ok === true) {
                setLevel(body.level)
                setStatus('ready')
                return
              }
              // 宿主说「不是本模式」：两个来源不一致时以宿主为准，整块收掉，不报错。
              if (body?.code === 'NOT_PAPER') {
                setStatus('hidden')
                return
              }
              // 其余（会话还没读出来、端点刚挂上、网络抖动）：退避重试。
              if (attempt >= RETRIES) {
                setStatus('failed')
                return
              }
              attempt += 1
              timer = setTimeout(load, RETRY_DELAY_MS * attempt)
            })
            .catch(() => {
              if (cancelled) return
              if (attempt >= RETRIES) {
                setStatus('failed')
                return
              }
              attempt += 1
              timer = setTimeout(load, RETRY_DELAY_MS * attempt)
            })
        }
        load()
        return () => {
          cancelled = true
          if (timer !== undefined) clearTimeout(timer)
        }
      }, [active, sessionId])

      if (!active || status === 'hidden') return null
      if (status === 'failed') {
        return h('span', { className: 'prl-err', title: t('error') }, t('error'))
      }

      const choose = async (next) => {
        const previous = level
        setLevel(next)
        try {
          const body = await callHost('POST', sessionId, next)
          if (body?.ok !== true) setLevel(previous)
          else setLevel(body.level)
        } catch {
          setLevel(previous)
        }
      }

      return h(
        'div',
        {
          className: 'prl-group',
          role: 'group',
          'aria-label': t('group'),
          title: t('hint'),
        },
        ...LEVELS.map((entry) =>
          h(
            'button',
            {
              key: entry.name,
              type: 'button',
              className: 'prl-btn',
              'aria-pressed': level === entry.name ? 'true' : 'false',
              title: t(entry.name),
              disabled: locked === true || level === undefined,
              onClick: () => void choose(entry.name),
            },
            entry.label,
          ),
        ),
      )
    }

    /**
     * 插件入口。
     *
     * @param {import('cordis').Context} ctx 客户端插件上下文。
     */
    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => ctx.locale.register(NS, DICT), 'paper-reader-level: dictionaries')
      const t = ctx.locale.bind(NS)

      // 输入框工具行左侧。`inject` 的第一个参数是 sessionId（session 作用域的槽）。
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'paper-reader-level',
            order: 20,
            locale: NS,
            inject: (sessionId) => ({
              hooks: { paperSessions: ctx.sessions.list },
            }),
          },
          LevelControl,
        ),
      )
    }

    exports.apply = apply
    // 只依赖插槽、会话面与文案服务。
    exports.inject = ['slots', 'sessions', 'locale']

    // 仅供测试（test/client.test.mjs）核对与宿主目录一致。宿主加载器只读
    // apply / inject，多挂一个字段无副作用。
    exports.__internals = { LEVELS, PRESET_ID, ROUTE_PATH }

    // 必须显式返回：dsh-client-modules 取 factory 的**返回值**当作 exports。
    return module.exports
  },
})
