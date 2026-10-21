# 发布 @attson/aipagego-mcp 到 npm — 设计文档

> 状态：设计已评审通过，待 writing-plans。
> 对应 plan：`../plans/2026-06-07-mcp-publish.md`（待生成）。

## 1. 目标

让别人能用一行命令装 aipagego 的 MCP server：

```
claude mcp add aipagego --scope user -- npx -y @attson/aipagego-mcp
```

不再需要 clone monorepo、配 tsx 绝对路径。Chrome 扩展侧的分发仍走「下载 [v* tag 的 release zip](https://github.com/attson/aipagego/releases/latest) → 加载已解压扩展」（Chrome Web Store 上架不在本期）。

## 2. 范围决策（brainstorming 结论）

| 维度 | 决策 |
|---|---|
| 包名 | `@attson/aipagego-mcp`（个人 scope `@attson`，公开包） |
| Bundler | **tsup**（esbuild-based, 零配置） |
| Workspace 依赖处理 | **内联**进单文件 `dist/index.js`（`@aipagego/shared` 和 `@aipagego/coordinator` 不发 npm） |
| 运行时依赖（external） | `ws`, `@modelcontextprotocol/sdk`, `zod` —— 这三个不内联，由 npm 自动装到用户机器 |
| Shebang | tsup `banner: { js: "#!/usr/bin/env node" }`；publish 时给 `dist/index.js` 加 `executable` bit（npm 自动处理 bin 字段对应文件） |
| Version | 与 root `package.json` 版本同步；首发即 `0.0.19` |
| License | **Apache-2.0**，加 `LICENSE` 全文 + copyright Attson 2026 |
| 发布触发 | CI auto-publish：v* tag 推上 → 新 workflow `publish-mcp-server.yml` 跑 → `npm publish` |
| npm scope 可见性 | `publishConfig.access: "public"`（scoped 包默认 private，需显式放开） |
| env var 改名 | **本 plan 包含** `WEBPILOT_*` → `AIPAGEGO_*`，硬切换无回退 |
| 其余包 | `packages/shared` `packages/coordinator` `packages/extension` 保持 `"private": true` |
| 安装文档 | 根 README 顶部加 `## 安装` 小节；`packages/mcp-server/README.md` 改 npx 优先；AGENTS.md 不动 |

## 3. 非目标（YAGNI）

- **Chrome Web Store 上架**：仍是 future work；扩展走 release zip 侧载。
- **env var 软回退**（同时读旧 `WEBPILOT_*` 兜底）：本地唯一用户、24 小时前才配的，硬切；plan 里给明改 `~/.claude.json` 的命令。
- **多版本 LTS / 包内部版本独立**：mcp-server 版本与 root 同步。
- **包大小最小化（tree-shaking 内部 deps）**：tsup 默认 esbuild bundle 已够，不调优。

## 4. 架构与流程

```
 ┌──────────── 开发者本地 (monorepo) ────────────┐
 │                                              │
 │  src/*.ts  +  workspace deps (shared/coord)  │
 │     │                                        │
 │     ▼                                        │
 │  tsup build (noExternal workspace deps)      │
 │     │                                        │
 │     ▼                                        │
 │  packages/mcp-server/dist/index.js  (single  │
 │   file with shebang, ~几百 KB, deps externalized) │
 │                                              │
 └──────────────────────────────────────────────┘
                     │
       推 v* tag    │
                     ▼
 ┌─────────── GitHub Actions ────────────────────┐
 │  publish-mcp-server.yml (new workflow)        │
 │   on push tag v*                              │
 │     pnpm install --frozen-lockfile            │
 │     pnpm -F @aipagego/mcp-server build      │
 │     cd packages/mcp-server                    │
 │     npm publish --provenance --access public  │
 │       NODE_AUTH_TOKEN: ${{secrets.NPM_TOKEN}} │
 └───────────────────────────────────────────────┘
                     │
                     ▼
 ┌───── npm registry: @attson/aipagego-mcp ────┐
 │  versions: 0.0.19, 0.0.20, ...                │
 │  package.json fields:                          │
 │    bin: { "aipagego-mcp": "dist/index.js" } │
 │    files: ["dist","README.md","LICENSE"]      │
 │    license: "Apache-2.0"                       │
 │    publishConfig.access: "public"              │
 └───────────────────────────────────────────────┘
                     │
                     ▼
 ┌── 用户机器 ─────────────────────────────────────┐
 │  ~/.claude.json:                                │
 │    "command":"npx", "args":["-y","@attson/aipagego-mcp"] │
 │  Claude Code 启会话 → npx 自动拉最新 → spawn   │
 │  stdio MCP 通；ws 服务端口 8787 监听            │
 │                                                 │
 │  浏览器扩展 (release zip 侧载) → 设置 →         │
 │  Coordinator 填 ws://127.0.0.1:8787/worker      │
 └─────────────────────────────────────────────────┘
```

## 5. 组件改动详表

### 5.1 `packages/mcp-server/package.json`

改动前（关键字段）：
```json
{
  "name": "@aipagego/mcp-server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "aipagego-mcp": "./src/index.ts" },
  "exports": { ".": "./src/index.ts" },
  "scripts": { "start": "tsx src/index.ts" }
}
```

改动后：
```json
{
  "name": "@attson/aipagego-mcp",                     ← 改 scope 到 @attson（用户个人 scope）
  "version": "0.0.19",                                  ← 与 root 同步，首发
  "license": "Apache-2.0",                              ← 新增
  "description": "MCP server for the aipagego browser extension — let Claude Code drive your browser.",
  "homepage": "https://github.com/attson/aipagego#readme",
  "repository": { "type": "git", "url": "git+https://github.com/attson/aipagego.git" },
  "type": "module",
  "bin": { "aipagego-mcp": "./dist/index.js" },       ← 指向 bundled 输出
  "exports": { ".": "./dist/index.js" },                ← 同上
  "files": ["dist", "README.md", "LICENSE"],            ← 控制 tarball 内容
  "publishConfig": { "access": "public" },              ← scoped 包须显式 public
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "build": "tsup",                                    ← 新
    "start": "tsx src/index.ts"                         ← 开发者本地仍可 tsx 直跑
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "ws": "^8.18.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@aipagego/shared": "workspace:*",                ← 从 deps 移到 devDeps（构建期用，内联不再是运行期依赖）
    "@aipagego/coordinator": "workspace:*",
    "@types/node": "^20",
    "@types/ws": "^8.5.12",
    "typescript": "^5.5.4",
    "tsup": "^8.0.0",                                   ← 新
    "tsx": "^4.19.0",
    "vitest": "^2.0.5"
  }
}
```

> **关键决策**：name 从 `@aipagego/mcp-server` 改成 `@attson/aipagego-mcp`。原因：`@aipagego` 是个未注册的 npm scope（要发的话用户得注册一个 organization）；`@attson` 是用户已有的 npm 用户名 scope，零额外注册。**所有源码 import 仍可保留 `@aipagego/shared|coordinator`**——因为这俩 workspace 包不发 npm，只内部用。

注意 workspace 包名仍是 `@aipagego/shared` 和 `@aipagego/coordinator`，本 plan 不动它们。只有 mcp-server 这一个外发包改名。

### 5.2 `packages/mcp-server/tsup.config.ts`（新建）

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  // 内联 workspace 包源码：npm 上无这俩包，必须 inline
  noExternal: ["@aipagego/shared", "@aipagego/coordinator"],
  // 这三个声明在 dependencies，npm 自动装到用户机器
  external: ["ws", "@modelcontextprotocol/sdk", "zod"],
  // sourcemap 不要——增大 tarball 又无 user-debug 价值
  sourcemap: false,
  // dts 不需要——这不是 lib，是 bin
  dts: false,
  // splitting=false 确保单文件
  splitting: false
});
```

### 5.3 `packages/mcp-server/src/index.ts`（env var rename）

唯一改 2 行：

```diff
- const port = Number(process.env.WEBPILOT_WS_PORT ?? 8787);
- const token = process.env.WEBPILOT_WS_TOKEN || undefined;
+ const port = Number(process.env.AIPAGEGO_WS_PORT ?? 8787);
+ const token = process.env.AIPAGEGO_WS_TOKEN || undefined;
```

### 5.4 `packages/mcp-server/README.md`（重写）

```markdown
# @attson/aipagego-mcp

让 Claude Code 经一个本地 ws 中继驱动 aipagego 浏览器扩展操作网页。

## 给用户：一行装

    claude mcp add aipagego --scope user -- npx -y @attson/aipagego-mcp

可选环境变量：

- `AIPAGEGO_WS_PORT`（默认 8787）：本地 ws 监听端口
- `AIPAGEGO_WS_TOKEN`（可选）：扩展连接时要求 `bearer.<token>` 子协议

然后[下载 release zip](https://github.com/attson/aipagego/releases/latest) 加载已解压扩展，
在扩展设置 → Coordinator 子页填 `ws://127.0.0.1:8787/worker` → 连接。

## 给开发者：本地 monorepo

    pnpm -F @attson/aipagego-mcp start

## 工具

- 控制面 4 个：`list_tabs / open_session / close_session / get_quota`
- 执行面 19 个 `browser_*`：snapshotDOM / click / fillInput / extractText / httpRequest / ...

详细工具与协议见 `../../docs/superpowers/specs/2026-06-06-mcp-bridge-design.md`。

⚠ 进程禁止往 stdout 写非 MCP 内容（stdout 是 MCP 通道）。
```

### 5.5 `packages/mcp-server/LICENSE`（新建）

Apache-2.0 标准全文（从 https://www.apache.org/licenses/LICENSE-2.0.txt），文件末尾加：

```
Copyright 2026 Attson

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

（实现时把 Apache-2.0 完整文本贴进去；上面是末尾的 copyright header。）

### 5.6 `.github/workflows/publish-mcp-server.yml`（新建）

```yaml
name: Publish MCP Server
on:
  push:
    tags: ["v*"]
permissions:
  contents: read
  id-token: write   # npm provenance
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: 'https://registry.npmjs.org'
      - run: |
          corepack enable
          corepack prepare pnpm@9 --activate
      - run: pnpm install --frozen-lockfile
      - run: pnpm -F @attson/aipagego-mcp build
      - name: Verify dist
        run: |
          test -f packages/mcp-server/dist/index.js
          head -1 packages/mcp-server/dist/index.js | grep -q '^#!/usr/bin/env node'
      - run: npm publish --provenance --access public
        working-directory: packages/mcp-server
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

注意：现有 `build-extension.yml` 也 on v* tag——两个 workflow 各管各的（extension build & GitHub release / npm publish），不冲突。

### 5.7 根 `README.md`：加 `## 安装` 小节

放在文件顶部「介绍段落」之后、「装载」（开发者侧）之前。预期插入位置：当前 README 的 `## 装载` 节标题之前。

```markdown
## 安装

只想 **用**（不开发）：

    claude mcp add aipagego --scope user -- npx -y @attson/aipagego-mcp

然后下载 [最新 release zip](https://github.com/attson/aipagego/releases/latest)，在
`chrome://extensions` 加载已解压扩展，扩展设置 → Coordinator 填
`ws://127.0.0.1:8787/worker` → 连接。

可选环境变量：`AIPAGEGO_WS_PORT` / `AIPAGEGO_WS_TOKEN`。
```

## 6. 前置准备（一次性手动，发布前必须做完）

1. **npmjs.com 账号**：用户 `attson` 应已有（个人 scope `@attson` = npm 用户名）。如果还没注册，先注册。
2. **生成 access token**：npmjs.com → Profile → Access Tokens → **Granular** token：
   - Token name: `aipagego-github-actions`
   - Expiration: 1 year（或 No expiration）
   - Permissions: **Read and write**
   - Packages and scopes: limit to `@attson/*`
3. **加 GitHub Secret**：GitHub repo settings → Secrets and variables → Actions → New repository secret，name `NPM_TOKEN`，value = 上一步的 token。

这三步是用户手动完成，plan 里列出但不让 subagent 跑（subagent 无 npm/GitHub 凭证）。

## 7. 验收

- [ ] `pnpm -F @attson/aipagego-mcp build` 出 `dist/index.js`，含 shebang，文件大小 < 2 MB
- [ ] `node packages/mcp-server/dist/index.js` 启动正常（stderr 打印 ready 行）
- [ ] `pnpm -r typecheck/test` 519 测试零回归
- [ ] `pnpm -F @aipagego/extension build` 仍正常（扩展包名 `@aipagego/extension` 不变）
- [ ] PR 合 main 后 bump root v0.0.19 + tag → 两个 workflow 都触发：
  - `build-extension.yml`：出 GitHub Release `aipagego-0.0.19.zip`
  - `publish-mcp-server.yml`：`npm publish` 成功
- [ ] `npm view @attson/aipagego-mcp` 显示 0.0.19
- [ ] 在 monorepo 之外的目录 `npx -y @attson/aipagego-mcp` 启动 ws server，打印 ready 行
- [ ] 用户更新 `~/.claude.json` 改用 npx 配置 + 改 env var 名，新会话能 `list_tabs`

## 8. 风险

| 风险 | 概率 | 应对 |
|---|---|---|
| `npm publish` 因 `NPM_TOKEN` 未设/权限不够失败 | 中（首次） | 前置准备 §6 详写；publish 失败不阻塞 extension Release |
| tsup bundle 出错（如 import.meta 或 dynamic require 问题） | 中 | 本地 `pnpm build` 后跑 `node dist/index.js` 烟测；CI 也跑同样的 verify dist 步骤 |
| 内联的 workspace 包源码无意引入 dev-only 代码（如 vitest 类） | 低 | tsup 默认只跟 entry 的静态 import；监控 bundle size |
| 用户 `~/.claude.json` 配的旧 env var 名未更新 → server 用默认 port 8787 / 无 token | 已接受 | plan 里给一行 `sed` 命令改用户 config；用户主动改 |
| 包名 `@attson/aipagego-mcp` 在 npm 上被抢注（虽个人 scope 应独占） | 极低 | publish 前 `npm view @attson/aipagego-mcp` 应 404 |
| 两个 workflow on `v*` tag 同时跑 → race | 已分析无害 | 两 workflow 互不依赖、产出不同（GitHub Release vs npm registry） |

## 9. 后续

发布稳定后可考虑：

- 扩展上 Chrome Web Store（仍需图标 + 隐私政策 + Google 审）
- MCP server 加 `--version` / `--help` flag
- shared & coordinator 各自发包（如果其他项目要复用 coordinator 状态机）
