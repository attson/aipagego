# Plan 1: AI 采集器扩展 — 可执行骨架（无 AI）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个能装载到 Chromium 浏览器的扩展骨架，用户可以把**手写**的 Tool JSON 粘到侧边面板，在被注入的页面（如商品详情页）顺序执行所有 step，看到 JSON 输出，并保存为 IndexedDB 中的工具供下次重放。

**Architecture:** Manifest V3 扩展，三入口（service worker / content script / sidepanel）。侧边面板是唯一 UI，通过 typed RPC 与 service worker 通信；service worker 持有 IndexedDB 工具库；content script 在 isolated world 跑 Step Runner，按需通过 `chrome.scripting.executeScript({world:"MAIN"})` 注入 AI 生成的 JS（本计划仅留接口，不接 AI）。

**Tech Stack:** Vite 5 + @crxjs/vite-plugin、React 18 + TypeScript 5、Tailwind CSS 3、idb 8、zod 3、vitest + happy-dom + fake-indexeddb，pnpm。

---

## 文件结构（本计划范围）

```
aipagego2/
├─ package.json
├─ pnpm-lock.yaml
├─ tsconfig.json
├─ vite.config.ts
├─ tailwind.config.ts
├─ postcss.config.js
├─ src/
│  ├─ manifest.ts                         # 由 @crxjs 在构建时读取
│  ├─ shared/
│  │  ├─ types.ts                         # Tool / Step / RunRecord / JsonSchema 等
│  │  ├─ url-pattern.ts                   # glob → RegExp + 匹配
│  │  ├─ messages.ts                      # RPC zod schema (sidepanel ↔ BG ↔ content)
│  │  └─ result.ts                        # Result<T> 简单封装
│  ├─ background/
│  │  ├─ index.ts                         # SW 入口：注册 sidePanel、路由 RPC
│  │  ├─ rpc-handlers.ts                  # 各 RPC 方法实现
│  │  ├─ storage/
│  │  │  ├─ db.ts                         # IndexedDB schema (idb)
│  │  │  ├─ tools.ts                      # CRUD: tools + versions
│  │  │  ├─ runs.ts                       # CRUD: runs
│  │  │  └─ export-import.ts              # 序列化 / 合并 (导出 / 导入)
│  │  └─ http-proxy.ts                    # 后台跨域 fetch（默认 omit cookie）
│  ├─ content/
│  │  ├─ index.ts                         # CS 入口：监听 BG 消息 → 调 runner
│  │  ├─ runner.ts                        # Step Runner：顺序执行 + 变量绑定
│  │  ├─ ctx.ts                           # RunContext：变量绑定、日志
│  │  ├─ inject-main.ts                   # 通过 BG 转发 chrome.scripting MAIN 注入
│  │  └─ tools/
│  │     ├─ index.ts                      # tool 注册表
│  │     ├─ snapshot-dom.ts
│  │     ├─ query.ts                      # querySelector + querySelectorAll
│  │     ├─ extract-text.ts
│  │     ├─ extract-images.ts
│  │     ├─ scroll.ts
│  │     ├─ wait-for.ts
│  │     ├─ click.ts
│  │     ├─ read-storage.ts
│  │     └─ http-request.ts               # 通过 RPC 走 BG 的 http-proxy
│  └─ sidepanel/
│     ├─ index.html
│     ├─ main.tsx
│     ├─ index.css                        # Tailwind 入口
│     ├─ app.tsx                          # 路由：Tools / Run / Settings
│     ├─ rpc.ts                           # typed wrapper of chrome.runtime.sendMessage
│     ├─ pages/
│     │  ├─ run-page.tsx                  # 粘 Tool JSON → 在当前 tab 跑 → 看输出
│     │  ├─ tools-page.tsx                # 工具列表 / 删除 / 重放
│     │  ├─ tool-detail-page.tsx          # 步骤展开、版本切换
│     │  └─ settings-page.tsx             # 导出 / 导入 / 清空
│     └─ components/
│        ├─ json-editor.tsx
│        ├─ step-list.tsx
│        └─ result-view.tsx
└─ tests/
   ├─ setup.ts                            # vitest setup（fake-indexeddb 引入）
   ├─ shared/
   │  └─ url-pattern.test.ts
   ├─ background/
   │  └─ storage/
   │     ├─ tools.test.ts
   │     ├─ runs.test.ts
   │     └─ export-import.test.ts
   └─ content/
      ├─ runner.test.ts
      └─ tools/
         ├─ snapshot-dom.test.ts
         ├─ query.test.ts
         ├─ extract-text.test.ts
         ├─ extract-images.test.ts
         ├─ scroll.test.ts
         ├─ wait-for.test.ts
         ├─ click.test.ts
         └─ read-storage.test.ts
```

每个文件单一职责。`shared/` 不依赖 chrome / DOM / fetch，三个入口都能 import。`content/tools/` 一个工具一个文件，签名统一 `(args, ctx) => Promise<Json>`。

---

## Task 1: 初始化项目

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.npmrc`

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "aipagego2",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b --noEmit"
  },
  "dependencies": {
    "idb": "^8.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0-beta.27",
    "@types/chrome": "^0.0.270",
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

- [ ] **Step 2: 创建 `tsconfig.json`**

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
    "types": ["chrome", "vitest/globals"],
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src", "tests", "vite.config.ts", "tailwind.config.ts"]
}
```

- [ ] **Step 3: 创建 `.gitignore`**

```
node_modules
dist
.DS_Store
*.local
.vite
coverage
```

- [ ] **Step 4: 创建 `.npmrc`**

```
strict-peer-dependencies=false
```

- [ ] **Step 5: 安装依赖**

Run: `pnpm install`
Expected: 退出码 0；产出 `node_modules` 与 `pnpm-lock.yaml`

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json .gitignore .npmrc pnpm-lock.yaml
git commit -m "chore: initialize project with pnpm + typescript scaffolding"
```

---

## Task 2: Vite + Tailwind + 扩展构建配置

**Files:**
- Create: `vite.config.ts`
- Create: `src/manifest.ts`
- Create: `tailwind.config.ts`
- Create: `postcss.config.js`

- [ ] **Step 1: 创建 `src/manifest.ts`**

```ts
import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "aipagego2 — AI 网页采集器",
  description: "对话式 AI 采集 + 工具固化复用",
  version: pkg.version,
  action: { default_title: "aipagego2" },
  side_panel: { default_path: "src/sidepanel/index.html" },
  background: { service_worker: "src/background/index.ts", type: "module" },
  permissions: ["sidePanel", "storage", "scripting", "activeTab", "tabs"],
  host_permissions: [
    "http://*/*",
    "https://*/*"
  ],
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle"
    }
  ],
  web_accessible_resources: [
    { resources: ["src/sidepanel/index.html"], matches: ["<all_urls>"] }
  ]
});
```

- [ ] **Step 2: 创建 `vite.config.ts`**

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

- [ ] **Step 3: 创建 `tailwind.config.ts`**

```ts
import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx,html}"],
  theme: { extend: {} },
  plugins: []
} satisfies Config;
```

- [ ] **Step 4: 创建 `postcss.config.js`**

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {}
  }
};
```

- [ ] **Step 5: Commit**

```bash
git add vite.config.ts src/manifest.ts tailwind.config.ts postcss.config.js
git commit -m "chore: configure vite, crx plugin, and tailwind"
```

---

## Task 3: 最小可启动骨架（sidepanel "hello"）

**Files:**
- Create: `src/sidepanel/index.html`
- Create: `src/sidepanel/main.tsx`
- Create: `src/sidepanel/index.css`
- Create: `src/sidepanel/app.tsx`
- Create: `src/background/index.ts`
- Create: `src/content/index.ts`
- Create: `tests/setup.ts`

- [ ] **Step 1: 创建 `src/sidepanel/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>aipagego2</title>
  </head>
  <body class="bg-zinc-950 text-zinc-100 font-sans">
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: 创建 `src/sidepanel/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; }
body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
```

- [ ] **Step 3: 创建 `src/sidepanel/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 4: 创建 `src/sidepanel/app.tsx`**

```tsx
export function App() {
  return (
    <div className="p-4 text-sm">
      <h1 className="text-base font-semibold">aipagego2</h1>
      <p className="mt-2 text-zinc-400">扩展骨架已加载。</p>
    </div>
  );
}
```

- [ ] **Step 5: 创建 `src/background/index.ts`**

```ts
chrome.runtime.onInstalled.addListener(() => {
  console.info("[aipagego2] service worker installed");
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("[aipagego2] sidePanel setPanelBehavior", e));
```

- [ ] **Step 6: 创建 `src/content/index.ts`**

```ts
console.info("[aipagego2] content script loaded on", location.href);
```

- [ ] **Step 7: 创建 `tests/setup.ts`**

```ts
import "fake-indexeddb/auto";
```

- [ ] **Step 8: 构建一次确认能编译**

Run: `pnpm build`
Expected: 退出码 0；`dist/` 目录生成 `manifest.json`、`assets/` 等。

- [ ] **Step 9: Commit**

```bash
git add src tests/setup.ts
git commit -m "feat: minimal sidepanel + service worker + content script skeleton"
```

---

## Task 4: 共享类型 `shared/types.ts`

**Files:**
- Create: `src/shared/types.ts`

- [ ] **Step 1: 写入文件**

```ts
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [k: string]: Json };

export type JsonSchema = Json;

export type BuiltinTool =
  | "snapshotDOM"
  | "querySelector"
  | "querySelectorAll"
  | "extractImages"
  | "extractText"
  | "scroll"
  | "waitFor"
  | "click"
  | "httpRequest"
  | "readStorage";

export type Step =
  | { kind: "tool"; tool: BuiltinTool; args: Json; bindResultTo?: string; timeoutMs?: number }
  | { kind: "js"; source: string; bindResultTo?: string; timeoutMs?: number };

export type ToolVersion = {
  version: number;
  steps: Step[];
  outputSchema: JsonSchema;
  createdAt: number;
  note?: string;
};

export type Tool = {
  id: string;
  name: string;
  urlPatterns: string[];
  description: string;
  steps: Step[];
  outputSchema: JsonSchema;
  createdAt: number;
  updatedAt: number;
  versions: ToolVersion[];
  stats: { runs: number; lastRunAt?: number; lastRunOk?: boolean };
};

export type RunStepLogEntry = {
  stepIndex: number;
  input: Json;
  output: Json;
  ms: number;
  error?: string;
};

export type RunStatus = "pending-approval" | "running" | "ok" | "error" | "aborted";

export type RunRecord = {
  id: string;
  toolId: string | null;     // 临时手写工具运行时为 null
  toolVersion: number | null;
  url: string;
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  stepLog: RunStepLogEntry[];
  output?: Json;
};

export type ExportBundle = {
  schema: "aipagego.tools/v1";
  exportedAt: number;
  tools: Tool[];
};
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(shared): add core types (Tool, Step, RunRecord)"
```

---

## Task 5: URL 模式匹配 `shared/url-pattern.ts`

把 glob（`*`、`**`）翻译成 RegExp。`*` 不跨 `/`；`**` 跨 `/`。

**Files:**
- Create: `src/shared/url-pattern.ts`
- Create: `tests/shared/url-pattern.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/shared/url-pattern.test.ts
import { describe, expect, it } from "vitest";
import { compilePattern, matchesAny } from "@/shared/url-pattern";

describe("url-pattern", () => {
  it("compilePattern matches Shop goods page", () => {
    const re = compilePattern("https://shop.example.com/goods*.html");
    expect(re.test("https://shop.example.com/goods.html?id=1")).toBe(true);
    expect(re.test("https://shop.example.com/goods_detail.html")).toBe(true);
    expect(re.test("https://other.com/goods.html")).toBe(false);
  });

  it("single * does not cross /", () => {
    const re = compilePattern("https://example.com/*");
    expect(re.test("https://example.com/foo")).toBe(true);
    expect(re.test("https://example.com/foo/bar")).toBe(false);
  });

  it("double ** crosses /", () => {
    const re = compilePattern("https://example.com/**");
    expect(re.test("https://example.com/foo")).toBe(true);
    expect(re.test("https://example.com/foo/bar")).toBe(true);
  });

  it("matchesAny returns true if any pattern matches", () => {
    const url = "https://shop.example.com/goods.html";
    expect(matchesAny(url, ["https://other.com/*", "https://*.example.com/**"])).toBe(true);
    expect(matchesAny(url, ["https://other.com/*"])).toBe(false);
  });

  it("special regex chars are escaped", () => {
    const re = compilePattern("https://example.com/a.b+c?d=1");
    expect(re.test("https://example.com/a.b+c?d=1")).toBe(true);
    expect(re.test("https://example.com/aXb+cYd=1")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/shared/url-pattern.test.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 3: 实现**

```ts
// src/shared/url-pattern.ts
const SPECIAL = /[.+?^${}()|[\]\\]/g;
const PLACEHOLDER_DOUBLE = "";
const PLACEHOLDER_SINGLE = "";

export function compilePattern(pattern: string): RegExp {
  const replaced = pattern.replace(/\*\*/g, PLACEHOLDER_DOUBLE).replace(/\*/g, PLACEHOLDER_SINGLE);
  const escaped = replaced.replace(SPECIAL, "\\$&");
  const expanded = escaped.replace(new RegExp(PLACEHOLDER_DOUBLE, "g"), ".*").replace(
    new RegExp(PLACEHOLDER_SINGLE, "g"),
    "[^/]*"
  );
  return new RegExp(`^${expanded}$`);
}

export function matchesAny(url: string, patterns: string[]): boolean {
  return patterns.some((p) => compilePattern(p).test(url));
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/shared/url-pattern.test.ts`
Expected: 5 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/shared/url-pattern.ts tests/shared/url-pattern.test.ts
git commit -m "feat(shared): add glob url-pattern matcher with tests"
```

---

## Task 6: RPC 协议 `shared/messages.ts`

定义 sidepanel ↔ background 的消息 schema 与类型。

**Files:**
- Create: `src/shared/messages.ts`

- [ ] **Step 1: 写入文件**

```ts
import { z } from "zod";

export const StepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool"),
    tool: z.enum([
      "snapshotDOM",
      "querySelector",
      "querySelectorAll",
      "extractImages",
      "extractText",
      "scroll",
      "waitFor",
      "click",
      "httpRequest",
      "readStorage"
    ]),
    args: z.unknown(),
    bindResultTo: z.string().optional(),
    timeoutMs: z.number().int().positive().optional()
  }),
  z.object({
    kind: z.literal("js"),
    source: z.string(),
    bindResultTo: z.string().optional(),
    timeoutMs: z.number().int().positive().optional()
  })
]);

export const ToolDraftSchema = z.object({
  name: z.string().min(1),
  urlPatterns: z.array(z.string().min(1)).min(1),
  description: z.string().default(""),
  steps: z.array(StepSchema).min(1),
  outputSchema: z.unknown().default({})
});

export const RpcRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tools.list") }),
  z.object({ type: z.literal("tools.get"), id: z.string() }),
  z.object({ type: z.literal("tools.save"), draft: ToolDraftSchema }),
  z.object({ type: z.literal("tools.delete"), id: z.string() }),
  z.object({ type: z.literal("tools.matching"), url: z.string() }),
  z.object({ type: z.literal("tools.export") }),
  z.object({ type: z.literal("tools.import"), bundle: z.unknown() }),
  z.object({
    type: z.literal("runs.start"),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("draft"), draft: ToolDraftSchema }),
      z.object({ kind: z.literal("tool"), id: z.string() })
    ]),
    tabId: z.number()
  }),
  z.object({ type: z.literal("runs.list"), toolId: z.string().optional() }),
  z.object({ type: z.literal("runs.get"), id: z.string() }),
  z.object({
    type: z.literal("http.request"),
    url: z.string().url(),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
    withCredentials: z.boolean().default(false)
  }),
  z.object({
    type: z.literal("scripting.injectMain"),
    // tabId 可选：content 端 sendMessage 时不会带，BG 从 sender.tab.id 补全后再 dispatch
    tabId: z.number().optional(),
    source: z.string(),
    args: z.unknown()
  })
]);

export type RpcRequest = z.infer<typeof RpcRequest>;

export type RpcOk<T> = { ok: true; data: T };
export type RpcErr = { ok: false; error: string };
export type RpcResult<T> = RpcOk<T> | RpcErr;

// 从 background → content script 的消息（content 主动监听）
export const ContentRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("content.runStep"),
    step: StepSchema,
    bindings: z.record(z.unknown())
  })
]);
export type ContentRequest = z.infer<typeof ContentRequest>;
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/shared/messages.ts
git commit -m "feat(shared): add zod RPC schemas for sidepanel <-> bg <-> content"
```

---

## Task 7: IndexedDB 封装 `background/storage/db.ts`

**Files:**
- Create: `src/background/storage/db.ts`

- [ ] **Step 1: 写入文件**

```ts
import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { RunRecord, Tool } from "@/shared/types";

export interface aipagegoDB extends DBSchema {
  tools: {
    key: string;
    value: Tool;
    indexes: { byUpdatedAt: number };
  };
  runs: {
    key: string;
    value: RunRecord;
    indexes: { byToolId: string; byStartedAt: number };
  };
}

const DB_NAME = "aipagego";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<aipagegoDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<aipagegoDB>> {
  if (!dbPromise) {
    dbPromise = openDB<aipagegoDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const tools = db.createObjectStore("tools", { keyPath: "id" });
        tools.createIndex("byUpdatedAt", "updatedAt");
        const runs = db.createObjectStore("runs", { keyPath: "id" });
        runs.createIndex("byToolId", "toolId");
        runs.createIndex("byStartedAt", "startedAt");
      }
    });
  }
  return dbPromise;
}

export function _resetDBForTests() {
  dbPromise = null;
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/background/storage/db.ts
git commit -m "feat(storage): add idb schema for tools + runs"
```

---

## Task 8: 工具 CRUD `background/storage/tools.ts`

**Files:**
- Create: `src/background/storage/tools.ts`
- Create: `tests/background/storage/tools.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/background/storage/tools.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";
import {
  appendVersion,
  deleteTool,
  getTool,
  listTools,
  matchingTools,
  saveDraft
} from "@/background/storage/tools";
import type { Step } from "@/shared/types";

const sampleSteps: Step[] = [
  { kind: "tool", tool: "snapshotDOM", args: { maxDepth: 3 } }
];

describe("tools storage", () => {
  beforeEach(async () => {
    _resetDBForTests();
    indexedDB = new IDBFactory();
  });
  afterEach(async () => {
    _resetDBForTests();
  });

  it("saveDraft creates a tool with v1 + listTools returns it", async () => {
    const t = await saveDraft({
      name: "T1",
      urlPatterns: ["https://example.com/*"],
      description: "",
      steps: sampleSteps,
      outputSchema: {}
    });
    expect(t.id).toBeTruthy();
    expect(t.versions).toHaveLength(1);
    expect(t.versions[0].version).toBe(1);

    const list = await listTools();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("T1");
  });

  it("getTool returns the saved tool", async () => {
    const t = await saveDraft({
      name: "T2",
      urlPatterns: ["https://example.com/*"],
      description: "",
      steps: sampleSteps,
      outputSchema: {}
    });
    const got = await getTool(t.id);
    expect(got?.id).toBe(t.id);
  });

  it("appendVersion increments version and updates main steps", async () => {
    const t = await saveDraft({
      name: "T3",
      urlPatterns: ["https://example.com/*"],
      description: "",
      steps: sampleSteps,
      outputSchema: {}
    });
    const newSteps: Step[] = [
      { kind: "tool", tool: "extractText", args: { selector: "h1" } }
    ];
    const updated = await appendVersion(t.id, {
      steps: newSteps,
      outputSchema: {},
      note: "fix"
    });
    expect(updated.versions).toHaveLength(2);
    expect(updated.versions[1].version).toBe(2);
    expect(updated.steps).toEqual(newSteps);
  });

  it("matchingTools filters by URL pattern", async () => {
    await saveDraft({
      name: "电商平台",
      urlPatterns: ["https://*.example.com/**"],
      description: "",
      steps: sampleSteps,
      outputSchema: {}
    });
    await saveDraft({
      name: "TB",
      urlPatterns: ["https://*.taobao.com/**"],
      description: "",
      steps: sampleSteps,
      outputSchema: {}
    });
    const hits = await matchingTools("https://shop.example.com/goods.html");
    expect(hits.map((t) => t.name)).toEqual(["电商平台"]);
  });

  it("deleteTool removes the tool", async () => {
    const t = await saveDraft({
      name: "X",
      urlPatterns: ["https://example.com/*"],
      description: "",
      steps: sampleSteps,
      outputSchema: {}
    });
    await deleteTool(t.id);
    expect(await getTool(t.id)).toBeUndefined();
  });
});
```

注意：`indexedDB = new IDBFactory()` 是利用 `fake-indexeddb` 提供的全局重置；`tests/setup.ts` 已 import `fake-indexeddb/auto` 注入了 `IDBFactory`。

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/background/storage/tools.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// src/background/storage/tools.ts
import { matchesAny } from "@/shared/url-pattern";
import type { JsonSchema, Step, Tool } from "@/shared/types";
import { getDB } from "./db";

export type ToolDraft = {
  name: string;
  urlPatterns: string[];
  description: string;
  steps: Step[];
  outputSchema: JsonSchema;
};

function uuid(): string {
  return crypto.randomUUID();
}

export async function saveDraft(draft: ToolDraft): Promise<Tool> {
  const db = await getDB();
  const now = Date.now();
  const tool: Tool = {
    id: uuid(),
    name: draft.name,
    urlPatterns: draft.urlPatterns,
    description: draft.description,
    steps: draft.steps,
    outputSchema: draft.outputSchema,
    createdAt: now,
    updatedAt: now,
    versions: [
      { version: 1, steps: draft.steps, outputSchema: draft.outputSchema, createdAt: now }
    ],
    stats: { runs: 0 }
  };
  await db.put("tools", tool);
  return tool;
}

export async function appendVersion(
  id: string,
  patch: { steps: Step[]; outputSchema: JsonSchema; note?: string }
): Promise<Tool> {
  const db = await getDB();
  const tool = await db.get("tools", id);
  if (!tool) throw new Error(`tool ${id} not found`);
  const next = (tool.versions.at(-1)?.version ?? 0) + 1;
  const now = Date.now();
  const updated: Tool = {
    ...tool,
    steps: patch.steps,
    outputSchema: patch.outputSchema,
    updatedAt: now,
    versions: [
      ...tool.versions,
      {
        version: next,
        steps: patch.steps,
        outputSchema: patch.outputSchema,
        createdAt: now,
        note: patch.note
      }
    ]
  };
  await db.put("tools", updated);
  return updated;
}

export async function listTools(): Promise<Tool[]> {
  const db = await getDB();
  return db.getAll("tools");
}

export async function getTool(id: string): Promise<Tool | undefined> {
  const db = await getDB();
  return db.get("tools", id);
}

export async function deleteTool(id: string): Promise<void> {
  const db = await getDB();
  await db.delete("tools", id);
}

export async function matchingTools(url: string): Promise<Tool[]> {
  const all = await listTools();
  return all.filter((t) => matchesAny(url, t.urlPatterns));
}

export async function recordRunStat(id: string, ok: boolean): Promise<void> {
  const db = await getDB();
  const tool = await db.get("tools", id);
  if (!tool) return;
  tool.stats.runs += 1;
  tool.stats.lastRunAt = Date.now();
  tool.stats.lastRunOk = ok;
  await db.put("tools", tool);
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/background/storage/tools.test.ts`
Expected: 5 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/background/storage/tools.ts tests/background/storage/tools.test.ts
git commit -m "feat(storage): add tools CRUD with version history"
```

---

## Task 9: 运行记录 CRUD `background/storage/runs.ts`

**Files:**
- Create: `src/background/storage/runs.ts`
- Create: `tests/background/storage/runs.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/background/storage/runs.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";
import { createRun, finalizeRun, getRun, listRuns } from "@/background/storage/runs";

describe("runs storage", () => {
  beforeEach(() => {
    _resetDBForTests();
    indexedDB = new IDBFactory();
  });
  afterEach(() => {
    _resetDBForTests();
  });

  it("createRun then finalizeRun ok", async () => {
    const run = await createRun({ toolId: null, toolVersion: null, url: "u" });
    expect(run.status).toBe("running");
    const final = await finalizeRun(run.id, { status: "ok", output: { a: 1 } });
    expect(final.status).toBe("ok");
    expect(final.output).toEqual({ a: 1 });
    expect(final.finishedAt).toBeGreaterThanOrEqual(final.startedAt);
  });

  it("listRuns returns runs sorted desc by startedAt", async () => {
    const r1 = await createRun({ toolId: "t1", toolVersion: 1, url: "u1" });
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await createRun({ toolId: "t1", toolVersion: 1, url: "u2" });
    const list = await listRuns({ toolId: "t1" });
    expect(list[0].id).toBe(r2.id);
    expect(list[1].id).toBe(r1.id);
  });

  it("getRun returns saved run", async () => {
    const r = await createRun({ toolId: null, toolVersion: null, url: "u" });
    const got = await getRun(r.id);
    expect(got?.id).toBe(r.id);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/background/storage/runs.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/background/storage/runs.ts
import type { Json, RunRecord, RunStepLogEntry, RunStatus } from "@/shared/types";
import { getDB } from "./db";

export async function createRun(input: {
  toolId: string | null;
  toolVersion: number | null;
  url: string;
}): Promise<RunRecord> {
  const db = await getDB();
  const run: RunRecord = {
    id: crypto.randomUUID(),
    toolId: input.toolId,
    toolVersion: input.toolVersion,
    url: input.url,
    startedAt: Date.now(),
    status: "running",
    stepLog: []
  };
  await db.put("runs", run);
  return run;
}

export async function appendStepLog(id: string, entry: RunStepLogEntry): Promise<void> {
  const db = await getDB();
  const run = await db.get("runs", id);
  if (!run) throw new Error(`run ${id} not found`);
  run.stepLog.push(entry);
  await db.put("runs", run);
}

export async function finalizeRun(
  id: string,
  patch: { status: RunStatus; output?: Json }
): Promise<RunRecord> {
  const db = await getDB();
  const run = await db.get("runs", id);
  if (!run) throw new Error(`run ${id} not found`);
  run.status = patch.status;
  run.output = patch.output;
  run.finishedAt = Date.now();
  await db.put("runs", run);
  return run;
}

export async function getRun(id: string): Promise<RunRecord | undefined> {
  const db = await getDB();
  return db.get("runs", id);
}

export async function listRuns(filter?: { toolId?: string }): Promise<RunRecord[]> {
  const db = await getDB();
  const all = await db.getAll("runs");
  const filtered = filter?.toolId ? all.filter((r) => r.toolId === filter.toolId) : all;
  return filtered.sort((a, b) => b.startedAt - a.startedAt);
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/background/storage/runs.test.ts`
Expected: 3 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/background/storage/runs.ts tests/background/storage/runs.test.ts
git commit -m "feat(storage): add runs CRUD"
```

---

## Task 10: 导出 / 导入 `background/storage/export-import.ts`

**Files:**
- Create: `src/background/storage/export-import.ts`
- Create: `tests/background/storage/export-import.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/background/storage/export-import.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";
import { exportAll, importBundle } from "@/background/storage/export-import";
import { listTools, saveDraft } from "@/background/storage/tools";

describe("export-import", () => {
  beforeEach(() => {
    _resetDBForTests();
    indexedDB = new IDBFactory();
  });
  afterEach(() => _resetDBForTests());

  it("exportAll produces a valid bundle", async () => {
    const t = await saveDraft({
      name: "A",
      urlPatterns: ["https://example.com/*"],
      description: "",
      steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
      outputSchema: {}
    });
    const bundle = await exportAll();
    expect(bundle.schema).toBe("aipagego.tools/v1");
    expect(bundle.tools).toHaveLength(1);
    expect(bundle.tools[0].id).toBe(t.id);
  });

  it("importBundle merges tools by id (default skip)", async () => {
    const t = await saveDraft({
      name: "A",
      urlPatterns: ["https://example.com/*"],
      description: "",
      steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
      outputSchema: {}
    });
    const bundle = {
      schema: "aipagego.tools/v1" as const,
      exportedAt: Date.now(),
      tools: [{ ...t, name: "A-modified" }]
    };
    const result = await importBundle(bundle, { onConflict: "skip" });
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    const list = await listTools();
    expect(list[0].name).toBe("A");
  });

  it("importBundle overwrite replaces existing", async () => {
    const t = await saveDraft({
      name: "A",
      urlPatterns: ["https://example.com/*"],
      description: "",
      steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
      outputSchema: {}
    });
    const bundle = {
      schema: "aipagego.tools/v1" as const,
      exportedAt: Date.now(),
      tools: [{ ...t, name: "A-modified" }]
    };
    const result = await importBundle(bundle, { onConflict: "overwrite" });
    expect(result.imported).toBe(1);
    const list = await listTools();
    expect(list[0].name).toBe("A-modified");
  });

  it("importBundle copy creates a new id", async () => {
    const t = await saveDraft({
      name: "A",
      urlPatterns: ["https://example.com/*"],
      description: "",
      steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
      outputSchema: {}
    });
    const bundle = {
      schema: "aipagego.tools/v1" as const,
      exportedAt: Date.now(),
      tools: [{ ...t, name: "A-modified" }]
    };
    const result = await importBundle(bundle, { onConflict: "copy" });
    expect(result.imported).toBe(1);
    const list = await listTools();
    expect(list).toHaveLength(2);
    expect(list.find((x) => x.name === "A-modified")?.id).not.toBe(t.id);
  });

  it("importBundle rejects invalid schema", async () => {
    await expect(
      importBundle({ schema: "wrong", tools: [] } as unknown as Parameters<typeof importBundle>[0], { onConflict: "skip" })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/background/storage/export-import.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/background/storage/export-import.ts
import type { ExportBundle, Tool } from "@/shared/types";
import { getDB } from "./db";

export async function exportAll(): Promise<ExportBundle> {
  const db = await getDB();
  const tools = await db.getAll("tools");
  return { schema: "aipagego.tools/v1", exportedAt: Date.now(), tools };
}

export type ConflictPolicy = "skip" | "overwrite" | "copy";

export type ImportResult = {
  imported: number;
  skipped: number;
};

export async function importBundle(
  raw: ExportBundle,
  opts: { onConflict: ConflictPolicy }
): Promise<ImportResult> {
  if (!raw || raw.schema !== "aipagego.tools/v1" || !Array.isArray(raw.tools)) {
    throw new Error("invalid bundle: schema mismatch");
  }
  const db = await getDB();
  let imported = 0;
  let skipped = 0;
  for (const incoming of raw.tools as Tool[]) {
    if (!incoming.id) {
      skipped++;
      continue;
    }
    const existing = await db.get("tools", incoming.id);
    if (!existing) {
      await db.put("tools", incoming);
      imported++;
      continue;
    }
    if (opts.onConflict === "skip") {
      skipped++;
    } else if (opts.onConflict === "overwrite") {
      await db.put("tools", incoming);
      imported++;
    } else if (opts.onConflict === "copy") {
      await db.put("tools", { ...incoming, id: crypto.randomUUID() });
      imported++;
    }
  }
  return { imported, skipped };
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/background/storage/export-import.test.ts`
Expected: 5 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/background/storage/export-import.ts tests/background/storage/export-import.test.ts
git commit -m "feat(storage): add export/import with conflict policies"
```

---

## Task 11: Step Runner `content/runner.ts` 与 `content/ctx.ts`

Step Runner 顺序执行 step，维护变量绑定，命中超时则抛出。AI 生成的 JS（`kind: "js"`）通过注入接口由外部传入；本任务的 runner 只负责调度，注入实现在 Task 12。

**Files:**
- Create: `src/content/ctx.ts`
- Create: `src/content/runner.ts`
- Create: `tests/content/runner.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/runner.test.ts
import { describe, expect, it } from "vitest";
import { runSteps } from "@/content/runner";
import type { Step } from "@/shared/types";

describe("Step Runner", () => {
  it("runs tool steps in order and binds results", async () => {
    const steps: Step[] = [
      { kind: "tool", tool: "extractText", args: { selector: "x" }, bindResultTo: "title" },
      { kind: "tool", tool: "extractText", args: { selector: "${title}" } }
    ];
    const calls: { tool: string; args: unknown }[] = [];
    const result = await runSteps(steps, {
      runTool: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === "extractText") return "captured";
        return null;
      },
      runJs: async () => null
    });

    expect(result.status).toBe("ok");
    expect(calls).toEqual([
      { tool: "extractText", args: { selector: "x" } },
      { tool: "extractText", args: { selector: "captured" } }
    ]);
    expect(result.output).toBe("captured");
  });

  it("propagates tool error and stops", async () => {
    const steps: Step[] = [
      { kind: "tool", tool: "extractText", args: { selector: "x" } },
      { kind: "tool", tool: "extractText", args: { selector: "y" } }
    ];
    const calls: number[] = [];
    const result = await runSteps(steps, {
      runTool: async (_, __, idx) => {
        calls.push(idx);
        if (idx === 0) throw new Error("boom");
        return null;
      },
      runJs: async () => null
    });
    expect(result.status).toBe("error");
    expect(result.stepLog).toHaveLength(1);
    expect(result.stepLog[0].error).toContain("boom");
    expect(calls).toEqual([0]);
  });

  it("times out a long step", async () => {
    const steps: Step[] = [
      { kind: "tool", tool: "waitFor", args: { ms: 500 }, timeoutMs: 50 }
    ];
    const result = await runSteps(steps, {
      runTool: () => new Promise((res) => setTimeout(() => res(null), 500)),
      runJs: async () => null
    });
    expect(result.status).toBe("error");
    expect(result.stepLog[0].error).toMatch(/timeout/i);
  });

  it("substitutes ${var} in nested objects and arrays", async () => {
    const steps: Step[] = [
      { kind: "tool", tool: "extractText", args: { selector: "h1" }, bindResultTo: "t" },
      {
        kind: "tool",
        tool: "querySelectorAll",
        args: { selectors: ["${t}", { wrap: "${t}" }] }
      }
    ];
    let captured: unknown = null;
    await runSteps(steps, {
      runTool: async (_, args, idx) => {
        if (idx === 0) return "X";
        captured = args;
        return null;
      },
      runJs: async () => null
    });
    expect(captured).toEqual({ selectors: ["X", { wrap: "X" }] });
  });

  it("calls runJs for js steps", async () => {
    const steps: Step[] = [{ kind: "js", source: "return 1+1" }];
    const result = await runSteps(steps, {
      runTool: async () => null,
      runJs: async (src) => (src === "return 1+1" ? 2 : null)
    });
    expect(result.output).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/runner.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/content/ctx.ts`**

```ts
// src/content/ctx.ts
import type { Json } from "@/shared/types";

export class RunContext {
  private bindings: Record<string, Json> = {};

  set(name: string, value: Json) {
    this.bindings[name] = value;
  }

  snapshot(): Record<string, Json> {
    return { ...this.bindings };
  }

  resolve(value: unknown): Json {
    return resolveDeep(value, this.bindings) as Json;
  }
}

function resolveDeep(value: unknown, bindings: Record<string, Json>): unknown {
  if (typeof value === "string") return substitute(value, bindings);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, bindings));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveDeep(v, bindings);
    }
    return out;
  }
  return value;
}

function substitute(s: string, bindings: Record<string, Json>): unknown {
  // 整字符串就是 ${var} → 直接替换为对应值（保留类型）
  const exact = s.match(/^\$\{([^}]+)\}$/);
  if (exact) {
    const key = exact[1];
    return key in bindings ? bindings[key] : s;
  }
  // 否则做字符串模板替换
  return s.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const val = bindings[key];
    if (val == null) return "";
    return typeof val === "string" ? val : JSON.stringify(val);
  });
}
```

- [ ] **Step 4: 实现 `src/content/runner.ts`**

```ts
// src/content/runner.ts
import type { BuiltinTool, Json, RunStatus, RunStepLogEntry, Step } from "@/shared/types";
import { RunContext } from "./ctx";

export type RunnerHandlers = {
  runTool: (tool: BuiltinTool, args: Json, stepIndex: number) => Promise<Json>;
  runJs: (source: string, bindings: Record<string, Json>, stepIndex: number) => Promise<Json>;
};

export type RunResult = {
  status: RunStatus;
  output?: Json;
  stepLog: RunStepLogEntry[];
};

const DEFAULT_TIMEOUT = 10_000;

export async function runSteps(steps: Step[], handlers: RunnerHandlers): Promise<RunResult> {
  const ctx = new RunContext();
  const stepLog: RunStepLogEntry[] = [];
  let lastOutput: Json = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const start = Date.now();
    try {
      let resolvedInput: Json;
      let output: Json;
      if (step.kind === "tool") {
        resolvedInput = ctx.resolve(step.args);
        output = await withTimeout(
          handlers.runTool(step.tool, resolvedInput, i),
          step.timeoutMs ?? DEFAULT_TIMEOUT
        );
      } else {
        resolvedInput = step.source;
        output = await withTimeout(
          handlers.runJs(step.source, ctx.snapshot(), i),
          step.timeoutMs ?? DEFAULT_TIMEOUT
        );
      }
      stepLog.push({
        stepIndex: i,
        input: resolvedInput,
        output,
        ms: Date.now() - start
      });
      if (step.bindResultTo) ctx.set(step.bindResultTo, output);
      lastOutput = output;
    } catch (e) {
      stepLog.push({
        stepIndex: i,
        input: step.kind === "tool" ? (ctx.resolve(step.args) as Json) : step.source,
        output: null,
        ms: Date.now() - start,
        error: e instanceof Error ? e.message : String(e)
      });
      return { status: "error", stepLog };
    }
  }

  return { status: "ok", output: lastOutput, stepLog };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`step timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}
```

- [ ] **Step 5: 跑测试，确认全过**

Run: `pnpm test tests/content/runner.test.ts`
Expected: 5 个 test PASS。

- [ ] **Step 6: Commit**

```bash
git add src/content/ctx.ts src/content/runner.ts tests/content/runner.test.ts
git commit -m "feat(runner): step runner with variable bindings + timeouts"
```

---

## Task 12: 工具注册表 `content/tools/index.ts` + 第一个工具 `snapshot-dom.ts`

**Files:**
- Create: `src/content/tools/index.ts`
- Create: `src/content/tools/snapshot-dom.ts`
- Create: `tests/content/tools/snapshot-dom.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/snapshot-dom.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { snapshotDOM } from "@/content/tools/snapshot-dom";

describe("snapshotDOM", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="root">
        <h1 class="title">Hello</h1>
        <ul>
          <li>a</li>
          <li>b</li>
        </ul>
      </div>
    `;
  });

  it("returns a tree with tags, ids, classes and text", async () => {
    const result = (await snapshotDOM({ maxDepth: 4, root: "#root" })) as Record<string, unknown>;
    expect(result.tag).toBe("div");
    expect(result.id).toBe("root");
    const h1 = (result.children as Record<string, unknown>[])[0];
    expect(h1.tag).toBe("h1");
    expect(h1.classes).toEqual(["title"]);
    expect(h1.text).toBe("Hello");
  });

  it("respects maxDepth", async () => {
    const result = (await snapshotDOM({ maxDepth: 1, root: "#root" })) as Record<string, unknown>;
    const ul = (result.children as Record<string, unknown>[])[1];
    expect(ul.tag).toBe("ul");
    expect(ul.children).toBeUndefined(); // depth 截断
  });

  it("falls back to document if root selector misses", async () => {
    const result = await snapshotDOM({ maxDepth: 1, root: "#missing" });
    expect((result as Record<string, unknown>).tag).toBe("html");
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/snapshot-dom.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/content/tools/snapshot-dom.ts`**

```ts
// src/content/tools/snapshot-dom.ts
import type { Json } from "@/shared/types";

type Args = { maxDepth?: number; root?: string };

export async function snapshotDOM(args: Json): Promise<Json> {
  const { maxDepth = 3, root } = (args ?? {}) as Args;
  const rootEl = (root ? document.querySelector(root) : null) ?? document.documentElement;
  return summarize(rootEl, maxDepth);
}

function summarize(el: Element, depth: number): Json {
  const node: Record<string, Json> = { tag: el.tagName.toLowerCase() };
  if (el.id) node.id = el.id;
  const classList = Array.from(el.classList);
  if (classList.length) node.classes = classList;
  const direct = directText(el);
  if (direct) node.text = truncate(direct, 200);
  if (depth > 0 && el.children.length) {
    node.children = Array.from(el.children).map((c) => summarize(c, depth - 1));
  }
  return node;
}

function directText(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? "")
    .join(" ")
    .trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
```

- [ ] **Step 4: 实现 `src/content/tools/index.ts`**

```ts
// src/content/tools/index.ts
import type { BuiltinTool, Json } from "@/shared/types";
import { snapshotDOM } from "./snapshot-dom";

export type ToolFn = (args: Json) => Promise<Json>;

export const TOOLS: Partial<Record<BuiltinTool, ToolFn>> = {
  snapshotDOM
};

export async function callTool(name: BuiltinTool, args: Json): Promise<Json> {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`tool not implemented: ${name}`);
  return fn(args);
}
```

- [ ] **Step 5: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/snapshot-dom.test.ts`
Expected: 3 个 test PASS。

- [ ] **Step 6: Commit**

```bash
git add src/content/tools/index.ts src/content/tools/snapshot-dom.ts tests/content/tools/snapshot-dom.test.ts
git commit -m "feat(tools): snapshotDOM + tool registry"
```

---

## Task 13: 选择器工具 `query.ts`

**Files:**
- Create: `src/content/tools/query.ts`
- Modify: `src/content/tools/index.ts`
- Create: `tests/content/tools/query.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/query.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { querySelector, querySelectorAll } from "@/content/tools/query";

describe("query", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <ul><li class="x">a</li><li class="x">b</li><li class="y">c</li></ul>
    `;
  });

  it("querySelector returns first matched node summary", async () => {
    const r = (await querySelector({ selector: ".x" })) as Record<string, unknown>;
    expect(r.tag).toBe("li");
    expect(r.text).toBe("a");
  });

  it("querySelector returns null if none", async () => {
    const r = await querySelector({ selector: ".missing" });
    expect(r).toBeNull();
  });

  it("querySelectorAll returns array of summaries", async () => {
    const r = (await querySelectorAll({ selector: ".x" })) as Record<string, unknown>[];
    expect(r).toHaveLength(2);
    expect(r.map((n) => n.text)).toEqual(["a", "b"]);
  });

  it("querySelectorAll respects limit", async () => {
    const r = (await querySelectorAll({ selector: "li", limit: 2 })) as unknown[];
    expect(r).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/query.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/content/tools/query.ts`**

```ts
// src/content/tools/query.ts
import type { Json } from "@/shared/types";

type SingleArgs = { selector: string; root?: string };
type MultiArgs = { selector: string; root?: string; limit?: number };

function summarizeShallow(el: Element): Json {
  const node: Record<string, Json> = { tag: el.tagName.toLowerCase() };
  if (el.id) node.id = el.id;
  const classes = Array.from(el.classList);
  if (classes.length) node.classes = classes;
  const text = (el.textContent ?? "").trim();
  if (text) node.text = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  if (Object.keys(attrs).length) node.attrs = attrs;
  return node;
}

function rootOf(sel?: string): ParentNode {
  return (sel ? document.querySelector(sel) : null) ?? document;
}

export async function querySelector(args: Json): Promise<Json> {
  const { selector, root } = (args ?? {}) as SingleArgs;
  const el = rootOf(root).querySelector(selector);
  return el ? summarizeShallow(el) : null;
}

export async function querySelectorAll(args: Json): Promise<Json> {
  const { selector, root, limit } = (args ?? {}) as MultiArgs;
  const list = Array.from(rootOf(root).querySelectorAll(selector));
  const sliced = typeof limit === "number" ? list.slice(0, limit) : list;
  return sliced.map(summarizeShallow);
}
```

- [ ] **Step 4: 修改 `src/content/tools/index.ts`**

```ts
import type { BuiltinTool, Json } from "@/shared/types";
import { querySelector, querySelectorAll } from "./query";
import { snapshotDOM } from "./snapshot-dom";

export type ToolFn = (args: Json) => Promise<Json>;

export const TOOLS: Partial<Record<BuiltinTool, ToolFn>> = {
  snapshotDOM,
  querySelector,
  querySelectorAll
};

export async function callTool(name: BuiltinTool, args: Json): Promise<Json> {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`tool not implemented: ${name}`);
  return fn(args);
}
```

- [ ] **Step 5: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/query.test.ts`
Expected: 4 个 test PASS。

- [ ] **Step 6: Commit**

```bash
git add src/content/tools/query.ts src/content/tools/index.ts tests/content/tools/query.test.ts
git commit -m "feat(tools): querySelector / querySelectorAll"
```

---

## Task 14: 文本提取 `extract-text.ts`

**Files:**
- Create: `src/content/tools/extract-text.ts`
- Modify: `src/content/tools/index.ts`
- Create: `tests/content/tools/extract-text.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/extract-text.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { extractText } from "@/content/tools/extract-text";

describe("extractText", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <h1>标题</h1>
      <ul><li>a</li><li>b</li></ul>
    `;
  });

  it("returns single text when single=true", async () => {
    const r = await extractText({ selector: "h1", single: true });
    expect(r).toBe("标题");
  });

  it("returns array of texts by default", async () => {
    const r = await extractText({ selector: "li" });
    expect(r).toEqual(["a", "b"]);
  });

  it("returns null/[] when no match", async () => {
    expect(await extractText({ selector: ".x", single: true })).toBeNull();
    expect(await extractText({ selector: ".x" })).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/extract-text.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/content/tools/extract-text.ts`**

```ts
// src/content/tools/extract-text.ts
import type { Json } from "@/shared/types";

type Args = { selector: string; root?: string; single?: boolean };

export async function extractText(args: Json): Promise<Json> {
  const { selector, root, single } = (args ?? {}) as Args;
  const parent: ParentNode = (root ? document.querySelector(root) : null) ?? document;
  if (single) {
    const el = parent.querySelector(selector);
    return el ? (el.textContent ?? "").trim() : null;
  }
  return Array.from(parent.querySelectorAll(selector)).map((el) =>
    (el.textContent ?? "").trim()
  );
}
```

- [ ] **Step 4: 注册到 `src/content/tools/index.ts`**

```ts
import type { BuiltinTool, Json } from "@/shared/types";
import { extractText } from "./extract-text";
import { querySelector, querySelectorAll } from "./query";
import { snapshotDOM } from "./snapshot-dom";

export type ToolFn = (args: Json) => Promise<Json>;

export const TOOLS: Partial<Record<BuiltinTool, ToolFn>> = {
  snapshotDOM,
  querySelector,
  querySelectorAll,
  extractText
};

export async function callTool(name: BuiltinTool, args: Json): Promise<Json> {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`tool not implemented: ${name}`);
  return fn(args);
}
```

- [ ] **Step 5: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/extract-text.test.ts`
Expected: 3 个 test PASS。

- [ ] **Step 6: Commit**

```bash
git add src/content/tools/extract-text.ts src/content/tools/index.ts tests/content/tools/extract-text.test.ts
git commit -m "feat(tools): extractText"
```

---

## Task 15: 图片提取 `extract-images.ts`

考虑 `src` / `srcset` / `data-src` / `data-original` / 背景图。

**Files:**
- Create: `src/content/tools/extract-images.ts`
- Modify: `src/content/tools/index.ts`
- Create: `tests/content/tools/extract-images.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/extract-images.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { extractImages } from "@/content/tools/extract-images";

describe("extractImages", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <img src="/a.jpg" />
      <img data-src="/b.jpg" />
      <img srcset="/c-1x.jpg 1x, /c-2x.jpg 2x" />
      <div style="background-image:url('/d.jpg')"></div>
    `;
  });

  it("collects src + data-src + srcset", async () => {
    const r = (await extractImages({})) as { url: string; via: string }[];
    const urls = r.map((x) => x.url).sort();
    expect(urls).toContain(new URL("/a.jpg", location.href).href);
    expect(urls).toContain(new URL("/b.jpg", location.href).href);
    expect(urls).toContain(new URL("/c-1x.jpg", location.href).href);
    expect(urls).toContain(new URL("/c-2x.jpg", location.href).href);
  });

  it("collects background-image when includeBg=true", async () => {
    const r = (await extractImages({ includeBg: true })) as { url: string }[];
    const urls = r.map((x) => x.url);
    expect(urls).toContain(new URL("/d.jpg", location.href).href);
  });

  it("scopes to root selector", async () => {
    document.body.innerHTML = `
      <div id="a"><img src="/inA.jpg" /></div>
      <div id="b"><img src="/inB.jpg" /></div>
    `;
    const r = (await extractImages({ root: "#a" })) as { url: string }[];
    expect(r.map((x) => x.url)).toEqual([new URL("/inA.jpg", location.href).href]);
  });

  it("dedupes urls", async () => {
    document.body.innerHTML = `<img src="/a.jpg" /><img src="/a.jpg" />`;
    const r = (await extractImages({})) as { url: string }[];
    expect(r).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/extract-images.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/content/tools/extract-images.ts`**

```ts
// src/content/tools/extract-images.ts
import type { Json } from "@/shared/types";

type Args = { root?: string; includeBg?: boolean };
type ImageRef = { url: string; via: "src" | "data-src" | "data-original" | "srcset" | "bg" };

export async function extractImages(args: Json): Promise<Json> {
  const { root, includeBg = false } = (args ?? {}) as Args;
  const scope: ParentNode = (root ? document.querySelector(root) : null) ?? document;
  const seen = new Set<string>();
  const out: ImageRef[] = [];

  const push = (raw: string | null | undefined, via: ImageRef["via"]) => {
    if (!raw) return;
    let abs: string;
    try {
      abs = new URL(raw, location.href).href;
    } catch {
      return;
    }
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ url: abs, via });
  };

  for (const img of Array.from(scope.querySelectorAll<HTMLImageElement>("img"))) {
    push(img.getAttribute("src"), "src");
    push(img.getAttribute("data-src"), "data-src");
    push(img.getAttribute("data-original"), "data-original");
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      for (const part of srcset.split(",")) {
        const url = part.trim().split(/\s+/)[0];
        push(url, "srcset");
      }
    }
  }

  if (includeBg) {
    for (const el of Array.from(scope.querySelectorAll<HTMLElement>("[style*=background]"))) {
      const m = el.style.backgroundImage.match(/url\((['"]?)([^'")]+)\1\)/);
      if (m) push(m[2], "bg");
    }
  }

  return out as unknown as Json;
}
```

- [ ] **Step 4: 注册到 `src/content/tools/index.ts`**

```ts
import type { BuiltinTool, Json } from "@/shared/types";
import { extractImages } from "./extract-images";
import { extractText } from "./extract-text";
import { querySelector, querySelectorAll } from "./query";
import { snapshotDOM } from "./snapshot-dom";

export type ToolFn = (args: Json) => Promise<Json>;

export const TOOLS: Partial<Record<BuiltinTool, ToolFn>> = {
  snapshotDOM,
  querySelector,
  querySelectorAll,
  extractText,
  extractImages
};

export async function callTool(name: BuiltinTool, args: Json): Promise<Json> {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`tool not implemented: ${name}`);
  return fn(args);
}
```

- [ ] **Step 5: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/extract-images.test.ts`
Expected: 4 个 test PASS。

- [ ] **Step 6: Commit**

```bash
git add src/content/tools/extract-images.ts src/content/tools/index.ts tests/content/tools/extract-images.test.ts
git commit -m "feat(tools): extractImages with src/srcset/data-src/bg"
```

---

## Task 16: 滚动 `scroll.ts`

支持 `to: "bottom" | "top" | px`；可选 `untilSelector`（出现就停）；可选 `max` 次数。

**Files:**
- Create: `src/content/tools/scroll.ts`
- Modify: `src/content/tools/index.ts`
- Create: `tests/content/tools/scroll.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/scroll.test.ts
import { describe, expect, it, vi } from "vitest";
import { scroll } from "@/content/tools/scroll";

describe("scroll", () => {
  it("scrolls to a numeric y", async () => {
    let last = 0;
    vi.spyOn(window, "scrollTo").mockImplementation(((opts: ScrollToOptions) => {
      last = opts.top ?? 0;
    }) as typeof window.scrollTo);
    const r = await scroll({ to: 200 });
    expect(last).toBe(200);
    expect((r as Record<string, unknown>).iterations).toBe(1);
  });

  it("scrolls to bottom up to max iterations", async () => {
    let y = 0;
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      get: () => y + 1000
    });
    vi.spyOn(window, "scrollTo").mockImplementation(((opts: ScrollToOptions) => {
      y = opts.top ?? 0;
    }) as typeof window.scrollTo);
    const r = (await scroll({ to: "bottom", max: 3, intervalMs: 1 })) as Record<string, unknown>;
    expect(r.iterations).toBe(3);
  });

  it("stops when untilSelector appears", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation((() => {}) as typeof window.scrollTo);
    let appeared = false;
    vi.spyOn(document, "querySelector").mockImplementation(() =>
      appeared ? document.createElement("div") : null
    );
    setTimeout(() => {
      appeared = true;
    }, 5);
    const r = (await scroll({
      to: "bottom",
      max: 100,
      intervalMs: 1,
      untilSelector: ".loaded"
    })) as Record<string, unknown>;
    expect(r.iterations).toBeLessThan(100);
    expect(r.foundUntil).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/scroll.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/content/tools/scroll.ts`**

```ts
// src/content/tools/scroll.ts
import type { Json } from "@/shared/types";

type Args = {
  to: "bottom" | "top" | number;
  max?: number;
  intervalMs?: number;
  untilSelector?: string;
};

export async function scroll(args: Json): Promise<Json> {
  const { to, max = 1, intervalMs = 250, untilSelector } = (args ?? {}) as Args;
  let iterations = 0;
  let foundUntil = false;

  for (let i = 0; i < max; i++) {
    iterations++;
    if (typeof to === "number") {
      window.scrollTo({ top: to, behavior: "instant" as ScrollBehavior });
    } else if (to === "top") {
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    } else {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: "instant" as ScrollBehavior
      });
    }

    if (untilSelector && document.querySelector(untilSelector)) {
      foundUntil = true;
      break;
    }
    if (typeof to === "number" || to === "top") break;
    await sleep(intervalMs);
  }

  return { iterations, foundUntil };
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}
```

- [ ] **Step 4: 注册到 `src/content/tools/index.ts`**

```ts
import type { BuiltinTool, Json } from "@/shared/types";
import { extractImages } from "./extract-images";
import { extractText } from "./extract-text";
import { querySelector, querySelectorAll } from "./query";
import { scroll } from "./scroll";
import { snapshotDOM } from "./snapshot-dom";

export type ToolFn = (args: Json) => Promise<Json>;

export const TOOLS: Partial<Record<BuiltinTool, ToolFn>> = {
  snapshotDOM,
  querySelector,
  querySelectorAll,
  extractText,
  extractImages,
  scroll
};

export async function callTool(name: BuiltinTool, args: Json): Promise<Json> {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`tool not implemented: ${name}`);
  return fn(args);
}
```

- [ ] **Step 5: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/scroll.test.ts`
Expected: 3 个 test PASS。

- [ ] **Step 6: Commit**

```bash
git add src/content/tools/scroll.ts src/content/tools/index.ts tests/content/tools/scroll.test.ts
git commit -m "feat(tools): scroll with to/max/intervalMs/untilSelector"
```

---

## Task 17: 等待 `wait-for.ts`

`{ selector?, ms?, timeoutMs? }`：等到 selector 命中或固定 ms。

**Files:**
- Create: `src/content/tools/wait-for.ts`
- Modify: `src/content/tools/index.ts`
- Create: `tests/content/tools/wait-for.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/wait-for.test.ts
import { describe, expect, it } from "vitest";
import { waitFor } from "@/content/tools/wait-for";

describe("waitFor", () => {
  it("waits for fixed ms", async () => {
    const start = Date.now();
    const r = await waitFor({ ms: 30 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(28);
    expect((r as Record<string, unknown>).reason).toBe("ms");
  });

  it("returns when selector appears", async () => {
    setTimeout(() => {
      const d = document.createElement("div");
      d.className = "ready";
      document.body.appendChild(d);
    }, 20);
    const r = (await waitFor({ selector: ".ready", timeoutMs: 200 })) as Record<string, unknown>;
    expect(r.reason).toBe("selector");
  });

  it("times out if selector never appears", async () => {
    document.body.innerHTML = "";
    const r = (await waitFor({ selector: ".never", timeoutMs: 30 })) as Record<string, unknown>;
    expect(r.reason).toBe("timeout");
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/wait-for.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/content/tools/wait-for.ts`**

```ts
// src/content/tools/wait-for.ts
import type { Json } from "@/shared/types";

type Args = { ms?: number; selector?: string; timeoutMs?: number };

export async function waitFor(args: Json): Promise<Json> {
  const { ms, selector, timeoutMs = 5000 } = (args ?? {}) as Args;

  if (typeof ms === "number" && !selector) {
    await sleep(ms);
    return { reason: "ms" };
  }

  if (selector) {
    if (document.querySelector(selector)) return { reason: "selector" };
    return new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        if (document.querySelector(selector)) {
          obs.disconnect();
          clearTimeout(timer);
          resolve({ reason: "selector" });
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        obs.disconnect();
        resolve({ reason: "timeout" });
      }, timeoutMs);
    });
  }

  return { reason: "noop" };
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}
```

- [ ] **Step 4: 注册到 `src/content/tools/index.ts`**

```ts
import type { BuiltinTool, Json } from "@/shared/types";
import { extractImages } from "./extract-images";
import { extractText } from "./extract-text";
import { querySelector, querySelectorAll } from "./query";
import { scroll } from "./scroll";
import { snapshotDOM } from "./snapshot-dom";
import { waitFor } from "./wait-for";

export type ToolFn = (args: Json) => Promise<Json>;

export const TOOLS: Partial<Record<BuiltinTool, ToolFn>> = {
  snapshotDOM,
  querySelector,
  querySelectorAll,
  extractText,
  extractImages,
  scroll,
  waitFor
};

export async function callTool(name: BuiltinTool, args: Json): Promise<Json> {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`tool not implemented: ${name}`);
  return fn(args);
}
```

- [ ] **Step 5: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/wait-for.test.ts`
Expected: 3 个 test PASS。

- [ ] **Step 6: Commit**

```bash
git add src/content/tools/wait-for.ts src/content/tools/index.ts tests/content/tools/wait-for.test.ts
git commit -m "feat(tools): waitFor selector/ms with MutationObserver"
```

---

## Task 18: 点击 `click.ts`

**Files:**
- Create: `src/content/tools/click.ts`
- Modify: `src/content/tools/index.ts`
- Create: `tests/content/tools/click.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/click.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { click } from "@/content/tools/click";

describe("click", () => {
  beforeEach(() => {
    document.body.innerHTML = `<button id="b">x</button>`;
  });

  it("clicks the matching element", async () => {
    let clicked = false;
    document.querySelector("#b")!.addEventListener("click", () => {
      clicked = true;
    });
    const r = await click({ selector: "#b" });
    expect(clicked).toBe(true);
    expect((r as Record<string, unknown>).clicked).toBe(true);
  });

  it("returns clicked=false when selector misses (and required=false)", async () => {
    const r = await click({ selector: ".missing", required: false });
    expect((r as Record<string, unknown>).clicked).toBe(false);
  });

  it("throws when selector misses and required=true", async () => {
    await expect(click({ selector: ".missing", required: true })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/click.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/content/tools/click.ts`**

```ts
// src/content/tools/click.ts
import type { Json } from "@/shared/types";

type Args = { selector: string; required?: boolean };

export async function click(args: Json): Promise<Json> {
  const { selector, required = true } = (args ?? {}) as Args;
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) {
    if (required) throw new Error(`click: selector not found: ${selector}`);
    return { clicked: false };
  }
  el.click();
  return { clicked: true };
}
```

- [ ] **Step 4: 注册到 `src/content/tools/index.ts`**

```ts
import type { BuiltinTool, Json } from "@/shared/types";
import { click } from "./click";
import { extractImages } from "./extract-images";
import { extractText } from "./extract-text";
import { querySelector, querySelectorAll } from "./query";
import { scroll } from "./scroll";
import { snapshotDOM } from "./snapshot-dom";
import { waitFor } from "./wait-for";

export type ToolFn = (args: Json) => Promise<Json>;

export const TOOLS: Partial<Record<BuiltinTool, ToolFn>> = {
  snapshotDOM,
  querySelector,
  querySelectorAll,
  extractText,
  extractImages,
  scroll,
  waitFor,
  click
};

export async function callTool(name: BuiltinTool, args: Json): Promise<Json> {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`tool not implemented: ${name}`);
  return fn(args);
}
```

- [ ] **Step 5: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/click.test.ts`
Expected: 3 个 test PASS。

- [ ] **Step 6: Commit**

```bash
git add src/content/tools/click.ts src/content/tools/index.ts tests/content/tools/click.test.ts
git commit -m "feat(tools): click"
```

---

## Task 19: 存储读取 `read-storage.ts`

**Files:**
- Create: `src/content/tools/read-storage.ts`
- Modify: `src/content/tools/index.ts`
- Create: `tests/content/tools/read-storage.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/tools/read-storage.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { readStorage } from "@/content/tools/read-storage";

describe("readStorage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("reads localStorage by key", async () => {
    localStorage.setItem("u", "alice");
    const r = await readStorage({ store: "local", key: "u" });
    expect(r).toBe("alice");
  });

  it("reads sessionStorage by key", async () => {
    sessionStorage.setItem("t", "abc");
    expect(await readStorage({ store: "session", key: "t" })).toBe("abc");
  });

  it("returns null for missing key", async () => {
    expect(await readStorage({ store: "local", key: "missing" })).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/read-storage.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/content/tools/read-storage.ts`**

```ts
// src/content/tools/read-storage.ts
import type { Json } from "@/shared/types";

type Args = { store: "local" | "session"; key: string };

export async function readStorage(args: Json): Promise<Json> {
  const { store, key } = (args ?? {}) as Args;
  const s = store === "local" ? localStorage : sessionStorage;
  return s.getItem(key);
}
```

- [ ] **Step 4: 注册到 `src/content/tools/index.ts`**

```ts
import type { BuiltinTool, Json } from "@/shared/types";
import { click } from "./click";
import { extractImages } from "./extract-images";
import { extractText } from "./extract-text";
import { querySelector, querySelectorAll } from "./query";
import { readStorage } from "./read-storage";
import { scroll } from "./scroll";
import { snapshotDOM } from "./snapshot-dom";
import { waitFor } from "./wait-for";

export type ToolFn = (args: Json) => Promise<Json>;

export const TOOLS: Partial<Record<BuiltinTool, ToolFn>> = {
  snapshotDOM,
  querySelector,
  querySelectorAll,
  extractText,
  extractImages,
  scroll,
  waitFor,
  click,
  readStorage
};

export async function callTool(name: BuiltinTool, args: Json): Promise<Json> {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`tool not implemented: ${name}`);
  return fn(args);
}
```

- [ ] **Step 5: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/read-storage.test.ts`
Expected: 3 个 test PASS。

- [ ] **Step 6: Commit**

```bash
git add src/content/tools/read-storage.ts src/content/tools/index.ts tests/content/tools/read-storage.test.ts
git commit -m "feat(tools): readStorage (local/session)"
```

---

## Task 20: 后台 HTTP 代理 `background/http-proxy.ts`

提供 `httpRequest` 工具的后台实现：默认 `credentials: 'omit'`；明确 `withCredentials: true` 时改 `'include'`。

**Files:**
- Create: `src/background/http-proxy.ts`

- [ ] **Step 1: 写入文件**

```ts
// src/background/http-proxy.ts
import type { Json } from "@/shared/types";

export type HttpRequestInput = {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: string;
  withCredentials: boolean;
};

export type HttpRequestOutput = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export async function httpRequest(input: HttpRequestInput): Promise<HttpRequestOutput> {
  const res = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
    credentials: input.withCredentials ? "include" : "omit"
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, headers, body: await res.text() };
}

export function asJson(out: HttpRequestOutput): Json {
  return out as unknown as Json;
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/background/http-proxy.ts
git commit -m "feat(background): http-proxy with credentials control"
```

---

## Task 21: content 端 httpRequest 工具桥接

content 不能直接 fetch（cookie 域 + CORS），桥接到 BG。

**Files:**
- Create: `src/content/tools/http-request.ts`
- Modify: `src/content/tools/index.ts`

注：本任务的"测试"放到 Task 23（content/index 接入 BG 后做集成验证）；这里写一个直接 mock 的轻测，确保桥接函数会发出预期 RPC。

- Create: `tests/content/tools/http-request.test.ts`

- [ ] **Step 1: 写测试（mock chrome.runtime）**

```ts
// tests/content/tools/http-request.test.ts
import { describe, expect, it, vi } from "vitest";
import { httpRequestBridge } from "@/content/tools/http-request";

describe("httpRequest bridge", () => {
  it("forwards to background via chrome.runtime.sendMessage", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      data: { status: 200, headers: {}, body: "{\"ok\":true}" }
    });
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      runtime: { sendMessage }
    } as unknown as typeof chrome;

    const r = (await httpRequestBridge({
      url: "https://example.com/api",
      method: "GET"
    })) as Record<string, unknown>;

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "http.request",
        url: "https://example.com/api",
        method: "GET",
        withCredentials: false
      })
    );
    expect(r.status).toBe(200);
  });

  it("throws when bg returns ok:false", async () => {
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: false, error: "blocked" }) }
    } as unknown as typeof chrome;
    await expect(httpRequestBridge({ url: "https://x.com", method: "GET" })).rejects.toThrow(
      /blocked/
    );
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/content/tools/http-request.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/content/tools/http-request.ts`**

```ts
// src/content/tools/http-request.ts
import type { Json } from "@/shared/types";

type Args = {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: string;
  withCredentials?: boolean;
};

export async function httpRequestBridge(args: Json): Promise<Json> {
  const { url, method = "GET", headers, body, withCredentials = false } = (args ?? {}) as Args;
  const res = (await chrome.runtime.sendMessage({
    type: "http.request",
    url,
    method,
    headers,
    body,
    withCredentials
  })) as { ok: true; data: Json } | { ok: false; error: string };
  if (!res.ok) throw new Error(`httpRequest: ${res.error}`);
  return res.data;
}
```

- [ ] **Step 4: 注册到 `src/content/tools/index.ts`**

```ts
import type { BuiltinTool, Json } from "@/shared/types";
import { click } from "./click";
import { extractImages } from "./extract-images";
import { extractText } from "./extract-text";
import { httpRequestBridge } from "./http-request";
import { querySelector, querySelectorAll } from "./query";
import { readStorage } from "./read-storage";
import { scroll } from "./scroll";
import { snapshotDOM } from "./snapshot-dom";
import { waitFor } from "./wait-for";

export type ToolFn = (args: Json) => Promise<Json>;

export const TOOLS: Partial<Record<BuiltinTool, ToolFn>> = {
  snapshotDOM,
  querySelector,
  querySelectorAll,
  extractText,
  extractImages,
  scroll,
  waitFor,
  click,
  readStorage,
  httpRequest: httpRequestBridge
};

export async function callTool(name: BuiltinTool, args: Json): Promise<Json> {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`tool not implemented: ${name}`);
  return fn(args);
}
```

- [ ] **Step 5: 跑测试，确认全过**

Run: `pnpm test tests/content/tools/http-request.test.ts`
Expected: 2 个 test PASS。

- [ ] **Step 6: Commit**

```bash
git add src/content/tools/http-request.ts src/content/tools/index.ts tests/content/tools/http-request.test.ts
git commit -m "feat(tools): httpRequest bridge to background"
```

---

## Task 22: MAIN world 注入接口 `content/inject-main.ts`

content 不能直接调 `chrome.scripting`，必须通过 BG 中转。

**Files:**
- Create: `src/content/inject-main.ts`

- [ ] **Step 1: 写入文件**

```ts
// src/content/inject-main.ts
import type { Json } from "@/shared/types";

export async function injectMain(source: string, args: Json): Promise<Json> {
  const res = (await chrome.runtime.sendMessage({
    type: "scripting.injectMain",
    source,
    args
  })) as { ok: true; data: Json } | { ok: false; error: string };
  if (!res.ok) throw new Error(`injectMain: ${res.error}`);
  return res.data;
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/content/inject-main.ts
git commit -m "feat(content): main-world injection bridge"
```

---

## Task 23: content 入口 `content/index.ts`

监听 BG 推过来的 `content.runStep`，调本地 `callTool` 或 `injectMain`，返回结果。

**Files:**
- Modify: `src/content/index.ts`

- [ ] **Step 1: 写入文件**

```ts
// src/content/index.ts
import { ContentRequest } from "@/shared/messages";
import type { Json } from "@/shared/types";
import { injectMain } from "./inject-main";
import { callTool } from "./tools";

console.info("[aipagego2] content script loaded on", location.href);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const parsed = ContentRequest.safeParse(msg);
  if (!parsed.success) return false;
  handle(parsed.data)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true; // 异步回复
});

async function handle(req: import("@/shared/messages").ContentRequest): Promise<Json> {
  if (req.type === "content.runStep") {
    const { step, bindings } = req;
    if (step.kind === "tool") {
      return callTool(step.tool, resolve(step.args, bindings));
    }
    return injectMain(step.source, bindings as unknown as Json);
  }
  throw new Error(`unhandled content request: ${(req as { type: string }).type}`);
}

function resolve(value: unknown, bindings: Record<string, unknown>): Json {
  if (typeof value === "string") {
    const exact = value.match(/^\$\{([^}]+)\}$/);
    if (exact) {
      const key = exact[1];
      return (key in bindings ? bindings[key] : value) as Json;
    }
    return value.replace(/\$\{([^}]+)\}/g, (_, key) => {
      const v = bindings[key];
      if (v == null) return "";
      return typeof v === "string" ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, bindings));
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolve(v, bindings);
    }
    return out;
  }
  return value as Json;
}
```

- [ ] **Step 2: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/content/index.ts
git commit -m "feat(content): RPC dispatcher to local tools + main-world inject"
```

---

## Task 24: 后台 RPC 路由 `background/rpc-handlers.ts` + `index.ts`

**Files:**
- Create: `src/background/rpc-handlers.ts`
- Modify: `src/background/index.ts`

- [ ] **Step 1: 实现 `src/background/rpc-handlers.ts`**

```ts
// src/background/rpc-handlers.ts
import {
  ContentRequest as ContentRequestSchema,
  RpcRequest as RpcRequestSchema,
  type RpcRequest
} from "@/shared/messages";
import type { Json, RunRecord, Tool } from "@/shared/types";
import { httpRequest } from "./http-proxy";
import { exportAll, importBundle } from "./storage/export-import";
import { appendStepLog, createRun, finalizeRun, getRun, listRuns } from "./storage/runs";
import {
  deleteTool as deleteToolDb,
  getTool,
  listTools,
  matchingTools,
  recordRunStat,
  saveDraft
} from "./storage/tools";

export async function handleRpc(raw: unknown): Promise<{ ok: true; data: Json } | { ok: false; error: string }> {
  const parsed = RpcRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid request: " + parsed.error.message };
  try {
    const data = await dispatch(parsed.data);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function dispatch(req: RpcRequest): Promise<Json> {
  switch (req.type) {
    case "tools.list":
      return (await listTools()) as unknown as Json;
    case "tools.get":
      return ((await getTool(req.id)) ?? null) as unknown as Json;
    case "tools.save":
      return (await saveDraft({
        name: req.draft.name,
        urlPatterns: req.draft.urlPatterns,
        description: req.draft.description ?? "",
        steps: req.draft.steps as Tool["steps"],
        outputSchema: (req.draft.outputSchema ?? {}) as Json
      })) as unknown as Json;
    case "tools.delete":
      await deleteToolDb(req.id);
      return null;
    case "tools.matching":
      return (await matchingTools(req.url)) as unknown as Json;
    case "tools.export":
      return (await exportAll()) as unknown as Json;
    case "tools.import": {
      const result = await importBundle(req.bundle as Parameters<typeof importBundle>[0], {
        onConflict: "skip"
      });
      return result as unknown as Json;
    }
    case "runs.start":
      return runTool(req) as unknown as Json;
    case "runs.list":
      return (await listRuns({ toolId: req.toolId })) as unknown as Json;
    case "runs.get":
      return ((await getRun(req.id)) ?? null) as unknown as Json;
    case "http.request":
      return (await httpRequest({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        withCredentials: req.withCredentials
      })) as unknown as Json;
    case "scripting.injectMain": {
      if (req.tabId == null) throw new Error("scripting.injectMain: tabId missing");
      return injectMainWorld(req.tabId, req.source, req.args) as unknown as Json;
    }
  }
}

async function runTool(req: Extract<RpcRequest, { type: "runs.start" }>): Promise<RunRecord> {
  let steps: Tool["steps"];
  let toolId: string | null = null;
  let toolVersion: number | null = null;
  if (req.target.kind === "draft") {
    steps = req.target.draft.steps as Tool["steps"];
  } else {
    const tool = await getTool(req.target.id);
    if (!tool) throw new Error("tool not found");
    steps = tool.steps;
    toolId = tool.id;
    toolVersion = tool.versions.at(-1)?.version ?? 1;
  }

  const tab = await chrome.tabs.get(req.tabId);
  const url = tab.url ?? "";
  const run = await createRun({ toolId, toolVersion, url });

  const bindings: Record<string, Json> = {};
  let lastOutput: Json = null;

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const start = Date.now();
      const stepReq = ContentRequestSchema.parse({
        type: "content.runStep",
        step,
        bindings
      });
      const res = (await chrome.tabs.sendMessage(req.tabId, stepReq)) as
        | { ok: true; data: Json }
        | { ok: false; error: string };
      if (!res.ok) {
        await appendStepLog(run.id, {
          stepIndex: i,
          input: step.kind === "tool" ? (step.args as Json) : step.source,
          output: null,
          ms: Date.now() - start,
          error: res.error
        });
        await finalizeRun(run.id, { status: "error" });
        if (toolId) await recordRunStat(toolId, false);
        return (await getRun(run.id)) as RunRecord;
      }
      await appendStepLog(run.id, {
        stepIndex: i,
        input: step.kind === "tool" ? (step.args as Json) : step.source,
        output: res.data,
        ms: Date.now() - start
      });
      if (step.bindResultTo) bindings[step.bindResultTo] = res.data;
      lastOutput = res.data;
    }
    await finalizeRun(run.id, { status: "ok", output: lastOutput });
    if (toolId) await recordRunStat(toolId, true);
    return (await getRun(run.id)) as RunRecord;
  } catch (e) {
    await finalizeRun(run.id, { status: "error" });
    if (toolId) await recordRunStat(toolId, false);
    throw e;
  }
}

async function injectMainWorld(tabId: number, source: string, args: Json): Promise<Json> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [source, args],
    func: (src: string, a: unknown) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(
        "ctx",
        `"use strict"; return (async (ctx) => { ${src} })(ctx);`
      ) as (ctx: unknown) => Promise<unknown>;
      return fn(a);
    }
  });
  return (result ?? null) as Json;
}
```

- [ ] **Step 2: 修改 `src/background/index.ts`**

```ts
// src/background/index.ts
import { RpcRequest as RpcRequestSchema } from "@/shared/messages";
import { handleRpc } from "./rpc-handlers";

chrome.runtime.onInstalled.addListener(() => {
  console.info("[aipagego2] service worker installed");
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("[aipagego2] sidePanel setPanelBehavior", e));

// 处理来自 sidepanel 与 content 的所有 RPC 请求。
// content 发来的请求 sender.tab 非空（content 调 httpRequestBridge / injectMain
// 时也走这里），但请求 schema 已是 RpcRequest 的子集（http.request / scripting.injectMain）。
// 不属于 RpcRequest 的消息（例如 ContentRequest，会从 BG 通过 chrome.tabs.sendMessage
// 发给 content，sender 是 BG，不会进到这里）由各自的 listener 处理。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const parsed = RpcRequestSchema.safeParse(msg);
  if (!parsed.success) return false;

  // content 端调 scripting.injectMain 时不会自带 tabId，这里补上。
  let req: unknown = parsed.data;
  if (parsed.data.type === "scripting.injectMain" && sender.tab?.id != null) {
    req = { ...parsed.data, tabId: sender.tab.id };
  }

  handleRpc(req).then(sendResponse);
  return true;
});
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 退出码 0。

- [ ] **Step 4: Commit**

```bash
git add src/background/index.ts src/background/rpc-handlers.ts
git commit -m "feat(background): RPC dispatcher + run-tool orchestration"
```

---

## Task 25: sidepanel typed RPC `sidepanel/rpc.ts`

**Files:**
- Create: `src/sidepanel/rpc.ts`

- [ ] **Step 1: 写入文件**

```ts
// src/sidepanel/rpc.ts
import type { RpcRequest } from "@/shared/messages";
import type { ExportBundle, RunRecord, Tool } from "@/shared/types";

async function call<T>(req: RpcRequest): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as
    | { ok: true; data: T }
    | { ok: false; error: string };
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

export const rpc = {
  listTools: () => call<Tool[]>({ type: "tools.list" }),
  getTool: (id: string) => call<Tool | null>({ type: "tools.get", id }),
  saveTool: (draft: Extract<RpcRequest, { type: "tools.save" }>["draft"]) =>
    call<Tool>({ type: "tools.save", draft }),
  deleteTool: (id: string) => call<null>({ type: "tools.delete", id }),
  matchingTools: (url: string) => call<Tool[]>({ type: "tools.matching", url }),
  exportAll: () => call<ExportBundle>({ type: "tools.export" }),
  importBundle: (bundle: unknown) =>
    call<{ imported: number; skipped: number }>({ type: "tools.import", bundle }),
  runDraft: (
    draft: Extract<RpcRequest, { type: "tools.save" }>["draft"],
    tabId: number
  ) => call<RunRecord>({ type: "runs.start", target: { kind: "draft", draft }, tabId }),
  runTool: (id: string, tabId: number) =>
    call<RunRecord>({ type: "runs.start", target: { kind: "tool", id }, tabId }),
  listRuns: (toolId?: string) => call<RunRecord[]>({ type: "runs.list", toolId }),
  getRun: (id: string) => call<RunRecord | null>({ type: "runs.get", id })
};

export async function currentTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active tab");
  return tab.id;
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/rpc.ts
git commit -m "feat(sidepanel): typed RPC client"
```

---

## Task 26: sidepanel 应用骨架（路由）

简单的页面切换（不引入 react-router，使用本地状态）。

**Files:**
- Modify: `src/sidepanel/app.tsx`
- Create: `src/sidepanel/components/json-editor.tsx`
- Create: `src/sidepanel/components/result-view.tsx`
- Create: `src/sidepanel/components/step-list.tsx`

- [ ] **Step 1: 实现 `app.tsx`（先用占位页面，后续 task 填具体内容）**

```tsx
// src/sidepanel/app.tsx
import { useState } from "react";
import { RunPage } from "./pages/run-page";
import { SettingsPage } from "./pages/settings-page";
import { ToolDetailPage } from "./pages/tool-detail-page";
import { ToolsPage } from "./pages/tools-page";

type Route = { name: "run" } | { name: "tools" } | { name: "tool"; id: string } | { name: "settings" };

export function App() {
  const [route, setRoute] = useState<Route>({ name: "run" });

  return (
    <div className="h-full flex flex-col">
      <nav className="flex gap-1 p-2 border-b border-zinc-800 text-xs">
        <NavBtn active={route.name === "run"} onClick={() => setRoute({ name: "run" })}>
          运行
        </NavBtn>
        <NavBtn active={route.name === "tools" || route.name === "tool"} onClick={() => setRoute({ name: "tools" })}>
          工具库
        </NavBtn>
        <NavBtn active={route.name === "settings"} onClick={() => setRoute({ name: "settings" })}>
          设置
        </NavBtn>
      </nav>
      <main className="flex-1 overflow-auto">
        {route.name === "run" && <RunPage />}
        {route.name === "tools" && <ToolsPage onOpen={(id) => setRoute({ name: "tool", id })} />}
        {route.name === "tool" && (
          <ToolDetailPage id={route.id} onBack={() => setRoute({ name: "tools" })} />
        )}
        {route.name === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}

function NavBtn(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      className={
        "px-3 py-1 rounded " +
        (props.active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200")
      }
    >
      {props.children}
    </button>
  );
}
```

- [ ] **Step 2: 实现 `components/json-editor.tsx`**

```tsx
// src/sidepanel/components/json-editor.tsx
import { useState } from "react";

export function JsonEditor(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <textarea
        spellCheck={false}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => {
          props.onChange(e.target.value);
          try {
            if (e.target.value.trim()) JSON.parse(e.target.value);
            setErr(null);
          } catch (er) {
            setErr(er instanceof Error ? er.message : String(er));
          }
        }}
        className="w-full h-64 p-2 font-mono text-xs bg-zinc-900 text-zinc-100 rounded border border-zinc-800"
      />
      {err && <span className="text-red-400 text-xs">JSON parse: {err}</span>}
    </div>
  );
}
```

- [ ] **Step 3: 实现 `components/result-view.tsx`**

```tsx
// src/sidepanel/components/result-view.tsx
import type { RunRecord } from "@/shared/types";

export function ResultView(props: { run: RunRecord }) {
  const { run } = props;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-center gap-2">
        <StatusPill status={run.status} />
        <span className="text-zinc-400">{run.url}</span>
      </div>

      <details className="bg-zinc-900 rounded p-2">
        <summary className="cursor-pointer text-zinc-300">步骤日志（{run.stepLog.length}）</summary>
        <ol className="mt-2 space-y-2">
          {run.stepLog.map((s) => (
            <li key={s.stepIndex} className="border-l-2 border-zinc-700 pl-2">
              <div className="text-zinc-400">
                #{s.stepIndex} · {s.ms}ms {s.error && <span className="text-red-400">{s.error}</span>}
              </div>
              <pre className="text-[10px] text-zinc-300 overflow-auto">
                {JSON.stringify({ in: s.input, out: s.output }, null, 2)}
              </pre>
            </li>
          ))}
        </ol>
      </details>

      <details open className="bg-zinc-900 rounded p-2">
        <summary className="cursor-pointer text-zinc-300">最终输出</summary>
        <pre className="mt-2 text-[10px] text-zinc-300 overflow-auto">
          {JSON.stringify(run.output, null, 2)}
        </pre>
      </details>

      <button
        onClick={() => downloadJson(run.output, `aipagego-output-${run.id.slice(0, 8)}.json`)}
        className="self-start px-3 py-1 bg-emerald-700 rounded"
      >
        导出 output JSON
      </button>
    </div>
  );
}

function StatusPill({ status }: { status: RunRecord["status"] }) {
  const cls =
    status === "ok"
      ? "bg-emerald-700"
      : status === "error"
      ? "bg-red-700"
      : status === "running"
      ? "bg-amber-700"
      : "bg-zinc-700";
  return <span className={`px-2 py-0.5 rounded text-[10px] ${cls}`}>{status}</span>;
}

function downloadJson(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 4: 实现 `components/step-list.tsx`**

```tsx
// src/sidepanel/components/step-list.tsx
import type { Step } from "@/shared/types";

export function StepList(props: { steps: Step[] }) {
  return (
    <ol className="text-xs space-y-1">
      {props.steps.map((s, i) => (
        <li key={i} className="bg-zinc-900 rounded p-2">
          <div className="text-zinc-400">
            #{i} · {s.kind === "tool" ? `tool:${s.tool}` : "js"}
            {s.bindResultTo && <span> → ${s.bindResultTo}</span>}
          </div>
          <pre className="mt-1 text-[10px] text-zinc-300 overflow-auto">
            {JSON.stringify(s.kind === "tool" ? s.args : s.source, null, 2)}
          </pre>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 5: 类型检查**

`pages/*` 还没建，下个 task 建。先确保 `pnpm typecheck` 报的错只是缺这四个 page 文件。

Run: `pnpm typecheck`
Expected: 退出码非 0，错误来自 `app.tsx` 的四个 page 引用。继续 Task 27 修复。

- [ ] **Step 6: Commit（保留半完成的 app.tsx，让下个 task 接续）**

```bash
git add src/sidepanel/app.tsx src/sidepanel/components
git commit -m "feat(sidepanel): app shell + json editor / step list / result view"
```

---

## Task 27: 运行页 `pages/run-page.tsx`

把手写 JSON 跑一遍并展示结果。

**Files:**
- Create: `src/sidepanel/pages/run-page.tsx`

- [ ] **Step 1: 写入文件**

```tsx
// src/sidepanel/pages/run-page.tsx
import { useState } from "react";
import type { RunRecord } from "@/shared/types";
import { JsonEditor } from "../components/json-editor";
import { ResultView } from "../components/result-view";
import { currentTabId, rpc } from "../rpc";

const SAMPLE = JSON.stringify(
  {
    name: "新工具",
    urlPatterns: ["https://*.example.com/**"],
    description: "",
    steps: [
      { kind: "tool", tool: "snapshotDOM", args: { maxDepth: 3 } }
    ],
    outputSchema: {}
  },
  null,
  2
);

export function RunPage() {
  const [text, setText] = useState(SAMPLE);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setErr(null);
    setRun(null);
    let draft: unknown;
    try {
      draft = JSON.parse(text);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return;
    }
    setBusy(true);
    try {
      const tabId = await currentTabId();
      const r = await rpc.runDraft(draft as Parameters<typeof rpc.runDraft>[0], tabId);
      setRun(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!run) return;
    let draft: Parameters<typeof rpc.saveTool>[0];
    try {
      draft = JSON.parse(text);
    } catch {
      return;
    }
    const tool = await rpc.saveTool(draft);
    alert(`已保存为工具: ${tool.name} (${tool.id.slice(0, 8)})`);
  }

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="text-xs text-zinc-400">
        把一个 Tool 草案 JSON 粘下面，按"运行"在当前页执行。每个 step 不会经过审阅 —— 这是 Plan 1 的最简形态。
      </div>
      <JsonEditor value={text} onChange={setText} placeholder="paste a Tool JSON…" />
      <div className="flex gap-2">
        <button
          disabled={busy}
          onClick={go}
          className="px-3 py-1 rounded bg-emerald-700 disabled:opacity-50"
        >
          {busy ? "执行中…" : "运行"}
        </button>
        <button
          disabled={!run || run.status !== "ok"}
          onClick={save}
          className="px-3 py-1 rounded bg-zinc-700 disabled:opacity-50"
        >
          保存为工具
        </button>
      </div>
      {err && <div className="text-red-400 text-xs">{err}</div>}
      {run && <ResultView run={run} />}
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 仍报缺 `tools-page`、`tool-detail-page`、`settings-page`。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/pages/run-page.tsx
git commit -m "feat(sidepanel): run page (paste JSON + run + save)"
```

---

## Task 28: 工具列表 + 详情 + 设置页

**Files:**
- Create: `src/sidepanel/pages/tools-page.tsx`
- Create: `src/sidepanel/pages/tool-detail-page.tsx`
- Create: `src/sidepanel/pages/settings-page.tsx`

- [ ] **Step 1: 实现 `tools-page.tsx`**

```tsx
// src/sidepanel/pages/tools-page.tsx
import { useEffect, useState } from "react";
import type { Tool } from "@/shared/types";
import { rpc } from "../rpc";

export function ToolsPage(props: { onOpen: (id: string) => void }) {
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function reload() {
    try {
      setTools(await rpc.listTools());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    reload();
  }, []);

  if (err) return <div className="p-3 text-red-400 text-xs">{err}</div>;
  if (!tools) return <div className="p-3 text-zinc-400 text-xs">加载中…</div>;
  if (tools.length === 0)
    return <div className="p-3 text-zinc-400 text-xs">还没有工具，去"运行"页粘 JSON 跑一次后保存。</div>;

  return (
    <ul className="p-3 space-y-2 text-xs">
      {tools.map((t) => (
        <li key={t.id} className="bg-zinc-900 rounded p-2 flex items-start gap-2">
          <div className="flex-1">
            <div className="font-medium">{t.name}</div>
            <div className="text-zinc-400">{t.urlPatterns.join("  ·  ")}</div>
            <div className="text-zinc-500">
              v{t.versions.at(-1)?.version} · {t.steps.length} steps · runs {t.stats.runs}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <button onClick={() => props.onOpen(t.id)} className="px-2 py-0.5 bg-zinc-700 rounded">
              详情
            </button>
            <button
              onClick={async () => {
                if (!confirm(`删除「${t.name}」？`)) return;
                await rpc.deleteTool(t.id);
                reload();
              }}
              className="px-2 py-0.5 bg-red-800 rounded"
            >
              删除
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: 实现 `tool-detail-page.tsx`**

```tsx
// src/sidepanel/pages/tool-detail-page.tsx
import { useEffect, useState } from "react";
import type { RunRecord, Tool } from "@/shared/types";
import { ResultView } from "../components/result-view";
import { StepList } from "../components/step-list";
import { currentTabId, rpc } from "../rpc";

export function ToolDetailPage(props: { id: string; onBack: () => void }) {
  const [tool, setTool] = useState<Tool | null>(null);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    rpc.getTool(props.id).then(setTool).catch((e) => setErr(String(e)));
  }, [props.id]);

  async function go() {
    setBusy(true);
    setErr(null);
    setRun(null);
    try {
      const tabId = await currentTabId();
      setRun(await rpc.runTool(props.id, tabId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (err) return <div className="p-3 text-red-400 text-xs">{err}</div>;
  if (!tool) return <div className="p-3 text-zinc-400 text-xs">加载中…</div>;

  return (
    <div className="p-3 flex flex-col gap-3 text-xs">
      <button onClick={props.onBack} className="self-start text-zinc-400">
        ← 返回
      </button>
      <h2 className="text-base font-medium">{tool.name}</h2>
      <div className="text-zinc-400">{tool.urlPatterns.join(", ")}</div>
      <div>
        <button
          onClick={go}
          disabled={busy}
          className="px-3 py-1 bg-emerald-700 rounded disabled:opacity-50"
        >
          {busy ? "执行中…" : "在当前 tab 运行"}
        </button>
      </div>
      <h3 className="text-zinc-300 mt-2">步骤（v{tool.versions.at(-1)?.version}）</h3>
      <StepList steps={tool.steps} />
      {run && <ResultView run={run} />}
    </div>
  );
}
```

- [ ] **Step 3: 实现 `settings-page.tsx`**

```tsx
// src/sidepanel/pages/settings-page.tsx
import { useState } from "react";
import { rpc } from "../rpc";

export function SettingsPage() {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function doExport() {
    setMsg(null);
    setErr(null);
    try {
      const bundle = await rpc.exportAll();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `aipagego-tools-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg(`导出 ${bundle.tools.length} 个工具`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function doImport(file: File) {
    setMsg(null);
    setErr(null);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const r = await rpc.importBundle(bundle);
      setMsg(`已导入 ${r.imported} 个，跳过 ${r.skipped} 个`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="p-3 flex flex-col gap-3 text-xs">
      <h2 className="text-base font-medium">设置</h2>

      <section className="bg-zinc-900 rounded p-3 space-y-2">
        <h3 className="text-zinc-300">备份</h3>
        <div className="flex gap-2">
          <button onClick={doExport} className="px-3 py-1 bg-zinc-700 rounded">
            导出工具库 JSON
          </button>
          <label className="px-3 py-1 bg-zinc-700 rounded cursor-pointer">
            导入 JSON
            <input
              type="file"
              accept="application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) doImport(f);
              }}
            />
          </label>
        </div>
        <p className="text-zinc-500">
          导出 / 导入只包含 tools。API Key、运行记录不在内。冲突默认 skip。
        </p>
      </section>

      {msg && <div className="text-emerald-400">{msg}</div>}
      {err && <div className="text-red-400">{err}</div>}
    </div>
  );
}
```

- [ ] **Step 4: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/pages
git commit -m "feat(sidepanel): tools list + tool detail + settings (export/import)"
```

---

## Task 29: 装载说明 README

**Files:**
- Create: `README.md`

- [ ] **Step 1: 写入文件**

```markdown
# aipagego2 — AI 网页采集器（Plan 1：可执行骨架）

## 开发与装载

```bash
pnpm install
pnpm build           # 产出 dist/
```

1. 打开 chrome://extensions
2. 开启「开发者模式」
3. 点「加载已解压的扩展程序」选 dist/
4. 任意页面右上角点扩展图标 → 自动打开侧边面板

## 当前能力（Plan 1）

- 在「运行」页粘一个 Tool JSON → 一键在当前 tab 执行 step 列表 → 看到结果
- 成功后可保存为工具到 IndexedDB
- 「工具库」列出已保存的工具，可重放、删除
- 「设置」页可导出整个工具库为 JSON、从 JSON 导入

下一步（Plan 2）：接入 LLM，实现"自然语言 → AI 自动 tool-use → 人工逐步审阅"的对话式采集。

## 工具 JSON 示例

```json
{
  "name": "商品详情页采集器",
  "urlPatterns": ["https://*.example.com/**"],
  "description": "抓主图与标题",
  "steps": [
    {
      "kind": "tool",
      "tool": "extractText",
      "args": { "selector": "h1", "single": true },
      "bindResultTo": "title"
    },
    {
      "kind": "tool",
      "tool": "extractImages",
      "args": { "root": ".product-gallery" }
    }
  ],
  "outputSchema": {}
}
```

## 测试

```bash
pnpm test            # 一次跑完
pnpm test:watch      # 监听
```
```

- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "docs: add README with loading + sample tool JSON"
```

---

## Task 30: 全量回归

**Files:** 无（仅运行命令）

- [ ] **Step 1: 全量类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 2: 全量单元测试**

Run: `pnpm test`
Expected: 退出码 0。所有 test 文件 PASS：
- `tests/shared/url-pattern.test.ts` (5)
- `tests/background/storage/tools.test.ts` (5)
- `tests/background/storage/runs.test.ts` (3)
- `tests/background/storage/export-import.test.ts` (5)
- `tests/content/runner.test.ts` (5)
- `tests/content/tools/snapshot-dom.test.ts` (3)
- `tests/content/tools/query.test.ts` (4)
- `tests/content/tools/extract-text.test.ts` (3)
- `tests/content/tools/extract-images.test.ts` (4)
- `tests/content/tools/scroll.test.ts` (3)
- `tests/content/tools/wait-for.test.ts` (3)
- `tests/content/tools/click.test.ts` (3)
- `tests/content/tools/read-storage.test.ts` (3)
- `tests/content/tools/http-request.test.ts` (2)

合计 51 个 test。

- [ ] **Step 3: 构建**

Run: `pnpm build`
Expected: 退出码 0；`dist/manifest.json` 中包含 `side_panel`、`content_scripts`、`host_permissions`、`permissions: ["sidePanel","storage","scripting","activeTab","tabs"]`。

- [ ] **Step 4: 手测验证**

1. `chrome://extensions` 加载 `dist/`
2. 打开 https://shop.example.com/goods.html?xxx（任一商品页，登录与否都行）
3. 点扩展图标 → 侧边面板出现
4. 默认 RunPage 显示一个示例 Tool JSON（`snapshotDOM`），点「运行」
5. 期望：1-3 秒内看到 `status=ok` 与 DOM 摘要 JSON
6. 点「保存为工具」→「工具库」可看到该工具
7. 切到「设置」→ 「导出工具库 JSON」下载文件，打开包含一项

如有失败，记录哪一步、控制台报错（背景页 service worker / 侧边面板 / content）。失败不算 Plan 1 完成。

- [ ] **Step 5: 收尾 commit（如果验证中有小修补就一起带上；纯验证就跳过）**

```bash
# 通常无新文件；若有 fix:
# git add -A && git commit -m "fix: address regressions found in manual smoke"
echo "Plan 1 complete"
```

---

## 自检清单（Plan 1 完成后必须确认）

- [ ] 所有 51 个单元测试通过
- [ ] 类型检查通过
- [ ] dist 可装载、可在商品详情页跑出 snapshotDOM 输出
- [ ] 工具列表能保存、列出、运行、删除
- [ ] 导出/导入 JSON 正确合并
- [ ] 没有 `console.error` 抛出在 service worker（除非是用户主动触发的预期失败）

完成后即可开始 Plan 2（接入 LLM、tool-use 会话循环、step 卡片人工审阅）。
