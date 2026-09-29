# 开发与验证

## 目录结构

```
dsh-paper-reader/
├── package.json            dsh.bundle.patch = [cordis.patch.yml, presets/paper.patch.yml]
├── cordis.patch.yml        profile 根层：刻意留空（见文件内说明）
├── presets/paper.patch.yml 唯一的开关：插入 preset-paper
├── lib/index.js            宿主插件：注册 skill provider + 四个工具
├── lib/tools.js            四个工具的声明、入参校验与输出渲染
├── lib/pdf.js              mupdf 封装：导入、检索、分页读取、页面渲染
├── skills/<name>/SKILL.md  技能正文（frontmatter: name / description / whenToUse）
├── test/                   契约测试（provider / preset）+ 行为测试（pdf / tools）
├── docs/                   设计取舍、已知限制、开发与验证（本文件）
└── CHANGELOG.md
```

`lib/tools.js` 末尾另外再导出了 `pdf.js` 的 `readMeta`，供诊断用（列已导入论文的元数据）。
`lib/pdf.js` 还有 `parsePages` / `captionsOf` / `listCached` / `defaultCacheRoot` 等导出，主要供
测试使用；`package.json` 的 `exports` 只暴露 `"."` 与 `"./package.json"`，外部拿不到这些内部函数。

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

`list()` 每次重新扫描目录、`get()` 每次重新读盘，所以改正文、`description`、以及增删技能包目录都
即时生效，不需要重载 preset；`apply` 另外挂了目录监视器，跨进程的变更会让注册表丢掉缓存目录。
校验分支（缺 SKILL.md、缺 frontmatter、缺 description、name 与目录名不一致、`whenToUse` 非字符串）
都有测试覆盖。

## 安装（本地路径）

本包自带运行时依赖（`mupdf`、`yaml`），且 `node_modules/` 不入库，所以在装进 profile 之前必须先在本
包目录里装一次依赖：

```sh
cd <本包目录>
pnpm install

dsh plugin --profile web add <本包目录>
```

`pnpm-lock.yaml` **入库**，所以这次安装解析出的依赖树与实测过的那份一致。装完重启 `dsh web`
（preset 属启动期组装）。

两点注意：

- **别用 scp 风格的 URL 让 pnpm 去装**（`git@github.com:...`）：pnpm 会把它误解析成「包名 `git`
  + 版本」，装出一个空依赖，插件不会生效。若要走远端安装，用 `github:<owner>/<repo>` 形式。
- **本插件目前只验证过本地路径安装**。走 GitHub 安装（本仓库目前是私有仓库，需要 pnpm 侧能拿到
  凭据）未实测，装完请用下面的 `--dump-config` 确认 `preset-paper` 真的插进来了。

## 测试

```sh
node --test
```

当前 80 条，四块：

| 文件 | 覆盖 |
|---|---|
| `test/provider.test.mjs` | skill provider 契约：frontmatter 校验的每个失败分支、只认顶层目录、`list()`/`get()` 即时反映改动、`apply()` 注册的工具集与顺序 |
| `test/preset.test.mjs` | preset 契约：`{{…}}` 白名单与未闭合检测、preset 身份与挂载点、persona 点名四个工具与 `read_image` |
| `test/pdf.test.mjs` | 解析行为：导入幂等（同文件换路径命中同一缓存）、锚点与标题判定（含表格行假锚点、全篇基准字号）、两段式检索、页码表达式、分页读取与截断 |
| `test/tools.test.mjs` | 工具行为：schema 只用白名单关键字、入参校验（缺必填/未知键/类型/小数/越界）、输出满足自声明 schema、缓存根覆盖 |

`test/helpers/synthetic-paper.mjs` 手写生成 fixture PDF（不引第三方依赖，且字节完全确定——
`docId` 就是字节哈希，fixture 只要带时间戳，幂等那条测试立刻变成假绿）。

## 验证 bundle 与 preset 组装

改完 `package.json` 的 `dsh.bundle.patch`、`cordis.patch.yml` 或 preset 之后，先跑这个再重启
`dsh web`：全程只写临时目录，不动真实 profile。

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
DSH_HOME="$ROOT" dsh --profile web --dump-config | grep -A6 'id: preset-paper'
```

实测输出（`DSH_PKG` 用的是 `readlink -f` 推导出来的路径，不写死用户名与 Node 版本）：

```
- id: preset-paper
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: paper
    name: 论文解读
    description: 精读单篇论文并生成解读报告；基于同一份解析产物回答论文相关问题
    order: 5
```

`--dump-config-schema` 不能用来验证加载，见[已知限制](limitations.md#--dump-config-schema-不能用)。

## 提交前检查

1. `node --test` 全绿（80 条）。
2. 改了**抽取逻辑**（分页、分块、行拼接、标题判定、基准字号）→ 抬 `lib/pdf.js` 的 `CACHE_FORMAT`
   并在注释里写清这一版改了什么，见[维护纪律](design.md#维护纪律改了抽取逻辑就必须抬-cache_format)。
3. 改了 `presets/paper.patch.yml` 的 persona → 确认没有引入新的 `{{…}}`（`node --test` 会拦下）。
4. 文档里不留本机绝对路径与固定 Node 版本；实测数字标明「本机实测」与来源。
