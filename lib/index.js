/**
 * index.js — dsh-paper-reader 的宿主半部。
 *
 * 本插件**只**被 `preset-paper` 挂载（见 `presets/paper.patch.yml`），因此它的
 * `apply` 运行在该 preset 的 scope 上下文里。这一步很关键：
 *
 *   `ctx.skills.registerProvider(...)` 的注册**落到调用上下文的 scope 层**——
 *   preset 里挂载的插件只对该 preset 的 agent 可见。所以这里注册的 skill
 *   不会出现在其他模式（standard / ptc / …）的会话目录里，其他会话的上下文
 *   里也就没有它们的任何痕迹。
 *
 * 职责有两件，都注册在**本 preset 的 scope 层**，因此其他模式（standard / ptc / …）
 * 的会话目录与工具表里都看不到它们的任何痕迹：
 *
 *   1. 把自己 `skills/<name>/SKILL.md` 下的技能包注册成一个 skill provider；
 *   2. 注册 paper_import / paper_search / paper_read / paper_figure 四个宿主工具
 *      （实现在 `lib/tools.js`）。
 *
 * 不做缓存：`get()` 每次重新读盘，所以改 SKILL.md 正文不需要重启，也不需要
 * 失效逻辑（与官方 dsh-skill-office 的做法一致）。
 */

import { readFileSync, readdirSync, watch } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { createTools } from './tools.js'

/**
 * 插件 id，与 preset 里那一行的 id 无关，也与 provider 名无关。
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
 * 代价是下面那个常量要自己维护。
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

/**
 * 依赖 skill 注册表与工具注册表。
 *
 * 两者都由 profile 根层无条件提供（base bundle 的 `tools` 行、
 * `dsh-skill` 行都没有 disabled），所以用声明式 inject 是安全的——
 * 不存在「服务缺失导致 apply 静默不跑」的风险。
 */
export const inject = ['skills', 'tools']

/** provider 名，需在本 scope 层内唯一（同层的 filesystem 是另一个名字）。 */
const PROVIDER = 'dsh-paper-reader'

/** 技能包根目录：`<包根>/skills/`。 */
const SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url))

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
 * 抽成纯函数（而不是直接写在 apply 里）是为了让测试可以传入自己的根目录去
 * 覆盖校验分支；`apply` 只是把默认根目录接上去。
 *
 * `list()` 每次重新扫描目录、`get()` 每次重新读盘，所以改 SKILL.md 正文、
 * 增删技能包目录都不需要重载 preset。注册表侧还持有目录缓存，跨进程的变更
 * 由 `apply` 里的目录监视器调 `control.invalidate()` 通知。
 *
 * @param {string} [root] 技能包根目录，默认本包的 `skills/`。
 * @returns {{ name: string, list: () => Promise<object[]>, get: (candidate: object) => Promise<object> }}
 *   注册表可用的 provider。
 */
export function createProvider(root = SKILLS_ROOT) {
  // 激活时先探一次：目录不存在或一个合法技能包都没有时**立即报错**，
  // 而不是等到第一次列目录才发现。装配错误早暴露比晚暴露好排查得多。
  buildCandidates(root)

  return {
    name: PROVIDER,
    list: () => Promise.resolve(buildCandidates(root)),
    /**
     * 载入完整正文。`rank` / `locator` 是 provider 与注册表之间的私有字段，
     * 返回给消费者前必须剥掉。
     */
    get(candidate) {
      const { rank: _rank, locator, ...summary } = candidate
      return Promise.resolve({
        ...summary,
        content: readSkill(locator.directory, candidate.name).body,
      })
    },
  }
}

/**
 * 插件入口。
 *
 * 两件事，都注册在**本 preset 的 scope 层**，所以其他模式的 session 既看不到
 * 这些技能、工具表里也没有这四个工具。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主插件上下文（preset scope）。
 * @param {{ cacheRoot?: string }} [config] preset 行里覆盖的配置。
 */
export function apply(ctx, config = {}) {
  ctx.skills.registerProvider((control) => {
    // 监视技能包根目录，目录增删时让注册表丢掉已缓存的目录。
    // 监视不可用（某些文件系统/容器）不影响功能——只是新增技能需要重载 preset，
    // 所以这里吞掉异常而不是让插件装配失败。
    try {
      const watcher = watch(SKILLS_ROOT, { persistent: false }, () => control.invalidate())
      control.signal.addEventListener('abort', () => watcher.close(), { once: true })
    } catch {
      // 静默降级：正文与 description 改动仍然即时生效
    }
    return createProvider()
  })

  for (const definition of createTools({ cacheRoot: config.cacheRoot })) {
    ctx.tools.register(definition)
  }
}
