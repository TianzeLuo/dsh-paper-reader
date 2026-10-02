# 开发与验证

## 目录结构

```
dsh-paper-reader/
├── package.json            dsh.bundle.patch = [cordis.patch.yml, presets/paper.patch.yml]
│                           dsh.client = 浏览器半部（档位控件），exports["./client"]
├── cordis.patch.yml        profile 根层：插入 paper-reader 行（role: control，只为控件与端点）
├── presets/paper.patch.yml 模式身份：插入 preset-paper（persona + 工具集基线）与
│                           paper-reader-agent 行（role: agent，模型可见面全在这里）
├── lib/index.js            宿主插件：按 role 分派到控制面（端点）/ 代理面（provider + 五工具 + 档位段）
├── lib/tools.js            五个工具的声明、入参校验与输出渲染
├── lib/pdf.js              mupdf 封装：导入、检索、分页读取、页面渲染
├── lib/client.js           浏览器半部：输入框左侧的三档段控件
├── lib/roles.js            两个挂载角色的常量与校验（config.role）
├── lib/preset-gate.js      控制面判断「这个会话是不是论文解读模式」（端点用）
├── lib/level-catalog.js    档位的纯数据（宿主与浏览器半部都读）
├── lib/level-store.js      档位按会话持久化（原子写，$DSH_HOME/paper-reader/levels.json）
├── lib/levels.js           技能正文装配：占位符 → levels/*.md，以及提示词档位段
├── levels/<档位>.md        该档的工作流（注入 paper-report）
├── levels/verify.md        该档的自审项（注入 paper-verify）
├── skills/<name>/SKILL.md  技能正文（frontmatter: name / description / whenToUse）
├── test/                   契约测试（provider / preset / client / levels）+ 行为测试（pdf / tools）
├── docs/                   设计取舍、已知限制、开发与验证（本文件）
└── CHANGELOG.md
```

`lib/tools.js` 末尾另外再导出了 `pdf.js` 的 `readMeta`，供诊断用（列已导入论文的元数据）。
`lib/pdf.js` 还有 `parsePages` / `captionsOf` / `listCached` / `defaultCacheRoot` 等导出，主要供
测试使用；`package.json` 的 `exports` 只暴露 `"."`、`"./client"` 与 `"./package.json"`，
外部拿不到这些内部函数。

## 档位是怎么一路传下去的

改档位相关的东西之前，先把这条链看一遍（每一环都有测试）：

```
控件点击 (lib/client.js)
  → POST /api/dsh-paper-reader/level {sessionId, level}   (lib/index.js applyControlPlane)
  → 门控：会话的 agentPreset 必须是 'paper'               (lib/preset-gate.js)
  → LevelStore.set(sessionId, level)                      (lib/level-store.js → levels.json)

装配期（preset 的 standing composition，模型不可见的时机）：
  → applyAgentPlane：provider / 五个工具 / 档位段
      全部注册在 preset 的 scope 层                       (lib/index.js，role: agent)

下一个模型步骤：
  → systemPrompt.assemble({ agent })                      (dsh-agent-loop)
  → 档位段 text(agent) → levelPromptSection(level)         (lib/levels.js)
  → 技能目录快照 → provider.list({ scope: agent })
  → skill 工具 → provider.get(candidate, { scope: agent })
      → resolveSkillBody(name, body, level) → levels/*.md  (lib/levels.js)
```

两个必须知道的前提：

- **`options.scope` 就是 agent。** `dsh-tool-skill` 传的是 `{ cwd, signal, scope: agent }`，
  `dsh-skill` 原样透传给 provider。这在 `dsh-skill` 的类型里**没有写进 provider 契约**（契约只承诺
  `{ cwd, signal }`），所以 `lib/index.js` 把它当「有就用来取档位、没有就按默认档」的可选信息，
  而不是硬依赖——**注意它不再承担任何隔离职责**：别的模式的 agent 根本不会读到这个 provider。
  真要改成有契约保障的做法，就走 `agent.ctx.skills.register()` 在 `agent/created` 时注册运行时技能。
- **代理面每份 preset revision 只实例化一次**（`dsh-agent-preset-registry`），所以 `ctx` 里没有会话；
  按会话的状态只能从 `options.scope` / `context.agent` 里现取。这也是档位存储带 `sessionId` 的原因。

## 技能包格式

`skills/<name>/SKILL.md`，目录名即技能名。frontmatter：

```yaml
---
name: paper-qa          # 必须与目录名一致，否则加载时报错
description: 一句话说明这个技能做什么。   # 必填；这是模型在目录里唯一能看到的信息
whenToUse: 什么情况下该用它。            # 可选
---
```

更深的嵌套目录（如 `references/`）里的 `SKILL.md` **不会**被发现，避免把参考材料误当成技能。

按档位装配的两个技能在正文里留占位符（`{{workflow}}` / `{{level-check}}`），`get()` 时替换。
占位符规则是**严格**的：出现两次、应当出现却没有、替换完还剩别的 `{{…}}` 都会抛错——宁可让技能
加载失败，也不要把带未解析占位符的正文交给模型（那种失败是静默的）。

`list()` 每次重新扫描目录、`get()` 每次重新读盘，所以改正文、`description`、以及增删技能包目录都
即时生效，不需要重载；`apply` 另外挂了目录监视器，跨进程的变更会让注册表丢掉缓存目录。
校验分支（缺 SKILL.md、缺 frontmatter、缺 description、name 与目录名不一致、`whenToUse` 非字符串）
都有测试覆盖。

## 浏览器半部

`lib/client.js` 是**手写的 factory-CJS**（不是打包器的产物）：必须在
`window.__ModuleLoader__.load({ id, factory })` 里注册，`id` 等于包名，factory 必须**返回**
`module.exports`。三条硬约束：

1. **只能 require seed 模块**：`react` / `react-dom` / `react/jsx-runtime` / `@deepseek-ai/cordis` /
   `dsh-client-store` / `dsh-client-ui-slots` / `dsh-client-ui-primitives` / `dsh-client-ui-dockkit`。
   本文件只用 `react`。
2. **不能有 ESM `import`，也不能 import 相对的本地文件**——factory 是同步 `require`，没有打包器把
   本地文件内联进来。所以档位名与展示名在 `lib/client.js` 里存了一份副本，`test/client.test.mjs`
   钉死它与 `lib/level-catalog.js` 一致。
3. **必须自己收住模式**：根层 bundle 对每个页面都加载，组件读会话投影的 `agentPreset`，
   不是 `paper` 就渲染 null 并且**不发请求**。控件本身没有隔离能力，它只是不打扰别的模式；
   真正的隔离在宿主侧（见 [设计与取舍](design.md#档位控件为什么挂在-profile-根层)）。

`test/client.test.mjs` 搭了一个假 `window.__ModuleLoader__` + 假 React + 假 document，
**真的把 bundle 执行一遍**，覆盖加载器契约、档位目录一致性、槽位注册与模式门控。

## 两个挂载点（改宿主前必读）

`lib/index.js` 的 `apply` 按 `config.role` 分派，两个角色注册的东西**不能互换**：

| role | 由谁声明 | `apply` 里注册 |
|---|---|---|
| `control` | `cordis.patch.yml`（profile 根层） | 只注册 `/api/dsh-paper-reader/level`；有 `dsh.client` 声明的这一行才会让控件进页面 |
| `agent` | `presets/paper.patch.yml`（preset 内） | 技能 provider、五个工具、档位提示词段——**模型可见的东西全在这里** |

三条规则：

1. **新的模型可见注册一律加在 `applyAgentPlane`。** 加在控制面会泄漏到所有模式，且不报错。
2. **不要给 `lib/index.js` 加静态 `inject`。** 静态 `inject` 被两个角色共用，而根层那一行必须
   无条件激活（`dsh-client-modules` 跳过 `entry.fiber === void 0` 的行）；缺服务时要的是
   「这一半不工作」，不是「控件消失」。需要的服务写在 `ctx.inject([...], scope => …)` 里。
3. **不要在 provider / 档位段里加模式判断。** 隔离由 preset scope 提供；加回判断只会让换 preset
   的行为变错。`test/provider.test.mjs` 有一条测试专门钉住「读取结果与 scope 无关」。

## 安装（本地路径）

本包自带运行时依赖（`mupdf`、`yaml`），且 `node_modules/` 不入库，所以在装进 profile 之前必须先在本
包目录里装一次依赖：

```sh
cd <本包目录>
pnpm install

dsh plugin --profile web add <本包目录>
```

`pnpm-lock.yaml` **入库**，所以这次安装解析出的依赖树与实测过的那份一致。装完重启 `dsh web`
（preset 与根层 bundle 都属启动期组装）。

两点注意：

- **别用 scp 风格的 URL 让 pnpm 去装**（`git@github.com:...`）：pnpm 会把它误解析成「包名 `git`
  + 版本」，装出一个空依赖，插件不会生效。若要走远端安装，用 `github:<owner>/<repo>` 形式。
- **本插件目前只验证过本地路径安装**。走 GitHub 安装（本仓库目前是私有仓库，需要 pnpm 侧能拿到
  凭据）未实测，装完请用下面的 `--dump-config` 确认 `preset-paper` 与根层的 `paper-reader` 行都
  真的插进来了。

## 测试

```sh
node --test
```

当前 127 条，六块：

| 文件 | 覆盖 |
|---|---|
| `test/provider.test.mjs` | skill provider 契约：frontmatter 校验的每个失败分支、只认顶层目录、`list()`/`get()` 即时反映改动、**两个角色各注册什么**（代理面三件套 / 控制面只注册端点）、缺 `systemPrompt` / `connection` 的降级、`role` 缺失或未知时报错、档位端点的完整语义（BAD_REQUEST / NOT_PAPER / BAD_LEVEL / 写后读，含**冷会话**读写与 observation 租借归还） |
| `test/preset.test.mjs` | preset 契约：`{{…}}` 白名单与未闭合检测、preset 身份、**两个挂载点各就各位且 role 不能互换**、代理面行的位置、persona 点名五个工具与 `read_image`、`dsh.client` 声明 |
| `test/client.test.mjs` | 浏览器半部：在假 `window.__ModuleLoader__` 里真的执行 bundle，覆盖加载器契约、**档位目录与宿主一致**、槽位注册与模式门控 |
| `test/levels.test.mjs` | 档位：存储的按会话读写/原子写/坏文件降级、占位符装配（含缺失/重复/残留报错）、**provider 不做模式判断**、装配后正文仍在裁剪阈值内 |
| `test/pdf.test.mjs` | 解析行为：导入幂等（同文件换路径命中同一缓存）、锚点与标题判定（含表格行假锚点、全篇基准字号）、两段式检索、页码表达式、分页读取与截断 |
| `test/tools.test.mjs` | 工具行为：schema 只用白名单关键字、入参校验（缺必填/未知键/类型/小数/越界）、输出满足自声明 schema、缓存根覆盖 |

`test/helpers/synthetic-paper.mjs` 手写生成 fixture PDF（不引第三方依赖，且字节完全确定——
`docId` 就是字节哈希，fixture 只要带时间戳，幂等那条测试立刻变成假绿）。

## 验证 bundle 与 preset 组装

改完 `package.json` 的 `dsh.bundle.patch` / `dsh.client`、`cordis.patch.yml`、`presets/paper.patch.yml`
或 `lib/client.js` 之后，先跑这个再重启 `dsh web`：全程只写临时目录，不动真实 profile。

```sh
cd <本包目录>

ROOT=$(mktemp -d /tmp/dsh-paperverify-XXXX)   # 临时 DSH_HOME
PROF="$ROOT/profiles/web"
DSH_BIN=$(readlink -f "$(command -v dsh)")
DSH_PKG=$(cd "$(dirname "$DSH_BIN")/.." && pwd)   # → .../@deepseek-ai/dsh

mkdir -p "$PROF/node_modules"
ln -sfn "$DSH_PKG/node_modules/@deepseek-ai" "$PROF/node_modules/@deepseek-ai"
ln -sfn "$PWD" "$PROF/node_modules/dsh-paper-reader"

cat > "$PROF/package.json" <<EOF
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": { "dsh-paper-reader": "link:$PWD" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-paper-reader"] } }
}
EOF

cd "$PROF"
# ① 根层有 paper-reader 行（role: control），preset 里有 paper-reader-agent 行（role: agent）
DSH_HOME="$ROOT" dsh --profile web --dump-config | grep -A3 -- '- id: paper-reader$'
DSH_HOME="$ROOT" dsh --profile web --dump-config | grep -A3 'id: paper-reader-agent'
```

实测输出（`DSH_PKG` 用的是 `readlink -f` 推导出来的路径，不写死用户名与 Node 版本）：

```
- id: paper-reader
  name: dsh-paper-reader
  config:
    role: control
```

```
      - id: paper-reader-agent
        name: dsh-paper-reader
        config:
          role: agent
```

**`--dump-config` 看不到浏览器半部。** 它只渲染 Loader 配置，而 boot graph 是
`dsh-client-modules` 在运行期组装的。要确认控件真的进了页面，起一个一次性 web 服务再读首页：

```sh
DSH_HOME="$ROOT" nohup dsh --profile web --no-open --port 3155 > "$ROOT/server.log" 2>&1 &
sleep 15
TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' "$ROOT/server.log" | head -1 | cut -d= -f2)
curl -sL -c "$ROOT/c.txt" -b "$ROOT/c.txt" "http://127.0.0.1:3155/?token=$TOKEN" -o "$ROOT/index.html"

# 首页里应当出现这条 boot entry（id / url / rev / inject / immediately）
grep -o '{"id":"dsh-paper-reader"[^}]*}' "$ROOT/index.html"

# 端点也应当已注册（业务失败也是 200 + ok:false）
curl -s -b "$ROOT/c.txt" "http://127.0.0.1:3155/api/dsh-paper-reader/level"
# → {"ok":false,"code":"BAD_REQUEST","message":"缺少 sessionId"}

# 验完记得停掉这个一次性服务（它监听 3155，不是你在用的那个）
kill %1
```

实测首页里的那一条：

```json
{"id":"dsh-paper-reader","url":"plugins/??dsh-paper-reader/client.js&rev=a0fc5d1ef7b1",
 "rev":"a0fc5d1ef7b1","inject":["@deepseek-ai/dsh-client-ui-conversation"],"immediately":true}
```

`--dump-config-schema` 不能用来验证加载，见[已知限制](limitations.md#--dump-config-schema-不能用)。

## 验证工具有没有真的隔离住

改挂载点、改注册内容之后，**光跑 `node --test` 不够**——那 127 条测的是「谁注册了什么」，
测不到「DSH 的 scope 层有没有按预期把它们分开」。隔离是 DSH 的行为，得让它自己说话。

做法：在临时 `DSH_HOME` 里加一个只会写盘的探针插件，它创建两个 agent（`paper` 与 `standard`），
对每个 agent 调 `ctx.tools.schemas(agent)` 与 `ctx.skills.snapshot({ scope: agent })`，
再把结果与「不带 scope 的全局视角」（`ctx.tools.schemas()`、`ctx.skills.snapshot({ cwd })`）
一起写进文件；中间用 `ctx.agentPresets.select(agent, '<preset>')` 换档并重读一次。
探针代码放临时目录（`$ROOT/probe/`），通过 `$ROOT/probe.patch.yml`（一个只含 `- insert:` 的
顶层数组）插进 profile，**不进仓库**——它是验证工具，不是产品的一部分。

```sh
ROOT=$(mktemp -d /tmp/dsh-paperprobe-XXXX)
DSH_HOME="$ROOT" dsh paper-e2e --from-default-profile web --dump-config >/dev/null   # 造一个干净 profile
DSH_HOME="$ROOT" dsh plugin --profile paper-e2e add "$PWD"                            # 装本插件
DSH_HOME="$ROOT" dsh plugin --profile paper-e2e add "$ROOT/probe"                     # 装探针
DSH_HOME="$ROOT" PROBE_OUT="$ROOT/out.json" \
  nohup dsh --profile paper-e2e --patch "$ROOT/probe.patch.yml" --no-open --port 3161 \
  > "$ROOT/server.log" 2>&1 &
sleep 25
cat "$ROOT/out.json"
```

探针里两个必须知道的点：`ctx.agents.create({ sessionId, meta: { cwd, agentPreset }, setup })`
要自己在 `setup` 里 `ctx.agentPresets.mount(agentCtx, preset)`（与 `dsh-api-session-controller`
的 `composeAgent` 一样）；`sessionId` 别复用——同一个临时 `DSH_HOME` 跑第二次会撞
`SessionAlreadyExistsError`，加个时间戳后缀。

实测结果（`toolCount` 是全部工具数，这里只列本插件的）：

| 视角 | `paper_*` 工具 | 本插件技能 |
|---|---|---|
| 论文解读模式的 agent | 5 | 3 |
| standard 模式的 agent | 0 | 0 |
| standard → 切到论文解读 | 5 | 3 |
| 论文解读 → 切到 standard | 0 | 0 |
| 全局视角（`schemas()` 不带 scope） | 0 | 0 |

换 preset 两行必须成立：DSH 允许在首个 turn 之前换模式，`tools.restrict()` 那种一次性装在 agent
scope 上的限制会在换模式后留下错误的可见面（见 [设计与取舍](design.md#早先的做法为什么被删掉了)）。

顺带还能验「档位 → 技能正文」这条跨挂载点的链：直接写 `$DSH_HOME/paper-reader/levels.json`
（等价于控制面端点的写路径），再对同一个 agent 调
`ctx.skills.get('paper-report', { cwd, scope: agent })`，正文应当随档位变化、且只带当前档的片段。
实测的装配后长度：速览 5457、解读 5876、深读 5942 字符，三份都只包含自己那一档的片段。

## 提交前检查

1. `node --test` 全绿（127 条）。
2. 改了**抽取逻辑**（分页、分块、行拼接、标题判定、基准字号）→ 抬 `lib/pdf.js` 的 `CACHE_FORMAT`
   并在注释里写清这一版改了什么，见[维护纪律](design.md#维护纪律改了抽取逻辑就必须抬-cache_format)。
3. 改了 `presets/paper.patch.yml` 的 persona → 确认没有引入新的 `{{…}}`（`node --test` 会拦下）。
4. 改了档位（加档、改档位名、改篇幅/文件名）→ 按
   [档位三处同步](design.md#维护纪律档位相关的东西有三处必须同步) 一次改齐，其中包括手工同步
   `lib/client.js` 里的展示名副本。
5. 改了 `lib/client.js` → 起一次性 web 服务确认首页 boot entry 与 bundle 路由（见上一节）；
   纯改渲染细节也要跑 `node --test` 的 `client.test.mjs`。
6. 改了**挂载点或注册内容** → 跑一遍上一节的隔离验证，确认换 preset 与全局视角两栏还是 0。
7. 文档里不留本机绝对路径与固定 Node 版本；实测数字标明「本机实测」与来源。
