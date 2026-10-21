# Phase 0 — Monorepo 改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有单包 AIPageGo 扩展改造成 pnpm workspaces monorepo —— `packages/shared/`（纯函数 + 类型，给后续 coordinator/daemon/server 共享）与 `packages/extension/`（现有扩展整体迁入）—— 不改任何运行时行为，所有 168 个测试与 build 产物保持一致。

**Architecture:** 五步小步快跑：先建空骨架（workspace + root scripts），再把 `src/shared/*` 镜像到 `packages/shared/`，然后 codemod 全量 `@/shared/X` → `@aipagego/shared/X` 并删旧 `src/shared/`，再把剩余扩展源码整体迁入 `packages/extension/`，最后改 CI 工作流路径。每步 commit，每步跑全测套防回归。

**Tech Stack:** pnpm 9 workspaces、TypeScript 5.5、Vite 5 + @crxjs（不变）、vitest 2 + happy-dom（不变）、GitHub Actions（路径调整）。

**Phase 0 范围警告：** 本计划**不**创建 `packages/coordinator/`、`packages/daemon/`、`packages/server/`，**不**新增任何 protocol / MCP / WS 代码——那些都在 Phase 1+。如果某 task 想"顺便"动这些，停下来重读 spec 第 7.4 节。

---

## 文件结构总览（Phase 0 结束态）

```
aipagego2/
├─ pnpm-workspace.yaml                ← 新
├─ package.json                       ← 改写为 workspace 编排（仅留 -r 转发脚本）
├─ pnpm-lock.yaml                     ← 自动重新生成
├─ tsconfig.json                      ← 删除（每包各自管）
├─ vite.config.ts                     ← 移到 packages/extension/
├─ tailwind.config.ts                 ← 移到 packages/extension/
├─ postcss.config.js                  ← 移到 packages/extension/
├─ src/                               ← 整体移除（内容迁到 packages/extension/src/）
├─ tests/                             ← 整体移除（迁到 packages/{shared,extension}/tests/）
├─ packages/
│  ├─ shared/
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ vitest.config.ts
│  │  ├─ src/
│  │  │  ├─ types.ts
│  │  │  ├─ messages.ts
│  │  │  ├─ static-scan.ts
│  │  │  ├─ url-pattern.ts
│  │  │  └─ infer-json-schema.ts
│  │  └─ tests/
│  │     ├─ infer-json-schema.test.ts
│  │     ├─ messages.test.ts
│  │     ├─ static-scan.test.ts
│  │     └─ url-pattern.test.ts
│  └─ extension/
│     ├─ package.json                 ← 含 "@aipagego/shared": "workspace:*"
│     ├─ tsconfig.json                ← 含 @/* 别名
│     ├─ vite.config.ts
│     ├─ tailwind.config.ts
│     ├─ postcss.config.js
│     ├─ src/
│     │  ├─ manifest.ts
│     │  ├─ background/               ← 现 src/background/ 原样迁
│     │  ├─ content/                  ← 现 src/content/ 原样迁
│     │  └─ sidepanel/                ← 现 src/sidepanel/ 原样迁
│     └─ tests/
│        ├─ setup.ts
│        ├─ manifest.test.ts
│        ├─ background/               ← 现 tests/background/ 原样迁
│        ├─ content/                  ← 现 tests/content/ 原样迁
│        └─ sidepanel/                ← 现 tests/sidepanel/ 原样迁
├─ .github/workflows/
│  └─ build-extension.yml             ← 改：cd dist → cd packages/extension/dist；版本读取路径
├─ AGENTS.md                          ← 改：目录树章节同步
└─ docs/                              ← 不动
```

**关键设计**：

1. `@aipagego/shared` 通过 `package.json#exports` 做子路径暴露：`@aipagego/shared/types`、`@aipagego/shared/messages` 等，与现有 `@/shared/types` 形如直接映射，codemod 是纯字符串替换
2. 扩展包内 `@/*` 别名保留（指向 `packages/extension/src/*`），扩展内部 import 完全不动
3. 不引入 TS project references（避免 `tsc -b` 复杂度），每包独立 `tsc --noEmit`
4. `@aipagego/shared` 以 **源码引用** 形式被扩展消费（exports 指向 `.ts`），不需要预 build；vite 通过 `@crxjs` 与 react 插件正常打包

---

## Task 1: pnpm workspace 骨架 + root scripts 转发

**Files:**
- Create: `pnpm-workspace.yaml`
- Modify: `package.json`（整体重写）

- [ ] **Step 1: 添加 `pnpm-workspace.yaml`**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: 重写根 `package.json` 为 workspace 编排器**

把 `package.json` 完整替换为：

```json
{
  "name": "aipagego-monorepo",
  "private": true,
  "version": "0.0.5",
  "description": "AIPageGo — AI 网页助手（侧边面板）monorepo root",
  "type": "module",
  "scripts": {
    "dev": "pnpm --filter @aipagego/extension dev",
    "build": "pnpm --filter @aipagego/extension build",
    "preview": "pnpm --filter @aipagego/extension preview",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "test:watch": "pnpm --filter @aipagego/extension test:watch"
  },
  "packageManager": "pnpm@9.0.0"
}
```

**注意**：`packageManager` 字段帮 corepack 锁版本；所有运行时 deps 与 devDeps 都搬到子包，root 不留任何 deps。

- [ ] **Step 3: 验证 workspace 元数据被 pnpm 识别（packages 还没建，install 应当无害）**

Run: `pnpm install`
Expected: 成功完成，`pnpm-lock.yaml` 重新生成；终端可能提示 "no projects matched the filters" 之类——这是因为 `packages/` 还是空的，是预期的。

- [ ] **Step 4: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml
git commit -m "feat(workspace): scaffold pnpm workspaces skeleton"
```

---

## Task 2: 创建 `@aipagego/shared` 包（镜像 src/shared）

镜像而非搬动——这样在 Task 3 codemod 完成前，原 `src/shared/` 仍服务现有扩展代码，typecheck / test / build 始终绿。

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/vitest.config.ts`
- Copy: `src/shared/*.ts` → `packages/shared/src/*.ts`
- Copy: `tests/shared/*.test.ts` → `packages/shared/tests/*.test.ts`

- [ ] **Step 1: 创建 `packages/shared/package.json`**

```json
{
  "name": "@aipagego/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./types": "./src/types.ts",
    "./messages": "./src/messages.ts",
    "./static-scan": "./src/static-scan.ts",
    "./url-pattern": "./src/url-pattern.ts",
    "./infer-json-schema": "./src/infer-json-schema.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: 创建 `packages/shared/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: 创建 `packages/shared/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
```

- [ ] **Step 4: 复制 shared 源码**

Run（请使用 `git mv` 不可，因为我们要保留原文件给现扩展继续用——用普通 cp）：

```bash
mkdir -p packages/shared/src packages/shared/tests
cp src/shared/types.ts packages/shared/src/types.ts
cp src/shared/messages.ts packages/shared/src/messages.ts
cp src/shared/static-scan.ts packages/shared/src/static-scan.ts
cp src/shared/url-pattern.ts packages/shared/src/url-pattern.ts
cp src/shared/infer-json-schema.ts packages/shared/src/infer-json-schema.ts
cp tests/shared/infer-json-schema.test.ts packages/shared/tests/infer-json-schema.test.ts
cp tests/shared/messages.test.ts packages/shared/tests/messages.test.ts
cp tests/shared/static-scan.test.ts packages/shared/tests/static-scan.test.ts
cp tests/shared/url-pattern.test.ts packages/shared/tests/url-pattern.test.ts
```

- [ ] **Step 5: 创建 `packages/shared/src/index.ts` 作为 barrel（可选但便于"裸包名"导入）**

```ts
export * from "./types";
export * from "./messages";
export * from "./static-scan";
export * from "./url-pattern";
export * from "./infer-json-schema";
```

如果某些文件里有同名导出冲突（例如 `Json` 在多个文件都声明），改成显式：

```ts
export type { Json, /* ...其他类型 */ } from "./types";
export { ToolSchema, /* ... */ } from "./messages";
// ... 其他模块继续
```

执行前先 grep 各文件的顶级 export 名，按命名空间显式列出而非 `*`，避免冲突。

- [ ] **Step 6: 检查 shared tests 是否有任何 `from "@/"` 或跨包路径**

Run: `grep -rE "from \"(@/|\\.\\./\\.\\./)" packages/shared`
Expected: 无输出（shared 应当只 import 自身相对路径）。如果有，把 `@/shared/X` 换成 `./X`，把 `../../shared/X` 换成 `./X`。

- [ ] **Step 7: 装依赖并跑 shared 包测试**

Run:
```bash
pnpm install
pnpm --filter @aipagego/shared typecheck
pnpm --filter @aipagego/shared test
```
Expected:
- `typecheck` 0 error
- `test` 全绿（应是 4 个 test 文件，~37 个测试，与现 `tests/shared/` 数量一致）

- [ ] **Step 8: Commit**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): add @aipagego/shared package mirroring src/shared"
```

---

## Task 3: Codemod `@/shared/*` → `@aipagego/shared/*` 并删除 `src/shared/`

此 task 让现扩展全量切到新 shared 包。完成后 `src/shared/` 与 `tests/shared/` 永久删除。

**Files:**
- Modify: 当前 80+ 处 `from "@/shared/..."` 引用，分布于 `src/` 与 `tests/`
- Modify: `package.json`（root 暂时还是单包形态，需要加 `@aipagego/shared` 作为本地依赖）
- Modify: `tsconfig.json`（暂保留 `@/*` 别名，无需改）
- Delete: `src/shared/`、`tests/shared/`

- [ ] **Step 1: 给 root `package.json` 加 `@aipagego/shared` 依赖**

注意：上一步已经把 root `package.json` 改成 monorepo 编排器了，没有 dependencies 字段。但现在扩展代码还在 `src/`，还没迁到 `packages/extension/`——扩展此刻是"用 root 的 node_modules + workspace 链接"在跑。所以需要在 root `package.json` 临时加一个 dep：

把 Task 1 写好的 root `package.json` 改为：

```json
{
  "name": "aipagego-monorepo",
  "private": true,
  "version": "0.0.5",
  "description": "AIPageGo — AI 网页助手（侧边面板）monorepo root",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run && pnpm -r --filter ./packages/* test",
    "test:watch": "vitest",
    "typecheck": "tsc -b --noEmit && pnpm -r --filter ./packages/* typecheck"
  },
  "packageManager": "pnpm@9.0.0",
  "dependencies": {
    "@aipagego/shared": "workspace:*",
    "idb": "^8.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zod": "^3.23.8",
    "zustand": "^4.5.7"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0-beta.27",
    "@types/chrome": "^0.0.270",
    "@types/node": "^25.6.2",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.20",
    "fake-indexeddb": "^6.0.0",
    "happy-dom": "^15.0.0",
    "postcss": "^8.4.41",
    "tailwindcss": "^3.4.10",
    "typescript": "^5.5.4",
    "vite": "^5.4.2",
    "vitest": "^2.0.5"
  }
}
```

这把全部 deps 恢复回 root（与 Task 1 之前一致），只多了 `@aipagego/shared: workspace:*`。Task 4 会再次把这些 deps 移到 `packages/extension`，但当下要它们留在 root 让 vite 能找到。

- [ ] **Step 2: 重新装依赖让 `@aipagego/shared` symlink 到 root node_modules**

Run: `pnpm install`
Expected: `node_modules/@aipagego/shared` 是指向 `packages/shared` 的 symlink。

Run: `ls -la node_modules/@aipagego/`
Expected: `shared -> ../../packages/shared`

- [ ] **Step 3: 写一个一次性 codemod 脚本**

Create `tools/codemod-shared-imports.mjs`:

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const files = execSync(
  `grep -rlE "from \\"@/shared" src tests`,
  { encoding: "utf8" }
).trim().split("\n").filter(Boolean);

let total = 0;
for (const file of files) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(/from "@\/shared\/([^"]+)"/g, 'from "@aipagego/shared/$1"');
  if (before !== after) {
    const diff = (before.match(/@\/shared\//g) || []).length;
    total += diff;
    writeFileSync(file, after);
    console.log(`  ${file}: ${diff} replacements`);
  }
}
console.log(`Total: ${total} replacements across ${files.length} files`);
```

- [ ] **Step 4: 跑 codemod**

Run: `node tools/codemod-shared-imports.mjs`
Expected: 输出每个文件的替换数；总数应当 ≈ 80（来自前期 grep）。

- [ ] **Step 5: 验证已无 `@/shared` 引用**

Run: `grep -rE "from \"@/shared" src tests || echo OK`
Expected: `OK`（无输出即通过）

- [ ] **Step 6: 删除原 `src/shared/` 与 `tests/shared/`**

Run:
```bash
git rm -r src/shared tests/shared
```

- [ ] **Step 7: 跑全部检查**

Run:
```bash
pnpm typecheck
pnpm test
pnpm build
```

Expected:
- typecheck 0 error
- test 全绿（注意 `test` 脚本里既跑 root 的 vitest，也通过 `pnpm -r` 把 shared 包的 vitest 也带跑——总测试数仍 168 左右，shared 那 37 个搬到 `@aipagego/shared` 包跑）
- build 产出 `dist/`，与改造前 byte-by-byte 不需要一致但应能加载（必要时 `chrome://extensions` 重 load）

- [ ] **Step 8: 删 codemod 临时脚本**

Run: `git rm tools/codemod-shared-imports.mjs`
（这是一次性脚本，commit 前清掉；如需复用历史，git log 可以找回）

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: migrate extension imports to @aipagego/shared

80 imports of @/shared/X rewritten to @aipagego/shared/X via codemod.
Old src/shared and tests/shared removed; tests now run inside the
shared package."
```

---

## Task 4: 把扩展整体迁到 `packages/extension/`

**Files:**
- Create: `packages/extension/package.json`
- Create: `packages/extension/tsconfig.json`
- Move: `vite.config.ts` → `packages/extension/vite.config.ts`
- Move: `tailwind.config.ts` → `packages/extension/tailwind.config.ts`
- Move: `postcss.config.js` → `packages/extension/postcss.config.js`
- Move: `src/{background,content,sidepanel,manifest.ts}` → `packages/extension/src/`
- Move: `tests/{background,content,sidepanel,manifest.test.ts,setup.ts}` → `packages/extension/tests/`
- Modify: root `package.json`（再次回到 monorepo 编排器形态，无 deps）
- Modify: root `tsconfig.json`（删除——不再需要）

- [ ] **Step 1: 创建 `packages/extension/package.json`**

```json
{
  "name": "@aipagego/extension",
  "version": "0.0.5",
  "private": true,
  "type": "module",
  "description": "AIPageGo — AI 网页助手（侧边面板）",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@aipagego/shared": "workspace:*",
    "idb": "^8.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zod": "^3.23.8",
    "zustand": "^4.5.7"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0-beta.27",
    "@types/chrome": "^0.0.270",
    "@types/node": "^25.6.2",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.20",
    "fake-indexeddb": "^6.0.0",
    "happy-dom": "^15.0.0",
    "postcss": "^8.4.41",
    "tailwindcss": "^3.4.10",
    "typescript": "^5.5.4",
    "vite": "^5.4.2",
    "vitest": "^2.0.5"
  }
}
```

注意 `version: "0.0.5"` 与现 root 一致——后续发版只 bump 这一处（CI 也读这一处）。

- [ ] **Step 2: 创建 `packages/extension/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "types": ["chrome", "vitest/globals", "node"],
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src", "tests", "vite.config.ts", "tailwind.config.ts"]
}
```

- [ ] **Step 3: 使用 `git mv` 整体迁移扩展源码与测试**

```bash
mkdir -p packages/extension/src packages/extension/tests

# 源码
git mv src/background packages/extension/src/background
git mv src/content packages/extension/src/content
git mv src/sidepanel packages/extension/src/sidepanel
git mv src/manifest.ts packages/extension/src/manifest.ts

# 测试
git mv tests/background packages/extension/tests/background
git mv tests/content packages/extension/tests/content 2>/dev/null || true
git mv tests/sidepanel packages/extension/tests/sidepanel
git mv tests/manifest.test.ts packages/extension/tests/manifest.test.ts
git mv tests/setup.ts packages/extension/tests/setup.ts

# 配置
git mv vite.config.ts packages/extension/vite.config.ts
git mv tailwind.config.ts packages/extension/tailwind.config.ts
git mv postcss.config.js packages/extension/postcss.config.js
```

注意：`tests/content` 可能不存在（如果当前没有 content-script 测试）——`|| true` 兜底。

- [ ] **Step 4: 修 manifest.ts 的 `../package.json` 路径**

`packages/extension/src/manifest.ts` 现在还引用 `from "../package.json"`，目前指向 `packages/extension/package.json`——刚好就是扩展自己的 package.json，路径无需改。验证：

Run: `head -3 packages/extension/src/manifest.ts`
Expected: `import pkg from "../package.json" with { type: "json" };` 保持不变。

- [ ] **Step 5: 修扩展 `vite.config.ts` 里的 manifest 引用与 alias**

打开 `packages/extension/vite.config.ts`，验证其内容并按需修改为：

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import path from "node:path";
import manifest from "./src/manifest";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") }
  },
  plugins: [react(), crx({ manifest })],
  server: { port: 5173, strictPort: true, hmr: { port: 5174 } },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"]
  }
});
```

（与原版完全一致——所有路径都是相对 `packages/extension/`，自然有效。）

- [ ] **Step 6: 把 root `package.json` 改回 workspace 编排器（去掉所有 deps）**

```json
{
  "name": "aipagego-monorepo",
  "private": true,
  "version": "0.0.5",
  "description": "AIPageGo — AI 网页助手（侧边面板）monorepo root",
  "type": "module",
  "scripts": {
    "dev": "pnpm --filter @aipagego/extension dev",
    "build": "pnpm --filter @aipagego/extension build",
    "preview": "pnpm --filter @aipagego/extension preview",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "test:watch": "pnpm --filter @aipagego/extension test:watch"
  },
  "packageManager": "pnpm@9.0.0"
}
```

- [ ] **Step 7: 删除 root `tsconfig.json`**

```bash
git rm tsconfig.json
```

每包各自的 tsconfig 已就位，root tsconfig 不再需要。`tsconfig.tsbuildinfo` 也是旧的 `tsc -b` 产物，可以删：

```bash
git rm -f tsconfig.tsbuildinfo 2>/dev/null || true
```

（如果 .gitignore 已经忽略它，git rm 会报"not in tree"，加 `|| true` 兜底。）

- [ ] **Step 8: 重新装依赖**

Run: `pnpm install`
Expected: `packages/extension/node_modules` 与 `node_modules` 各自就位；`packages/extension/node_modules/@aipagego/shared` symlink 到 `packages/shared`。

- [ ] **Step 9: 验证 typecheck、test、build 全绿**

Run:
```bash
pnpm typecheck
pnpm test
pnpm build
```

Expected:
- `typecheck`：shared 与 extension 各自 0 error（pnpm -r 串行/并行执行两包的 typecheck script）
- `test`：shared 37+ 测试 + extension 130+ 测试，总数与 Phase 0 前一致；全绿
- `build`：产物在 `packages/extension/dist/`（注意路径变化），包含 `manifest.json`

Run: `ls packages/extension/dist/manifest.json && cat packages/extension/dist/manifest.json | head -5`
Expected: 文件存在，version 显示 `0.0.5`。

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: move extension into packages/extension

All src/ and tests/ contents migrated under packages/extension/ via
git mv (history preserved). Root package.json becomes a thin pnpm
workspaces orchestrator; per-package tsconfigs replace the root one.
Extension version 0.0.5 now lives in packages/extension/package.json."
```

---

## Task 5: 更新 GitHub Actions 工作流

CI 现在跑 `pnpm typecheck && pnpm test && pnpm build`——这三个 root scripts 已经通过 `pnpm -r` / `pnpm --filter` 转发，命令本身不用改。需要改的是 **build artifact 的路径** 和 **版本读取来源**。

**Files:**
- Modify: `.github/workflows/build-extension.yml`

- [ ] **Step 1: 打开工作流并修改三处**

读取 `.github/workflows/build-extension.yml`，找到这几处改：

第一处（version 读取来源）：
```yaml
      - name: Read package version
        id: package
        run: |
          version=$(node -p "require('./package.json').version")
          echo "version=$version" >> "$GITHUB_OUTPUT"
          echo "zip_name=aipagego-$version.zip" >> "$GITHUB_OUTPUT"
```
改为：
```yaml
      - name: Read package version
        id: package
        run: |
          version=$(node -p "require('./packages/extension/package.json').version")
          echo "version=$version" >> "$GITHUB_OUTPUT"
          echo "zip_name=aipagego-$version.zip" >> "$GITHUB_OUTPUT"
```

第二处（zip 打包路径）：
```yaml
      - name: Package dist
        run: |
          cd dist
          zip -r "../${{ steps.package.outputs.zip_name }}" .
```
改为：
```yaml
      - name: Package dist
        run: |
          cd packages/extension/dist
          zip -r "${{ github.workspace }}/${{ steps.package.outputs.zip_name }}" .
```

第三处（artifact 上传路径）：检查 `path: ${{ steps.package.outputs.zip_name }}` 是否还指向 workspace 根目录。上面 zip 命令用了 `${{ github.workspace }}/${{ ...zip_name }}` 显式放回 workspace 根，所以 artifact 的 `path` 字段保持原样即可，不用改。

`Publish GitHub Release` 段里 `ZIP_NAME` env 也指向 workspace 根的 zip，配合 `gh release upload "$tag" "$ZIP_NAME"` 也保持原样。

- [ ] **Step 2: 整体校验工作流 yaml 合法**

Run: `cat .github/workflows/build-extension.yml | python3 -c "import yaml, sys; yaml.safe_load(sys.stdin)" && echo OK`
Expected: `OK`

（系统应当装了 `python3` + PyYAML；如果没有 PyYAML，改用 `yamllint` 或仅做语法 sanity 检查。）

- [ ] **Step 3: 本地模拟构建产物路径完整流程**

Run:
```bash
rm -rf packages/extension/dist
pnpm build
ls packages/extension/dist/manifest.json
cd packages/extension/dist && zip -r /tmp/aipagego-test.zip . && cd - && ls -la /tmp/aipagego-test.zip
unzip -l /tmp/aipagego-test.zip | head -20
```
Expected:
- `manifest.json` 在 zip 根目录
- zip 内文件结构与之前发版一致（顶层包含 manifest、html、js、css 等）

清理：`rm /tmp/aipagego-test.zip`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/build-extension.yml
git commit -m "ci: update build workflow for monorepo layout

Read version from packages/extension/package.json; zip from
packages/extension/dist into workspace root. Existing typecheck/test/
build commands now use pnpm -r transparently and need no change."
```

---

## Task 6: 更新 AGENTS.md 目录树章节

`AGENTS.md` 当前是给 AI 协作者的目录导航，老的 `src/` 树与现实不符。同步一下。

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: 读 AGENTS.md 当前的目录树章节**

Run: `head -100 AGENTS.md`
预期看到一段类似 README 末尾的 `src/` 目录树描述（具体行号视当前文件而定）。

- [ ] **Step 2: 把目录树章节替换为新结构**

在 AGENTS.md 里找到形如 ```src/├─ shared/...``` 的目录树块（或类似的 markdown 段落），整体替换为：

```
aipagego2/                              # pnpm workspaces monorepo（Phase 0 起）
├─ packages/
│  ├─ shared/                        # 纯函数 + 类型，给后续 coordinator/daemon/server 共享
│  │  ├─ src/                        # types / messages / static-scan / url-pattern / infer-json-schema
│  │  └─ tests/
│  └─ extension/                     # AIPageGo 浏览器扩展（现 19 工具 + sidepanel + LLM agent loop）
│     ├─ src/
│     │  ├─ background/              # Service Worker (IndexedDB / RPC / tab-watcher / scripting)
│     │  ├─ content/                 # Content script + 19 个内置工具
│     │  └─ sidepanel/               # React UI + zustand session store + LLM 客户端
│     ├─ tests/
│     ├─ vite.config.ts              # 含 @crxjs，build 产物在 packages/extension/dist
│     └─ tsconfig.json
└─ docs/superpowers/
   ├─ specs/                         # 设计文档
   └─ plans/                         # 实施计划（每个对应一份 spec）
```

并在该章节末尾追加一段说明：

```
## monorepo 开发常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 跑扩展开发模式（vite + HMR） |
| `pnpm build` | 产 `packages/extension/dist/` |
| `pnpm typecheck` | shared + extension 串跑 tsc --noEmit |
| `pnpm test` | shared + extension 串跑 vitest |
| `pnpm --filter @aipagego/shared test` | 只跑 shared 包测试 |
| `pnpm --filter @aipagego/extension test:watch` | 扩展测试 watch 模式 |
```

如果 AGENTS.md 还有其它处提到 `src/shared/`、`src/background/` 形如旧路径的，一并替换为 `packages/shared/src/` 与 `packages/extension/src/background/` 等。

- [ ] **Step 3: 验证 AGENTS.md 渲染**

Run: `grep -nE "^src/|src/shared|src/background|src/sidepanel|src/content" AGENTS.md`
Expected: 输出应当仅在引用文件路径、commit message 或代码示例的上下文中出现旧路径；如有"目录树"或"路径说明"还残留旧路径，继续修。

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs(agents): update directory tree for monorepo layout"
```

---

## Phase 0 收尾验证

完整跑一遍：

- [ ] **Step 1: 全套绿灯**

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Expected:
- typecheck: 0 error
- test: 168（或与改造前完全一致的数）个测试全绿，分布在两个包
- build: `packages/extension/dist/manifest.json` 存在，version `0.0.5`

- [ ] **Step 2: 手动加载验证（可选但推荐）**

打开 `chrome://extensions` → 取消加载旧 `dist/`（如有） → 「加载已解压的扩展程序」选 `packages/extension/dist/` → 点扩展图标打开 side panel → 输入"hi"看 LLM 是否照常工作。

- [ ] **Step 3: 删干净 root 残留**

Run:
```bash
ls src tests 2>/dev/null || echo "no leftover root src/tests"
ls vite.config.ts tailwind.config.ts postcss.config.js tsconfig.json 2>/dev/null || echo "no leftover root configs"
```
Expected: 两行都打印"no leftover"。

如果有残留，确认它们是否在某 task 漏删，补一个 `git rm` commit。

- [ ] **Step 4: 推送到远端**（取得用户同意后）

Phase 0 是一组重构 commit，建议**保留中间 commits**（每个 task 一个 commit），让历史可读。不要 squash。

```bash
git log --oneline -8        # 应该看到 6 个 Phase 0 commits
git push origin main        # 仅在用户同意后执行
```

---

## Self-Review Checklist

写完 plan 后核对：

- ✅ Spec 第 3 节"仓库布局"中 packages/shared 与 packages/extension 的位置、文件、子目录都被 Task 2 + Task 4 覆盖
- ✅ Spec 第 3 节"对现有代码的入侵面"——30 个 import 路径调整由 Task 3 的 codemod 完成（实际 80 处）
- ✅ Spec 第 7.4 节 Phase 0 三个子项（monorepo + extension 迁 + shared 独立 + CI 改并行）全部对应到 Task 1-5
- ✅ 无 TBD/TODO/"fill in"
- ✅ 文件路径精确（含 `packages/extension/src/manifest.ts`、`.github/workflows/build-extension.yml` 等）
- ✅ 命令带预期输出
- ✅ Phase 0 不创建 coordinator/daemon/server 包——Task 4 的 `packages/` 下只新增 `shared/` 与 `extension/`
