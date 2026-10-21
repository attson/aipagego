# 发布 @attson/aipagego-mcp 到 npm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `npx -y @attson/aipagego-mcp` 即用——`packages/mcp-server` 改名 + tsup bundle + Apache-2.0 + npm publish CI + env var rename + 一行装文档。

**Architecture:** tsup 打 single-file ESM bundle（含 shebang，内联 workspace deps，external `ws/@modelcontextprotocol/sdk/zod`）。package.json 改 name 到 `@attson/aipagego-mcp`、`private:false`、`bin/exports` 指向 `dist/index.js`、`publishConfig.access:public`。新 workflow `publish-mcp-server.yml` on `v*` tag 跑 `npm publish --provenance`。env var 硬切换 `WEBPILOT_*` → `AIPAGEGO_*`。

**Tech Stack:** tsup (esbuild), pnpm workspaces, GitHub Actions, npm registry。

**对应 spec:** `../specs/2026-06-07-mcp-publish-design.md`

**关键既有事实（已核对）:**
- 当前主分支 head `42deae6 chore: release v0.0.18`，root `package.json` version `0.0.18`，**已发 v0.0.18 release**（aipagego-0.0.18.zip on Github Release）。
- mcp-server 当前 `name: "@aipagego/mcp-server"`, `private:true`, `version:"0.0.0"`, `bin/exports` 指 `./src/index.ts`，无 build。
- 现有 CI workflow 只有 `.github/workflows/build-extension.yml`（on push branch + v* tag + PR）。
- 用户 `~/.claude.json` 已配 `webpilot` MCP server 指向 tsx 绝对路径（用户手动改，不在本 plan 自动范围）。

---

## File Structure

新增 / 修改：

- **修改** `packages/mcp-server/package.json` — name `@attson/aipagego-mcp`、private:false、Apache-2.0、bin/exports 指 dist/、workspace deps 移到 devDeps、加 `tsup` devDep、加 `publishConfig.access:public`
- **新增** `packages/mcp-server/tsup.config.ts` — 单文件 ESM bundle 配置
- **修改** `packages/mcp-server/src/index.ts` — env var rename 2 处
- **新增** `packages/mcp-server/LICENSE` — Apache-2.0 全文
- **重写** `packages/mcp-server/README.md` — npx 优先
- **修改** `README.md`（根）— 顶部加 `## 安装` 小节
- **新增** `.github/workflows/publish-mcp-server.yml` — npm publish on v* tag
- **修改** `docs/superpowers/plans/README.md` — Plan 17 索引行
- **修改** `docs/superpowers/specs/README.md` — Plan 17 索引已加（spec phase 写时）

**不动**：
- `packages/shared`, `packages/coordinator` 包名仍 `@aipagego/*`（仅内部用，不发 npm）
- `packages/extension` 包名 `@aipagego/extension`（仍 private）
- `.github/workflows/build-extension.yml`（继续负责扩展 build + Release）

---

## Task 1: 切分支 + 装 tsup + tsup.config.ts

**Files:**
- Create: `packages/mcp-server/tsup.config.ts`
- Modify: `packages/mcp-server/package.json`（仅加 tsup 到 devDependencies）

- [ ] **Step 1: 切分支**

```bash
cd /Users/attson/code/aipagego2
git checkout main
git pull --ff-only
git status   # MUST be clean
git checkout -b feat/mcp-publish
```

- [ ] **Step 2: 加 tsup devDep**

编辑 `packages/mcp-server/package.json`，在 `devDependencies` 块里加一行（保持原有 deps 不变本步）：
```json
"tsup": "^8.0.0",
```

具体位置：放在 `"tsx": "^4.19.0",` 上方，alphabetical。

- [ ] **Step 3: pnpm install**

```bash
pnpm install 2>&1 | tail -5
```

Expected: 无错，"Done in N"。

- [ ] **Step 4: 新建 `packages/mcp-server/tsup.config.ts`**

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  // 内联 workspace 包源码：npm 上不存在这俩包
  noExternal: ["@aipagego/shared", "@aipagego/coordinator"],
  // 这三个声明在 dependencies，npm 自动装到用户机器
  external: ["ws", "@modelcontextprotocol/sdk", "zod"],
  sourcemap: false,
  dts: false,
  splitting: false
});
```

- [ ] **Step 5: 验证 typecheck 仍过**

```bash
pnpm -F @aipagego/mcp-server typecheck
```

Expected: clean (no output). 

注意：当前包名仍是 `@aipagego/mcp-server`（Task 2 才改名），所以 pnpm filter 用这个旧名。

- [ ] **Step 6: 烟测 tsup build**

⚠ 这一步不应该完全成功——tsup 会构建，但因为 package.json 里 `bin/exports` 仍指 `./src/index.ts`、产物没有用武之地。我们只是确认 tsup 能跑：

```bash
pnpm -F @aipagego/mcp-server exec tsup 2>&1 | tail -10
```

Expected: tsup 打印 build 进度、产出 `packages/mcp-server/dist/index.js`，无致命错。

```bash
ls -la packages/mcp-server/dist/
head -1 packages/mcp-server/dist/index.js
wc -c packages/mcp-server/dist/index.js
```

Expected: `index.js` 存在，第一行 `#!/usr/bin/env node`，大小 < 2 MB。

- [ ] **Step 7: 把 dist/ 加到 .gitignore（如果还没）**

```bash
grep -n "^dist" .gitignore 2>/dev/null || echo "needs check"
```

如果根 `.gitignore` 没有覆盖 `packages/mcp-server/dist/`，加一行（去掉构建产物入 git）：

```bash
# 检查
git status packages/mcp-server/dist/
```

如果 `git status` 显示 dist/ untracked，说明确需 ignore。在 `packages/mcp-server/.gitignore`（新建或追加）写：
```
dist/
```

如果 dist/ 已经被某条规则 ignore，跳过本步。

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-server/package.json packages/mcp-server/tsup.config.ts pnpm-lock.yaml
# 如果新加了 .gitignore
test -f packages/mcp-server/.gitignore && git add packages/mcp-server/.gitignore
git commit -m "chore(mcp-server): add tsup + bundler config for npm publish"
```

---

## Task 2: package.json overhaul

**Files:**
- Modify: `packages/mcp-server/package.json`

- [ ] **Step 1: 读现状**

```bash
cat packages/mcp-server/package.json
```

记录现有字段，下面的改动按 diff 方式叙述。

- [ ] **Step 2: 改 package.json**

整文件内容替换为：

```json
{
  "name": "@attson/aipagego-mcp",
  "version": "0.0.19",
  "license": "Apache-2.0",
  "description": "MCP server for the aipagego browser extension — let Claude Code drive your browser.",
  "homepage": "https://github.com/attson/aipagego#readme",
  "repository": { "type": "git", "url": "git+https://github.com/attson/aipagego.git" },
  "type": "module",
  "bin": { "aipagego-mcp": "./dist/index.js" },
  "exports": { ".": "./dist/index.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "build": "tsup",
    "start": "tsx src/index.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "ws": "^8.18.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@aipagego/shared": "workspace:*",
    "@aipagego/coordinator": "workspace:*",
    "@types/node": "^20",
    "@types/ws": "^8.5.12",
    "tsup": "^8.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

**关键变化**：
- `name`: `@aipagego/mcp-server` → `@attson/aipagego-mcp`
- 删 `"private": true`
- `version` 0.0.0 → 0.0.19
- 加 `license` / `description` / `homepage` / `repository`
- `bin` / `exports` 指 `./dist/index.js`
- 加 `files`、`publishConfig`
- `scripts.build` 加 `tsup`
- workspace deps 从 `dependencies` 移到 `devDependencies`

- [ ] **Step 3: pnpm install 重新解析 lockfile**

包名改动后 lockfile 需要更新：

```bash
pnpm install 2>&1 | tail -10
```

Expected: 成功，可能提示 `Already up to date`（如果 lockfile 已是新结构）或重新解析后 `Done in N`。

- [ ] **Step 4: 验证 typecheck + test 仍过**

```bash
pnpm -F @attson/aipagego-mcp typecheck
pnpm -F @attson/aipagego-mcp test 2>&1 | tail -10
```

Expected：typecheck clean；test 25 passed (5 files)。

注意 pnpm filter 现在用**新名** `@attson/aipagego-mcp`。

- [ ] **Step 5: 重新 build dist/**

```bash
pnpm -F @attson/aipagego-mcp build 2>&1 | tail -10
ls -la packages/mcp-server/dist/index.js
head -1 packages/mcp-server/dist/index.js
```

Expected: `dist/index.js` 存在，第一行 `#!/usr/bin/env node`。

- [ ] **Step 6: 烟测 bundled 启动**

```bash
AIPAGEGO_WS_PORT=8888 node packages/mcp-server/dist/index.js &
PID=$!
sleep 2
kill $PID 2>/dev/null
```

⚠ 这一步**预期**失败/无输出，因为 src/index.ts 仍读 `WEBPILOT_WS_PORT`（旧名）—— Task 3 才改。可以观察 stderr 应该有 ready 行（如果 server 起来了），但端口可能用了 default 8787。本步只是确认 process 不立刻 crash。

- [ ] **Step 7: 全仓 typecheck + test 仍过**

```bash
pnpm -r typecheck 2>&1 | tail -10
pnpm -r test 2>&1 | tail -10
```

Expected: 4 包 typecheck clean；519 测试全绿。

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-server/package.json pnpm-lock.yaml
git commit -m "chore(mcp-server): rename to @attson/aipagego-mcp, prep for npm publish"
```

---

## Task 3: env var rename WEBPILOT_* → AIPAGEGO_*

**Files:**
- Modify: `packages/mcp-server/src/index.ts`

- [ ] **Step 1: 改两行**

读 `packages/mcp-server/src/index.ts` 第 9-10 行，应该是：
```ts
  const port = Number(process.env.WEBPILOT_WS_PORT ?? 8787);
  const token = process.env.WEBPILOT_WS_TOKEN || undefined;
```

改成：
```ts
  const port = Number(process.env.AIPAGEGO_WS_PORT ?? 8787);
  const token = process.env.AIPAGEGO_WS_TOKEN || undefined;
```

- [ ] **Step 2: 全仓再扫一遍 `WEBPILOT_`（全大写）**

```bash
grep -rIn 'WEBPILOT_' --exclude-dir={node_modules,dist,.git} . 2>/dev/null
```

Expected: 仅命中 `packages/mcp-server/README.md` 里几处（Task 6 才重写 README 覆盖）。如果命中 src 文件其他位置，也一并改成 `AIPAGEGO_`。

- [ ] **Step 3: 验证 typecheck + test 仍过**

```bash
pnpm -F @attson/aipagego-mcp typecheck
pnpm -F @attson/aipagego-mcp test 2>&1 | tail -5
```

Expected: 通过，25 测试。

- [ ] **Step 4: 重 build + 烟测 bundled 启动**

```bash
pnpm -F @attson/aipagego-mcp build 2>&1 | tail -5
AIPAGEGO_WS_PORT=8889 node packages/mcp-server/dist/index.js 2>/tmp/mcp-smoke.log &
PID=$!
sleep 2
kill $PID 2>/dev/null
cat /tmp/mcp-smoke.log
```

Expected: stderr 含 `[aipagego-mcp] ws://127.0.0.1:8889/worker ready; stdio MCP connected`。

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/index.ts
git commit -m "refactor(mcp-server): env var WEBPILOT_* → AIPAGEGO_* (no fallback)"
```

---

## Task 4: LICENSE file

**Files:**
- Create: `packages/mcp-server/LICENSE`

- [ ] **Step 1: 下载 Apache-2.0 全文**

```bash
curl -fsSL https://www.apache.org/licenses/LICENSE-2.0.txt -o packages/mcp-server/LICENSE
```

如果网络不通，可手工写入（Apache-2.0 标准文本可从任意 Apache 项目复制）。

- [ ] **Step 2: 验证文件**

```bash
head -5 packages/mcp-server/LICENSE
wc -l packages/mcp-server/LICENSE
```

Expected: 头部 `Apache License`/`Version 2.0`；行数 ~200+。

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-server/LICENSE
git commit -m "chore(mcp-server): add Apache-2.0 LICENSE"
```

---

## Task 5: Rewrite packages/mcp-server/README.md

**Files:**
- Rewrite: `packages/mcp-server/README.md`

- [ ] **Step 1: 整文件替换**

把 `packages/mcp-server/README.md` 整个内容换为：

```markdown
# @attson/aipagego-mcp

让 Claude Code 经一个本地 ws 中继驱动 aipagego 浏览器扩展操作网页（读 / 写 / 采）。

## 给用户：一行装

    claude mcp add aipagego --scope user -- npx -y @attson/aipagego-mcp

可选环境变量：

- `AIPAGEGO_WS_PORT`（默认 8787）：本地 ws 监听端口
- `AIPAGEGO_WS_TOKEN`（可选）：扩展连接时要求 `bearer.<token>` 子协议

然后[下载 release zip](https://github.com/attson/aipagego/releases/latest) 加载已解压扩展，
在扩展设置 → Coordinator 子页填 `ws://127.0.0.1:8787/worker` → 连接。新会话 Claude 调
`list_tabs` 即可看到当前标签页。

## 给开发者：本地 monorepo

    pnpm -F @attson/aipagego-mcp start

环境变量同上，路径用 `tsx src/index.ts` 直跑（包内 `start` script 已封）。

## 工具面

- 控制面 4 个：`list_tabs / open_session / close_session / get_quota`
- 执行面 19 个 `browser_*`：snapshotDOM / click / fillInput / setCheckbox / selectOption / extractText / extractImages / submitForm / uploadFile / readStorage / httpRequest / scroll / waitFor / hover / focus / getValue / extractFormState / querySelector / querySelectorAll

详细协议与设计见 [`../../docs/superpowers/specs/2026-06-06-mcp-bridge-design.md`](../../docs/superpowers/specs/2026-06-06-mcp-bridge-design.md)。

⚠ 进程禁止往 stdout 写非 MCP 内容（stdout 是 MCP 通道）。所有日志走 stderr。
```

- [ ] **Step 2: Commit**

```bash
git add packages/mcp-server/README.md
git commit -m "docs(mcp-server): README rewrite — npx-first for npm consumers"
```

---

## Task 6: 根 README.md 加 `## 安装` 顶部小节

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 找插入点**

```bash
grep -n "^## " README.md | head -5
```

预期看到第一个 `## ` 标题（多半是 `## 装载`）。新 `## 安装` 小节插到第一个 `## ` 之前。

- [ ] **Step 2: 插入安装小节**

在 root README.md 中，紧贴现有 `## 装载`（或第一个 `## ` 标题）之前插入：

```markdown
## 安装

只想 **用**（不开发）：

    claude mcp add aipagego --scope user -- npx -y @attson/aipagego-mcp

然后下载 [最新 release zip](https://github.com/attson/aipagego/releases/latest)，在
`chrome://extensions` 加载已解压扩展，扩展设置 → Coordinator 填
`ws://127.0.0.1:8787/worker` → 连接。

可选环境变量：`AIPAGEGO_WS_PORT`（默认 8787）、`AIPAGEGO_WS_TOKEN`（可选）。

---

```

注意末尾的 `---` 分隔，让原有「装载」（开发者侧）与「安装」（用户侧）视觉分隔。

- [ ] **Step 3: 看一下**

```bash
head -40 README.md
```

确认顺序：项目介绍 → `## 安装` → `---` → `## 装载` ...

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(root): add '## 安装' top section for npm install path"
```

---

## Task 7: publish-mcp-server.yml workflow

**Files:**
- Create: `.github/workflows/publish-mcp-server.yml`

- [ ] **Step 1: 新建 workflow**

写入 `.github/workflows/publish-mcp-server.yml`：

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
    name: Build + npm publish
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: 'https://registry.npmjs.org'

      - name: Enable pnpm
        run: |
          corepack enable
          corepack prepare pnpm@9 --activate

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build mcp-server
        run: pnpm -F @attson/aipagego-mcp build

      - name: Verify dist
        run: |
          test -f packages/mcp-server/dist/index.js
          head -1 packages/mcp-server/dist/index.js | grep -q '^#!/usr/bin/env node'

      - name: npm publish
        working-directory: packages/mcp-server
        run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 2: 验证 yaml 语法**

```bash
# 用 python 简单 parse yaml
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/publish-mcp-server.yml'))" && echo "yaml ok"
```

Expected: `yaml ok`。

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/publish-mcp-server.yml
git commit -m "ci: add publish-mcp-server workflow (npm publish on v* tag)"
```

---

## Task 8: Plan 索引行

**Files:**
- Modify: `docs/superpowers/plans/README.md`

- [ ] **Step 1: 看现状**

```bash
sed -n '1,30p' docs/superpowers/plans/README.md
```

确认列结构（5 列：`# | 实施计划 | task 数 | 测试增量 | 总测试数`）。

- [ ] **Step 2: 加 Plan 17 行**

在末尾 Plan 16 行之后加：

```markdown
| 17 | [`2026-06-07-mcp-publish.md`](./2026-06-07-mcp-publish.md) | 9 | 0 (publish only) | ~492 |
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/README.md
git commit -m "docs(plan): add Plan 17 index row — npm publish @attson/aipagego-mcp"
```

---

## Task 9: 全量验收

**Files:** 无；纯验证。

- [ ] **Step 1: typecheck**

```bash
pnpm -r typecheck 2>&1 | tail -10
```

Expected: 4 包全过。

- [ ] **Step 2: test**

```bash
pnpm -r test 2>&1 | tail -10
```

Expected: 519 测试全绿（无回归——env var rename 不破坏行为）。

- [ ] **Step 3: extension build**

```bash
pnpm -F @aipagego/extension build 2>&1 | tail -5
```

Expected: vite 正常出 dist。

- [ ] **Step 4: mcp-server build**

```bash
pnpm -F @attson/aipagego-mcp build 2>&1 | tail -10
ls -la packages/mcp-server/dist/index.js
head -1 packages/mcp-server/dist/index.js
wc -c packages/mcp-server/dist/index.js
```

Expected：dist/index.js 存在；shebang 在第一行；大小 < 2 MB（健全性）。

- [ ] **Step 5: 烟测 bundled 启动**

```bash
AIPAGEGO_WS_PORT=8890 node packages/mcp-server/dist/index.js 2>/tmp/mcp-final.log &
PID=$!
sleep 3
kill $PID 2>/dev/null
cat /tmp/mcp-final.log
```

Expected: stderr 含 `[aipagego-mcp] ws://127.0.0.1:8890/worker ready; stdio MCP connected`。

- [ ] **Step 6: 漏网扫描 WEBPILOT_**

```bash
grep -rIn 'WEBPILOT_' --exclude-dir={node_modules,dist,.git} . 2>/dev/null | grep -v 'AIPAGEGO_'
```

Expected: 空输出。

- [ ] **Step 7: 任何回归 → 修 + 加 commit；否则跳过**

---

## Task 10: PR + 一次性 NPM_TOKEN 准备 + ship-release

**Files:** 无源码改动；这是上线流程。

⚠️ **关键前置：NPM_TOKEN 准备由人类用户手动完成**。subagent / Claude 无 npm/GitHub UI 凭证；以下步骤遇到「需用户操作」一项时报 BLOCKED，等用户完成后继续。

- [ ] **Step 1: 检查工作树状态**

```bash
git status                      # MUST be clean
git log --oneline -10           # 应看到 Task 1-8 的 8 个 commit + Task 9 可能 0 个修复 commit
git branch --show-current       # MUST be feat/mcp-publish
```

- [ ] **Step 2: Push 分支**

```bash
git push -u origin feat/mcp-publish
```

- [ ] **Step 3: 开 PR**

```bash
gh pr create --base main --head feat/mcp-publish \
  --title "feat(mcp-server): publish @attson/aipagego-mcp to npm (Plan 17)" \
  --body "$(cat <<'EOF'
## Summary

让 `npx -y @attson/aipagego-mcp` 即用。对应 spec [`2026-06-07-mcp-publish-design.md`](docs/superpowers/specs/2026-06-07-mcp-publish-design.md)。

- 包改名 `@aipagego/mcp-server` → `@attson/aipagego-mcp`（个人 scope，无需注册 org）
- tsup 打 single-file ESM bundle（含 shebang，内联 shared+coordinator）
- Apache-2.0 license
- env var `WEBPILOT_*` → `AIPAGEGO_*` 硬切换（无回退）
- 新 workflow `publish-mcp-server.yml` on `v*` tag → `npm publish --provenance --access public`
- 根 README 加一行装小节

## Test Plan

- [x] `pnpm -r typecheck/test` — 4 包全绿，519 测试零回归
- [x] `pnpm -F @attson/aipagego-mcp build` — dist/index.js 出，含 shebang，< 2 MB
- [x] `node dist/index.js` 启动 stderr 含 ready 行
- [x] 漏网扫描 `WEBPILOT_` 空输出（除 `AIPAGEGO_`）
- [ ] **合入后**：root v0.0.18 → 0.0.19，tag v0.0.19 触发 **两个** workflow
  - [ ] `build-extension.yml` 出 `aipagego-0.0.19.zip` GitHub Release
  - [ ] `publish-mcp-server.yml` `npm publish @attson/aipagego-mcp@0.0.19`
- [ ] `npm view @attson/aipagego-mcp` 显示 0.0.19
- [ ] 在 monorepo 之外 `npx -y @attson/aipagego-mcp` 启动 ws server
- [ ] 用户更新 `~/.claude.json`：command 改 npx，env var 改名

## ⚠ Tag 前必须完成的手动前置

1. npmjs.com → Profile → Access Tokens → Granular token，限定 `@attson/*` scope，Read+Write
2. GitHub repo → Settings → Secrets → 加 `NPM_TOKEN`
EOF
)"
```

记下 PR URL。

- [ ] **Step 4: 等 CI 通过**

```bash
gh pr checks $(gh pr view --json number --jq .number)
```

等所有 check pass。如果 fail，修+push，再等。

- [ ] **Step 5: ⚠ STOP — 等用户准备 NPM_TOKEN**

在 squash-merge **之前**，**必须**告诉用户：

> 「请完成下列两步，完成后告诉我『NPM_TOKEN 已设置』再继续」：
>
> 1. npmjs.com → 登录 → Profile → Access Tokens → Generate Granular Token：
>    - Name: `aipagego-github-actions`
>    - Expiration: 1y 或 No expiration
>    - Permissions: Read and write
>    - Packages and scopes: limited to `@attson/*`
> 2. GitHub repo (https://github.com/attson/aipagego) → Settings → Secrets and variables → Actions → New repository secret：
>    - Name: `NPM_TOKEN`
>    - Value: 上一步的 token

报 NEEDS_CONTEXT 暂停；等用户确认后再进 Step 6。

- [ ] **Step 6: 用 gh API 验证 NPM_TOKEN 存在**

```bash
gh secret list --repo attson/aipagego | grep -i NPM_TOKEN
```

Expected: 显示 `NPM_TOKEN` 一行（不显示值，但能确认存在）。

- [ ] **Step 7: Squash-merge + 同步 main**

```bash
gh pr merge $(gh pr view --json number --jq .number) --squash --delete-branch
git checkout main
git fetch origin
git reset --hard origin/main          # 如果本地有未推的 commit 但已含在 squash 里（往例如此）
git log --oneline -3
```

- [ ] **Step 8: Bump root v0.0.19 + commit + push**

```bash
# 把 root package.json 的 "version": "0.0.18" 改为 "0.0.19"
sed -i '' 's|"version": "0.0.18"|"version": "0.0.19"|' package.json
grep '"version"' package.json
git add package.json
git commit -m "chore: release v0.0.19"
git push origin main
```

- [ ] **Step 9: Tag + push tag**

```bash
git tag v0.0.19
git push origin v0.0.19
```

- [ ] **Step 10: 监控两个 workflow**

```bash
sleep 5
gh run list --limit 5 --json status,conclusion,name,headBranch,headSha,event,createdAt,url \
  --jq '.[] | "\(.status) \(.conclusion // "-") \(.name) [\(.event)] \(.headBranch) \(.headSha[0:7]) \(.url)"'
```

找到 **两条** `[push] v0.0.19` 的 run：
- `Build Extension`：现有，出 GitHub Release
- `Publish MCP Server`：新，npm publish

记下两个 URL，等到都 `completed success`。

- [ ] **Step 11: 验证 npm publish 成功**

```bash
sleep 30   # npm registry 索引有时延
npm view @attson/aipagego-mcp version
npm view @attson/aipagego-mcp dist.tarball
```

Expected: version `0.0.19`；tarball URL 类似 `https://registry.npmjs.org/@attson/aipagego-mcp/-/aipagego-mcp-0.0.19.tgz`。

- [ ] **Step 12: 终验 npx 在新目录可用**

```bash
cd /tmp
mkdir -p aipagego-mcp-smoke && cd aipagego-mcp-smoke
AIPAGEGO_WS_PORT=8891 timeout 5 npx -y @attson/aipagego-mcp 2>&1 | head -5
```

Expected: stderr 含 ready 行 `[aipagego-mcp] ws://127.0.0.1:8891/worker ready; stdio MCP connected`。timeout 后退出码 124 是预期的（npx 启动了 stdio server，等 input 直到被杀）。

- [ ] **Step 13: 验证 GitHub Release v0.0.19**

```bash
gh release view v0.0.19 --json url,assets --jq '.url, .assets[].name'
```

Expected: URL 显示，asset 名 `aipagego-0.0.19.zip`。

---

## Self-Review（已对照 spec 检查）

- **Spec §2 范围决策**：每条都有对应 task。包名→T2、tsup→T1+T2、内联 deps→T1 tsup.config、external deps→T1、shebang→T1 banner、version→T2、Apache-2.0→T2+T4、CI publish→T7、publishConfig→T2、env var→T3、其余包不动→无 task 显式动它们。
- **Spec §3 非目标**：不做 Chrome Web Store，不做 env var 软回退——计划里都不出现。
- **Spec §5.1 package.json 改动详表**：T2 完整覆盖。
- **Spec §5.2 tsup.config.ts**：T1 完整。
- **Spec §5.3 src/index.ts env var**：T3 完整。
- **Spec §5.4 README rewrite**：T5 完整。
- **Spec §5.5 LICENSE**：T4 完整。
- **Spec §5.6 publish workflow**：T7 完整。
- **Spec §5.7 root README**：T6 完整。
- **Spec §6 前置准备**：T10 Step 5 强制 STOP 让用户做。
- **Spec §7 验收**：T9 全量 + T10 Step 11-13 publish 后验证。
- **Spec §8 风险**：plan 内对应防护：tsup 烟测（T1+T2+T3+T9）防 bundle 错；漏网扫描（T9 Step 6）防 env var 漏；publish workflow `Verify dist` 步骤（T7）防 shebang 漏。

**类型一致性**：
- 包名 `@attson/aipagego-mcp` 在 T2、T7、T10 中所有 `pnpm -F` / `npx` / `npm view` 命令一致。
- env var `AIPAGEGO_WS_PORT`/`AIPAGEGO_WS_TOKEN` 在 T3、T5、T6、T9、T10 中一致。
- Version `0.0.19` 在 T2、T10 中一致；root version 用 `0.0.18`→`0.0.19` sed。

**占位扫描**：无 TBD/TODO/"similar to"。每命令完整；每 commit message 写定。

**已知 hand-off**：
- T10 Step 5 NPM_TOKEN 准备**必须**人类做，subagent 报 NEEDS_CONTEXT 暂停。
- T10 Step 12 后续：用户**还要**手动改 `~/.claude.json`（删 `~/.claude.json` 里 webpilot 的 tsx 配置，换成 npx 配置 + env var 改名）——本 plan 完成后会单独通知。
