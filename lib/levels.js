/**
 * levels.js — 档位内容装配。
 *
 * 「论文解读」的三个档位（速览 / 解读 / 深读）决定两件模型可见的事：
 *
 *   1. **技能正文。** `paper-report` 与 `paper-verify` 的正文各自留了一个占位符
 *      （`{{workflow}}` / `{{level-check}}`），加载时按当前档位替换。这样技能名
 *      稳定（`/paper-report` 这种手势不会因为档位不同而失效），而模型只看到自己
 *      这一档的流程，没有另外两档的冗余。
 *   2. **系统提示词里的档位段。** 装配提示词时按档位注入一行，保证模型不必先
 *      加载技能就知道当前是哪一档、以及这一档的边界。
 *
 * 占位符是**一次性**的：出现两次、没有出现、或替换完还剩别的 `{{…}}` 都算装配
 * 错误并抛错。宁可让技能加载失败，也不要把一份带着未解析占位符的正文交给模型——
 * 那种失败是静默的，模型会照着 `{{workflow}}` 这四个字编流程。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LEVEL_NAME, LEVEL_CATALOG } from './level-catalog.js'
import { DEFAULT_LEVEL, LEVELS, isLevel } from './level-store.js'

/** 档位片段根目录：`<包根>/levels/`。 */
export const LEVELS_ROOT = fileURLToPath(new URL('../levels/', import.meta.url))

/**
 * 每个档位的展示元信息，由 `level-catalog.js` 认领（那份是给浏览器半部也能读的
 * 纯数据）。
 *
 * @type {Readonly<Record<string, { name: string, label: string, blurb: string }>>}
 */
export const LEVEL_INFO = Object.freeze(
  Object.fromEntries(LEVEL_CATALOG.map((entry) => [entry.name, entry])),
)

/**
 * 档位片段在技能正文里的占位符。
 *
 * `paper-report` 插工作流（`levels/<level>.md`），`paper-verify` 插档位校验项
 * （`levels/verify.md` 里对应的小节）。两个技能各自只认自己的占位符。
 */
export const PLACEHOLDERS = Object.freeze({
  'paper-report': '{{workflow}}',
  'paper-verify': '{{level-check}}',
})

/**
 * 取一个档位的展示名。
 *
 * @param {string} level 档位。
 * @returns {string} 展示名；未知档位时给默认档的展示名。
 */
export function labelOf(level) {
  return LEVEL_INFO[isLevel(level) ? level : DEFAULT_LEVEL].label
}

/**
 * 读一个档位的工作流片段。
 *
 * 每次调用都重新读盘：改 `levels/*.md` 不需要重载宿主，与技能正文的约定一致。
 *
 * @param {string} level 档位。
 * @param {string} [root] 片段根目录，测试可覆盖。
 * @returns {string} 片段正文。
 * @throws {Error} 档位不存在，或片段文件读不到时。
 */
export function levelSection(level, root = LEVELS_ROOT) {
  if (!isLevel(level)) throw new Error(`paper-reader: 未知档位「${String(level)}」`)
  return readFileSync(join(root, `${level}.md`), 'utf8').trim()
}

/**
 * 从 `levels/verify.md` 里切出某一档的小节。
 *
 * 文件形如：
 *
 *     ### brief（速览）
 *     - …
 *     ### standard（解读）
 *     - …
 *
 * 切法按 `### ` 行分组，组名以档位名开头。找不到该档的小节时抛错——`paper-verify`
 * 少了这一段就查不出档位有没有兑现，属于必须早暴露的装配错误。
 *
 * @param {string} level 档位。
 * @param {string} [root] 片段根目录，测试可覆盖。
 * @returns {string} 该档的校验项正文（不含 `### ` 标题行）。
 * @throws {Error} 文件里没有该档的小节时。
 */
export function verifySection(level, root = LEVELS_ROOT) {
  if (!isLevel(level)) throw new Error(`paper-reader: 未知档位「${String(level)}」`)
  const text = readFileSync(join(root, 'verify.md'), 'utf8')
  const sections = new Map()
  let current
  for (const line of text.split('\n')) {
    const heading = /^###\s+(\S+)/u.exec(line)
    if (heading !== null) {
      current = heading[1].replace(/[（(].*$/u, '')
      sections.set(current, [])
    } else if (current !== undefined) {
      sections.get(current).push(line)
    }
  }
  const body = sections.get(level)
  if (body === undefined) throw new Error(`paper-reader: levels/verify.md 里没有「${level}」这一档`)
  return body.join('\n').trim()
}

/**
 * 按档位解析一份技能正文里的占位符。
 *
 * @param {string} skillName 技能名，决定用哪个占位符。
 * @param {string} body 去掉 frontmatter 的技能正文。
 * @param {string} level 当前档位。
 * @param {{ root?: string }} [options] 片段根目录覆盖（测试用）。
 * @returns {string} 解析后的正文；没有占位符的技能原样返回。
 * @throws {Error} 占位符出现多次、应当存在却不存在、或解析后仍残留 `{{…}}` 时。
 */
export function resolveSkillBody(skillName, body, level, options = {}) {
  const placeholder = PLACEHOLDERS[skillName]
  if (placeholder === undefined) return body
  const parts = body.split(placeholder)
  if (parts.length === 1) {
    throw new Error(`paper-reader: ${skillName} 的正文里没有占位符 ${placeholder}`)
  }
  if (parts.length > 2) {
    throw new Error(`paper-reader: ${skillName} 的正文里出现了 ${parts.length - 1} 次 ${placeholder}，只能出现一次`)
  }
  const filled =
    skillName === 'paper-verify' ? verifySection(level, options.root) : levelSection(level, options.root)
  const resolved = `${parts[0]}${filled}${parts[1]}`
  const leftover = /\{\{[^}]*\}\}/u.exec(resolved)
  if (leftover !== null) {
    throw new Error(`paper-reader: ${skillName} 解析后仍残留模板变量 ${leftover[0]}`)
  }
  return resolved
}

/**
 * 装配提示词里的档位段。
 *
 * 这一段是模型知道自己档位的**唯一权威来源**：技能目录行只有技能名与描述，正文要
 * 显式加载才看得到；而档位段每个模型步骤都在系统提示里，且只写当前这一档。
 *
 * @param {string} level 当前档位。
 * @returns {string} 段落正文（多行）。
 */
export function levelPromptSection(level) {
  const effective = isLevel(level) ? level : DEFAULT_LEVEL
  const info = LEVEL_INFO[effective]
  const others = LEVELS.filter((candidate) => candidate !== effective)
    .map((candidate) => LEVEL_INFO[candidate].label)
    .join(' / ')
  return [
    `当前档位：**${info.label}**（${effective}），由用户在界面控件里选定。`,
    '',
    info.blurb,
    '',
    `- **不要自行升档或降档**：用户的话听起来像在要另一档时，先按当前档写，再在导读里说明可以切到 ${others}。`,
    '- 档位细节以加载 `paper-report` 后看到的正文为准。',
  ].join('\n')
}
