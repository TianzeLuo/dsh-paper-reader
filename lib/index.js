/**
 * index.js — dsh-paper-reader 的宿主半部。
 *
 * ## 本包被挂两次，两面各挂一处
 *
 * 这不是冗余，而是两面各自只有一个地方能生效：
 *
 *   | 面 | 挂在哪 | 为什么只能是这里 |
 *   | --- | --- | --- |
 *   | 浏览器半部（档位控件） | profile 根层 | `dsh-client-modules` 只遍历 `ctx.loader.entries()` 组装 boot graph，preset 的子树是 `PresetTree`，**不在其中** |
 *   | 模型可见面（技能目录、五个工具、档位提示词段） | preset 内 | agent 的 scope key 以 preset 的 standing key 为父，scoped 注册表按 scope 链解析——隔离是天然的，不需要任何运行期判断 |
 *
 * 角色由 `config.role` 显式声明（`lib/roles.js`），两个挂载点都写在**本包自己的
 * patch 文件**里：根层那一行在 `cordis.patch.yml`，preset 那一行在
 * `presets/paper.patch.yml`。用户不需要手写任何一行。
 *
 * ## 为什么不做运行期门控
 *
 * 早先的版本把模型可见面也挂在根层，然后用 `isPaperAgent` 在每个消费点手工过滤
 * （技能目录返回空、提示词段返回空串）。那套做法已经被删掉，因为：
 *
 *   1. 它是**逐个消费点**的，新增一个注册点就多一个漏点；
 *   2. 它挡不住「全局工具表」这类全局视图——工具仍在根层注册表里；
 *   3. 最要命的是**换 preset**：agent 可以在首个 turn 之前换模式
 *      （Web 客户端的模式选择器就是这么做的），一次性装在 agent scope 上的
 *      限制不会随之撤掉。
 *
 * 现在的隔离是结构性的：注册落在 preset 的 scope 层，别的模式的 agent 根本
 * 不在那条 scope 链上。换 preset 时 `bindings` 会 `rebind` 到新 generation，
 * 旧 generation 在最后一个使用者离开时被 `collect` 掉，注册随之消失。
 *
 * ## 为什么没有静态 `inject`
 *
 * 根层那一行必须**无条件激活**：`dsh-client-modules` 只认活着的 loader 行
 * （`entry.fiber !== undefined`，见其 `processOne`），静态 `inject` 少一个服务就
 * 会让浏览器半部整块从页面里消失。
 *
 * 同一个模块的静态 `inject` 是两个角色共用的，而「控制面」不需要任何服务，
 * 所以这里不声明静态 `inject`：需要的服务都在各自的注入回调里取（`ctx.inject`）。
 * 代价是缺服务时不再有 fail-fast，收益是根层那一行的激活不再依赖别的插件——
 * 两害相权取轻，因为缺服务是装配事故，而激活被拖住是静默的 UI 消失。
 *
 * ## 档位
 *
 * 档位是**用户在控件里选的**，不是模型判断的，按会话独立存储（`lib/level-store.js`）。
 * 它影响两处模型可见面，都在 `lib/levels.js` 里装配：
 *
 *   1. 技能正文：`paper-report` / `paper-verify` 各自的占位符按当前档位解析；
 *   2. 系统提示词的档位段：每个模型步骤只写当前这一档。
 *
 * 不做缓存：`list()` 每次重新扫描目录、`get()` 每次重新读盘，所以改 SKILL.md 正文
 * 或 `levels/*.md` 都不需要重载（与官方 dsh-skill-office 的做法一致）。
 */

import { readFileSync, readdirSync, watch } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { DEFAULT_LEVEL, LEVELS, defaultLevelRoot, isLevel, levelStoreAt } from './level-store.js'
import { levelPromptSection, resolveSkillBody } from './levels.js'
import { isPaperSession } from './preset-gate.js'
import { ROLE_AGENT, roleOf } from './roles.js'
import { createTools } from './tools.js'

/**
 * 插件 id，与 loader 行里的 id 无关，也与 provider 名无关。
 *
 * ## 为什么这里没有 `@deepseek-ai/*` 的 import
 *
 * 本包以 `link:` 方式装进 profile，Node 按符号链接的 **realpath** 解析裸导入，
 * 于是 `@deepseek-ai/*` 只存在于 `profiles/node_modules`（DSH 为 profile 铺的
 * symlink 农场），不在本包的祖先目录链上——实测从本包目录
 * `import('@deepseek-ai/dsh-skill')` 直接 ERR_MODULE_NOT_FOUND，且启动器没有开
 * `--preserve-symlinks`。
 *
 * 所以本插件像既有四个插件一样**保持自包含**，不引入任何 DSH 包依赖。
 */
export const name = 'paper-reader'

/**
 * `BUNDLED_SKILL_RANK`，取自 `@deepseek-ai/dsh-skill` 的公开常量。
 *
 * 含义：同一 scope 层内重名技能按 rank 抢位，rank 小的赢。打包附带的技能用
 * 600，高于本地各层（project 100/200、custom 300、user 400/500）——也就是
 * **用户自己的同名技能会覆盖本插件提供的版本**，这正是我们要的语义。
 */
const BUNDLED_SKILL_RANK = 600

/** provider 名，需在本 scope 层内唯一（同层的 filesystem 是另一个名字）。 */
const PROVIDER = 'dsh-paper-reader'

/** 技能包根目录：`<包根>/skills/`。 */
const SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url))

/** 浏览器半部请求的精确路径。两侧必须逐字一致。 */
export const LEVEL_ROUTE = '/api/dsh-paper-reader/level'

/** 档位段的 order：persona 前缀是 0，运行期上下文在 10000 之后，取中间。 */
const LEVEL_SECTION_ORDER = 500

/** SKILL.md 的 YAML frontmatter。 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u

/**
 * 读取并校验一个技能包。
 *
 * @param {string} directory 技能包目录。
 * @param {string} expectedName 目录名，同时也是技能的对外名字。
 * @returns {{ description: string, whenToUse: string | undefined, body: string }}
 *   解析后的 frontmatter 字段与去掉 frontmatter 的正文。
 * @throws {Error} 目录下没有 SKILL.md、没有 frontmatter、缺少 description，
 *   或 frontmatter 的 name 与目录名不一致时。
 */
function readSkill(directory, expectedName) {
  const path = join(directory, 'SKILL.md')
  const raw = readFileSync(path, 'utf8')
  const match = FRONTMATTER.exec(raw)
  if (match?.[1] === undefined) {
    throw new Error(`${name}: ${path} 缺少 YAML frontmatter`)
  }
  const metadata = parseYaml(match[1])
  if (typeof metadata !== 'object' || metadata === null) {
    throw new Error(`${name}: ${path} 的 frontmatter 不是对象`)
  }
  const { name: declaredName, description, whenToUse } = metadata
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`${name}: ${path} 的 frontmatter 缺少 description`)
  }
  if (whenToUse !== undefined && typeof whenToUse !== 'string') {
    throw new Error(`${name}: ${path} 的 whenToUse 不是字符串`)
  }
  // 技能名来自目录名。声明了 name 却不一致时直接报错，否则模型会拿目录名去
  // 加载、而人对着文件里的名字排查，这类不一致排查成本很高。
  if (declaredName !== undefined && declaredName !== expectedName) {
    throw new Error(
      `${name}: ${path} 的 frontmatter name "${String(declaredName)}" 与目录名 "${expectedName}" 不一致`,
    )
  }
  return { description, whenToUse, body: raw.slice(match[0].length).trim() }
}

/**
 * 列出技能包目录。
 *
 * 只认顶层目录 + 其中的 SKILL.md，与官方 skill-filesystem 的约定一致：
 * 更深层目录里的同名文件刻意不发现，避免把 references/templates 误当成技能。
 *
 * @param {string} root 技能包根目录。
 * @returns {string[]} 技能名（即目录名）数组，按名称排序。
 */
function listSkillNames(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/**
 * 扫描根目录，构建当前的全部候选。
 *
 * 每次调用都重新读盘，因此**新增/删除技能包目录、改 description 都会即时生效**，
 * 不需要重载 preset。
 *
 * @param {string} root 技能包根目录。
 * @returns {object[]} 候选数组。
 * @throws {Error} 根目录下没有任何技能包，或某个技能包校验不通过时。
 */
function buildCandidates(root) {
  const names = listSkillNames(root)
  if (names.length === 0) {
    throw new Error(`${name}: ${root} 下没有任何技能包`)
  }
  return names.map((skillName) => {
    const directory = join(root, skillName)
    const { description, whenToUse } = readSkill(directory, skillName)
    return {
      name: skillName,
      description,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER,
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: directory },
      locator: { directory },
    }
  })
}

/**
 * 构造 skill provider。
 *
 * 抽成纯函数（而不是直接写在 apply 里）是为了让测试可以传入自己的根目录去覆盖
 * 校验分支；`apply` 只是把默认根目录与真实的档位来源接上去。
 *
 * `list()` 每次重新扫描目录、`get()` 每次重新读盘，所以改 SKILL.md 正文、
 * 增删技能包目录都不需要重载 preset。注册表侧还持有目录缓存，跨进程的变更
 * 由 `apply` 里的目录监视器调 `control.invalidate()` 通知。
 *
 * **这里不做任何模式判断**：provider 注册在 «论文解读» preset 的 scope 层上，
 * 别的模式的 agent 不在那条 scope 链上，注册表根本不会问到它。
 *
 * @param {string} [root] 技能包根目录，默认本包的 `skills/`。
 * @param {{
 *   levelFor?: (sessionId: string | undefined) => string,
 *   levelsRoot?: string,
 * }} [options] 档位来源；缺省时一律用默认档。
 * @returns {{ name: string, list: (options?: object) => Promise<object[]>,
 *   get: (candidate: object, options?: object) => Promise<object> }}
 *   注册表可用的 provider。
 */
export function createProvider(root = SKILLS_ROOT, options = {}) {
  // 激活时先探一次：目录不存在或一个合法技能包都没有时**立即报错**，
  // 而不是等到第一次列目录才发现。装配错误早暴露比晚暴露好排查得多。
  buildCandidates(root)

  const levelFor = options.levelFor ?? (() => DEFAULT_LEVEL)
  const levelsRoot = options.levelsRoot

  return {
    name: PROVIDER,
    list() {
      return Promise.resolve(buildCandidates(root))
    },
    /**
     * 载入完整正文。`rank` / `locator` 是 provider 与注册表之间的私有字段，
     * 返回给消费者前必须剥掉；正文按**当前档位**解析占位符。
     *
     * 档位按「发起这次读取的 agent 的会话」取；拿不到 scope（例如测试直接调用）
     * 时退回默认档。
     */
    get(candidate, lookup) {
      const { rank: _rank, locator, ...summary } = candidate
      const sessionId = lookup?.scope?.session?.id
      const level = levelFor(typeof sessionId === 'string' ? sessionId : undefined)
      const body = resolveSkillBody(
        candidate.name,
        readSkill(locator.directory, candidate.name).body,
        level,
        levelsRoot === undefined ? {} : { root: levelsRoot },
      )
      return Promise.resolve({ ...summary, content: body })
    },
  }
}

/**
 * 组装一个 JSON 响应。
 *
 * @param {object} value 响应体。
 * @param {number} [status] HTTP 状态码。
 * @returns {Response} 响应。
 */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 解析请求体里的 `sessionId`。
 *
 * @param {unknown} payload 请求体。
 * @returns {string} 会话 id；缺失时为空串。
 */
function sessionIdOf(payload) {
  const value = payload?.sessionId
  return typeof value === 'string' ? value : ''
}

/**
 * 插件入口：按 `config.role` 分派到两个挂载点之一。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主插件上下文。
 * @param {{ role?: string, cacheRoot?: string, levelsRoot?: string }} [config]
 *   loader 行里的配置。`role` 必填（`lib/roles.js`）。
 * @throws {Error} `role` 缺失或取值不认识时——见 `lib/roles.js` 里的理由。
 */
export function apply(ctx, config = {}) {
  if (roleOf(config) === ROLE_AGENT) applyAgentPlane(ctx, config)
  else applyControlPlane(ctx, config)
}

/**
 * 代理面：注册**一切模型可见的东西**。
 *
 * 这一份 `apply` 跑在 preset 的 scope 上，所以技能目录、五个工具与档位提示词段
 * 都只对 «论文解读» 模式的 agent 可见。`skills` / `tools` 就在 preset 自己声明
 * 的那几个兄弟行后面，装配期即可取到；缺任何一件都说明 profile 装配错了，
 * 所以这里不做静默降级——注入回调不会被调用，而 `apply` 本身已经成功返回，
 * 装配诊断由 `dsh-agent-preset-registry` 的 `diagnostic()` 报出「这一行没激活」。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx preset 子树里的插件上下文。
 * @param {{ cacheRoot?: string, levelsRoot?: string }} config loader 行里的配置。
 */
function applyAgentPlane(ctx, config) {
  // 档位存储。进程内同一个根目录只建一个 store（`levelStoreAt` 是进程级单例），
  // 所以控制面那一行读到的是同一份状态。
  const store = levelStoreAt(config.cacheRoot ?? defaultLevelRoot())
  const levelFor = (sessionId) => store.levelOf(sessionId)

  ctx.inject(['skills'], (scope) => {
    scope.skills.registerProvider((control) => {
      // 监视技能包根目录，目录增删时让注册表丢掉已缓存的目录。
      // 监视不可用（某些文件系统/容器）不影响功能——只是新增技能需要重载 preset，
      // 所以这里吞掉异常而不是让插件装配失败。
      try {
        const watcher = watch(SKILLS_ROOT, { persistent: false }, () => control.invalidate())
        control.signal.addEventListener('abort', () => watcher.close(), { once: true })
      } catch {
        // 静默降级：正文与 description 改动仍然即时生效
      }
      return createProvider(SKILLS_ROOT, {
        levelFor,
        ...(config.levelsRoot === undefined ? {} : { levelsRoot: config.levelsRoot }),
      })
    })
  })

  ctx.inject(['tools'], (scope) => {
    for (const definition of createTools({ cacheRoot: config.cacheRoot })) {
      scope.tools.register(definition)
    }
  })

  // 档位段：每个模型步骤都重新求值。
  //
  // 这一段是「锦上添花」：没有 `systemPrompt` 的部署（headless / SDK 精简装配）里
  // 技能正文仍然按档位装配，只是模型不会在每个步骤里看到当前档位的一行说明。
  // 所以这里延迟注入而不是写进静态 inject——静态 inject 缺服务会让整行不激活，
  // 连带五个工具一起消失。
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: 'paper-reader:level',
      order: LEVEL_SECTION_ORDER,
      text: (context) => {
        // 拿不到会话时给空串（`renderPrompt` 会丢掉空段），而不是替模型猜一个档。
        const sessionId = context?.agent?.session?.id
        return typeof sessionId === 'string' ? levelPromptSection(levelFor(sessionId)) : ''
      },
    })
  })
}

/**
 * 控制面：只注册档位端点，**不注册任何模型可见的东西**。
 *
 * 这一份 `apply` 跑在 profile 根层。它存在的唯一理由是浏览器半部：根层 bundle 行
 * 才会被 `dsh-client-modules` 组装进 boot graph（见文件顶部的表）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx profile 根层的插件上下文。
 * @param {{ cacheRoot?: string }} config loader 行里的配置。
 */
function applyControlPlane(ctx, config) {
  const store = levelStoreAt(config.cacheRoot ?? defaultLevelRoot())

  // `connection` 用延迟注入：没有 web 宿主时（tui / headless）只是不注册端点，
  // 而不是让这一行装配失败——它还要负责让浏览器半部被组装。
  ctx.inject(['connection'], (scope) => {
    try {
      scope.connection.fetch.register({
        path: LEVEL_ROUTE,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (request.method === 'GET') {
            const sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
            const checked = await gate(ctx, sessionId)
            if (checked.error !== undefined) return checked.error
            return jsonResponse({
              ok: true,
              sessionId,
              level: store.levelOf(sessionId),
              levels: LEVELS,
            })
          }
          let payload
          try {
            payload = await request.json()
          } catch {
            return jsonResponse({ ok: false, code: 'BAD_REQUEST', message: '请求体不是 JSON' })
          }
          const sessionId = sessionIdOf(payload)
          const checked = await gate(ctx, sessionId)
          if (checked.error !== undefined) return checked.error
          const level = payload?.level
          if (!isLevel(level)) {
            return jsonResponse({
              ok: false,
              code: 'BAD_LEVEL',
              message: `未知档位「${String(level)}」，只能是 ${LEVELS.join(' / ')}`,
            })
          }
          store.set(sessionId, level)
          return jsonResponse({ ok: true, sessionId, level })
        },
      })
    } catch (error) {
      // 注册失败不能把整个插件拖垮：这一行还要让浏览器半部被组装。
      console.warn(`[${name}] 档位端点注册失败: ${String(error?.message ?? error)}`)
    }
  })
}

/**
 * 请求前的检查：会话属于 «论文解读» 模式。
 *
 * 端点挂在根层，URL 是可猜测的；不校验的话别的模式也能改自己的档位（无害但没意义），
 * 更糟的是这会让「根层注册」从一个受控取舍变成真正的越权面。
 *
 * **必须同时认 live 与 cold 会话**：Web 里点开一条历史会话看记录不会激活 Agent，
 * 只认 live 会话会让「回到旧会话」时控件报「档位读取失败」。判定细节与理由见
 * `lib/preset-gate.js`。会话不存在与不是本模式在这里合流成同一个 `NOT_PAPER`
 * ——两种情况下控件都不该出现，而把它们分开只会多一条需要前端做特判的错误码。
 *
 * 注意这只是**控制面**的检查，与模型可见面的隔离无关——后者由 preset scope 保证，
 * 不经过这里。
 *
 * @param {object} ctx profile 根层的宿主上下文。
 * @param {string} sessionId 请求里的会话 id。
 * @returns {Promise<{ sessionId: string } | { error: Response }>} 通过时给会话 id，否则给现成的错误响应。
 */
async function gate(ctx, sessionId) {
  if (sessionId === '') return { error: jsonResponse({ ok: false, code: 'BAD_REQUEST', message: '缺少 sessionId' }) }
  if (!(await isPaperSession(ctx, sessionId))) {
    return { error: jsonResponse({ ok: false, code: 'NOT_PAPER', message: '档位只对论文解读模式有效' }) }
  }
  return { sessionId }
}
