/**
 * roles.js — 本插件的两种**挂载角色**。
 *
 * ## 为什么一个包要挂两次
 *
 * 本插件的两面分别只在一个地方能生效，而那两个地方恰好不同：
 *
 *   - **浏览器半部**（档位控件）只有挂在 **profile 根层**才会被加载。
 *     `dsh-client-modules` 组装 boot graph 时只遍历 `ctx.loader.entries()`
 *     （见 `lib/index.js:835` 的 `processOne`），而 preset 的插件子树是
 *     `PresetTree`——它的构造函数刻意把自己从 owner entry 的 `subtree` 上摘掉
 *     （`dsh-agent-preset-registry/lib/index.js` 的 `PresetTree`），所以 preset 里
 *     的行**根本不在** `loader.entries()` 的遍历结果里。挂在那里 = 永远拿不到 UI。
 *
 *   - **模型可见面**（技能目录、五个工具、档位提示词段）只有挂在 **preset 里**
 *     才有天然隔离。agent 的 scope key 以 preset 的 standing key 为父
 *     （`bindScopeParent(key, generation.key)`），scoped 注册表按 scope 链解析，
 *     于是别的模式看不到其中任何一件——不需要任何运行期判断。
 *
 * 把这两件事混在一次挂载里是不可能的，所以包被挂两次，用 `config.role` 说明
 * 「这一行负责哪一面」。两个挂载点都写在**本包自己的 patch 文件**里
 * （`cordis.patch.yml` 与 `presets/paper.patch.yml`），用户不需要手写任何一行。
 *
 * ## 为什么必须是显式配置，而不是自动探测
 *
 * 从 `ctx` 上探测「我是不是在 preset 里」需要 `scopeOf(ctx)`，而它是
 * `@deepseek-ai/dsh-scope` 的内部导出——本包不能依赖 `@deepseek-ai/*`
 * （见 `lib/index.js` 顶部关于 realpath 的说明）。更重要的是：探测出来的默认值
 * 一旦猜错，错的方向是**静默泄漏**（在根层注册模型可见面）或**静默失效**
 * （preset 里不注册工具）。显式声明 + 未知值报错，两种错法都变成启动时的噪音。
 */

/** 控制面：挂 profile 根层。只注册浏览器半部需要的档位端点，一件模型可见的东西都不注册。 */
export const ROLE_CONTROL = 'control'

/** 代理面：挂 preset 内。注册技能目录、五个工具与档位提示词段，隔离由 scope 层保证。 */
export const ROLE_AGENT = 'agent'

/**
 * 读出一个挂载点的角色。
 *
 * @param {{ role?: unknown }} [config] loader 行里的 `config`。
 * @returns {string} `ROLE_CONTROL` 或 `ROLE_AGENT`。
 * @throws {Error} 缺失或取值不认识时。刻意不提供默认值：猜错的代价是上面说的两种
 *   静默故障，而报错只在装配时出现一次，排查成本低得多。
 */
export function roleOf(config) {
  const role = config?.role
  if (role === ROLE_CONTROL || role === ROLE_AGENT) return role
  throw new Error(
    `paper-reader: config.role 必须是 '${ROLE_CONTROL}'（profile 根层）或 '${ROLE_AGENT}'（preset 内），` +
      `实际是 ${JSON.stringify(role ?? null)}。两个挂载点都在本包自己的 patch 文件里，不要手写。`,
  )
}
