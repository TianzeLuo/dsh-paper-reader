/**
 * level-store.js — 「论文解读」档位的按会话存储。
 *
 * 档位由 UI 控件选定（见 `lib/client.js`），所以它必须满足三件事：
 *
 *   1. **按会话独立。** 同一份工作目录里可以同时开着「速览」与「深读」两个会话，
 *      互不干扰。
 *   2. **宿主两个实例读同一份真相。** 读档位的是 preset 里的宿主半部（它要据此
 *      装配技能正文与提示词段），写档位的是 profile 根层宿主半部的 `/api` 路由
 *      （浏览器半部只能打到那里）。两者是同一进程里同一个包的两个模块实例，
 *      靠模块级单例共享不了状态，所以真值放在磁盘上，内存只做读缓存。
 *   3. **写要原子。** 这份文件同时被路由与多个模型步骤读，不能出现半份 JSON。
 *
 * 为什么不用 session 事件/projection：`Session.append()` 无法给事件打上
 * `ignorable` 标记，而持久化读到未知事件类型时会拒绝整条日志
 * （`dsh-session-persistence`：`unknown to this harness and not marked ignorable`）。
 * 也就是说，一个仓库外插件往会话日志里写自定义事件会让会话之后读不出来。
 * 档位是纯展示态、丢了只影响一次成稿，不值得冒这个风险。
 *
 * 缓存按文件 stat 失效（mtimeMs + size），所以另一个实例写完的下一毫秒就能读到；
 * 每个模型步骤只多一次 `statSync`，不重复解析 JSON。
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_LEVEL_NAME, LEVEL_CATALOG } from './level-catalog.js'

/**
 * 默认存储根：与论文缓存同一个根（`$DSH_HOME/paper-reader`），所以缓存与档位一起
 * 备份、一起迁移，不额外发明一个目录。
 *
 * 刻意不从 `lib/pdf.js` 的 `defaultCacheRoot()` 转发：那个模块会拉起 `mupdf`，
 * 而档位存储同时被浏览器半部的端点用，不该为此付一个 PDF 引擎的加载成本。
 *
 * @returns {string} 存储根目录绝对路径。
 */
export function defaultLevelRoot() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'paper-reader')
}

/**
 * 三个档位的机器名，顺序即由浅到深（来自纯数据目录 `level-catalog.js`，浏览器半部
 * 读的是同一份）。
 *
 * @type {readonly string[]}
 */
export const LEVELS = Object.freeze(LEVEL_CATALOG.map((entry) => entry.name))

/** 没选过档位时的默认档：与技能正文里的旧默认一致。 */
export const DEFAULT_LEVEL = DEFAULT_LEVEL_NAME

/** 存储格式版本。结构变了要抬，对不上就整份重新开始（档位丢了无害）。 */
const STORE_FORMAT = 1

/**
 * 判断一个值是不是合法档位。
 *
 * @param {unknown} value 待判定的值。
 * @returns {boolean} 是三个档位之一时为真。
 */
export function isLevel(value) {
  return typeof value === 'string' && LEVELS.includes(value)
}

/**
 * 档位存储。
 *
 * 一个进程里可能有多个实例（preset 宿主半部与 profile 根层宿主半部），它们各持
 * 一份内存缓存，但都指向同一个文件，所以**读到的是同一份真相**。
 */
export class LevelStore {
  /**
   * @param {string} root 存储根目录，默认由 `defaultRoot()` 给出。
   */
  constructor(root) {
    /** @type {string} 存储根目录。 */
    this.root = root
    /** @type {string} 档位文件路径。 */
    this.path = join(root, 'levels.json')
    /** @type {{version: number, levels: Record<string, string>}} 最近一次解析结果。 */
    this.cache = { version: STORE_FORMAT, levels: {} }
    /** @type {string} 缓存对应的 stat 指纹，空串表示还没读过盘。 */
    this.stamp = ''
  }

  /**
   * 当前文件的 stat 指纹。文件不存在时返回 `'missing'`。
   *
   * @returns {string} 指纹。
   */
  fingerprint() {
    try {
      const info = statSync(this.path)
      return `${info.mtimeMs}:${info.size}`
    } catch {
      // 文件还没建出来：这与「读到空表」等价，不是错误。
      return 'missing'
    }
  }

  /**
   * 读当前全表。解析失败（半份 JSON、手工改坏）时退化成空表而不是抛错：档位丢了
   * 只是回到默认档，不该让整个插件装配失败。
   *
   * @returns {Record<string, string>} `sessionId -> level`。
   */
  read() {
    const stamp = this.fingerprint()
    if (stamp === this.stamp) return this.cache.levels
    this.stamp = stamp
    if (stamp === 'missing') {
      this.cache = { version: STORE_FORMAT, levels: {} }
      return this.cache.levels
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      const levels = parsed?.version === STORE_FORMAT && isRecord(parsed.levels) ? parsed.levels : {}
      const clean = {}
      for (const [sessionId, level] of Object.entries(levels)) {
        if (isLevel(level)) clean[sessionId] = level
      }
      this.cache = { version: STORE_FORMAT, levels: clean }
    } catch {
      this.cache = { version: STORE_FORMAT, levels: {} }
    }
    return this.cache.levels
  }

  /**
   * 读一个会话的档位。
   *
   * @param {string} sessionId 会话 id。
   * @returns {string} 合法档位；没设过或值不合法时给默认档。
   */
  levelOf(sessionId) {
    const value = typeof sessionId === 'string' ? this.read()[sessionId] : undefined
    return isLevel(value) ? value : DEFAULT_LEVEL
  }

  /**
   * 写一个会话的档位。
   *
   * 先写同目录下的临时文件再 `rename`，因此读侧永远看到完整的 JSON。临时文件名带
   * 进程号，两个实例同时写也不会互相截断（最后落地的那份赢）。
   *
   * @param {string} sessionId 会话 id。
   * @param {string} level 要写入的档位。
   * @returns {string} 实际落盘的档位。
   * @throws {TypeError} 会话 id 为空，或档位不是三个合法值之一时。
   */
  set(sessionId, level) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('paper-reader: 设置档位需要一个非空的 sessionId')
    }
    if (!isLevel(level)) {
      throw new TypeError(`paper-reader: 未知档位「${String(level)}」，只能是 ${LEVELS.join(' / ')}`)
    }
    const next = { ...this.read(), [sessionId]: level }
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: STORE_FORMAT, levels: next }, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.path)
    // 自己写完立刻自洽：不等下次 stat（同一毫秒内的 mtime 可能没变）。
    this.cache = { version: STORE_FORMAT, levels: next }
    this.stamp = this.fingerprint()
    return level
  }
}

/**
 * 值是不是普通对象（不是数组、不是 null）。
 *
 * @param {unknown} value 待判定的值。
 * @returns {boolean} 是普通对象时为真。
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 进程级单例表。
 *
 * 用 `Symbol.for` 挂在 globalThis 上，是为了让同一进程里**同一个包的两个模块实例**
 * （profile 根层宿主与 preset 宿主）共用一份缓存；如果它们各建一份，按文件 stat
 * 失效也仍然正确，只是多几次解析。
 *
 * @returns {Map<string, LevelStore>} `root -> store`。
 */
function registry() {
  const key = Symbol.for('dsh-paper-reader.level-stores')
  const existing = globalThis[key]
  if (existing instanceof Map) return existing
  const created = new Map()
  Object.defineProperty(globalThis, key, { value: created, enumerable: false, configurable: true })
  return created
}

/**
 * 取某个存储根下的存储实例（进程内共享）。
 *
 * @param {string} root 存储根目录。
 * @returns {LevelStore} 存储。
 */
export function levelStoreAt(root) {
  const stores = registry()
  const existing = stores.get(root)
  if (existing !== undefined) return existing
  const created = new LevelStore(root)
  stores.set(root, created)
  return created
}
