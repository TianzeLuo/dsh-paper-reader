/**
 * level-catalog.js — 三个档位的**纯数据**目录。
 *
 * 单独一个文件、且不 import 任何 Node 内置模块，是为了让浏览器半部能安全地静态
 * import 它（`lib/client.js` 的 factory 是 `require()` 同步执行的，没法用动态
 * import 绕开）：宿主半部的 `lib/levels.js` 也引同一份，档位顺序与展示名只有一个
 * 来源。
 *
 * 加档位时要同时动三处，`test/levels.test.mjs` 会检查一致：
 *   1. 本文件；
 *   2. `lib/level-store.js` 的 `LEVELS` 与 `DEFAULT_LEVEL`；
 *   3. `levels/<name>.md` 与 `levels/verify.md` 里的对应小节。
 */

/**
 * 档位目录。`name` 由浅到深，**这个顺序就是界面顺序**。
 *
 * @type {readonly { name: string, label: string, blurb: string }[]}
 */
export const LEVEL_CATALOG = Object.freeze([
  Object.freeze({
    name: 'brief',
    label: '速览',
    blurb: '快速判断这篇论文值不值得细读：主智能体自己顺序读 3–5 页，不并行、不做数字核对，篇幅通常 800–1500 字（参考值，不设上限）。',
  }),
  Object.freeze({
    name: 'standard',
    label: '解读',
    blurb: '把论文讲清楚：并行分节读正文（附录只读与主张直接相关的部分），成稿后做数字核对与自审，篇幅通常 3000–6000 字（参考值，不设上限）。',
  }),
  Object.freeze({
    name: 'deep',
    label: '深读',
    blurb: '为复现或深挖细节服务：并行分节读全文加附录的超参、梯度、算力与数据配比，篇幅参考 8000 字以上、不设上限，验收看细节是否兑现而不是字数。',
  }),
])

/** 默认档位：用户没动控件时用的那一档（`standard` = 解读）。 */
export const DEFAULT_LEVEL_NAME = 'standard'
