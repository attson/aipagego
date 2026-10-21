# Plan 2: AI 对话与工具固化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Plan 1 的扩展骨架上接入 LLM（Anthropic + OpenAI）和 tool-use 会话循环，实现"用户输入自然语言 → AI 流式产出 tool_use → 每步人工审阅 → 失败回灌给 AI 重试 → 成功后保存为工具 → URL 命中时面板顶部 banner 推荐重放"的完整闭环。

**Architecture:** 会话循环全部住在 sidepanel React state；BG 仅做"原子操作"（runOneStep / chat.session.{start,appendLog,end} / tab-watcher）；LLM API 通过 fetch 流式直连，sidepanel 内 zustand 持有 ChatSession；runJS 通过纯函数静态扫描分级。

**Tech Stack:** 复用 Plan 1 的 Vite + React + TS + Tailwind + zod + idb；新增 zustand 4（轻量状态机），其余无新依赖。

---

## 文件结构（Plan 2 增量）

```
aipagego2/
├─ src/
│  ├─ manifest.ts                                # MOD: 加 host_permissions for LLM 域名 + webNavigation 权限
│  ├─ shared/
│  │  ├─ types.ts                                # MOD: ChatMessage, ToolUsePart, ToolResultPart, ScanFinding, Severity, LlmSettings
│  │  ├─ messages.ts                             # MOD: runs.runOneStep + chat.session.{start,appendLog,end}
│  │  ├─ static-scan.ts                          # NEW
│  │  └─ infer-json-schema.ts                    # NEW: 给 save dialog 用的极简 schema 推断
│  ├─ background/
│  │  ├─ index.ts                                # MOD: install tab-watcher
│  │  ├─ rpc-handlers.ts                         # MOD: 4 个 case
│  │  └─ tab-watcher.ts                          # NEW
│  └─ sidepanel/
│     ├─ rpc.ts                                  # MOD: 4 个 wrapper + tabs.recommendations 监听
│     ├─ app.tsx                                 # MOD: 默认 route → chat
│     ├─ llm/
│     │  ├─ types.ts                             # NEW
│     │  ├─ anthropic.ts                         # NEW
│     │  ├─ openai.ts                            # NEW
│     │  ├─ tool-schema.ts                       # NEW
│     │  ├─ system-prompt.ts                     # NEW
│     │  └─ client.ts                            # NEW
│     ├─ chat/
│     │  ├─ session-store.ts                     # NEW: zustand store
│     │  ├─ severity.ts                          # NEW
│     │  ├─ approval.ts                          # NEW
│     │  ├─ tool-runner.ts                       # NEW
│     │  ├─ run-session.ts                       # NEW
│     │  └─ settings-store.ts                    # NEW: provider/model/apiKey 持久化
│     ├─ pages/
│     │  ├─ chat-page.tsx                        # NEW
│     │  ├─ settings-page.tsx                    # MOD: 全部重写
│     │  ├─ tool-detail-page.tsx                 # MOD: "让 AI 修复" 入口
│     │  └─ run-page.tsx                         # MOD: 折叠成 DEV 入口提示文案
│     └─ components/
│        ├─ message-bubble.tsx                   # NEW
│        ├─ static-scan-badge.tsx                # NEW
│        ├─ step-card.tsx                        # NEW
│        ├─ chat-view.tsx                        # NEW
│        ├─ recommendations-banner.tsx           # NEW
│        ├─ status-bar.tsx                       # NEW
│        └─ save-as-tool-dialog.tsx              # NEW
└─ tests/
   ├─ shared/
   │  ├─ static-scan.test.ts                     # NEW
   │  └─ infer-json-schema.test.ts               # NEW
   ├─ background/
   │  └─ tab-watcher.test.ts                     # NEW
   └─ sidepanel/
      ├─ llm/
      │  ├─ anthropic-stream.test.ts             # NEW
      │  └─ openai-stream.test.ts                # NEW
      └─ chat/
         ├─ severity.test.ts                     # NEW
         └─ run-session.test.ts                  # NEW
```

每个文件单一职责。`shared/static-scan.ts` 与 `infer-json-schema.ts` 是纯函数，三入口可 import。`sidepanel/llm/*` 不依赖 chrome API，纯流解析。`sidepanel/chat/run-session.ts` 通过 DI 接 LlmClient + ToolRunner + Approver，单测可全 mock。

---

## Task 1: 加新依赖 zustand

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装**

Run: `pnpm add zustand@^4.5.5`
Expected: 退出码 0；`package.json` 出现 `"zustand": "^4.5.5"`。

- [ ] **Step 2: 类型检查不退化**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add zustand for sidepanel session state"
```

---

## Task 2: manifest 扩展（LLM 域 + webNavigation）

**Files:**
- Modify: `src/manifest.ts`

- [ ] **Step 1: 修改文件**

替换 `permissions` 与 `host_permissions` 段：

```ts
// 在 src/manifest.ts 中：
permissions: ["sidePanel", "storage", "scripting", "activeTab", "tabs", "webNavigation"],
host_permissions: [
  "http://*/*",
  "https://*/*"
],
```

- [ ] **Step 2: 构建验证**

Run: `pnpm build`
Expected: 退出码 0；`dist/manifest.json` 中 `permissions` 包含 `webNavigation`，`host_permissions` 包含两个 LLM 域名。

- [ ] **Step 3: Commit**

```bash
git add src/manifest.ts
git commit -m "chore(manifest): add webNavigation + LLM API host permissions"
```

---

## Task 3: shared/types.ts 增量类型

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: 在文件末尾追加**

```ts
// === Plan 2 additions ===

export type TextPart = { type: "text"; text: string };
export type ToolUsePart = { type: "tool_use"; id: string; name: string; input: Json };
export type ToolResultPart = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type ChatMessage =
  | { role: "user"; content: string | Array<TextPart | ToolResultPart> }
  | { role: "assistant"; content: Array<TextPart | ToolUsePart> };

export type Severity = "info" | "caution" | "dangerous";

export type ScanFinding = {
  rule: string;
  severity: Severity;
  message: string;
  matches: { line: number; col: number; text: string }[];
};

export type LlmProvider = "anthropic" | "openai";

export type LlmSettings = {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  apiKeyMode: "persistent" | "session";
  maxRounds: number;
};
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(shared): add chat message + scan + llm settings types"
```

---

## Task 4: shared/static-scan.ts + 单测

**Files:**
- Create: `src/shared/static-scan.ts`
- Create: `tests/shared/static-scan.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/shared/static-scan.test.ts
import { describe, expect, it } from "vitest";
import { highestSeverity, runStaticScan } from "@/shared/static-scan";

describe("runStaticScan", () => {
  it("returns empty for plain code", () => {
    expect(runStaticScan(`return document.title`)).toEqual([]);
  });

  it("flags document.cookie as dangerous", () => {
    const findings = runStaticScan(`return document.cookie`);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("uses-document-cookie");
    expect(findings[0].severity).toBe("dangerous");
    expect(findings[0].matches[0].line).toBe(1);
  });

  it("flags fetch as caution", () => {
    const findings = runStaticScan(`await fetch("/api")`);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("uses-fetch");
    expect(findings[0].severity).toBe("caution");
  });

  it("flags eval and new Function as dangerous", () => {
    const findings = runStaticScan(`eval(x); new Function("y")()`);
    expect(findings.map((f) => f.rule).sort()).toEqual([
      "uses-eval",
      "uses-new-function"
    ]);
  });

  it("flags chrome.* api access", () => {
    const findings = runStaticScan(`chrome.runtime.sendMessage({})`);
    expect(findings.some((f) => f.rule === "uses-chrome-api")).toBe(true);
  });

  it("flags localStorage and sessionStorage", () => {
    const findings = runStaticScan(`localStorage.getItem("k"); sessionStorage.setItem("k","v")`);
    expect(findings.filter((f) => f.rule === "uses-storage")).toHaveLength(1);
  });

  it("matches tracks line and column", () => {
    const src = `console.log("a");\nfetch("/api");\n`;
    const findings = runStaticScan(src);
    const fetchFinding = findings.find((f) => f.rule === "uses-fetch")!;
    expect(fetchFinding.matches[0].line).toBe(2);
    expect(fetchFinding.matches[0].col).toBe(1);
  });
});

describe("highestSeverity", () => {
  it("returns dangerous if any dangerous finding", () => {
    expect(
      highestSeverity([
        { rule: "x", severity: "caution", message: "", matches: [] },
        { rule: "y", severity: "dangerous", message: "", matches: [] }
      ])
    ).toBe("dangerous");
  });

  it("returns caution if only caution", () => {
    expect(
      highestSeverity([{ rule: "x", severity: "caution", message: "", matches: [] }])
    ).toBe("caution");
  });

  it("returns info for empty", () => {
    expect(highestSeverity([])).toBe("info");
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/shared/static-scan.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// src/shared/static-scan.ts
import type { ScanFinding, Severity } from "./types";

type Rule = {
  rule: string;
  severity: Severity;
  message: string;
  pattern: RegExp;
};

const RULES: Rule[] = [
  { rule: "uses-document-cookie", severity: "dangerous", message: "读取/写入 cookie",
    pattern: /\bdocument\s*\.\s*cookie\b/g },
  { rule: "uses-eval", severity: "dangerous", message: "eval() 执行动态代码",
    pattern: /\beval\s*\(/g },
  { rule: "uses-new-function", severity: "dangerous", message: "new Function 执行动态代码",
    pattern: /\bnew\s+Function\s*\(/g },
  { rule: "uses-chrome-api", severity: "dangerous", message: "尝试访问扩展 API",
    pattern: /\b(chrome|browser)\s*\.\s*[a-zA-Z_$]/g },
  { rule: "uses-fetch", severity: "caution", message: "发起网络请求 (fetch)",
    pattern: /\bfetch\s*\(/g },
  { rule: "uses-xhr", severity: "caution", message: "发起网络请求 (XMLHttpRequest)",
    pattern: /\bnew\s+XMLHttpRequest\b|\bXMLHttpRequest\s*\(/g },
  { rule: "uses-send-beacon", severity: "caution", message: "navigator.sendBeacon",
    pattern: /navigator\s*\.\s*sendBeacon\b/g },
  { rule: "uses-storage", severity: "caution", message: "读/写 localStorage / sessionStorage",
    pattern: /\b(local|session)Storage\b/g },
  { rule: "uses-indexed-db", severity: "caution", message: "读/写 IndexedDB",
    pattern: /\bindexedDB\b/g },
  { rule: "uses-mutation-observer", severity: "info", message: "MutationObserver",
    pattern: /\bMutationObserver\b/g }
];

export function runStaticScan(source: string): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const r of RULES) {
    const matches = collectMatches(source, r.pattern);
    if (matches.length > 0) {
      out.push({
        rule: r.rule,
        severity: r.severity,
        message: r.message,
        matches
      });
    }
  }
  return out;
}

export function highestSeverity(findings: ScanFinding[]): Severity {
  if (findings.some((f) => f.severity === "dangerous")) return "dangerous";
  if (findings.some((f) => f.severity === "caution")) return "caution";
  return "info";
}

function collectMatches(source: string, pattern: RegExp): ScanFinding["matches"] {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  const out: ScanFinding["matches"] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const { line, col } = locate(source, m.index);
    out.push({ line, col, text: m[0] });
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-length matches
  }
  return out;
}

function locate(source: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/shared/static-scan.test.ts`
Expected: 10 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/shared/static-scan.ts tests/shared/static-scan.test.ts
git commit -m "feat(shared): add runJS static scanner with severity rules"
```

---

## Task 5: shared/messages.ts 增量 RPC

**Files:**
- Modify: `src/shared/messages.ts`

- [ ] **Step 1: 在 `RpcRequest` 的 discriminatedUnion 数组里追加 4 条**

打开 `src/shared/messages.ts`，找到 `RpcRequest = z.discriminatedUnion(...)`，在最后一条 `scripting.injectMain` 之后、闭合数组之前追加：

```ts
  // chat session
  z.object({ type: z.literal("chat.session.start"), url: z.string() }),
  z.object({
    type: z.literal("chat.session.appendLog"),
    runId: z.string(),
    entry: z.object({
      stepIndex: z.number().int().min(0),
      input: z.unknown(),
      output: z.unknown(),
      ms: z.number().int().min(0),
      error: z.string().optional()
    })
  }),
  z.object({
    type: z.literal("chat.session.end"),
    runId: z.string(),
    status: z.enum(["ok", "error", "aborted"]),
    output: z.unknown().optional()
  }),

  // single step (for sidepanel-driven session loop)
  z.object({
    type: z.literal("runs.runOneStep"),
    step: StepSchema,
    tabId: z.number(),
    bindings: z.record(z.unknown()).default({})
  }),
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0（注意：BG handlers 还没处理这些新 type，但 schema 层 typecheck 不该有错）。

- [ ] **Step 3: Commit**

```bash
git add src/shared/messages.ts
git commit -m "feat(shared): add chat.session.* + runs.runOneStep RPC schemas"
```

---

## Task 6: shared/infer-json-schema.ts + 单测

**Files:**
- Create: `src/shared/infer-json-schema.ts`
- Create: `tests/shared/infer-json-schema.test.ts`

极简 JSON Schema 推断（给"保存为工具"对话框用），不追求完美。

- [ ] **Step 1: 写失败测试**

```ts
// tests/shared/infer-json-schema.test.ts
import { describe, expect, it } from "vitest";
import { inferJsonSchema } from "@/shared/infer-json-schema";

describe("inferJsonSchema", () => {
  it("primitives", () => {
    expect(inferJsonSchema(null)).toEqual({ type: "null" });
    expect(inferJsonSchema(true)).toEqual({ type: "boolean" });
    expect(inferJsonSchema(42)).toEqual({ type: "integer" });
    expect(inferJsonSchema(3.14)).toEqual({ type: "number" });
    expect(inferJsonSchema("hi")).toEqual({ type: "string" });
  });

  it("array of strings", () => {
    expect(inferJsonSchema(["a", "b"])).toEqual({
      type: "array",
      items: { type: "string" }
    });
  });

  it("empty array", () => {
    expect(inferJsonSchema([])).toEqual({ type: "array", items: {} });
  });

  it("object with mixed types", () => {
    expect(
      inferJsonSchema({ title: "x", count: 3, tags: ["a"] })
    ).toEqual({
      type: "object",
      properties: {
        title: { type: "string" },
        count: { type: "integer" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["title", "count", "tags"]
    });
  });

  it("array of mixed objects merges properties", () => {
    expect(
      inferJsonSchema([{ a: 1 }, { a: 2, b: "x" }])
    ).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: {
          a: { type: "integer" },
          b: { type: "string" }
        },
        required: ["a"]
      }
    });
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/shared/infer-json-schema.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/shared/infer-json-schema.ts
import type { Json, JsonSchema } from "./types";

export function inferJsonSchema(value: Json): JsonSchema {
  if (value === null) return { type: "null" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
  }
  if (typeof value === "string") return { type: "string" };
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array", items: {} };
    const items = mergeSchemas(value.map(inferJsonSchema));
    return { type: "array", items };
  }
  // object
  const properties: Record<string, JsonSchema> = {};
  const keys = Object.keys(value);
  for (const k of keys) {
    properties[k] = inferJsonSchema(value[k]);
  }
  return {
    type: "object",
    properties,
    required: keys
  };
}

function mergeSchemas(schemas: JsonSchema[]): JsonSchema {
  if (schemas.length === 0) return {};
  if (schemas.length === 1) return schemas[0];
  // 都是 object → 合并 properties，required 取交集
  const allObject = schemas.every((s) => isObject(s) && (s as Record<string, Json>).type === "object");
  if (allObject) {
    const merged: Record<string, JsonSchema> = {};
    let required: string[] | null = null;
    for (const s of schemas) {
      const props = (s as Record<string, Json>).properties as Record<string, JsonSchema> | undefined;
      const req = (s as Record<string, Json>).required as string[] | undefined;
      if (props) for (const [k, v] of Object.entries(props)) merged[k] = v;
      required = required === null ? (req ?? []).slice() : (req ? required.filter((k) => req.includes(k)) : []);
    }
    return { type: "object", properties: merged, required: required ?? [] };
  }
  // 不同类型 → 取第一个（极简版，不做 oneOf）
  return schemas[0];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/shared/infer-json-schema.test.ts`
Expected: 5 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/shared/infer-json-schema.ts tests/shared/infer-json-schema.test.ts
git commit -m "feat(shared): add minimal JSON schema inference for save dialog"
```

---

## Task 7: background/rpc-handlers.ts 处理新 RPC

**Files:**
- Modify: `src/background/rpc-handlers.ts`

- [ ] **Step 1: 在 imports 顶部追加**

```ts
import type { Step } from "@/shared/types";
```

- [ ] **Step 2: 在 `dispatch` 函数 switch 末尾、闭合 `}` 之前追加 4 个 case**

```ts
    case "chat.session.start": {
      const run = await createRun({ toolId: null, toolVersion: null, url: req.url });
      return run as unknown as Json;
    }
    case "chat.session.appendLog": {
      await appendStepLog(req.runId, {
        stepIndex: req.entry.stepIndex,
        input: req.entry.input as Json,
        output: req.entry.output as Json,
        ms: req.entry.ms,
        error: req.entry.error
      });
      return null;
    }
    case "chat.session.end": {
      const r = await finalizeRun(req.runId, {
        status: req.status,
        output: req.output as Json | undefined
      });
      return r as unknown as Json;
    }
    case "runs.runOneStep": {
      return (await runOneStep(req.step as Step, req.tabId, req.bindings as Record<string, Json>)) as unknown as Json;
    }
```

- [ ] **Step 3: 在文件末尾追加 `runOneStep` helper（在 `injectMainWorld` 之前或之后均可）**

```ts
async function runOneStep(
  step: Step,
  tabId: number,
  bindings: Record<string, Json>
): Promise<Json> {
  const stepReq = ContentRequestSchema.parse({
    type: "content.runStep",
    step,
    bindings
  });
  const res = (await chrome.tabs.sendMessage(tabId, stepReq)) as
    | { ok: true; data: Json }
    | { ok: false; error: string };
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
```

- [ ] **Step 4: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add src/background/rpc-handlers.ts
git commit -m "feat(background): handle chat.session.* + runs.runOneStep"
```

---

## Task 8: background/tab-watcher.ts + 单测

**Files:**
- Create: `src/background/tab-watcher.ts`
- Create: `tests/background/tab-watcher.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/background/tab-watcher.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";
import { saveDraft } from "@/background/storage/tools";
import { refreshRecommendations } from "@/background/tab-watcher";

const setBadgeText = vi.fn();
const setBadgeBackgroundColor = vi.fn();
const sendMessage = vi.fn().mockResolvedValue(undefined);

describe("tab-watcher", () => {
  beforeEach(() => {
    _resetDBForTests();
    indexedDB = new IDBFactory();
    setBadgeText.mockClear();
    setBadgeBackgroundColor.mockClear();
    sendMessage.mockClear();
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      action: { setBadgeText, setBadgeBackgroundColor },
      runtime: { sendMessage }
    } as unknown as typeof chrome;
  });

  afterEach(() => _resetDBForTests());

  it("sets badge text when matching tools exist", async () => {
    await saveDraft({
      name: "电商平台",
      urlPatterns: ["https://*.example.com/**"],
      description: "",
      steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
      outputSchema: {}
    });
    await refreshRecommendations(7, "https://shop.example.com/goods.html");
    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "1" });
    expect(setBadgeBackgroundColor).toHaveBeenCalled();
  });

  it("clears badge when no match", async () => {
    await refreshRecommendations(8, "https://other.com/");
    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 8, text: "" });
    expect(setBadgeBackgroundColor).not.toHaveBeenCalled();
  });

  it("broadcasts recommendations to sidepanel", async () => {
    await saveDraft({
      name: "电商平台",
      urlPatterns: ["https://*.example.com/**"],
      description: "",
      steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
      outputSchema: {}
    });
    const url = "https://shop.example.com/goods.html";
    await refreshRecommendations(9, url);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tabs.recommendations",
        tabId: 9,
        url,
        tools: expect.arrayContaining([expect.objectContaining({ name: "电商平台" })])
      })
    );
  });

  it("swallows sidepanel sendMessage rejection", async () => {
    sendMessage.mockRejectedValueOnce(new Error("no listeners"));
    await expect(refreshRecommendations(10, "https://other.com/")).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/background/tab-watcher.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// src/background/tab-watcher.ts
import { matchingTools } from "./storage/tools";

export async function refreshRecommendations(tabId: number, url: string): Promise<void> {
  const tools = await matchingTools(url);
  await chrome.action.setBadgeText({
    tabId,
    text: tools.length ? String(tools.length) : ""
  });
  if (tools.length) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#10b981" });
  }
  try {
    await chrome.runtime.sendMessage({
      type: "tabs.recommendations",
      tabId,
      url,
      tools
    });
  } catch {
    // sidepanel 不在听就 swallow
  }
}

export function installTabWatcher(): void {
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (!change.url) return;
    void refreshRecommendations(tabId, change.url);
  });
  chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, url }) => {
    void refreshRecommendations(tabId, url);
  });
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/background/tab-watcher.test.ts`
Expected: 4 个 test PASS。

- [ ] **Step 5: 在 `src/background/index.ts` 调用 installTabWatcher**

```ts
// src/background/index.ts (full file)
import { RpcRequest as RpcRequestSchema } from "@/shared/messages";
import { handleRpc } from "./rpc-handlers";
import { installTabWatcher } from "./tab-watcher";

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

installTabWatcher();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const parsed = RpcRequestSchema.safeParse(msg);
  if (!parsed.success) return false;

  let req: unknown = parsed.data;
  if (parsed.data.type === "scripting.injectMain" && sender.tab?.id != null) {
    req = { ...parsed.data, tabId: sender.tab.id };
  }

  handleRpc(req).then(sendResponse);
  return true;
});
```

- [ ] **Step 6: 全量构建**

Run: `pnpm build`
Expected: 退出码 0。

- [ ] **Step 7: Commit**

```bash
git add src/background/tab-watcher.ts src/background/index.ts tests/background/tab-watcher.test.ts
git commit -m "feat(background): add tab-watcher with badge + recommendations"
```

---

## Task 9: sidepanel/llm/types.ts

**Files:**
- Create: `src/sidepanel/llm/types.ts`

- [ ] **Step 1: 写入文件**

```ts
import type { ChatMessage, Json, JsonSchema } from "@/shared/types";

export type LlmTool = {
  name: string;
  description: string;
  input_schema: JsonSchema;
};

export type LlmStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; partial_json: string }
  | { type: "tool_use_end"; id: string; input: Json }
  | { type: "message_end"; usage?: { input_tokens: number; output_tokens: number } }
  | { type: "error"; error: string };

export interface LlmClient {
  stream(input: {
    apiKey: string;
    model: string;
    system: string;
    messages: ChatMessage[];
    tools: LlmTool[];
    maxTokens?: number;
    abortSignal?: AbortSignal;
  }): AsyncIterable<LlmStreamEvent>;
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/llm/types.ts
git commit -m "feat(llm): add LlmClient interface + stream event types"
```

---

## Task 10: sidepanel/llm/anthropic.ts + 流解析单测

**Files:**
- Create: `src/sidepanel/llm/anthropic.ts`
- Create: `tests/sidepanel/llm/anthropic-stream.test.ts`

Anthropic Messages API 的 SSE 用 `event:` + `data:`，每个 event 是 JSON。重要事件：
- `message_start` — 包含 message id
- `content_block_start` — `index`, `content_block: {type:"text"|"tool_use", id?, name?}`
- `content_block_delta` — `index`, `delta: {type:"text_delta", text} | {type:"input_json_delta", partial_json}`
- `content_block_stop` — `index`
- `message_delta` — `usage: {output_tokens}`, `delta: {stop_reason}`
- `message_stop`

我们要把这些翻译成 `LlmStreamEvent`。先把"流解析"做成纯函数（喂 raw chunks 字符串、yield 出 events），再让 `stream()` 包一层 fetch。

- [ ] **Step 1: 写失败测试（流解析纯函数）**

```ts
// tests/sidepanel/llm/anthropic-stream.test.ts
import { describe, expect, it } from "vitest";
import { parseAnthropicStream } from "@/sidepanel/llm/anthropic";
import type { LlmStreamEvent } from "@/sidepanel/llm/types";

async function collect(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

function chunksFrom(text: string) {
  return readableStreamFromString(text);
}

function readableStreamFromString(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      // 按 64 字节切片，模拟分片到达
      for (let i = 0; i < enc.length; i += 64) {
        c.enqueue(enc.subarray(i, Math.min(i + 64, enc.length)));
      }
      c.close();
    }
  });
}

describe("parseAnthropicStream", () => {
  it("emits text_delta and message_end on text-only response", async () => {
    const sse = [
      `event: message_start`,
      `data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":5,"output_tokens":0}}}`,
      ``,
      `event: content_block_start`,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      ``,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}`,
      ``,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}`,
      ``,
      `event: content_block_stop`,
      `data: {"type":"content_block_stop","index":0}`,
      ``,
      `event: message_delta`,
      `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}`,
      ``,
      `event: message_stop`,
      `data: {"type":"message_stop"}`,
      ``,
      ``
    ].join("\n");

    const events = await collect(parseAnthropicStream(chunksFrom(sse)));
    expect(events).toEqual([
      { type: "text_delta", text: "Hi" },
      { type: "text_delta", text: " there" },
      { type: "message_end", usage: { input_tokens: 5, output_tokens: 3 } }
    ]);
  });

  it("emits tool_use sequence with parsed input", async () => {
    const sse = [
      `event: message_start`,
      `data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":7,"output_tokens":0}}}`,
      ``,
      `event: content_block_start`,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"snapshotDOM","input":{}}}`,
      ``,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"max"}}`,
      ``,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"Depth\\":3}"}}`,
      ``,
      `event: content_block_stop`,
      `data: {"type":"content_block_stop","index":0}`,
      ``,
      `event: message_delta`,
      `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}`,
      ``,
      `event: message_stop`,
      `data: {"type":"message_stop"}`,
      ``,
      ``
    ].join("\n");

    const events = await collect(parseAnthropicStream(chunksFrom(sse)));
    expect(events).toEqual([
      { type: "tool_use_start", id: "t1", name: "snapshotDOM" },
      { type: "tool_use_input_delta", id: "t1", partial_json: "{\"max" },
      { type: "tool_use_input_delta", id: "t1", partial_json: "Depth\":3}" },
      { type: "tool_use_end", id: "t1", input: { maxDepth: 3 } },
      { type: "message_end", usage: { input_tokens: 7, output_tokens: 4 } }
    ]);
  });

  it("emits error event on malformed JSON in input", async () => {
    const sse = [
      `event: content_block_start`,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"x","input":{}}}`,
      ``,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{not json"}}`,
      ``,
      `event: content_block_stop`,
      `data: {"type":"content_block_stop","index":0}`,
      ``
    ].join("\n");

    const events = await collect(parseAnthropicStream(chunksFrom(sse)));
    expect(events.find((e) => e.type === "error")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/sidepanel/llm/anthropic-stream.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/sidepanel/llm/anthropic.ts`**

```ts
import type { ChatMessage, Json } from "@/shared/types";
import type { LlmClient, LlmStreamEvent, LlmTool } from "./types";

const ANTHROPIC_VERSION = "2023-06-01";

export async function* parseAnthropicStream(
  stream: ReadableStream<Uint8Array>
): AsyncIterable<LlmStreamEvent> {
  const blocks = new Map<
    number,
    { kind: "text" | "tool_use"; id?: string; name?: string; inputBuf: string }
  >();
  let usageInput = 0;
  let usageOutput = 0;

  for await (const event of readSseEvents(stream)) {
    if (!event.data) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.data);
    } catch {
      continue;
    }
    const type = payload.type as string;

    if (type === "message_start") {
      const msg = payload.message as { usage?: { input_tokens?: number } } | undefined;
      if (msg?.usage?.input_tokens != null) usageInput = msg.usage.input_tokens;
    } else if (type === "content_block_start") {
      const idx = payload.index as number;
      const cb = payload.content_block as {
        type: "text" | "tool_use";
        id?: string;
        name?: string;
      };
      blocks.set(idx, { kind: cb.type, id: cb.id, name: cb.name, inputBuf: "" });
      if (cb.type === "tool_use" && cb.id && cb.name) {
        yield { type: "tool_use_start", id: cb.id, name: cb.name };
      }
    } else if (type === "content_block_delta") {
      const idx = payload.index as number;
      const delta = payload.delta as { type: string; text?: string; partial_json?: string };
      const block = blocks.get(idx);
      if (!block) continue;
      if (delta.type === "text_delta" && delta.text != null) {
        yield { type: "text_delta", text: delta.text };
      } else if (delta.type === "input_json_delta" && delta.partial_json != null && block.id) {
        block.inputBuf += delta.partial_json;
        yield { type: "tool_use_input_delta", id: block.id, partial_json: delta.partial_json };
      }
    } else if (type === "content_block_stop") {
      const idx = payload.index as number;
      const block = blocks.get(idx);
      if (!block) continue;
      if (block.kind === "tool_use" && block.id) {
        let input: Json;
        try {
          input = block.inputBuf ? (JSON.parse(block.inputBuf) as Json) : ({} as Json);
        } catch (e) {
          yield {
            type: "error",
            error: `tool_use ${block.id} input JSON parse failed: ${
              e instanceof Error ? e.message : String(e)
            }`
          };
          blocks.delete(idx);
          continue;
        }
        yield { type: "tool_use_end", id: block.id, input };
      }
      blocks.delete(idx);
    } else if (type === "message_delta") {
      const usage = payload.usage as { output_tokens?: number } | undefined;
      if (usage?.output_tokens != null) usageOutput = usage.output_tokens;
    } else if (type === "message_stop") {
      yield {
        type: "message_end",
        usage: { input_tokens: usageInput, output_tokens: usageOutput }
      };
    }
  }
}

type SseEvent = { event?: string; data?: string };

async function* readSseEvents(stream: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    if (done) break;
    let nl = buf.indexOf("\n\n");
    while (nl >= 0) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      yield parseSseEvent(raw);
      nl = buf.indexOf("\n\n");
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield parseSseEvent(buf);
}

function parseSseEvent(raw: string): SseEvent {
  const out: SseEvent = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) out.event = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const piece = line.slice(5).trimStart();
      out.data = (out.data ?? "") + piece;
    }
  }
  return out;
}

export const anthropicClient: LlmClient = {
  async *stream(input) {
    const body = {
      model: input.model,
      max_tokens: input.maxTokens ?? 4096,
      system: input.system,
      messages: input.messages,
      tools: input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema
      })),
      stream: true
    };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(body),
      signal: input.abortSignal
    });
    if (!res.ok) {
      yield {
        type: "error",
        error: `Anthropic ${res.status}: ${await res.text().catch(() => "<no body>")}`
      };
      return;
    }
    if (!res.body) {
      yield { type: "error", error: "Anthropic: empty body" };
      return;
    }
    yield* parseAnthropicStream(res.body);
  }
};

export function _toolsForAnthropic(tools: LlmTool[]) {
  // 暴露给单测；生产路径已在 stream 内联
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema
  }));
}
```

注：`anthropic-dangerous-direct-browser-access` 头是 Anthropic 允许浏览器直连必需的开关，已经过用户的"用户填 API Key、浏览器直连"决策授权。

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/sidepanel/llm/anthropic-stream.test.ts`
Expected: 3 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/llm/anthropic.ts tests/sidepanel/llm/anthropic-stream.test.ts
git commit -m "feat(llm): anthropic SSE parser + client"
```

---

## Task 11: sidepanel/llm/openai.ts + 流解析单测

OpenAI Chat Completions API 的流：每个 chunk 是 `data: {choices:[{delta:{content?,tool_calls?:[{index,id?,function:{name?,arguments}}]}}]}`，最后一行 `data: [DONE]`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/sidepanel/llm/openai-stream.test.ts
import { describe, expect, it } from "vitest";
import { parseOpenAiStream } from "@/sidepanel/llm/openai";
import type { LlmStreamEvent } from "@/sidepanel/llm/types";

async function collect(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

function chunksFrom(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < enc.length; i += 32) {
        c.enqueue(enc.subarray(i, Math.min(i + 32, enc.length)));
      }
      c.close();
    }
  });
}

describe("parseOpenAiStream", () => {
  it("emits text_delta and message_end on text-only response", async () => {
    const sse = [
      `data: {"choices":[{"delta":{"role":"assistant","content":"Hi"}}]}`,
      ``,
      `data: {"choices":[{"delta":{"content":" there"}}]}`,
      ``,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}`,
      ``,
      `data: [DONE]`,
      ``,
      ``
    ].join("\n");

    const events = await collect(parseOpenAiStream(chunksFrom(sse)));
    expect(events).toEqual([
      { type: "text_delta", text: "Hi" },
      { type: "text_delta", text: " there" },
      { type: "message_end", usage: { input_tokens: 5, output_tokens: 2 } }
    ]);
  });

  it("emits tool_use sequence and parsed input", async () => {
    const sse = [
      `data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"snapshotDOM","arguments":""}}]}}]}`,
      ``,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"max"}}]}}]}`,
      ``,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Depth\\":3}"}}]}}]}`,
      ``,
      `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":4}}`,
      ``,
      `data: [DONE]`,
      ``,
      ``
    ].join("\n");

    const events = await collect(parseOpenAiStream(chunksFrom(sse)));
    expect(events).toEqual([
      { type: "tool_use_start", id: "call_1", name: "snapshotDOM" },
      { type: "tool_use_input_delta", id: "call_1", partial_json: "{\"max" },
      { type: "tool_use_input_delta", id: "call_1", partial_json: "Depth\":3}" },
      { type: "tool_use_end", id: "call_1", input: { maxDepth: 3 } },
      { type: "message_end", usage: { input_tokens: 7, output_tokens: 4 } }
    ]);
  });

  it("emits error on malformed JSON arguments", async () => {
    const sse = [
      `data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"x","arguments":"{not"}}]}}]}`,
      ``,
      `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
      ``,
      `data: [DONE]`,
      ``
    ].join("\n");

    const events = await collect(parseOpenAiStream(chunksFrom(sse)));
    expect(events.find((e) => e.type === "error")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/sidepanel/llm/openai-stream.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/sidepanel/llm/openai.ts`**

```ts
import type { ChatMessage, Json } from "@/shared/types";
import type { LlmClient, LlmStreamEvent, LlmTool } from "./types";

export async function* parseOpenAiStream(
  stream: ReadableStream<Uint8Array>
): AsyncIterable<LlmStreamEvent> {
  type Tc = { id?: string; name?: string; argsBuf: string; emittedStart: boolean };
  const tcs = new Map<number, Tc>();
  let usageIn = 0;
  let usageOut = 0;
  let finishReason: string | null = null;
  let messageEnded = false;

  for await (const data of readDataLines(stream)) {
    if (data === "[DONE]") {
      if (!messageEnded) {
        for (const tc of tcs.values()) {
          if (tc.id) {
            try {
              const input = tc.argsBuf ? (JSON.parse(tc.argsBuf) as Json) : ({} as Json);
              yield { type: "tool_use_end", id: tc.id, input };
            } catch (e) {
              yield {
                type: "error",
                error: `tool_use ${tc.id} arguments JSON parse failed: ${
                  e instanceof Error ? e.message : String(e)
                }`
              };
            }
          }
        }
        yield { type: "message_end", usage: { input_tokens: usageIn, output_tokens: usageOut } };
        messageEnded = true;
      }
      return;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const choices = chunk.choices as Array<{
      delta?: { content?: string; tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }> };
      finish_reason?: string | null;
    }> | undefined;
    const usage = chunk.usage as
      | { prompt_tokens?: number; completion_tokens?: number }
      | undefined;
    if (usage) {
      if (usage.prompt_tokens != null) usageIn = usage.prompt_tokens;
      if (usage.completion_tokens != null) usageOut = usage.completion_tokens;
    }
    if (!choices || choices.length === 0) continue;
    const c = choices[0];
    if (c.delta?.content) {
      yield { type: "text_delta", text: c.delta.content };
    }
    if (c.delta?.tool_calls) {
      for (const tc of c.delta.tool_calls) {
        const cur = tcs.get(tc.index) ?? { argsBuf: "", emittedStart: false };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.argsBuf += tc.function.arguments;
        if (!cur.emittedStart && cur.id && cur.name) {
          yield { type: "tool_use_start", id: cur.id, name: cur.name };
          cur.emittedStart = true;
        }
        if (cur.emittedStart && tc.function?.arguments && cur.id) {
          yield { type: "tool_use_input_delta", id: cur.id, partial_json: tc.function.arguments };
        }
        tcs.set(tc.index, cur);
      }
    }
    if (c.finish_reason) {
      finishReason = c.finish_reason;
    }
  }

  // 兜底：流结束但没收到 [DONE]
  if (!messageEnded) {
    if (finishReason === "tool_calls") {
      for (const tc of tcs.values()) {
        if (tc.id) {
          try {
            const input = tc.argsBuf ? (JSON.parse(tc.argsBuf) as Json) : ({} as Json);
            yield { type: "tool_use_end", id: tc.id, input };
          } catch (e) {
            yield {
              type: "error",
              error: `tool_use ${tc.id} arguments JSON parse failed: ${
                e instanceof Error ? e.message : String(e)
              }`
            };
          }
        }
      }
    }
    yield { type: "message_end", usage: { input_tokens: usageIn, output_tokens: usageOut } };
  }
}

async function* readDataLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    if (done) break;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trimEnd();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trimStart();
      nl = buf.indexOf("\n");
    }
  }
  buf += decoder.decode();
  for (const line of buf.split("\n")) {
    const t = line.trimEnd();
    if (t.startsWith("data:")) yield t.slice(5).trimStart();
  }
}

export const openaiClient: LlmClient = {
  async *stream(input) {
    const body = {
      model: input.model,
      max_tokens: input.maxTokens ?? 4096,
      messages: [
        { role: "system", content: input.system },
        ...input.messages.map((m) => convertToOpenAiMessage(m))
      ],
      tools: input.tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.input_schema }
      })),
      stream: true,
      stream_options: { include_usage: true }
    };
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: input.abortSignal
    });
    if (!res.ok) {
      yield {
        type: "error",
        error: `OpenAI ${res.status}: ${await res.text().catch(() => "<no body>")}`
      };
      return;
    }
    if (!res.body) {
      yield { type: "error", error: "OpenAI: empty body" };
      return;
    }
    yield* parseOpenAiStream(res.body);
  }
};

function convertToOpenAiMessage(m: ChatMessage): unknown {
  if (m.role === "user") {
    if (typeof m.content === "string") return { role: "user", content: m.content };
    // 把 tool_result 部分映射成 OpenAI 的 role:"tool" 多条
    const out: unknown[] = [];
    const userParts: { type: "text"; text: string }[] = [];
    for (const part of m.content) {
      if (part.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: part.tool_use_id,
          content: part.content
        });
      } else if (part.type === "text") {
        userParts.push({ type: "text", text: part.text });
      }
    }
    if (userParts.length > 0) {
      out.unshift({ role: "user", content: userParts });
    }
    return out;
  }
  // assistant
  const text = m.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
  const toolCalls = m.content
    .filter((p): p is { type: "tool_use"; id: string; name: string; input: unknown } =>
      p.type === "tool_use"
    )
    .map((p) => ({
      id: p.id,
      type: "function" as const,
      function: { name: p.name, arguments: JSON.stringify(p.input) }
    }));
  return {
    role: "assistant",
    content: text || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  };
}

export const _convertToOpenAiMessage = convertToOpenAiMessage;
```

注：`convertToOpenAiMessage` 在 user 角色含 `tool_result` 时返回数组（多条 message），调用方需要 flat。我们在 stream() 里用 `flatMap` 处理。

修正 stream() 的 messages 构造：

```ts
// 把上面 stream() 里的 messages 构造改成:
messages: [
  { role: "system", content: input.system },
  ...input.messages.flatMap((m) => {
    const r = convertToOpenAiMessage(m);
    return Array.isArray(r) ? r : [r];
  })
],
```

直接把这个修正合并进 Step 3 的实现里（替换原 `messages` 段）。

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/sidepanel/llm/openai-stream.test.ts`
Expected: 3 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/llm/openai.ts tests/sidepanel/llm/openai-stream.test.ts
git commit -m "feat(llm): openai SSE parser + client with chat→tool message conversion"
```

---

## Task 12: sidepanel/llm/{client,tool-schema,system-prompt}.ts

**Files:**
- Create: `src/sidepanel/llm/client.ts`
- Create: `src/sidepanel/llm/tool-schema.ts`
- Create: `src/sidepanel/llm/system-prompt.ts`

- [ ] **Step 1: `client.ts`**

```ts
import { anthropicClient } from "./anthropic";
import { openaiClient } from "./openai";
import type { LlmClient } from "./types";
import type { LlmProvider } from "@/shared/types";

export function pickClient(provider: LlmProvider): LlmClient {
  return provider === "anthropic" ? anthropicClient : openaiClient;
}
```

- [ ] **Step 2: `tool-schema.ts`**

```ts
import type { LlmTool } from "./types";

export const TOOL_DEFS: LlmTool[] = [
  {
    name: "snapshotDOM",
    description: "页面 DOM 摘要：返回从 root 开始的简化树，含 tag/id/classes/直接文本/children。优先在每次任务开始用一次以了解结构。",
    input_schema: {
      type: "object",
      properties: {
        maxDepth: { type: "integer", default: 3 },
        root: { type: "string", description: "可选的 CSS 选择器；找不到时退回到 <html>" }
      }
    }
  },
  {
    name: "querySelector",
    description: "返回首个匹配元素的浅层摘要 (tag/id/classes/text/attrs)。",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        root: { type: "string" }
      },
      required: ["selector"]
    }
  },
  {
    name: "querySelectorAll",
    description: "返回所有匹配元素的浅层摘要数组。",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        root: { type: "string" },
        limit: { type: "integer" }
      },
      required: ["selector"]
    }
  },
  {
    name: "extractText",
    description: "提取选择器命中的元素文本。single=true 返回一个字符串，否则返回数组。",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        root: { type: "string" },
        single: { type: "boolean" }
      },
      required: ["selector"]
    }
  },
  {
    name: "extractImages",
    description: "在 root 范围内提取所有 <img> 的 src/data-src/srcset；includeBg=true 时也提取背景图。返回 {url, via}[].",
    input_schema: {
      type: "object",
      properties: {
        root: { type: "string" },
        includeBg: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "scroll",
    description: "滚动页面。to 可为 'bottom'|'top'|number；max 是滚动次数；untilSelector 出现时提前停。",
    input_schema: {
      type: "object",
      properties: {
        to: { description: "'bottom' | 'top' | number" },
        max: { type: "integer", default: 1 },
        intervalMs: { type: "integer", default: 250 },
        untilSelector: { type: "string" }
      },
      required: ["to"]
    }
  },
  {
    name: "waitFor",
    description: "等待固定 ms，或等待选择器出现（带 timeoutMs 兜底）。",
    input_schema: {
      type: "object",
      properties: {
        ms: { type: "integer" },
        selector: { type: "string" },
        timeoutMs: { type: "integer", default: 5000 }
      }
    }
  },
  {
    name: "click",
    description: "点击选择器命中的元素。required=false 时找不到不报错。需要人工审阅。",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        required: { type: "boolean", default: true }
      },
      required: ["selector"]
    }
  },
  {
    name: "httpRequest",
    description: "通过后台代理发请求。withCredentials=true 时带 cookie，需要人工审阅；默认 omit。",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"], default: "GET" },
        headers: { type: "object" },
        body: { type: "string" },
        withCredentials: { type: "boolean", default: false }
      },
      required: ["url"]
    }
  },
  {
    name: "readStorage",
    description: "读 localStorage 或 sessionStorage 的指定 key。需要人工审阅。",
    input_schema: {
      type: "object",
      properties: {
        store: { type: "string", enum: ["local", "session"] },
        key: { type: "string" }
      },
      required: ["store", "key"]
    }
  },
  {
    name: "runJS",
    description: "在 MAIN world 注入并执行一段 async 函数体（receives `ctx` = bindings）。务必使用 return 返回值。仅在结构化工具不够用时使用，会经过静态扫描与人工审阅。",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", description: "async function body" }
      },
      required: ["source"]
    }
  }
];
```

- [ ] **Step 3: `system-prompt.ts`**

```ts
export function buildSystemPrompt(input: { url: string; title?: string }): string {
  return [
    "你是一个网页采集助手。用户会描述要从当前网页提取什么内容。你需要：",
    "1) 先用 snapshotDOM 看一下页面结构。",
    "2) 优先使用结构化工具（querySelector*/extractText/extractImages/scroll/waitFor/click/httpRequest/readStorage）。",
    "3) 仅在结构化工具不够用时调用 runJS（会经过静态扫描与人工审阅，更慢）。",
    "4) 处理懒加载内容时使用 scroll 配合 untilSelector / waitFor。",
    "5) 完成采集后用一段简短文本总结，并以 JSON 形式给出最终输出（结构与字段尽量稳定，方便后续重放）。",
    "6) 注意：所有工具调用对当前用户可见，dangerous 级别（cookie/eval/withCredentials/storage 读取等）需要明确审阅。",
    "",
    `当前页面 URL: ${input.url}`,
    input.title ? `页面标题: ${input.title}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}
```

- [ ] **Step 4: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/llm/client.ts src/sidepanel/llm/tool-schema.ts src/sidepanel/llm/system-prompt.ts
git commit -m "feat(llm): add client picker + tool schema + system prompt"
```

---

## Task 13: sidepanel/chat/severity.ts + 单测

**Files:**
- Create: `src/sidepanel/chat/severity.ts`
- Create: `tests/sidepanel/chat/severity.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/sidepanel/chat/severity.test.ts
import { describe, expect, it } from "vitest";
import { autoApproves, classifyTool } from "@/sidepanel/chat/severity";

describe("classifyTool", () => {
  it("safe tools", () => {
    expect(classifyTool("snapshotDOM", {})).toBe("safe");
    expect(classifyTool("extractText", { selector: "h1" })).toBe("safe");
    expect(classifyTool("scroll", { to: "bottom" })).toBe("safe");
  });

  it("click is caution", () => {
    expect(classifyTool("click", { selector: "#a" })).toBe("caution");
  });

  it("httpRequest depends on withCredentials", () => {
    expect(classifyTool("httpRequest", { url: "https://x/" })).toBe("caution");
    expect(classifyTool("httpRequest", { url: "https://x/", withCredentials: true })).toBe("dangerous");
  });

  it("readStorage is dangerous", () => {
    expect(classifyTool("readStorage", { store: "local", key: "k" })).toBe("dangerous");
  });

  it("runJS classified by static scan", () => {
    expect(classifyTool("runJS", { source: "return document.title" })).toBe("caution");
    expect(classifyTool("runJS", { source: "return document.cookie" })).toBe("dangerous");
    expect(classifyTool("runJS", { source: "return await fetch('/x').then(r => r.text())" })).toBe("caution");
  });
});

describe("autoApproves", () => {
  it("safe always auto", () => {
    expect(autoApproves("safe", true)).toBe(true);
    expect(autoApproves("safe", false)).toBe(true);
  });
  it("caution auto only when toggle on", () => {
    expect(autoApproves("caution", true)).toBe(true);
    expect(autoApproves("caution", false)).toBe(false);
  });
  it("dangerous never auto", () => {
    expect(autoApproves("dangerous", true)).toBe(false);
    expect(autoApproves("dangerous", false)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/sidepanel/chat/severity.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/sidepanel/chat/severity.ts
import { highestSeverity, runStaticScan } from "@/shared/static-scan";
import type { Json } from "@/shared/types";

export type ToolSeverity = "safe" | "caution" | "dangerous";

const SAFE = new Set([
  "snapshotDOM",
  "querySelector",
  "querySelectorAll",
  "extractText",
  "extractImages",
  "scroll",
  "waitFor"
]);

export function classifyTool(name: string, input: Json): ToolSeverity {
  if (SAFE.has(name)) return "safe";
  if (name === "click") return "caution";
  if (name === "readStorage") return "dangerous";
  if (name === "httpRequest") {
    const withCred = isObject(input) && (input as Record<string, Json>).withCredentials === true;
    return withCred ? "dangerous" : "caution";
  }
  if (name === "runJS") {
    const source = isObject(input) ? ((input as Record<string, Json>).source as string | undefined) : undefined;
    if (!source) return "caution";
    const sev = highestSeverity(runStaticScan(source));
    if (sev === "dangerous") return "dangerous";
    if (sev === "caution") return "caution";
    return "caution"; // 任何 runJS 至少 caution
  }
  return "dangerous"; // 未知工具一律 dangerous
}

export function autoApproves(severity: ToolSeverity, approveAllSafe: boolean): boolean {
  if (severity === "safe") return true;
  if (severity === "caution") return approveAllSafe;
  return false;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/sidepanel/chat/severity.test.ts`
Expected: 7 个 test PASS。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/chat/severity.ts tests/sidepanel/chat/severity.test.ts
git commit -m "feat(chat): add tool severity classifier + auto-approve gate"
```

---

## Task 14: sidepanel/chat/approval.ts

**Files:**
- Create: `src/sidepanel/chat/approval.ts`

- [ ] **Step 1: 实现**

```ts
// src/sidepanel/chat/approval.ts
export type Decision = { kind: "run" } | { kind: "skip" } | { kind: "deny" };

export class Approver {
  private pending = new Map<string, (d: Decision) => void>();

  request(toolUseId: string): Promise<Decision> {
    return new Promise((resolve) => {
      this.pending.set(toolUseId, resolve);
    });
  }

  resolve(toolUseId: string, decision: Decision): void {
    const r = this.pending.get(toolUseId);
    if (!r) return;
    this.pending.delete(toolUseId);
    r(decision);
  }

  resolveAllPending(decision: Decision): void {
    for (const [id, r] of this.pending) {
      r(decision);
      this.pending.delete(id);
    }
  }

  has(toolUseId: string): boolean {
    return this.pending.has(toolUseId);
  }
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/chat/approval.ts
git commit -m "feat(chat): add Approver promise-resolver registry"
```

---

## Task 15: sidepanel/chat/tool-runner.ts

**Files:**
- Create: `src/sidepanel/chat/tool-runner.ts`

`ToolRunner` 是对 `rpc.runOneStep` 的薄包装，定义清晰接口便于测试 mock。

- [ ] **Step 1: 实现**

```ts
// src/sidepanel/chat/tool-runner.ts
import type { Json, Step } from "@/shared/types";

export interface ToolRunner {
  runStep(step: Step, tabId: number, bindings: Record<string, Json>): Promise<Json>;
}

export class RpcToolRunner implements ToolRunner {
  constructor(
    private send: (req: unknown) => Promise<{ ok: true; data: Json } | { ok: false; error: string }>
  ) {}

  async runStep(step: Step, tabId: number, bindings: Record<string, Json>): Promise<Json> {
    const res = await this.send({
      type: "runs.runOneStep",
      step,
      tabId,
      bindings
    });
    if (!res.ok) throw new Error(res.error);
    return res.data;
  }
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```ts
git add src/sidepanel/chat/tool-runner.ts
git commit -m "feat(chat): add ToolRunner abstraction + Rpc impl"
```

---

## Task 16: sidepanel/chat/session-store.ts (zustand)

**Files:**
- Create: `src/sidepanel/chat/session-store.ts`

- [ ] **Step 1: 实现**

```ts
// src/sidepanel/chat/session-store.ts
import { create } from "zustand";
import type { ChatMessage, Json, Step, ToolUsePart } from "@/shared/types";

export type StepCardState = {
  toolUseId: string;
  name: string;
  input: Json;
  partialJson: string;          // 流式累积
  inputReady: boolean;
  status: "draft" | "awaiting" | "running" | "ok" | "error" | "skipped" | "denied";
  output?: Json;
  error?: string;
  ms?: number;
};

export type ChatSessionState = {
  // identity
  runRecordId: string | null;
  tabId: number | null;
  url: string;

  // chat
  messages: ChatMessage[];
  streamingAssistantText: string;     // 当前轮 assistant 流式文本累加
  cards: StepCardState[];             // 顺序的 step 卡片
  approveAllSafe: boolean;
  status: "idle" | "streaming" | "awaiting" | "running" | "done" | "error" | "aborted";
  errorMessage: string | null;

  // counters
  roundCount: number;
  tokenUsage: { input: number; output: number };

  // executed steps for save-as-tool
  executedSteps: Step[];
  lastOutput: Json;
  showSaveDialog: boolean;

  // abort
  abortController: AbortController | null;
};

const initialState = (): ChatSessionState => ({
  runRecordId: null,
  tabId: null,
  url: "",
  messages: [],
  streamingAssistantText: "",
  cards: [],
  approveAllSafe: true,
  status: "idle",
  errorMessage: null,
  roundCount: 0,
  tokenUsage: { input: 0, output: 0 },
  executedSteps: [],
  lastOutput: null,
  showSaveDialog: false,
  abortController: null
});

type SessionActions = {
  reset: () => void;
  setApproveAllSafe: (v: boolean) => void;
  setStatus: (s: ChatSessionState["status"]) => void;
  setError: (msg: string | null) => void;
  setIdentity: (p: { tabId: number; url: string; runRecordId: string }) => void;
  appendUserMessage: (text: string) => void;
  beginAssistantTurn: () => void;
  appendAssistantText: (delta: string) => void;
  finalizeAssistantTurn: (toolUses: ToolUsePart[]) => void;
  upsertCard: (card: Partial<StepCardState> & { toolUseId: string }) => void;
  setCardStatus: (
    toolUseId: string,
    patch: Partial<Pick<StepCardState, "status" | "output" | "error" | "ms" | "input" | "inputReady">>
  ) => void;
  appendToolResults: (
    results: Array<{ tool_use_id: string; content: string; is_error?: boolean }>
  ) => void;
  pushExecutedStep: (step: Step) => void;
  setLastOutput: (v: Json) => void;
  incrementRound: () => void;
  addUsage: (u: { input_tokens: number; output_tokens: number }) => void;
  setAbortController: (c: AbortController | null) => void;
  showSave: () => void;
  hideSave: () => void;
};

export const useSession = create<ChatSessionState & SessionActions>((set) => ({
  ...initialState(),
  reset: () => set({ ...initialState() }),
  setApproveAllSafe: (v) => set({ approveAllSafe: v }),
  setStatus: (s) => set({ status: s }),
  setError: (errorMessage) => set({ errorMessage }),
  setIdentity: (p) => set({ tabId: p.tabId, url: p.url, runRecordId: p.runRecordId }),
  appendUserMessage: (text) =>
    set((s) => ({ messages: [...s.messages, { role: "user", content: text }] })),
  beginAssistantTurn: () =>
    set({ streamingAssistantText: "" }),
  appendAssistantText: (delta) =>
    set((s) => ({ streamingAssistantText: s.streamingAssistantText + delta })),
  finalizeAssistantTurn: (toolUses) =>
    set((s) => {
      const content: Array<
        { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Json }
      > = [];
      if (s.streamingAssistantText) content.push({ type: "text", text: s.streamingAssistantText });
      for (const tu of toolUses) content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      return {
        messages: [...s.messages, { role: "assistant", content }],
        streamingAssistantText: ""
      };
    }),
  upsertCard: (card) =>
    set((s) => {
      const idx = s.cards.findIndex((c) => c.toolUseId === card.toolUseId);
      if (idx === -1) {
        return {
          cards: [
            ...s.cards,
            {
              toolUseId: card.toolUseId,
              name: card.name ?? "",
              input: card.input ?? {},
              partialJson: card.partialJson ?? "",
              inputReady: card.inputReady ?? false,
              status: card.status ?? "draft"
            }
          ]
        };
      }
      const merged = { ...s.cards[idx], ...card };
      const next = [...s.cards];
      next[idx] = merged;
      return { cards: next };
    }),
  setCardStatus: (id, patch) =>
    set((s) => {
      const idx = s.cards.findIndex((c) => c.toolUseId === id);
      if (idx === -1) return {};
      const next = [...s.cards];
      next[idx] = { ...next[idx], ...patch };
      return { cards: next };
    }),
  appendToolResults: (results) =>
    set((s) => ({
      messages: [
        ...s.messages,
        {
          role: "user",
          content: results.map((r) => ({
            type: "tool_result" as const,
            tool_use_id: r.tool_use_id,
            content: r.content,
            is_error: r.is_error
          }))
        }
      ]
    })),
  pushExecutedStep: (step) => set((s) => ({ executedSteps: [...s.executedSteps, step] })),
  setLastOutput: (v) => set({ lastOutput: v }),
  incrementRound: () => set((s) => ({ roundCount: s.roundCount + 1 })),
  addUsage: (u) =>
    set((s) => ({
      tokenUsage: {
        input: s.tokenUsage.input + (u.input_tokens ?? 0),
        output: s.tokenUsage.output + (u.output_tokens ?? 0)
      }
    })),
  setAbortController: (abortController) => set({ abortController }),
  showSave: () => set({ showSaveDialog: true }),
  hideSave: () => set({ showSaveDialog: false })
}));
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/chat/session-store.ts
git commit -m "feat(chat): add zustand session store"
```

---

## Task 17: sidepanel/chat/run-session.ts + 单测

会话主循环。通过 DI 接 LlmClient / ToolRunner / Approver / store / rpc，方便单测全 mock。

**Files:**
- Create: `src/sidepanel/chat/run-session.ts`
- Create: `tests/sidepanel/chat/run-session.test.ts`

- [ ] **Step 1: 写失败测试（先列接口）**

```ts
// tests/sidepanel/chat/run-session.test.ts
import { describe, expect, it, vi } from "vitest";
import { runChatSession } from "@/sidepanel/chat/run-session";
import { Approver } from "@/sidepanel/chat/approval";
import type { LlmClient, LlmStreamEvent } from "@/sidepanel/llm/types";
import type { ToolRunner } from "@/sidepanel/chat/tool-runner";
import type { Json, Step } from "@/shared/types";

function streamFrom(events: LlmStreamEvent[]): AsyncIterable<LlmStreamEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

function makeClient(rounds: LlmStreamEvent[][]): LlmClient {
  let i = 0;
  return {
    stream() {
      const events = rounds[i++] ?? [{ type: "message_end", usage: { input_tokens: 0, output_tokens: 0 } }];
      return streamFrom(events);
    }
  };
}

function makeRunner(handler: (step: Step) => Promise<Json>): ToolRunner {
  return { async runStep(step) { return handler(step); } };
}

describe("runChatSession", () => {
  it("auto-approves safe tool, retrieves output, terminates after assistant final text", async () => {
    const client = makeClient([
      [
        { type: "tool_use_start", id: "t1", name: "snapshotDOM" },
        { type: "tool_use_input_delta", id: "t1", partial_json: "{}" },
        { type: "tool_use_end", id: "t1", input: {} },
        { type: "message_end", usage: { input_tokens: 5, output_tokens: 10 } }
      ],
      [
        { type: "text_delta", text: "done." },
        { type: "message_end", usage: { input_tokens: 12, output_tokens: 5 } }
      ]
    ]);
    const runner = makeRunner(async () => ({ tag: "html" }));
    const approver = new Approver();
    const rpc = {
      startSession: vi.fn().mockResolvedValue({ id: "run-1" }),
      appendStepLog: vi.fn().mockResolvedValue(null),
      finalizeSession: vi.fn().mockResolvedValue(null)
    };

    const result = await runChatSession({
      client,
      runner,
      approver,
      rpc,
      input: { userPrompt: "go", tabId: 7, url: "https://x/" },
      settings: { provider: "anthropic", model: "m", apiKey: "k", apiKeyMode: "session", maxRounds: 5 },
      systemPrompt: "sys",
      tools: [],
      approveAllSafe: true
    });

    expect(result.status).toBe("done");
    expect(result.runRecordId).toBe("run-1");
    expect(rpc.appendStepLog).toHaveBeenCalledTimes(1);
    expect(rpc.finalizeSession).toHaveBeenCalledWith("run-1", "ok", expect.anything());
  });

  it("waits for approval on dangerous tool and aborts on deny", async () => {
    const client = makeClient([
      [
        { type: "tool_use_start", id: "t1", name: "readStorage" },
        { type: "tool_use_input_delta", id: "t1", partial_json: '{"store":"local","key":"k"}' },
        { type: "tool_use_end", id: "t1", input: { store: "local", key: "k" } },
        { type: "message_end" }
      ]
    ]);
    const runner = makeRunner(async () => null);
    const approver = new Approver();

    const promise = runChatSession({
      client,
      runner,
      approver,
      rpc: {
        startSession: vi.fn().mockResolvedValue({ id: "r" }),
        appendStepLog: vi.fn(),
        finalizeSession: vi.fn().mockResolvedValue(null)
      },
      input: { userPrompt: "x", tabId: 1, url: "u" },
      settings: { provider: "anthropic", model: "m", apiKey: "k", apiKeyMode: "session", maxRounds: 5 },
      systemPrompt: "sys",
      tools: [],
      approveAllSafe: true
    });

    // 模拟用户点 deny
    await new Promise((r) => setTimeout(r, 10));
    approver.resolve("t1", { kind: "deny" });
    const result = await promise;

    expect(result.status).toBe("aborted");
  });

  it("recovers from step error by feeding back tool_result with is_error and continues", async () => {
    const client = makeClient([
      [
        { type: "tool_use_start", id: "t1", name: "extractText" },
        { type: "tool_use_input_delta", id: "t1", partial_json: '{"selector":"x"}' },
        { type: "tool_use_end", id: "t1", input: { selector: "x" } },
        { type: "message_end" }
      ],
      [
        { type: "text_delta", text: "ok" },
        { type: "message_end" }
      ]
    ]);
    let calls = 0;
    const runner = makeRunner(async () => {
      calls++;
      if (calls === 1) throw new Error("selector miss");
      return [];
    });
    const approver = new Approver();

    const result = await runChatSession({
      client,
      runner,
      approver,
      rpc: {
        startSession: vi.fn().mockResolvedValue({ id: "r" }),
        appendStepLog: vi.fn(),
        finalizeSession: vi.fn().mockResolvedValue(null)
      },
      input: { userPrompt: "x", tabId: 1, url: "u" },
      settings: { provider: "anthropic", model: "m", apiKey: "k", apiKeyMode: "session", maxRounds: 5 },
      systemPrompt: "sys",
      tools: [],
      approveAllSafe: true
    });

    expect(result.status).toBe("done"); // 第二轮 LLM 给文本就结束
  });

  it("stops at maxRounds", async () => {
    const oneRound: LlmStreamEvent[] = [
      { type: "tool_use_start", id: "t1", name: "snapshotDOM" },
      { type: "tool_use_input_delta", id: "t1", partial_json: "{}" },
      { type: "tool_use_end", id: "t1", input: {} },
      { type: "message_end" }
    ];
    const client = makeClient([oneRound, oneRound, oneRound]);
    const runner = makeRunner(async () => null);
    const approver = new Approver();

    const result = await runChatSession({
      client,
      runner,
      approver,
      rpc: {
        startSession: vi.fn().mockResolvedValue({ id: "r" }),
        appendStepLog: vi.fn(),
        finalizeSession: vi.fn().mockResolvedValue(null)
      },
      input: { userPrompt: "x", tabId: 1, url: "u" },
      settings: { provider: "anthropic", model: "m", apiKey: "k", apiKeyMode: "session", maxRounds: 2 },
      systemPrompt: "sys",
      tools: [],
      approveAllSafe: true
    });

    expect(result.status).toBe("max_rounds");
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/sidepanel/chat/run-session.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/sidepanel/chat/run-session.ts`**

```ts
// src/sidepanel/chat/run-session.ts
import type {
  ChatMessage,
  Json,
  LlmSettings,
  Step,
  TextPart,
  ToolResultPart,
  ToolUsePart
} from "@/shared/types";
import type { LlmClient, LlmTool } from "@/sidepanel/llm/types";
import type { ToolRunner } from "./tool-runner";
import { Approver } from "./approval";
import { autoApproves, classifyTool } from "./severity";

export type SessionRpc = {
  startSession: (input: { url: string }) => Promise<{ id: string }>;
  appendStepLog: (
    runId: string,
    entry: {
      stepIndex: number;
      input: Json;
      output: Json;
      ms: number;
      error?: string;
    }
  ) => Promise<unknown>;
  finalizeSession: (
    runId: string,
    status: "ok" | "error" | "aborted",
    output?: Json
  ) => Promise<unknown>;
};

export type RunSessionInput = {
  userPrompt: string;
  tabId: number;
  url: string;
};

export type SessionEvent =
  | { type: "round_start"; round: number }
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; partial_json: string }
  | { type: "tool_use_end"; id: string; input: Json }
  | { type: "tool_running"; id: string }
  | { type: "tool_done"; id: string; output: Json; ms: number }
  | { type: "tool_error"; id: string; error: string; ms: number }
  | { type: "tool_skipped"; id: string }
  | { type: "usage"; input_tokens: number; output_tokens: number }
  | { type: "session_end"; status: "done" | "aborted" | "max_rounds" | "error"; lastOutput: Json };

export type RunSessionArgs = {
  client: LlmClient;
  runner: ToolRunner;
  approver: Approver;
  rpc: SessionRpc;
  input: RunSessionInput;
  settings: LlmSettings;
  systemPrompt: string;
  tools: LlmTool[];
  approveAllSafe: boolean;
  abortSignal?: AbortSignal;
  onEvent?: (e: SessionEvent) => void;
  initialMessages?: ChatMessage[];      // 给"修复入口"的预填上下文
};

export type RunSessionResult = {
  status: "done" | "aborted" | "max_rounds" | "error";
  runRecordId: string;
  messages: ChatMessage[];
  executedSteps: Step[];
  lastOutput: Json;
};

const MAX_PARSE_RETRIES = 3;

export async function runChatSession(args: RunSessionArgs): Promise<RunSessionResult> {
  const messages: ChatMessage[] = [
    ...(args.initialMessages ?? []),
    { role: "user", content: args.input.userPrompt }
  ];
  const executedSteps: Step[] = [];
  let lastOutput: Json = null;
  const { id: runRecordId } = await args.rpc.startSession({ url: args.input.url });

  let parseFailures = 0;
  let stepIndexGlobal = 0;

  for (let round = 0; round < args.settings.maxRounds; round++) {
    args.onEvent?.({ type: "round_start", round });

    const stream = args.client.stream({
      apiKey: args.settings.apiKey,
      model: args.settings.model,
      system: args.systemPrompt,
      messages,
      tools: args.tools,
      abortSignal: args.abortSignal
    });

    const inputBufs = new Map<string, string>();
    const tuMeta = new Map<string, { name: string }>();
    const completedToolUses: ToolUsePart[] = [];
    let textBuf = "";
    let streamErr: string | null = null;

    try {
      for await (const ev of stream) {
        if (args.abortSignal?.aborted) {
          await args.rpc.finalizeSession(runRecordId, "aborted");
          args.onEvent?.({ type: "session_end", status: "aborted", lastOutput });
          return { status: "aborted", runRecordId, messages, executedSteps, lastOutput };
        }
        switch (ev.type) {
          case "text_delta":
            textBuf += ev.text;
            args.onEvent?.({ type: "text_delta", text: ev.text });
            break;
          case "tool_use_start":
            tuMeta.set(ev.id, { name: ev.name });
            inputBufs.set(ev.id, "");
            args.onEvent?.({ type: "tool_use_start", id: ev.id, name: ev.name });
            break;
          case "tool_use_input_delta":
            inputBufs.set(ev.id, (inputBufs.get(ev.id) ?? "") + ev.partial_json);
            args.onEvent?.({
              type: "tool_use_input_delta",
              id: ev.id,
              partial_json: ev.partial_json
            });
            break;
          case "tool_use_end": {
            const meta = tuMeta.get(ev.id);
            if (!meta) break;
            completedToolUses.push({ type: "tool_use", id: ev.id, name: meta.name, input: ev.input });
            args.onEvent?.({ type: "tool_use_end", id: ev.id, input: ev.input });
            break;
          }
          case "message_end":
            if (ev.usage) {
              args.onEvent?.({
                type: "usage",
                input_tokens: ev.usage.input_tokens,
                output_tokens: ev.usage.output_tokens
              });
            }
            break;
          case "error":
            streamErr = ev.error;
            break;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (args.abortSignal?.aborted) {
        await args.rpc.finalizeSession(runRecordId, "aborted");
        args.onEvent?.({ type: "session_end", status: "aborted", lastOutput });
        return { status: "aborted", runRecordId, messages, executedSteps, lastOutput };
      }
      await args.rpc.finalizeSession(runRecordId, "error");
      args.onEvent?.({ type: "session_end", status: "error", lastOutput });
      throw new Error(msg);
    }

    if (streamErr) {
      parseFailures++;
      if (parseFailures >= MAX_PARSE_RETRIES) {
        await args.rpc.finalizeSession(runRecordId, "error");
        args.onEvent?.({ type: "session_end", status: "error", lastOutput });
        return { status: "error", runRecordId, messages, executedSteps, lastOutput };
      }
      // 把错误回灌为 user message，让 AI 重试
      messages.push({
        role: "user",
        content: `Previous response had a streaming error: ${streamErr}. Please try again.`
      });
      continue;
    }

    // 把 assistant turn 写回 messages
    const assistantContent: Array<TextPart | ToolUsePart> = [];
    if (textBuf) assistantContent.push({ type: "text", text: textBuf });
    for (const tu of completedToolUses) assistantContent.push(tu);
    messages.push({ role: "assistant", content: assistantContent });

    if (completedToolUses.length === 0) {
      // 终止：纯文本回复
      lastOutput = textBuf;
      await args.rpc.finalizeSession(runRecordId, "ok", lastOutput);
      args.onEvent?.({ type: "session_end", status: "done", lastOutput });
      return { status: "done", runRecordId, messages, executedSteps, lastOutput };
    }

    // 处理每一个 tool_use
    const results: ToolResultPart[] = [];
    for (const tu of completedToolUses) {
      const sev = classifyTool(tu.name, tu.input);
      let decision: { kind: "run" | "skip" | "deny" };
      if (autoApproves(sev, args.approveAllSafe)) {
        decision = { kind: "run" };
      } else {
        decision = await args.approver.request(tu.id);
      }

      if (decision.kind === "deny") {
        await args.rpc.finalizeSession(runRecordId, "aborted");
        args.onEvent?.({ type: "session_end", status: "aborted", lastOutput });
        return { status: "aborted", runRecordId, messages, executedSteps, lastOutput };
      }
      if (decision.kind === "skip") {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ skipped: true })
        });
        args.onEvent?.({ type: "tool_skipped", id: tu.id });
        continue;
      }

      args.onEvent?.({ type: "tool_running", id: tu.id });
      const step: Step = tu.name === "runJS"
        ? { kind: "js", source: ((tu.input as { source: string }).source) }
        : { kind: "tool", tool: tu.name as Step extends { kind: "tool" } ? Step["tool"] : never, args: tu.input };

      const start = Date.now();
      try {
        const out = await args.runner.runStep(step, args.input.tabId, {});
        const ms = Date.now() - start;
        await args.rpc.appendStepLog(runRecordId, {
          stepIndex: stepIndexGlobal++,
          input: tu.input,
          output: out,
          ms
        });
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(out)
        });
        executedSteps.push(step);
        lastOutput = out;
        args.onEvent?.({ type: "tool_done", id: tu.id, output: out, ms });
      } catch (e) {
        const ms = Date.now() - start;
        const errStr = e instanceof Error ? e.message : String(e);
        await args.rpc.appendStepLog(runRecordId, {
          stepIndex: stepIndexGlobal++,
          input: tu.input,
          output: null,
          ms,
          error: errStr
        });
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ error: errStr }),
          is_error: true
        });
        args.onEvent?.({ type: "tool_error", id: tu.id, error: errStr, ms });
        // 不终止 — 把错误回灌给 AI，让它决定是否改 args 重试
      }
    }

    messages.push({ role: "user", content: results });
  }

  // 达到 maxRounds
  await args.rpc.finalizeSession(runRecordId, "error");
  args.onEvent?.({ type: "session_end", status: "max_rounds", lastOutput });
  return { status: "max_rounds", runRecordId, messages, executedSteps, lastOutput };
}
```

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/sidepanel/chat/run-session.test.ts`
Expected: 4 个 test PASS。

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/chat/run-session.ts tests/sidepanel/chat/run-session.test.ts
git commit -m "feat(chat): add session main loop with approval + error feedback"
```

---

## Task 18: settings-store + 设置页改造

**Files:**
- Create: `src/sidepanel/chat/settings-store.ts`
- Modify: `src/sidepanel/pages/settings-page.tsx`

- [ ] **Step 1: 实现 `settings-store.ts`**

```ts
// src/sidepanel/chat/settings-store.ts
import { create } from "zustand";
import type { LlmSettings } from "@/shared/types";

const KEY = "aipagego.llm";

const DEFAULTS: LlmSettings = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKey: "",
  apiKeyMode: "persistent",
  maxRounds: 20
};

type StoreShape = LlmSettings & {
  loaded: boolean;
  load: () => Promise<void>;
  save: (patch: Partial<LlmSettings>) => Promise<void>;
};

export const useSettings = create<StoreShape>((set, get) => ({
  ...DEFAULTS,
  loaded: false,
  load: async () => {
    const fromLocal = (await chrome.storage.local.get([KEY]))[KEY] as Partial<LlmSettings> | undefined;
    const fromSession = (await chrome.storage.session.get([KEY]))[KEY] as Partial<LlmSettings> | undefined;
    const merged = { ...DEFAULTS, ...(fromLocal ?? {}) };
    if (merged.apiKeyMode === "session" && fromSession) {
      merged.apiKey = fromSession.apiKey ?? "";
    }
    set({ ...merged, loaded: true });
  },
  save: async (patch) => {
    const next = { ...get(), ...patch };
    set(next);
    const { apiKey, apiKeyMode, ...rest } = next;
    if (apiKeyMode === "session") {
      await chrome.storage.local.set({ [KEY]: { ...rest, apiKey: "", apiKeyMode } });
      await chrome.storage.session.set({ [KEY]: { apiKey } });
    } else {
      await chrome.storage.local.set({ [KEY]: { ...rest, apiKey, apiKeyMode } });
      await chrome.storage.session.remove(KEY);
    }
  }
}));

export const ANTHROPIC_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001"
];
export const OPENAI_MODELS = ["gpt-4o-mini", "gpt-4o"];
```

- [ ] **Step 2: 重写 `settings-page.tsx`**

```tsx
// src/sidepanel/pages/settings-page.tsx
import { useEffect, useState } from "react";
import { rpc } from "../rpc";
import {
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  useSettings
} from "../chat/settings-store";
import type { LlmProvider } from "@/shared/types";

export function SettingsPage() {
  const settings = useSettings();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.loaded) settings.load();
  }, [settings]);

  const models = settings.provider === "anthropic" ? ANTHROPIC_MODELS : OPENAI_MODELS;

  async function doExport() {
    setMsg(null); setErr(null);
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
    setMsg(null); setErr(null);
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
        <h3 className="text-zinc-300">LLM</h3>
        <div className="flex items-center gap-2">
          <span className="w-20 text-zinc-400">Provider</span>
          <select
            value={settings.provider}
            onChange={(e) => {
              const provider = e.target.value as LlmProvider;
              const defaults = provider === "anthropic" ? ANTHROPIC_MODELS[0] : OPENAI_MODELS[0];
              settings.save({ provider, model: defaults });
            }}
            className="bg-zinc-800 px-2 py-1 rounded"
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-20 text-zinc-400">Model</span>
          <select
            value={settings.model}
            onChange={(e) => settings.save({ model: e.target.value })}
            className="bg-zinc-800 px-2 py-1 rounded"
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-start gap-2">
          <span className="w-20 text-zinc-400 mt-1">API Key</span>
          <div className="flex-1 flex flex-col gap-1">
            <input
              type="password"
              value={settings.apiKey}
              onChange={(e) => settings.save({ apiKey: e.target.value })}
              placeholder={settings.provider === "anthropic" ? "sk-ant-..." : "sk-..."}
              className="bg-zinc-800 px-2 py-1 rounded"
            />
            <label className="flex items-center gap-1 text-zinc-400">
              <input
                type="checkbox"
                checked={settings.apiKeyMode === "session"}
                onChange={(e) =>
                  settings.save({ apiKeyMode: e.target.checked ? "session" : "persistent" })
                }
              />
              仅本次会话保存（重启浏览器后清除）
            </label>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-20 text-zinc-400">最大轮数</span>
          <input
            type="number"
            min={1}
            max={200}
            value={settings.maxRounds}
            onChange={(e) => settings.save({ maxRounds: parseInt(e.target.value || "20", 10) })}
            className="bg-zinc-800 px-2 py-1 rounded w-24"
          />
        </div>
      </section>

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

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 退出码 0。

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/chat/settings-store.ts src/sidepanel/pages/settings-page.tsx
git commit -m "feat(sidepanel): add settings store + LLM/key/round settings page"
```

---

## Task 19: rpc.ts 增量

**Files:**
- Modify: `src/sidepanel/rpc.ts`

- [ ] **Step 1: 在文件末尾追加（或合入 rpc 对象）**

把现有 `src/sidepanel/rpc.ts` 重写为：

```ts
// src/sidepanel/rpc.ts
import type { RpcRequest } from "@/shared/messages";
import type { ExportBundle, Json, RunRecord, Step, Tool } from "@/shared/types";

async function call<T>(req: RpcRequest): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as
    | { ok: true; data: T }
    | { ok: false; error: string };
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

export const rpc = {
  // tools
  listTools: () => call<Tool[]>({ type: "tools.list" }),
  getTool: (id: string) => call<Tool | null>({ type: "tools.get", id }),
  saveTool: (draft: Extract<RpcRequest, { type: "tools.save" }>["draft"]) =>
    call<Tool>({ type: "tools.save", draft }),
  deleteTool: (id: string) => call<null>({ type: "tools.delete", id }),
  matchingTools: (url: string) => call<Tool[]>({ type: "tools.matching", url }),
  exportAll: () => call<ExportBundle>({ type: "tools.export" }),
  importBundle: (bundle: unknown) =>
    call<{ imported: number; skipped: number }>({ type: "tools.import", bundle }),

  // runs
  runDraft: (
    draft: Extract<RpcRequest, { type: "tools.save" }>["draft"],
    tabId: number
  ) => call<RunRecord>({ type: "runs.start", target: { kind: "draft", draft }, tabId }),
  runTool: (id: string, tabId: number) =>
    call<RunRecord>({ type: "runs.start", target: { kind: "tool", id }, tabId }),
  runOneStep: (input: { step: Step; tabId: number; bindings?: Record<string, Json> }) =>
    call<Json>({
      type: "runs.runOneStep",
      step: input.step,
      tabId: input.tabId,
      bindings: input.bindings ?? {}
    }),
  listRuns: (toolId?: string) => call<RunRecord[]>({ type: "runs.list", toolId }),
  getRun: (id: string) => call<RunRecord | null>({ type: "runs.get", id }),

  // chat session
  startSession: (input: { url: string }) =>
    call<RunRecord>({ type: "chat.session.start", url: input.url }),
  appendStepLog: (
    runId: string,
    entry: { stepIndex: number; input: Json; output: Json; ms: number; error?: string }
  ) => call<null>({ type: "chat.session.appendLog", runId, entry }),
  finalizeSession: (
    runId: string,
    status: "ok" | "error" | "aborted",
    output?: Json
  ) => call<RunRecord>({ type: "chat.session.end", runId, status, output })
};

export async function currentTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active tab");
  return tab.id;
}

export async function currentTabInfo(): Promise<{ tabId: number; url: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active tab");
  return { tabId: tab.id, url: tab.url ?? "" };
}

// tabs.recommendations 监听器
export function onTabRecommendations(
  cb: (msg: { tabId: number; url: string; tools: Tool[] }) => void
): () => void {
  const listener = (msg: unknown) => {
    if (
      typeof msg === "object" &&
      msg !== null &&
      (msg as { type?: string }).type === "tabs.recommendations"
    ) {
      cb(msg as { type: "tabs.recommendations"; tabId: number; url: string; tools: Tool[] });
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/rpc.ts
git commit -m "feat(sidepanel): expand rpc with chat session + recommendations listener"
```

---

## Task 20: components/static-scan-badge.tsx + message-bubble.tsx

**Files:**
- Create: `src/sidepanel/components/static-scan-badge.tsx`
- Create: `src/sidepanel/components/message-bubble.tsx`

- [ ] **Step 1: `static-scan-badge.tsx`**

```tsx
import type { ScanFinding } from "@/shared/types";

export function StaticScanBadge(props: { findings: ScanFinding[] }) {
  if (props.findings.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {props.findings.map((f) => (
        <span
          key={f.rule}
          className={
            "px-1.5 py-0.5 rounded text-[10px] " +
            (f.severity === "dangerous"
              ? "bg-red-700 text-red-100"
              : f.severity === "caution"
              ? "bg-amber-700 text-amber-100"
              : "bg-zinc-700 text-zinc-200")
          }
          title={f.message}
        >
          {f.rule}
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: `message-bubble.tsx`**

```tsx
import type { ChatMessage } from "@/shared/types";

export function MessageBubble(props: { message: ChatMessage }) {
  const m = props.message;
  if (m.role === "user") {
    if (typeof m.content === "string") {
      return (
        <div className="bg-blue-900/40 rounded p-2 text-xs whitespace-pre-wrap">
          {m.content}
        </div>
      );
    }
    // tool_results — 不在主消息流单独渲染（在 step card 里已经显示）
    return null;
  }
  // assistant
  const text = m.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  if (!text) return null;
  return (
    <div className="bg-zinc-800/60 rounded p-2 text-xs whitespace-pre-wrap">
      {text}
    </div>
  );
}
```

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/components/static-scan-badge.tsx src/sidepanel/components/message-bubble.tsx
git commit -m "feat(sidepanel): add scan badge + message bubble components"
```

---

## Task 21: components/step-card.tsx

**Files:**
- Create: `src/sidepanel/components/step-card.tsx`

- [ ] **Step 1: 实现**

```tsx
// src/sidepanel/components/step-card.tsx
import { runStaticScan } from "@/shared/static-scan";
import type { ScanFinding } from "@/shared/types";
import type { StepCardState } from "../chat/session-store";
import { classifyTool } from "../chat/severity";
import { StaticScanBadge } from "./static-scan-badge";

type Props = {
  card: StepCardState;
  onApprove: (id: string, decision: "run" | "skip" | "deny") => void;
  needsManualApproval: boolean;
};

export function StepCard({ card, onApprove, needsManualApproval }: Props) {
  const severity = classifyTool(card.name, card.input);
  const findings: ScanFinding[] =
    card.name === "runJS" && typeof (card.input as { source?: string })?.source === "string"
      ? runStaticScan((card.input as { source: string }).source)
      : [];

  const cls =
    severity === "dangerous"
      ? "border-red-700"
      : severity === "caution"
      ? "border-amber-700"
      : "border-zinc-700";

  return (
    <div className={`rounded border ${cls} bg-zinc-900 p-2 text-xs flex flex-col gap-1`}>
      <div className="flex items-center gap-2">
        <span className="text-zinc-400">tool:</span>
        <span className="font-medium">{card.name}</span>
        <SeverityPill severity={severity} />
        <CardStatus card={card} />
      </div>
      <StaticScanBadge findings={findings} />
      <SourceOrArgs card={card} />
      {card.status === "ok" && (
        <details className="mt-1">
          <summary className="cursor-pointer text-zinc-400">output</summary>
          <pre className="text-[10px] text-zinc-300 mt-1 overflow-auto">
            {JSON.stringify(card.output, null, 2)}
          </pre>
        </details>
      )}
      {card.status === "error" && (
        <div className="text-red-400 text-[10px]">error: {card.error}</div>
      )}
      {card.status === "awaiting" && needsManualApproval && (
        <div className="flex gap-2 mt-1">
          <button
            onClick={() => onApprove(card.toolUseId, "run")}
            className="px-2 py-0.5 bg-emerald-700 rounded"
          >
            ✓ 通过
          </button>
          <button
            onClick={() => onApprove(card.toolUseId, "skip")}
            className="px-2 py-0.5 bg-zinc-700 rounded"
          >
            ⊘ 跳过
          </button>
          <button
            onClick={() => onApprove(card.toolUseId, "deny")}
            className="px-2 py-0.5 bg-red-800 rounded"
          >
            ✕ 终止
          </button>
        </div>
      )}
    </div>
  );
}

function SeverityPill({ severity }: { severity: ReturnType<typeof classifyTool> }) {
  const cls =
    severity === "dangerous"
      ? "bg-red-700"
      : severity === "caution"
      ? "bg-amber-700"
      : "bg-emerald-700";
  return <span className={`px-1.5 py-0.5 rounded text-[10px] ${cls}`}>{severity}</span>;
}

function CardStatus({ card }: { card: StepCardState }) {
  const text =
    card.status === "draft"
      ? "draft…"
      : card.status === "awaiting"
      ? "awaiting"
      : card.status === "running"
      ? "running…"
      : card.status === "ok"
      ? `✓ ${card.ms ?? 0}ms`
      : card.status === "error"
      ? "error"
      : card.status === "skipped"
      ? "skipped"
      : "denied";
  return <span className="text-zinc-400 ml-auto">{text}</span>;
}

function SourceOrArgs({ card }: { card: StepCardState }) {
  if (card.name === "runJS") {
    const src =
      typeof (card.input as { source?: string }).source === "string"
        ? (card.input as { source: string }).source
        : card.partialJson;
    return (
      <pre className="text-[10px] text-zinc-300 bg-zinc-950 rounded p-2 overflow-auto">
        {src}
      </pre>
    );
  }
  return (
    <pre className="text-[10px] text-zinc-300 bg-zinc-950 rounded p-2 overflow-auto">
      {card.inputReady ? JSON.stringify(card.input, null, 2) : card.partialJson || "…"}
    </pre>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/components/step-card.tsx
git commit -m "feat(sidepanel): step card with severity + scan badges + approval buttons"
```

---

## Task 22: components/{chat-view,recommendations-banner,status-bar,save-as-tool-dialog}.tsx

**Files:**
- Create: `src/sidepanel/components/chat-view.tsx`
- Create: `src/sidepanel/components/recommendations-banner.tsx`
- Create: `src/sidepanel/components/status-bar.tsx`
- Create: `src/sidepanel/components/save-as-tool-dialog.tsx`

- [ ] **Step 1: `chat-view.tsx`**

```tsx
// src/sidepanel/components/chat-view.tsx
import { useEffect, useRef } from "react";
import { useSession } from "../chat/session-store";
import { MessageBubble } from "./message-bubble";
import { StepCard } from "./step-card";
import type { ChatMessage, ToolUsePart } from "@/shared/types";
import { autoApproves, classifyTool } from "../chat/severity";

type Props = {
  onApprove: (id: string, decision: "run" | "skip" | "deny") => void;
};

export function ChatView({ onApprove }: Props) {
  const session = useSession();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [session.messages.length, session.streamingAssistantText, session.cards.length]);

  // 把 messages 与 cards 交错渲染：每条 assistant message 之后紧跟其 tool_use 卡片
  const items: Array<{ kind: "message"; msg: ChatMessage } | { kind: "card"; cardId: string }> =
    [];
  for (const m of session.messages) {
    items.push({ kind: "message", msg: m });
    if (m.role === "assistant") {
      const toolUses = m.content.filter((c): c is ToolUsePart => c.type === "tool_use");
      for (const tu of toolUses) items.push({ kind: "card", cardId: tu.id });
    }
  }
  // 流式中的 assistant 文本（还没 finalize）
  if (session.streamingAssistantText) {
    items.push({
      kind: "message",
      msg: {
        role: "assistant",
        content: [{ type: "text", text: session.streamingAssistantText }]
      }
    });
  }
  // 还没 finalize 的卡片（draft/awaiting/running 的）
  const finalizedIds = new Set(
    session.messages
      .filter((m): m is Extract<ChatMessage, { role: "assistant" }> => m.role === "assistant")
      .flatMap((m) => m.content.filter((c): c is ToolUsePart => c.type === "tool_use"))
      .map((c) => c.id)
  );
  for (const card of session.cards) {
    if (!finalizedIds.has(card.toolUseId) && !items.some((i) => i.kind === "card" && i.cardId === card.toolUseId)) {
      items.push({ kind: "card", cardId: card.toolUseId });
    }
  }

  return (
    <div ref={ref} className="flex-1 overflow-auto flex flex-col gap-2 p-3">
      {items.map((it, i) => {
        if (it.kind === "message") return <MessageBubble key={i} message={it.msg} />;
        const card = session.cards.find((c) => c.toolUseId === it.cardId);
        if (!card) return null;
        const sev = card.inputReady ? classifyTool(card.name, card.input) : "safe";
        const needs = !autoApproves(sev, session.approveAllSafe);
        return <StepCard key={card.toolUseId} card={card} onApprove={onApprove} needsManualApproval={needs} />;
      })}
    </div>
  );
}
```

- [ ] **Step 2: `recommendations-banner.tsx`**

```tsx
// src/sidepanel/components/recommendations-banner.tsx
import type { Tool } from "@/shared/types";

export function RecommendationsBanner(props: {
  tools: Tool[];
  onRun: (toolId: string) => void;
}) {
  if (props.tools.length === 0) return null;
  return (
    <div className="bg-emerald-900/30 border-b border-emerald-800 p-2 text-xs flex flex-col gap-1">
      <div className="text-emerald-300">▶ 此页面可用 {props.tools.length} 个工具:</div>
      <ul className="space-y-1">
        {props.tools.map((t) => (
          <li key={t.id} className="flex items-center gap-2">
            <span className="flex-1">
              {t.name} <span className="text-zinc-500">v{t.versions.at(-1)?.version}</span>
            </span>
            <button
              onClick={() => props.onRun(t.id)}
              className="px-2 py-0.5 bg-emerald-700 rounded"
            >
              运行
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: `status-bar.tsx`**

```tsx
// src/sidepanel/components/status-bar.tsx
import type { ChatSessionState } from "../chat/session-store";

type Props = {
  status: ChatSessionState["status"];
  roundCount: number;
  maxRounds: number;
  tokenUsage: ChatSessionState["tokenUsage"];
  onAbort: () => void;
};

export function StatusBar({ status, roundCount, maxRounds, tokenUsage, onAbort }: Props) {
  if (status === "idle" || status === "done") return null;
  const dot =
    status === "error" || status === "aborted" ? "bg-red-500" : "bg-emerald-500 animate-pulse";
  return (
    <div className="border-b border-zinc-800 bg-zinc-900 p-2 text-xs flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      <span>
        {status === "streaming"
          ? "AI 工作中"
          : status === "awaiting"
          ? "等待审阅"
          : status === "running"
          ? "执行 step"
          : status === "aborted"
          ? "已终止"
          : "出错"}
        {" · "}
        round {roundCount}/{maxRounds}
        {" · "}
        {tokenUsage.input + tokenUsage.output} tokens
      </span>
      <button onClick={onAbort} className="ml-auto px-2 py-0.5 bg-red-800 rounded">
        ⏸ 终止
      </button>
    </div>
  );
}
```

- [ ] **Step 4: `save-as-tool-dialog.tsx`**

```tsx
// src/sidepanel/components/save-as-tool-dialog.tsx
import { useState } from "react";
import { inferJsonSchema } from "@/shared/infer-json-schema";
import type { Json, Step } from "@/shared/types";
import { rpc } from "../rpc";

type Props = {
  initialName: string;
  initialDescription: string;
  initialUrl: string;
  steps: Step[];
  lastOutput: Json;
  onClose: () => void;
  onSaved: (toolId: string) => void;
};

function defaultPattern(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const baseHost = host.split(".").slice(-2).join(".");
    return `https://*.${baseHost}/**`;
  } catch {
    return "https://example.com/**";
  }
}

export function SaveAsToolDialog(props: Props) {
  const [name, setName] = useState(props.initialName || "新工具");
  const [description, setDescription] = useState(props.initialDescription || "");
  const [patternsText, setPatternsText] = useState(defaultPattern(props.initialUrl));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    setBusy(true);
    try {
      const urlPatterns = patternsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (urlPatterns.length === 0) throw new Error("至少填一个 URL 模式");
      if (props.steps.length === 0) throw new Error("没有可保存的成功 step");
      const tool = await rpc.saveTool({
        name,
        urlPatterns,
        description,
        steps: props.steps,
        outputSchema: inferJsonSchema(props.lastOutput)
      });
      props.onSaved(tool.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-10">
      <div className="bg-zinc-900 rounded p-4 w-[90%] max-w-md text-xs flex flex-col gap-2">
        <h3 className="text-base font-medium">保存为工具</h3>
        <label className="flex flex-col gap-1">
          <span className="text-zinc-400">名称</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="bg-zinc-800 px-2 py-1 rounded"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-zinc-400">URL 模式（每行一条）</span>
          <textarea
            value={patternsText}
            onChange={(e) => setPatternsText(e.target.value)}
            rows={3}
            className="bg-zinc-800 px-2 py-1 rounded font-mono"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-zinc-400">描述</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="bg-zinc-800 px-2 py-1 rounded"
          />
        </label>
        <p className="text-zinc-500">将保存 {props.steps.length} 个成功执行的 step。</p>
        {err && <p className="text-red-400">{err}</p>}
        <div className="flex gap-2 justify-end">
          <button
            onClick={props.onClose}
            className="px-3 py-1 bg-zinc-700 rounded"
            disabled={busy}
          >
            取消
          </button>
          <button
            onClick={save}
            className="px-3 py-1 bg-emerald-700 rounded disabled:opacity-50"
            disabled={busy}
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/chat-view.tsx src/sidepanel/components/recommendations-banner.tsx src/sidepanel/components/status-bar.tsx src/sidepanel/components/save-as-tool-dialog.tsx
git commit -m "feat(sidepanel): chat view + status bar + recommendations banner + save dialog"
```

---

## Task 23: pages/chat-page.tsx

**Files:**
- Create: `src/sidepanel/pages/chat-page.tsx`

- [ ] **Step 1: 实现**

```tsx
// src/sidepanel/pages/chat-page.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { Approver } from "../chat/approval";
import { runChatSession, type SessionEvent } from "../chat/run-session";
import { useSession } from "../chat/session-store";
import { useSettings } from "../chat/settings-store";
import { RpcToolRunner } from "../chat/tool-runner";
import { TOOL_DEFS } from "../llm/tool-schema";
import { pickClient } from "../llm/client";
import { buildSystemPrompt } from "../llm/system-prompt";
import { ChatView } from "../components/chat-view";
import { RecommendationsBanner } from "../components/recommendations-banner";
import { SaveAsToolDialog } from "../components/save-as-tool-dialog";
import { StatusBar } from "../components/status-bar";
import { currentTabInfo, onTabRecommendations, rpc } from "../rpc";
import type { BuiltinTool, Json, Step, Tool } from "@/shared/types";

type ChatPageProps = {
  initialPrompt?: string;
  initialContext?: string;
};

export function ChatPage({ initialPrompt, initialContext }: ChatPageProps) {
  const session = useSession();
  const settings = useSettings();
  const [input, setInput] = useState(initialPrompt ?? "");
  const [recommendations, setRecommendations] = useState<Tool[]>([]);
  const approverRef = useRef<Approver>(new Approver());
  const initialSentRef = useRef(false);

  useEffect(() => {
    if (!settings.loaded) settings.load();
  }, [settings]);

  useEffect(() => {
    let active = true;
    (async () => {
      const { tabId, url } = await currentTabInfo();
      if (!active) return;
      const tools = await rpc.matchingTools(url);
      if (active) setRecommendations(tools);
      session.reset();
      useSession.setState({ tabId, url });
    })();
    const off = onTabRecommendations((m) => {
      currentTabInfo()
        .then((info) => {
          if (info.tabId === m.tabId) setRecommendations(m.tools);
        })
        .catch(() => {});
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  const handleApprove = useCallback(
    (id: string, decision: "run" | "skip" | "deny") => {
      approverRef.current.resolve(id, { kind: decision });
      session.setCardStatus(id, {
        status: decision === "run" ? "running" : decision === "skip" ? "skipped" : "denied"
      });
    },
    [session]
  );

  const send = useCallback(
    async (prompt: string) => {
      if (!prompt.trim()) return;
      if (!settings.apiKey) {
        session.setError("请先在设置页填入 API Key");
        return;
      }
      const { tabId, url } = await currentTabInfo();
      session.setIdentity({ tabId, url, runRecordId: "" });
      session.setStatus("streaming");
      session.appendUserMessage(prompt);
      setInput("");
      const ac = new AbortController();
      session.setAbortController(ac);
      const client = pickClient(settings.provider);
      const runner = new RpcToolRunner((req) =>
        chrome.runtime.sendMessage(req) as Promise<{ ok: true; data: Json } | { ok: false; error: string }>
      );

      const onEvent = (e: SessionEvent) => {
        switch (e.type) {
          case "round_start":
            session.incrementRound();
            session.beginAssistantTurn();
            break;
          case "text_delta":
            session.appendAssistantText(e.text);
            break;
          case "tool_use_start":
            session.upsertCard({ toolUseId: e.id, name: e.name, status: "draft", inputReady: false });
            break;
          case "tool_use_input_delta": {
            const fresh = useSession.getState().cards.find((c) => c.toolUseId === e.id);
            session.upsertCard({
              toolUseId: e.id,
              partialJson: (fresh?.partialJson ?? "") + e.partial_json
            });
            break;
          }
          case "tool_use_end":
            session.upsertCard({ toolUseId: e.id, input: e.input, inputReady: true, status: "awaiting" });
            session.setStatus("awaiting");
            break;
          case "tool_running":
            session.setCardStatus(e.id, { status: "running" });
            session.setStatus("running");
            break;
          case "tool_done":
            session.setCardStatus(e.id, { status: "ok", output: e.output, ms: e.ms });
            session.pushExecutedStep(stepFromCard(e.id));
            session.setLastOutput(e.output);
            session.setStatus("streaming");
            break;
          case "tool_error":
            session.setCardStatus(e.id, { status: "error", error: e.error, ms: e.ms });
            session.setStatus("streaming");
            break;
          case "tool_skipped":
            session.setCardStatus(e.id, { status: "skipped" });
            break;
          case "usage":
            session.addUsage({ input_tokens: e.input_tokens, output_tokens: e.output_tokens });
            break;
          case "session_end":
            if (e.status === "done") {
              session.setStatus("done");
              session.showSave();
            } else if (e.status === "max_rounds") {
              session.setStatus("error");
              session.setError("达到最大轮数");
            } else if (e.status === "aborted") {
              session.setStatus("aborted");
            } else {
              session.setStatus("error");
            }
            break;
        }
      };

      function stepFromCard(id: string): Step {
        const card = useSession.getState().cards.find((c) => c.toolUseId === id);
        if (!card) throw new Error(`card not found: ${id}`);
        if (card.name === "runJS") {
          return { kind: "js", source: (card.input as { source: string }).source };
        }
        return { kind: "tool", tool: card.name as BuiltinTool, args: card.input };
      }

      try {
        await runChatSession({
          client,
          runner,
          approver: approverRef.current,
          rpc: {
            startSession: (i) => rpc.startSession(i).then((r) => ({ id: r.id })),
            appendStepLog: (runId, entry) => rpc.appendStepLog(runId, entry),
            finalizeSession: (runId, status, output) => rpc.finalizeSession(runId, status, output)
          },
          input: { userPrompt: prompt, tabId, url },
          settings,
          systemPrompt: buildSystemPrompt({ url }),
          tools: TOOL_DEFS,
          approveAllSafe: session.approveAllSafe,
          abortSignal: ac.signal,
          onEvent,
          initialMessages: initialContext ? [{ role: "user", content: initialContext }] : undefined
        });
      } catch (e) {
        session.setError(e instanceof Error ? e.message : String(e));
        session.setStatus("error");
      } finally {
        approverRef.current.resolveAllPending({ kind: "deny" });
        session.setAbortController(null);
      }
    },
    [session, settings, initialContext]
  );

  // 失败修复入口预填后自动发一次（仅一次）
  useEffect(() => {
    if (initialPrompt && !initialSentRef.current) {
      initialSentRef.current = true;
      // 不自动发，仅预填，让用户检查后自己点
    }
  }, [initialPrompt]);

  return (
    <div className="h-full flex flex-col">
      <RecommendationsBanner
        tools={recommendations}
        onRun={async (id) => {
          const { tabId } = await currentTabInfo();
          await rpc.runTool(id, tabId);
        }}
      />
      <StatusBar
        status={session.status}
        roundCount={session.roundCount}
        maxRounds={settings.maxRounds}
        tokenUsage={session.tokenUsage}
        onAbort={() => session.abortController?.abort()}
      />
      {session.errorMessage && (
        <div className="bg-red-900/40 border-b border-red-800 p-2 text-xs text-red-200">
          {session.errorMessage}
        </div>
      )}
      <ChatView onApprove={handleApprove} />
      <div className="border-t border-zinc-800 p-2 flex flex-col gap-2">
        <label className="flex items-center gap-1 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={session.approveAllSafe}
            onChange={(e) => session.setApproveAllSafe(e.target.checked)}
          />
          自动通过 safe + caution
        </label>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={"描述要采集什么…（如：把主图、详情图、前 50 条评论拿出来）"}
          rows={3}
          className="bg-zinc-900 rounded p-2 text-xs resize-none"
        />
        <div className="flex justify-end">
          <button
            onClick={() => send(input)}
            disabled={
              session.status === "streaming" ||
              session.status === "awaiting" ||
              session.status === "running" ||
              !input.trim()
            }
            className="px-3 py-1 bg-emerald-700 rounded disabled:opacity-50"
          >
            发送
          </button>
        </div>
      </div>
      {session.showSaveDialog && (
        <SaveAsToolDialog
          initialName={
            recommendations[0]?.name ?? `采集器 ${new Date().toISOString().slice(0, 10)}`
          }
          initialDescription={
            session.messages
              .filter((m): m is Extract<typeof m, { role: "assistant" }> => m.role === "assistant")
              .at(-1)
              ?.content.find((c): c is { type: "text"; text: string } => c.type === "text")
              ?.text.slice(0, 200) ?? ""
          }
          initialUrl={session.url}
          steps={session.executedSteps}
          lastOutput={session.lastOutput}
          onClose={() => session.hideSave()}
          onSaved={() => {
            session.hideSave();
          }}
        />
      )}
    </div>
  );
}

```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0（如有错按提示修——`Json` import 已加；`stepFromCard` 类型 cast 较粗，可保留 `as` 强制）。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/pages/chat-page.tsx
git commit -m "feat(sidepanel): chat page with full session loop wiring"
```

---

## Task 24: app.tsx 接入 ChatPage + 失败修复入口

**Files:**
- Modify: `src/sidepanel/app.tsx`
- Modify: `src/sidepanel/pages/tool-detail-page.tsx`

- [ ] **Step 1: 重写 `src/sidepanel/app.tsx`**

```tsx
// src/sidepanel/app.tsx
import { useState } from "react";
import { ChatPage } from "./pages/chat-page";
import { RunPage } from "./pages/run-page";
import { SettingsPage } from "./pages/settings-page";
import { ToolDetailPage } from "./pages/tool-detail-page";
import { ToolsPage } from "./pages/tools-page";

type Route =
  | { name: "chat"; initialPrompt?: string; initialContext?: string }
  | { name: "run" }
  | { name: "tools" }
  | { name: "tool"; id: string }
  | { name: "settings" };

export function App() {
  const [route, setRoute] = useState<Route>({ name: "chat" });

  function fixWithAi(opts: { initialPrompt: string; initialContext: string }) {
    setRoute({ name: "chat", initialPrompt: opts.initialPrompt, initialContext: opts.initialContext });
  }

  return (
    <div className="h-full flex flex-col">
      <nav className="flex gap-1 p-2 border-b border-zinc-800 text-xs">
        <NavBtn active={route.name === "chat"} onClick={() => setRoute({ name: "chat" })}>
          对话
        </NavBtn>
        <NavBtn active={route.name === "tools" || route.name === "tool"} onClick={() => setRoute({ name: "tools" })}>
          工具库
        </NavBtn>
        <NavBtn active={route.name === "run"} onClick={() => setRoute({ name: "run" })}>
          DEV: JSON
        </NavBtn>
        <NavBtn active={route.name === "settings"} onClick={() => setRoute({ name: "settings" })}>
          设置
        </NavBtn>
      </nav>
      <main className="flex-1 overflow-hidden">
        {route.name === "chat" && (
          <ChatPage
            key={(route.initialPrompt ?? "") + (route.initialContext ?? "")}
            initialPrompt={route.initialPrompt}
            initialContext={route.initialContext}
          />
        )}
        {route.name === "run" && <RunPage />}
        {route.name === "tools" && <ToolsPage onOpen={(id) => setRoute({ name: "tool", id })} />}
        {route.name === "tool" && (
          <ToolDetailPage
            id={route.id}
            onBack={() => setRoute({ name: "tools" })}
            onFixWithAi={fixWithAi}
          />
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

- [ ] **Step 2: 修改 `src/sidepanel/pages/tool-detail-page.tsx`**

```tsx
// src/sidepanel/pages/tool-detail-page.tsx
import { useEffect, useState } from "react";
import type { RunRecord, Tool } from "@/shared/types";
import { ResultView } from "../components/result-view";
import { StepList } from "../components/step-list";
import { currentTabId, rpc } from "../rpc";

type Props = {
  id: string;
  onBack: () => void;
  onFixWithAi?: (opts: { initialPrompt: string; initialContext: string }) => void;
};

export function ToolDetailPage(props: Props) {
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

  function onFix() {
    if (!run || !tool || !props.onFixWithAi) return;
    const failedEntry = run.stepLog.find((e) => e.error);
    const initialPrompt = `工具「${tool.name} v${tool.versions.at(-1)?.version}」第 ${
      failedEntry?.stepIndex ?? "?"
    } 步失败：\n- step: ${JSON.stringify(failedEntry?.input)}\n- 错误: ${
      failedEntry?.error ?? "(未知)"
    }\n\n请基于当前页面 DOM 重新设计这一步（或整个工具）。`;
    const initialContext = `# 工具「${tool.name}」原 steps:\n\`\`\`json\n${JSON.stringify(
      tool.steps,
      null,
      2
    )}\n\`\`\`\n# 当前 URL: ${run.url}`;
    props.onFixWithAi({ initialPrompt, initialContext });
  }

  if (err) return <div className="p-3 text-red-400 text-xs">{err}</div>;
  if (!tool) return <div className="p-3 text-zinc-400 text-xs">加载中…</div>;

  const failed = run && run.status === "error";

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
      {failed && props.onFixWithAi && (
        <button
          onClick={onFix}
          className="self-start px-3 py-1 bg-amber-700 rounded"
        >
          让 AI 修复
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 退出码 0。

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/app.tsx src/sidepanel/pages/tool-detail-page.tsx
git commit -m "feat(sidepanel): wire chat page as default + fix-with-AI from tool detail"
```

---

## Task 25: 更新 README + Plan 2 手测脚本

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 重写 `README.md`**

```markdown
# aipagego2 — AI 网页采集器（Plan 2：对话采集与工具固化）

## 装载

```bash
pnpm install
pnpm build
```

1. `chrome://extensions` → 「开发者模式」 → 「加载已解压的扩展程序」选 `dist/`
2. 任意页面右上角点扩展图标 → 侧边面板打开

## 基本用法

1. 打开「设置」页：
   - Provider 选 Anthropic 或 OpenAI
   - 填入 API Key（建议先选「仅本次会话保存」）
   - 选模型（默认是 claude-sonnet-4-6 / gpt-4o-mini）
2. 切到「对话」页（默认）：
   - 在底部输入要采集什么，例如：「把主图、详情图、前 30 条评论拿出来」
   - 点「发送」
3. AI 会调用一组工具：safe 自动跑（snapshotDOM / extractText / extractImages 等）；caution / dangerous 工具弹卡片等你点「✓ 通过」/「⊘ 跳过」/「✕ 终止」
4. 完成后顶部出现「保存为工具」对话框：填名称 / URL 模式 / 描述 → 保存到工具库
5. 下次打开同模式 URL，面板顶部 banner 推荐重放，扩展图标也会有角标

## 失败修复

工具详情页跑工具失败时，点「让 AI 修复」会跳到对话页，预填错误上下文，点「发送」让 AI 改新版本。

## DEV 入口

「DEV: JSON」页保留 Plan 1 的"粘 JSON 跑工具"功能，方便调试。

## 测试

```bash
pnpm test            # 全量
pnpm test:watch
```

## Plan 2 手测脚本

需要真 API Key 的端到端验证：

1. 打开 https://shop.example.com/goods.html?goods_id=<任一商品>
2. 侧边面板「对话」页输入：「把主图和标题拿出来」
3. 期望：
   - AI 流式回文本，`snapshotDOM` 卡片自动通过、`querySelector*` / `extractImages` 自动通过
   - 顶部状态条显示 round 数 / token 数
   - 完成后弹「保存为工具」
4. 保存为工具后回「工具库」→ 详情页 → 「在当前 tab 运行」应能成功重放
5. 把 step 里的 selector 改坏（详情页 → 编辑工具 v1 暂未实现，可用 DEV: JSON 临时构造一个失败工具），运行失败 → 「让 AI 修复」→ 对话页预填上下文 → 发送 → AI 给新 steps → 保存为新版本
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README for Plan 2 (chat-driven collection)"
```

---

## Task 26: 全量回归

**Files:** 无

- [ ] **Step 1: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 2: 全量单元测试**

Run: `pnpm test`
Expected: 退出码 0。所有测试 PASS：
- Plan 1 已有 51 个
- 新增：static-scan (10) + infer-json-schema (5) + tab-watcher (4) + anthropic-stream (3) + openai-stream (3) + severity (7) + run-session (4) = 36
- 合计 87 个 test。

- [ ] **Step 3: 构建**

Run: `pnpm build`
Expected: 退出码 0；`dist/manifest.json` 含 `host_permissions` 包括两个 LLM 域、`permissions` 含 `webNavigation`。

- [ ] **Step 4: 手测验证（须真 API Key）**

按 README "Plan 2 手测脚本" 五步走。如失败记录控制台错误（service worker / 侧边面板 / content）。

- [ ] **Step 5: 收尾 commit（如手测发现 bug 修补）**

```bash
# 通常无新文件
echo "Plan 2 complete"
```

---

## 自检清单

- [ ] 全量单元测试通过（87 个）
- [ ] 类型检查通过
- [ ] dist 可装载，对话流程跑通：流式文本、step 卡审阅、保存对话框
- [ ] tab URL 切换 → action icon 角标正确刷新
- [ ] 商品详情页 banner 推荐能重放保存的工具
- [ ] 失败修复入口能跳转 ChatPage 并预填上下文
- [ ] runJS 含 `document.cookie` 时卡片红框 + 不能自动通过

完成后即可启动 Plan 3（动态权限请求 / 多模态 / 自动备份 / e2e）。
