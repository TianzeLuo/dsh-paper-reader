/**
 * preset-gate.js — 判断「这个会话是不是跑在论文解读模式里」。
 *
 * ## 用在哪、不用在哪
 *
 * 本包被挂两次（见 `lib/roles.js`）。**模型的可见面不经过这里**：技能目录、五个
 * 工具与档位提示词段由 `role: agent` 那一行注册在 preset 的 scope 层上，别的模式
 * 的 agent 不在那条 scope 链上，隔离是结构性的，没有可漏的判断点。
 *
 * 这里只服务**控制面**（`role: control`，profile 根层）的一个消费点：档位端点。
 * 端点挂在根层、URL 可猜测，所以每个请求都要确认「这个 sessionId 属于本模式」，
 * 否则「根层注册」会从一个受控取舍变成真正的越权面。
 *
 * ## 为什么不能只看 live 会话
 *
 * 判断依据是 `agentPreset` 会话 projection —— 它由
 * `@deepseek-ai/dsh-agent-preset-registry` 注册（`ctx.sessionProjections`，
 * 见该包 `lib/index.js` 的 `agentPresetProjectionDefinition`），从会话 header 起
 * 步、被 `agent-preset/selected` 事件推进。它有**两个来源**，缺一不可：
 *
 *   - **还活着的会话**（正在跑，或本次启动后已经发过消息）：`ctx.sessions.get()`
 *     拿得到 Session，直接 `stateOf(session, 'agentPreset')`。
 *   - **冷会话**：Web 里**点开一条历史会话看记录并不会激活 Agent**
 *     （`dsh-api-session-controller` 的 `history.page`：*without activating an
 *     Agent*），所以 `ctx.sessions.get()` 给 undefined。只认 live 会话的写法会
 *     在这种会话上报 `NO_SESSION`，界面上就是「档位读取失败」——而控件本身显示
 *     得出来（它的 `agentPreset` 来自会话列表的 projection），于是症状恰好是
 *     **只有回到旧会话时才坏**。
 *
 * 所以冷会话走 `ctx.sessionQuery.observeSession()`：它按需读一次持久化日志并算出
 * projection，同样**不会激活 Agent**（prepared session 是脱离 live store 的对象，
 * `sessions.get()` 仍然拿不到它）。取到的值与 Web 会话列表里那份是同一个 projection
 * 定义，所以控件显示什么，这里就判什么，两边不会打架。
 *
 * 为什么不读 `agent.session.header.agentPreset`：那是**创建时的**事实，而
 * DSH 允许在首个 turn 之前换 preset（Web 客户端的模式选择器就是这么做的），
 * 换完之后 header 与 projection 会不一致。用 header 会在「建的时候是论文解读、
 * 换成别的模式但还没发消息」的会话上放行——恰好是 projection 要挡的那种情形。
 * projection 拿不到时保守地按「不是本模式」处理。
 */

/** 本插件服务的 preset id（`presets/paper.patch.yml` 里的 `config.id`）。 */
export const PRESET_ID = 'paper'

/** 会话投影里承载 preset id 的那个 key。 */
const PRESET_PROJECTION_KEY = 'agentPreset'

/**
 * 从投影快照里取出 preset id。
 *
 * 会话列表与 `observeSession` 两处的投影块形状一致（`{ values, asOfSeq }`），
 * 所以两条路径共用这一个读数函数。
 *
 * @param {object | undefined} snapshot 投影块。
 * @returns {string | undefined} preset id；没有或不是非空字符串时为 undefined。
 */
function presetFrom(snapshot) {
  const value = snapshot?.values?.[PRESET_PROJECTION_KEY]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 读一个**还活着**的会话当前的 preset id。
 *
 * 拿不到 projection 注册表时返回 undefined（当作「不是本模式」）：宿主没有装配
 * `sessionProjections` 的部署里，档位端点会一律拒绝——这是刻意的保守方向，
 * 端点只是一个控件通道，宁可它不工作，也不要在别的模式里留下一个可写的档位。
 * （模型可见面不受影响：那份隔离由 preset scope 保证，与这里无关。）
 *
 * @param {object} ctx 任意能取到 `sessionProjections` 的上下文。
 * @param {object} session 会话对象。
 * @returns {string | undefined} preset id；未知时为 undefined。
 */
export function presetOf(ctx, session) {
  if (session === undefined || session === null) return undefined
  const projections = ctx?.get?.('sessionProjections')
  if (projections === undefined) return undefined
  try {
    const value = projections.stateOf(session, PRESET_PROJECTION_KEY)
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    // stateOf 在 key 没注册时抛错。这说明装配里没有 preset 注册表，按「不是本模式」处理。
    return undefined
  }
}

/**
 * 读一个**冷会话**（持久化在盘上、当前没有 Agent 的会话）的 preset id。
 *
 * `observeSession` 给的是租借（lease），必须 `dispose()` 归还，否则那份恢复出来的
 * Session 会一直被 observation 缓存钉住。任何失败都当作「不是本模式」：判不出来时
 * 保守地不放行，与上一节的理由一致。
 *
 * @param {object} ctx 宿主上下文。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<string | undefined>} preset id；读不到时为 undefined。
 */
async function coldPresetOf(ctx, sessionId) {
  const query = ctx?.get?.('sessionQuery')
  if (query === undefined || typeof query.observeSession !== 'function') return undefined
  let observation
  try {
    observation = await query.observeSession(sessionId, { projectionMode: 'all' })
    return presetFrom(observation?.projections)
  } catch {
    // 会话不存在、日志损坏、没有持久化层——一律按「不是本模式」处理。
    return undefined
  } finally {
    try {
      observation?.dispose?.()
    } catch {
      // 归还好坏都不该影响这次判断。
    }
  }
}

/**
 * 一个会话是不是「论文解读」模式——**live 与 cold 都能答**。
 *
 * @param {object} ctx 宿主上下文。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<boolean>} 是时为真。
 */
export async function isPaperSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false
  const live = ctx?.get?.('sessions')?.get?.(sessionId)
  if (live !== undefined && live !== null) return presetOf(ctx, live) === PRESET_ID
  return (await coldPresetOf(ctx, sessionId)) === PRESET_ID
}

/**
 * 一个 Agent 是否属于「论文解读」模式。
 *
 * 只对**手上已经有 Agent / Session 对象**的调用方有用；从 sessionId 出发的调用方
 * 请用 {@link isPaperSession}，否则冷会话会被误判。
 *
 * @param {object} agent Agent 对象（`agent.session` 必须存在）。
 * @param {object} ctx 宿主上下文。
 * @returns {boolean} 是时为真。
 */
export function isPaperAgent(ctx, agent) {
  return presetOf(ctx, agent?.session) === PRESET_ID
}
