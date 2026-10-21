# MCP Playwright Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AIPageGo's MCP bridge a functional replacement for `@playwright/mcp --extension` by adding a page-event recorder subsystem, 11 new built-in tools, and full built-in exposure over MCP.

**Architecture:** A new `page-recorder` subsystem records console, network, and dialog events with two interchangeable backends — a MAIN-world content script (default, installed via dynamic `chrome.scripting.registerContentScripts`) and an opt-in `chrome.debugger` CDP backend that auto-degrades to MAIN-world on attach failure. Separately, sidepanel-only meta tools are lowered into the background service worker so the coordinator/MCP `EXEC` path can reach them, and `tool-gen` flips from a 19-name allow-list to a 3-name block-list.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest + happy-dom, Chrome MV3 (`chrome.scripting`, `chrome.debugger`, `chrome.tabs`, `chrome.downloads`), `@modelcontextprotocol/sdk`, zod.

**Spec:** [`../specs/2026-08-17-mcp-playwright-parity-design.md`](../specs/2026-08-17-mcp-playwright-parity-design.md)

## Global Constraints

- Ring buffer sizes: console 500, network 300, dialog 100. Overflow drops oldest and increments a `dropped` counter returned on every read.
- Console argument serialisation: depth-limited, cycle-safe, 2 KB cap per argument. `Error` values keep `name`, `message`, `stack`.
- Network response body capture: **off by default**; when armed, capped at 256 KB and gated on a text-ish content type.
- Dialog patches are **passthrough by default** — until armed, `alert`/`confirm`/`prompt` behave exactly as unpatched.
- Recorder buffers are in-memory only. Never written to IndexedDB, never included in "export tool library".
- `debugger` goes in `optional_permissions`, never `permissions`.
- Every recorder read result carries `backend: "main-world" | "cdp"` and, when degraded, `degradedReason: string`.
- Recorder reads never throw for backend reasons. Disabled recorder returns an empty result plus a reason.
- MCP block-list is exactly `askUser`, `attachTab`, `detachTab`.
- `AIPAGEGO_MCP_TOOLS` defaults to `full`; the only other accepted value is `parity`.
- The MCP session permission posture does not change: `handleOpenSession` still grants the full capability scope by default.
- `packages/shared` must stay free of `chrome.*` and DOM globals — pure types and functions only.
- Never write non-MCP output to stdout in `packages/mcp-server`; logs go to stderr.

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `packages/shared/src/recorder/types.ts` | `RecorderBackend`, `ConsoleEntry`, `NetworkEntry`, `DialogEntry`, read-result and config shapes |
| `packages/shared/src/recorder/ring.ts` | Generic ring buffer with `dropped` accounting |
| `packages/shared/src/recorder/serialize.ts` | Depth/cycle/size-capped value serialiser |
| `packages/shared/src/recorder/filter.ts` | Pure filtering for `readConsole` / `readNetwork` queries |
| `packages/shared/src/recorder/index.ts` | Barrel |
| `packages/extension/src/content/recorder/main-world.ts` | The MAIN-world recorder script (console + network + dialog patches) |
| `packages/extension/src/content/recorder/drain.ts` | Isolated-world drain helpers that call `injectMain` |
| `packages/extension/src/content/tools/drag.ts` | `drag` |
| `packages/extension/src/content/tools/drop.ts` | `drop` |
| `packages/extension/src/content/tools/find-elements.ts` | `findElements` |
| `packages/extension/src/background/meta-tool-router.ts` | Background-side dispatch for meta tools so `EXEC` can reach them |
| `packages/extension/src/background/bg-tools/tabs.ts` | `listTabs`/`openTab`/`closeTab`/`switchToTab` in the SW |
| `packages/extension/src/background/bg-tools/nav.ts` | `navigateBack`/`navigateForward`/`resize` |
| `packages/extension/src/background/bg-tools/capture.ts` | `screenshot` (viewport + full-page stitch) in the SW |
| `packages/extension/src/background/bg-tools/downloads.ts` | `downloadImage`/`downloadSpreadsheet` via `data:` URLs |
| `packages/extension/src/background/bg-tools/search.ts` | `searchBookmarks`/`searchHistory` |
| `packages/extension/src/background/recorder/host.ts` | Backend selection, degradation, per-tab recorder registry |
| `packages/extension/src/background/recorder/cdp.ts` | `CdpRecorder` |
| `packages/extension/src/background/recorder/main-world-host.ts` | `MainWorldRecorder` host side (registration + drain) |

**Modified**

| Path | Change |
|---|---|
| `packages/shared/src/types.ts:11-56` | 11 new `BuiltinTool` members |
| `packages/shared/src/capability/catalog.ts` | 3 new capabilities + tier sets |
| `packages/shared/src/capability/tool-mapping.ts` | Exhaustive switch arms for the 11 new tools |
| `packages/shared/src/llm/builtin-tool-defs.ts` | 11 new `TOOL_DEFS` entries; extend `click`/`fillInput`/`screenshot`/`waitFor` schemas |
| `packages/shared/src/protocol/messages.ts:23` | `HELLO.supported_tools?: string[]` |
| `packages/extension/src/content/tools/index.ts` | Register `drag`/`drop`/`findElements` |
| `packages/extension/src/content/tools/click.ts` | `doubleClick`/`button`/`modifiers` |
| `packages/extension/src/content/tools/fill-input.ts` | `slowly`/`submit` |
| `packages/extension/src/content/tools/wait-for.ts` | `text`/`textGone` |
| `packages/extension/src/background/rpc-handlers.ts:186-235` | Route meta and recorder tools before the content-script hop |
| `packages/extension/src/background/coordinator-hello.ts` | Emit `supported_tools` |
| `packages/extension/src/sidepanel/chat/run-session.ts:391,505-600` | Delegate meta tools to the background router |
| `packages/extension/src/sidepanel/lib/meta-tools.ts` | Thin wrapper over the background router |
| `packages/mcp-server/src/tool-gen.ts` | Block-list, `resultKind`, `parity` set |
| `packages/mcp-server/src/mcp-server.ts:12,25` | Image `CallResult`, tool-list intersection |
| `packages/mcp-server/src/handlers.ts:45-62` | `runJS` step-kind special case, new capability opts |
| `skill/SKILL.md` | New tools, arming model, backend fidelity |
| `README.md`, `packages/mcp-server/README.md` | Tool counts and recorder docs |

---

## Phase 1 — Shared foundations

### Task 1: Recorder ring buffer and serialiser

**Files:**
- Create: `packages/shared/src/recorder/types.ts`
- Create: `packages/shared/src/recorder/ring.ts`
- Create: `packages/shared/src/recorder/serialize.ts`
- Create: `packages/shared/src/recorder/index.ts`
- Test: `packages/shared/tests/recorder/ring.test.ts`
- Test: `packages/shared/tests/recorder/serialize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Ring<T>` with `push(item): void`, `readonly dropped: number`, `toArray(): T[]`, `clear(): void`; `serializeArg(value: unknown, opts?: {maxDepth?: number; maxBytes?: number}): string`; the type surface below.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/tests/recorder/ring.test.ts
import { describe, expect, it } from "vitest";
import { Ring } from "../../src/recorder/ring";

describe("Ring", () => {
  it("keeps insertion order under capacity", () => {
    const r = new Ring<number>(3);
    r.push(1); r.push(2);
    expect(r.toArray()).toEqual([1, 2]);
    expect(r.dropped).toBe(0);
  });

  it("drops oldest and counts drops past capacity", () => {
    const r = new Ring<number>(3);
    for (const n of [1, 2, 3, 4, 5]) r.push(n);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.dropped).toBe(2);
  });

  it("clear resets contents but keeps the drop counter", () => {
    const r = new Ring<number>(2);
    for (const n of [1, 2, 3]) r.push(n);
    r.clear();
    expect(r.toArray()).toEqual([]);
    expect(r.dropped).toBe(1);
  });
});
```

```ts
// packages/shared/tests/recorder/serialize.test.ts
import { describe, expect, it } from "vitest";
import { serializeArg } from "../../src/recorder/serialize";

describe("serializeArg", () => {
  it("renders primitives", () => {
    expect(serializeArg("hi")).toBe("hi");
    expect(serializeArg(42)).toBe("42");
    expect(serializeArg(null)).toBe("null");
    expect(serializeArg(undefined)).toBe("undefined");
  });

  it("keeps name, message and stack for errors", () => {
    const e = new Error("boom");
    e.stack = "Error: boom\n    at x";
    const out = serializeArg(e);
    expect(out).toContain("Error");
    expect(out).toContain("boom");
    expect(out).toContain("at x");
  });

  it("survives cycles", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(serializeArg(a)).toContain("[Circular]");
  });

  it("truncates past maxDepth", () => {
    expect(serializeArg({ a: { b: { c: { d: 1 } } } }, { maxDepth: 2 })).toContain("[Object]");
  });

  it("caps output size and marks the cut", () => {
    const out = serializeArg("x".repeat(5000), { maxBytes: 100 });
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toContain("truncated");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F @aipagego/shared test -- recorder`
Expected: FAIL — cannot resolve `../../src/recorder/ring`.

- [ ] **Step 3: Write `types.ts`**

```ts
export type RecorderBackend = "main-world" | "cdp";
export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug" | "trace";

export type ConsoleEntry = {
  id: number;
  ts: number;
  level: ConsoleLevel;
  text: string;
  stack?: string;
  url?: string;
  line?: number;
};

export type NetworkEntry = {
  id: number;
  ts: number;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  ms?: number;
  resourceType?: string;
  /** true when sourced from PerformanceObserver rather than a wrapped call */
  observed?: boolean;
  transferSize?: number;
  error?: string;
};

export type NetworkPart = "request-headers" | "request-body" | "response-headers" | "response-body";

export type NetworkDetail = NetworkEntry & {
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  bodyUnavailable?: string;
};

export type DialogEntry = {
  id: number;
  ts: number;
  kind: "alert" | "confirm" | "prompt";
  message: string;
  defaultValue?: string;
  handled: "passthrough" | "accepted" | "dismissed";
  promptText?: string;
};

export type RecorderConfig = {
  console: boolean;
  network: boolean;
  /** response/request body capture; implies read:network-body */
  bodies: boolean;
  /** when false, alert/confirm/prompt run unpatched */
  dialog: boolean;
};

export const DEFAULT_RECORDER_CONFIG: RecorderConfig = {
  console: true,
  network: true,
  bodies: false,
  dialog: false
};

export const RING_SIZES = { console: 500, network: 300, dialog: 100 } as const;

export type BackendTag = { backend: RecorderBackend; degradedReason?: string; disabled?: string };

export type ConsoleReadResult = BackendTag & { dropped: number; messages: ConsoleEntry[] };
export type NetworkReadResult = BackendTag & { dropped: number; requests: NetworkEntry[] };
export type DialogReadResult = BackendTag & { dropped: number; dialogs: DialogEntry[] };

export type ConsoleQuery = { level?: ConsoleLevel; limit?: number; sinceId?: number };
export type NetworkQuery = {
  urlPattern?: string;
  method?: string;
  status?: number;
  includeStatic?: boolean;
  limit?: number;
  sinceId?: number;
};
```

- [ ] **Step 4: Write `ring.ts`**

```ts
export class Ring<T> {
  private items: T[] = [];
  private droppedCount = 0;

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error("Ring capacity must be >= 1");
  }

  push(item: T): void {
    this.items.push(item);
    while (this.items.length > this.capacity) {
      this.items.shift();
      this.droppedCount += 1;
    }
  }

  get dropped(): number {
    return this.droppedCount;
  }

  toArray(): T[] {
    return this.items.slice();
  }

  clear(): void {
    this.items = [];
  }
}
```

- [ ] **Step 5: Write `serialize.ts`**

```ts
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_BYTES = 2048;

export function serializeArg(
  value: unknown,
  opts?: { maxDepth?: number; maxBytes?: number }
): string {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const seen = new WeakSet<object>();
  const text = render(value, 0, maxDepth, seen);
  return text.length > maxBytes ? `${text.slice(0, maxBytes)}…[truncated ${text.length - maxBytes}B]` : text;
}

function render(value: unknown, depth: number, maxDepth: number, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "string") return value as string;
  if (t === "number" || t === "boolean" || t === "bigint") return String(value);
  if (t === "symbol") return (value as symbol).toString();
  if (t === "function") return `[Function ${(value as { name?: string }).name || "anonymous"}]`;

  const obj = value as object;
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
  }
  if (seen.has(obj)) return "[Circular]";
  if (depth >= maxDepth) return Array.isArray(value) ? "[Array]" : "[Object]";
  seen.add(obj);

  if (Array.isArray(value)) {
    return `[${value.map((v) => render(v, depth + 1, maxDepth, seen)).join(", ")}]`;
  }
  const entries = Object.entries(obj as Record<string, unknown>).map(
    ([k, v]) => `${k}: ${render(v, depth + 1, maxDepth, seen)}`
  );
  return `{${entries.join(", ")}}`;
}
```

- [ ] **Step 6: Write `index.ts`**

```ts
export * from "./types";
export * from "./ring";
export * from "./serialize";
```

- [ ] **Step 7: Add the subpath export**

In `packages/shared/package.json`, add `"./recorder": "./src/recorder/index.ts"` to `exports`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm -F @aipagego/shared test -- recorder`
Expected: PASS, 8 tests.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/recorder packages/shared/tests/recorder packages/shared/package.json
git commit -m "feat(recorder): ring buffer, value serialiser and shared types"
```

### Task 2: Recorder query filtering

**Files:**
- Create: `packages/shared/src/recorder/filter.ts`
- Modify: `packages/shared/src/recorder/index.ts`
- Test: `packages/shared/tests/recorder/filter.test.ts`

**Interfaces:**
- Consumes: `ConsoleEntry`, `NetworkEntry`, `ConsoleQuery`, `NetworkQuery` from Task 1.
- Produces: `filterConsole(entries: ConsoleEntry[], q: ConsoleQuery): ConsoleEntry[]` and `filterNetwork(entries: NetworkEntry[], q: NetworkQuery): NetworkEntry[]`. Both apply `sinceId` first, then field predicates, then take the **last** `limit` entries (most recent wins). `urlPattern` is a case-insensitive substring match unless it is wrapped in slashes (`/re/` or `/re/i`), in which case it is a regex. Invalid regex falls back to substring matching rather than throwing. `includeStatic` defaults to `false`, which drops entries with `observed === true`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/tests/recorder/filter.test.ts
import { describe, expect, it } from "vitest";
import { filterConsole, filterNetwork } from "../../src/recorder/filter";
import type { ConsoleEntry, NetworkEntry } from "../../src/recorder/types";

const c = (id: number, level: ConsoleEntry["level"], text: string): ConsoleEntry =>
  ({ id, ts: id, level, text });
const n = (id: number, url: string, extra: Partial<NetworkEntry> = {}): NetworkEntry =>
  ({ id, ts: id, method: "GET", url, ...extra });

describe("filterConsole", () => {
  const all = [c(1, "log", "a"), c(2, "error", "b"), c(3, "warn", "c"), c(4, "error", "d")];

  it("filters by level", () => {
    expect(filterConsole(all, { level: "error" }).map((e) => e.id)).toEqual([2, 4]);
  });

  it("drops entries at or below sinceId", () => {
    expect(filterConsole(all, { sinceId: 2 }).map((e) => e.id)).toEqual([3, 4]);
  });

  it("keeps the most recent entries when limited", () => {
    expect(filterConsole(all, { limit: 2 }).map((e) => e.id)).toEqual([3, 4]);
  });
});

describe("filterNetwork", () => {
  const all = [
    n(1, "https://a.test/api/users"),
    n(2, "https://a.test/style.css", { observed: true }),
    n(3, "https://b.test/api/orders", { method: "POST", status: 500 }),
    n(4, "https://b.test/api/users", { status: 200 })
  ];

  it("hides observed entries unless includeStatic", () => {
    expect(filterNetwork(all, {}).map((e) => e.id)).toEqual([1, 3, 4]);
    expect(filterNetwork(all, { includeStatic: true }).map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });

  it("matches urlPattern as a substring", () => {
    expect(filterNetwork(all, { urlPattern: "/api/users" }).map((e) => e.id)).toEqual([1, 4]);
  });

  it("matches urlPattern as a regex when slash-wrapped", () => {
    expect(filterNetwork(all, { urlPattern: "/b\\.test.*orders/" }).map((e) => e.id)).toEqual([3]);
  });

  it("falls back to substring on an invalid regex", () => {
    expect(filterNetwork(all, { urlPattern: "/[unclosed/" })).toEqual([]);
  });

  it("filters by method and status", () => {
    expect(filterNetwork(all, { method: "post" }).map((e) => e.id)).toEqual([3]);
    expect(filterNetwork(all, { status: 200 }).map((e) => e.id)).toEqual([4]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @aipagego/shared test -- recorder/filter`
Expected: FAIL — cannot resolve `../../src/recorder/filter`.

- [ ] **Step 3: Write `filter.ts`**

```ts
import type { ConsoleEntry, ConsoleQuery, NetworkEntry, NetworkQuery } from "./types";

function tail<T>(items: T[], limit?: number): T[] {
  if (limit == null || limit <= 0 || items.length <= limit) return items;
  return items.slice(items.length - limit);
}

function matchUrl(url: string, pattern: string): boolean {
  const re = pattern.match(/^\/(.*)\/([a-z]*)$/);
  if (re) {
    try {
      return new RegExp(re[1], re[2] || undefined).test(url);
    } catch {
      // fall through to substring matching on an invalid pattern
    }
  }
  return url.toLowerCase().includes(pattern.toLowerCase());
}

export function filterConsole(entries: ConsoleEntry[], q: ConsoleQuery): ConsoleEntry[] {
  let out = entries;
  if (q.sinceId != null) out = out.filter((e) => e.id > q.sinceId!);
  if (q.level) out = out.filter((e) => e.level === q.level);
  return tail(out, q.limit);
}

export function filterNetwork(entries: NetworkEntry[], q: NetworkQuery): NetworkEntry[] {
  let out = entries;
  if (q.sinceId != null) out = out.filter((e) => e.id > q.sinceId!);
  if (!q.includeStatic) out = out.filter((e) => e.observed !== true);
  if (q.method) {
    const m = q.method.toUpperCase();
    out = out.filter((e) => e.method.toUpperCase() === m);
  }
  if (q.status != null) out = out.filter((e) => e.status === q.status);
  if (q.urlPattern) out = out.filter((e) => matchUrl(e.url, q.urlPattern!));
  return tail(out, q.limit);
}
```

- [ ] **Step 4: Export it from the barrel**

Add `export * from "./filter";` to `packages/shared/src/recorder/index.ts`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -F @aipagego/shared test -- recorder`
Expected: PASS, 16 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/recorder packages/shared/tests/recorder
git commit -m "feat(recorder): console and network query filtering"
```

### Task 3: New built-in tool names and capability tiers

**Files:**
- Modify: `packages/shared/src/types.ts:11-56`
- Modify: `packages/shared/src/capability/catalog.ts`
- Modify: `packages/shared/src/capability/tool-mapping.ts`
- Test: `packages/shared/tests/capability/tool-mapping.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: 11 new `BuiltinTool` members — `consoleMessages`, `networkRequests`, `networkRequestDetail`, `handleDialog`, `recorderConfig`, `navigateBack`, `navigateForward`, `resize`, `drag`, `drop`, `findElements`. Three new `Capability` members — `read:console`, `read:network`, `read:network-body`. `capabilityForTool` gains two opts fields: `dropHasFiles?: boolean` and `recorderArmsBodies?: boolean`, alongside the existing `httpCookied` and `runJsUnsafe`.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/shared/tests/capability/tool-mapping.test.ts
import { capabilityForTool } from "../../src/capability/tool-mapping";
import { DANGEROUS_CAPABILITIES, IMPLICIT_CAPABILITIES } from "../../src/capability/catalog";

describe("parity tools", () => {
  it("maps recorder reads to their tiers", () => {
    expect(capabilityForTool("consoleMessages")).toBe("read:console");
    expect(capabilityForTool("networkRequests")).toBe("read:network");
    expect(capabilityForTool("networkRequestDetail")).toBe("read:network-body");
  });

  it("treats console reads as implicitly safe and bodies as dangerous", () => {
    expect(IMPLICIT_CAPABILITIES.has("read:console")).toBe(true);
    expect(DANGEROUS_CAPABILITIES.has("read:network-body")).toBe(true);
    expect(DANGEROUS_CAPABILITIES.has("read:network")).toBe(false);
  });

  it("escalates drop when it carries files", () => {
    expect(capabilityForTool("drop")).toBe("interact:form");
    expect(capabilityForTool("drop", { dropHasFiles: true })).toBe("upload:file");
  });

  it("escalates recorderConfig when it arms body capture", () => {
    expect(capabilityForTool("recorderConfig")).toBe("read:network");
    expect(capabilityForTool("recorderConfig", { recorderArmsBodies: true })).toBe("read:network-body");
  });

  it("maps navigation and interaction helpers", () => {
    expect(capabilityForTool("navigateBack")).toBe("nav:tab");
    expect(capabilityForTool("navigateForward")).toBe("nav:tab");
    expect(capabilityForTool("resize")).toBe("nav:tab");
    expect(capabilityForTool("drag")).toBe("interact:form");
    expect(capabilityForTool("handleDialog")).toBe("interact:form");
    expect(capabilityForTool("findElements")).toBe("read:dom");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @aipagego/shared test -- tool-mapping`
Expected: FAIL — TypeScript rejects `"consoleMessages"` as a `BuiltinTool`.

- [ ] **Step 3: Extend the `BuiltinTool` union**

Append to `packages/shared/src/types.ts` before the closing semicolon on line 56:

```ts
  // Plan 32 — playwright parity
  | "consoleMessages"
  | "networkRequests"
  | "networkRequestDetail"
  | "handleDialog"
  | "recorderConfig"
  | "navigateBack"
  | "navigateForward"
  | "resize"
  | "drag"
  | "drop"
  | "findElements";
```

Then extend the `ReplayableTool` exclusion list with `"consoleMessages" | "networkRequests" | "networkRequestDetail" | "handleDialog" | "recorderConfig"` — recorder state is per-session and not meaningfully replayable. `drag`, `drop`, `findElements`, `navigateBack`, `navigateForward`, and `resize` stay replayable.

- [ ] **Step 4: Extend the capability catalog**

In `packages/shared/src/capability/catalog.ts`, add `"read:console"`, `"read:network"`, `"read:network-body"` to `CAPABILITIES`; add `"read:console"` to `IMPLICIT_CAPABILITIES`; add `"read:network-body"` to `DANGEROUS_CAPABILITIES`.

- [ ] **Step 5: Extend `capabilityForTool`**

Widen the `opts` parameter to `{ httpCookied?: boolean; runJsUnsafe?: boolean; dropHasFiles?: boolean; recorderArmsBodies?: boolean }` and add the switch arms:

```ts
    case "consoleMessages":
      return "read:console";
    case "networkRequests":
      return "read:network";
    case "networkRequestDetail":
      return "read:network-body";
    case "recorderConfig":
      return opts?.recorderArmsBodies ? "read:network-body" : "read:network";
    case "handleDialog":
    case "drag":
      return "interact:form";
    case "drop":
      return opts?.dropHasFiles ? "upload:file" : "interact:form";
    case "navigateBack":
    case "navigateForward":
    case "resize":
      return "nav:tab";
    case "findElements":
      return "read:dom";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm -F @aipagego/shared test && pnpm -F @aipagego/shared typecheck`
Expected: PASS. The exhaustive `default` arm compiles, proving no tool was missed.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src packages/shared/tests
git commit -m "feat(capability): add 11 parity tools and three recorder capabilities"
```

### Task 4: LLM tool definitions for the new and extended tools

**Files:**
- Modify: `packages/shared/src/llm/builtin-tool-defs.ts`
- Test: `packages/shared/tests/llm/builtin-tool-defs.test.ts`

**Interfaces:**
- Consumes: the `BuiltinTool` union from Task 3.
- Produces: `TOOL_DEFS` grows from 46 to 57 entries. Every non-meta entry keeps the existing `tabId: TAB_ID_FIELD` convention so `runOneStep` can retarget. Descriptions follow the existing `[TAG] ...` prefix style; the recorder tools use a new `[OBSERVE]` tag and state the backend caveat.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/tests/llm/builtin-tool-defs.test.ts
import { describe, expect, it } from "vitest";
import { TOOL_DEFS } from "../../src/llm/builtin-tool-defs";

const byName = new Map(TOOL_DEFS.map((t) => [t.name, t]));

describe("parity tool defs", () => {
  const added = [
    "consoleMessages", "networkRequests", "networkRequestDetail", "handleDialog",
    "recorderConfig", "navigateBack", "navigateForward", "resize", "drag", "drop", "findElements"
  ];

  it("defines every new tool exactly once", () => {
    for (const name of added) expect(byName.has(name), name).toBe(true);
    expect(TOOL_DEFS.length).toBe(new Set(TOOL_DEFS.map((t) => t.name)).size);
  });

  it("documents the dialog policy caveat", () => {
    expect(byName.get("handleDialog")!.description).toContain("main-world");
  });

  it("extends click, fillInput, screenshot and waitFor", () => {
    const props = (n: string) => (byName.get(n)!.input_schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props("click"))).toEqual(expect.arrayContaining(["doubleClick", "button", "modifiers"]));
    expect(Object.keys(props("fillInput"))).toEqual(expect.arrayContaining(["slowly", "submit"]));
    expect(Object.keys(props("screenshot"))).toEqual(expect.arrayContaining(["fullPage", "format", "scale"]));
    expect(Object.keys(props("waitFor"))).toEqual(expect.arrayContaining(["text", "textGone"]));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @aipagego/shared test -- builtin-tool-defs`
Expected: FAIL — `consoleMessages` is not defined.

- [ ] **Step 3: Add the 11 new definitions**

Append to the `TOOL_DEFS` array. Use these exact schemas:

```ts
  {
    name: "consoleMessages",
    description:
      "[OBSERVE] 读取本页 console 日志与未捕获错误。返回里带 backend 字段：main-world 档看不到脚本注入之前的消息和浏览器级 CORS/CSP 报错，cdp 档能看到。\n" +
      "示例：只看报错 { level: 'error', limit: 50 }；增量轮询 { sinceId: 前一次返回的最大 id }",
    input_schema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["log", "info", "warn", "error", "debug", "trace"] },
        limit: { type: "integer", default: 100 },
        sinceId: { type: "integer", description: "只返回 id 大于此值的消息，用于增量读取" },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "networkRequests",
    description:
      "[OBSERVE] 列出本页发出的网络请求摘要（method / url / status / 耗时）。默认隐藏 PerformanceObserver 观测到的静态资源，includeStatic:true 才带上。\n" +
      "要看 headers 或 body 用 networkRequestDetail。",
    input_schema: {
      type: "object",
      properties: {
        urlPattern: { type: "string", description: "子串匹配；用 /re/ 或 /re/i 包起来则按正则" },
        method: { type: "string" },
        status: { type: "integer" },
        includeStatic: { type: "boolean", default: false },
        limit: { type: "integer", default: 50 },
        sinceId: { type: "integer" },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "networkRequestDetail",
    description:
      "[OBSERVE] 读取单条请求的 headers 与 body。**dangerous**：响应头里可能有 Authorization / Set-Cookie / token。\n" +
      "main-world 档需先 recorderConfig({bodies:true}) 才会记录 body，且只记 256KB 以内的文本类响应；cdp 档直接可取。",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "networkRequests 返回的条目 id" },
        part: {
          type: "string",
          enum: ["request-headers", "request-body", "response-headers", "response-body"],
          description: "只取其中一部分；省略则全给",
        },
        tabId: TAB_ID_FIELD,
      },
      required: ["id"],
    },
  },
  {
    name: "handleDialog",
    description:
      "[OBSERVE] 设定 alert / confirm / prompt 的应答策略，并返回已记录的弹窗。\n" +
      "main-world 档下弹窗是**同步**的，无法挂起等你决定，所以这里设的是**预先策略**：调用之后发生的弹窗按此处理。cdp 档下弹窗真挂起，本调用会立即应答当前挂起的弹窗。\n" +
      "未调用过本工具时，弹窗保持原生行为（passthrough），页面表现与没装扩展一致。",
    input_schema: {
      type: "object",
      properties: {
        accept: { type: "boolean", description: "true=确定，false=取消" },
        promptText: { type: "string", description: "prompt 弹窗填入的文本" },
        scope: { type: "string", enum: ["next", "all"], default: "next" },
        tabId: TAB_ID_FIELD,
      },
      required: ["accept"],
    },
  },
  {
    name: "recorderConfig",
    description:
      "[OBSERVE] 开关页面事件录制。bodies:true 打开请求/响应 body 捕获（默认关，有内存代价）；dialog:true 让弹窗走策略而不是原生行为；clear 清空缓冲。省略的字段保持原样。",
    input_schema: {
      type: "object",
      properties: {
        console: { type: "boolean" },
        network: { type: "boolean" },
        bodies: { type: "boolean" },
        dialog: { type: "boolean" },
        clear: {
          type: "array",
          items: { type: "string", enum: ["console", "network", "dialog"] },
        },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "navigateBack",
    description: "[FLOW] 后退一页（chrome.tabs.goBack）。已在历史起点时返回 { ok:false, reason }，不抛错。",
    input_schema: { type: "object", properties: { tabId: TAB_ID_FIELD } },
  },
  {
    name: "navigateForward",
    description: "[FLOW] 前进一页（chrome.tabs.goForward）。已在历史末尾时返回 { ok:false, reason }，不抛错。",
    input_schema: { type: "object", properties: { tabId: TAB_ID_FIELD } },
  },
  {
    name: "resize",
    description:
      "[FLOW] 把视口调整到指定尺寸。main-world 档通过量取 outerWidth-innerWidth 反推浏览器边框后改窗口外框，视口精确但**用户的窗口会真的变大小**；cdp 档用 Emulation 覆盖设备尺寸，不动真实窗口。",
    input_schema: {
      type: "object",
      properties: {
        width: { type: "integer" },
        height: { type: "integer" },
        tabId: TAB_ID_FIELD,
      },
      required: ["width", "height"],
    },
  },
  {
    name: "drag",
    description:
      "[ACT] 把一个元素拖到另一个元素上。同时发 pointer 序列和 HTML5 DragEvent（共用一个 DataTransfer），兼容原生拖放和自定义 pointer 拖放。\n" +
      "返回 { consumed: { pointer, html5 } } 说明目标实际消费了哪一类事件——都为 false 说明这个拖放实现两条路都不吃。",
    input_schema: {
      type: "object",
      properties: {
        fromSelector: { type: "string" },
        fromUid: { type: "string", description: "takeSnapshot / findElements 返回的 uid" },
        toSelector: { type: "string" },
        toUid: { type: "string" },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "drop",
    description:
      "[ACT] 模拟从浏览器外部把文件或数据拖放到页面元素上。带 files 时等同上传（dangerous）。\n" +
      "示例：{ selector:'#dropzone', files:[{ name:'a.csv', mimeType:'text/csv', base64:'...' }] }",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        uid: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              mimeType: { type: "string" },
              base64: { type: "string" },
            },
            required: ["name", "base64"],
          },
        },
        data: { type: "object", description: "MIME → 字符串，例如 { 'text/plain':'hi' }" },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "findElements",
    description:
      "[READ] 按文本或正则在可交互元素里找目标，返回 uid / role / name / bounds。不需要先 createPageIndex。\n" +
      "拿到 uid 后用 clickByUid / fillByUid 操作最稳。",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "大小写不敏感子串" },
        regex: { type: "string", description: "与 text 二选一" },
        limit: { type: "integer", default: 20 },
        tabId: TAB_ID_FIELD,
      },
    },
  },
```

- [ ] **Step 4: Extend the four existing schemas**

Add to `click.input_schema.properties`:

```ts
        doubleClick: { type: "boolean", default: false },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        modifiers: { type: "array", items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] } },
```

Add to `fillInput.input_schema.properties`:

```ts
        slowly: { type: "boolean", default: false, description: "逐字符触发 keydown/keypress/keyup，对付受控组件" },
        submit: { type: "boolean", default: false, description: "填完按一次 Enter" },
```

Add to `screenshot.input_schema.properties`:

```ts
        fullPage: { type: "boolean", default: false, description: "滚动分段截图后拼接整页" },
        format: { type: "string", enum: ["png", "jpeg"], default: "png" },
        scale: { type: "number", default: 1, description: "0.1–1，缩小可省 token" },
```

Add to `waitFor.input_schema.properties`:

```ts
        text: { type: "string", description: "等待页面出现该文本" },
        textGone: { type: "string", description: "等待该文本消失" },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm -F @aipagego/shared test && pnpm -F @aipagego/shared typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/llm packages/shared/tests/llm
git commit -m "feat(tools): define 11 parity tools and extend four existing schemas"
```

## Phase 2 — MAIN-world recorder

### Task 5: Ship a MAIN-world script and prove it builds

**Files:**
- Create: `packages/extension/src/content/recorder/main-world.ts`
- Modify: `packages/extension/src/manifest.ts`
- Test: `packages/extension/tests/manifest.test.ts`

**Interfaces:**
- Consumes: `Ring`, `serializeArg`, `RING_SIZES`, `DEFAULT_RECORDER_CONFIG` from `@aipagego/shared/recorder`.
- Produces: a global `window.__AIPAGEGO_REC__` implementing `{ version: 1; config: RecorderConfig; console: Ring<ConsoleEntry>; network: Ring<NetworkEntry>; dialog: Ring<DialogEntry>; details: Map<number, NetworkDetail>; configure(patch): RecorderConfig; uninstall(): void }`. Later tasks add capture logic; this task only stands up the shell, the global, and the build path.

**Build-path decision — resolve this first, it gates the file layout.**

- [ ] **Step 1: Try dynamic registration**

Add `"src/content/recorder/main-world.ts"` to `web_accessible_resources[0].resources` in `packages/extension/src/manifest.ts`, run `pnpm build`, and check for an emitted asset:

```bash
pnpm build && find packages/extension/dist -name "main-world*" -o -name "*main-world*" | head
```

If a JS asset is emitted, keep dynamic registration: the host will call `chrome.scripting.registerContentScripts({ id: "aipagego-recorder", world: "MAIN", runAt: "document_start", matches: ["<all_urls>"], allFrames: false, js: [<emitted path>], persistAcrossSessions: false })`, and the settings master switch calls `unregisterContentScripts({ ids: ["aipagego-recorder"] })`. Record the emitted path in a comment at the top of `main-world.ts`.

If nothing is emitted, fall back: declare a second `content_scripts` entry in the manifest with `world: "MAIN"`, `run_at: "document_start"`, `matches: ["<all_urls>"]`, `js: ["src/content/recorder/main-world.ts"]`. The master switch then means "the host pushes `uninstall()` to every tab and never drains" rather than "the script never loads". If you take this branch, note the `document_start` race in the settings-page copy and update the spec's Backend 1 section to match — do not leave the spec claiming something the build cannot do.

- [ ] **Step 2: Write the failing manifest test**

```ts
// append to packages/extension/tests/manifest.test.ts
it("does not request the debugger permission up front", () => {
  expect(manifest.permissions).not.toContain("debugger");
  expect(manifest.optional_permissions).toContain("debugger");
});

it("exposes the MAIN-world recorder to the build", () => {
  const war = manifest.web_accessible_resources?.[0]?.resources ?? [];
  const cs = manifest.content_scripts ?? [];
  const declared =
    war.some((r) => r.includes("recorder/main-world")) ||
    cs.some((e) => (e.js ?? []).some((f) => f.includes("recorder/main-world")));
  expect(declared).toBe(true);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm -F @aipagego/extension test -- manifest`
Expected: FAIL — `optional_permissions` is undefined.

- [ ] **Step 4: Add `optional_permissions` to the manifest**

```ts
  optional_permissions: ["debugger"],
```

- [ ] **Step 5: Write the recorder shell**

```ts
// packages/extension/src/content/recorder/main-world.ts
import {
  DEFAULT_RECORDER_CONFIG, RING_SIZES, Ring,
  type ConsoleEntry, type DialogEntry, type NetworkDetail, type NetworkEntry, type RecorderConfig
} from "@aipagego/shared/recorder";

export type RecorderGlobal = {
  version: 1;
  config: RecorderConfig;
  console: Ring<ConsoleEntry>;
  network: Ring<NetworkEntry>;
  dialog: Ring<DialogEntry>;
  details: Map<number, NetworkDetail>;
  nextId(): number;
  configure(patch: Partial<RecorderConfig> & { clear?: Array<"console" | "network" | "dialog"> }): RecorderConfig;
  uninstall(): void;
};

declare global {
  interface Window { __AIPAGEGO_REC__?: RecorderGlobal }
}

function install(): RecorderGlobal {
  let seq = 0;
  const restorers: Array<() => void> = [];
  const rec: RecorderGlobal = {
    version: 1,
    config: { ...DEFAULT_RECORDER_CONFIG },
    console: new Ring<ConsoleEntry>(RING_SIZES.console),
    network: new Ring<NetworkEntry>(RING_SIZES.network),
    dialog: new Ring<DialogEntry>(RING_SIZES.dialog),
    details: new Map<number, NetworkDetail>(),
    nextId: () => (seq += 1),
    configure(patch) {
      const { clear, ...rest } = patch;
      rec.config = { ...rec.config, ...rest };
      for (const kind of clear ?? []) {
        if (kind === "console") rec.console.clear();
        if (kind === "network") { rec.network.clear(); rec.details.clear(); }
        if (kind === "dialog") rec.dialog.clear();
      }
      return rec.config;
    },
    uninstall() {
      while (restorers.length) restorers.pop()!();
      rec.console.clear();
      rec.network.clear();
      rec.dialog.clear();
      rec.details.clear();
      delete window.__AIPAGEGO_REC__;
    }
  };
  // Task 6 pushes console + network restorers here; Task 7 pushes the dialog restorer.
  window.__AIPAGEGO_REC__ = rec;
  return rec;
}

if (!window.__AIPAGEGO_REC__) install();
export { install };
```

- [ ] **Step 6: Run the manifest test and the build**

Run: `pnpm -F @aipagego/extension test -- manifest && pnpm build`
Expected: PASS, and `dist/` contains the recorder asset.

- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/content/recorder packages/extension/src/manifest.ts packages/extension/tests/manifest.test.ts
git commit -m "feat(recorder): MAIN-world recorder shell and optional debugger permission"
```

### Task 6: Console and network capture in the MAIN world

**Files:**
- Modify: `packages/extension/src/content/recorder/main-world.ts`
- Test: `packages/extension/tests/content/recorder/main-world.test.ts`

**Interfaces:**
- Consumes: the `RecorderGlobal` shell and `install()` from Task 5.
- Produces: console entries for `log`/`info`/`warn`/`error`/`debug`/`trace` plus `error` and `unhandledrejection` window events; network entries for `fetch` and `XMLHttpRequest`, and `observed: true` entries from `PerformanceObserver('resource')`. Bodies land in `rec.details` only when `config.bodies` is true, capped at 256 KB and skipped unless the content type matches `/(json|text|xml|javascript|urlencoded|form-data)/i`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/extension/tests/content/recorder/main-world.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { install } from "@/content/recorder/main-world";

describe("main-world recorder", () => {
  let rec: ReturnType<typeof install>;
  beforeEach(() => {
    delete (window as { __AIPAGEGO_REC__?: unknown }).__AIPAGEGO_REC__;
    rec = install();
  });

  it("captures console calls with level and serialised text", () => {
    console.warn("careful", { n: 1 });
    const [entry] = rec.console.toArray();
    expect(entry.level).toBe("warn");
    expect(entry.text).toContain("careful");
    expect(entry.text).toContain("n: 1");
  });

  it("still forwards to the original console", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    console.log("hi");
    expect(spy).toHaveBeenCalledWith("hi");
    spy.mockRestore();
  });

  it("records uncaught errors", () => {
    window.dispatchEvent(new ErrorEvent("error", { message: "kaboom", filename: "a.js", lineno: 7 }));
    const entry = rec.console.toArray().at(-1)!;
    expect(entry.level).toBe("error");
    expect(entry.text).toContain("kaboom");
    expect(entry.line).toBe(7);
  });

  it("records fetch calls with method, url and status", async () => {
    window.fetch = vi.fn(async () => new Response("{}", { status: 201, headers: { "content-type": "application/json" } })) as typeof fetch;
    rec = install();
    await window.fetch("https://a.test/api", { method: "POST" });
    const entry = rec.network.toArray().at(-1)!;
    expect(entry.method).toBe("POST");
    expect(entry.url).toBe("https://a.test/api");
    expect(entry.status).toBe(201);
    expect(typeof entry.ms).toBe("number");
  });

  it("skips response bodies unless armed", async () => {
    window.fetch = vi.fn(async () => new Response("secret", { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;
    rec = install();
    await window.fetch("https://a.test/one");
    expect(rec.details.get(rec.network.toArray().at(-1)!.id)?.responseBody).toBeUndefined();

    rec.configure({ bodies: true });
    await window.fetch("https://a.test/two");
    expect(rec.details.get(rec.network.toArray().at(-1)!.id)?.responseBody).toBe("secret");
  });

  it("records fetch rejections", async () => {
    window.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    rec = install();
    await expect(window.fetch("https://a.test/down")).rejects.toThrow();
    expect(rec.network.toArray().at(-1)!.error).toContain("Failed to fetch");
  });

  it("uninstall restores the originals", () => {
    const patched = console.log;
    rec.uninstall();
    expect(console.log).not.toBe(patched);
    expect(window.__AIPAGEGO_REC__).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @aipagego/extension test -- main-world`
Expected: FAIL — nothing is captured; `rec.console.toArray()` is empty.

- [ ] **Step 3: Implement console capture**

Inside `install()`, before assigning the global:

```ts
  const LEVELS = ["log", "info", "warn", "error", "debug", "trace"] as const;
  for (const level of LEVELS) {
    const original = console[level] as (...a: unknown[]) => void;
    const patched = (...a: unknown[]) => {
      if (rec.config.console) {
        rec.console.push({
          id: rec.nextId(), ts: Date.now(), level,
          text: a.map((v) => serializeArg(v)).join(" ")
        });
      }
      original.apply(console, a);
    };
    (console as Record<string, unknown>)[level] = patched;
    restorers.push(() => { (console as Record<string, unknown>)[level] = original; });
  }

  const onError = (e: ErrorEvent) => {
    if (!rec.config.console) return;
    rec.console.push({
      id: rec.nextId(), ts: Date.now(), level: "error",
      text: e.message, stack: e.error instanceof Error ? e.error.stack : undefined,
      url: e.filename, line: e.lineno
    });
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    if (!rec.config.console) return;
    rec.console.push({
      id: rec.nextId(), ts: Date.now(), level: "error",
      text: `Unhandled rejection: ${serializeArg(e.reason)}`
    });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  restorers.push(() => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  });
```

- [ ] **Step 4: Implement network capture**

```ts
  const BODY_CAP = 256 * 1024;
  const TEXTY = /(json|text|xml|javascript|urlencoded|form-data)/i;

  const captureBody = async (res: Response): Promise<string | undefined> => {
    if (!rec.config.bodies) return undefined;
    const ct = res.headers.get("content-type") ?? "";
    if (!TEXTY.test(ct)) return undefined;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > BODY_CAP) return undefined;
    try {
      const text = await res.clone().text();
      return text.length > BODY_CAP ? text.slice(0, BODY_CAP) : text;
    } catch { return undefined; }
  };

  const headersOf = (h: Headers): Record<string, string> => {
    const out: Record<string, string> = {};
    h.forEach((v, k) => { out[k] = v; });
    return out;
  };

  const originalFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    if (!rec.config.network) return originalFetch.call(window, input, init);
    const id = rec.nextId();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const started = Date.now();
    try {
      const res = await originalFetch.call(window, input, init);
      const entry: NetworkEntry = {
        id, ts: started, method, url, status: res.status,
        statusText: res.statusText, ms: Date.now() - started
      };
      rec.network.push(entry);
      const body = await captureBody(res);
      rec.details.set(id, {
        ...entry,
        requestHeaders: init?.headers ? headersOf(new Headers(init.headers)) : undefined,
        requestBody: rec.config.bodies && typeof init?.body === "string" ? init.body.slice(0, BODY_CAP) : undefined,
        responseHeaders: headersOf(res.headers),
        responseBody: body
      });
      return res;
    } catch (e) {
      const entry: NetworkEntry = {
        id, ts: started, method, url, ms: Date.now() - started,
        error: e instanceof Error ? e.message : String(e)
      };
      rec.network.push(entry);
      rec.details.set(id, entry);
      throw e;
    }
  } as typeof fetch;
  restorers.push(() => { window.fetch = originalFetch; });
```

Wrap `XMLHttpRequest.prototype.open`/`send` with the same shape, stashing `{id, method, url, started}` on the XHR instance and filling the entry from a `loadend` listener (`this.status`, `this.responseText` under the same cap and content-type gate). Push a restorer for each.

Add the observer, guarded because happy-dom lacks it:

```ts
  if (typeof PerformanceObserver !== "undefined") {
    try {
      const obs = new PerformanceObserver((list) => {
        if (!rec.config.network) return;
        for (const e of list.getEntries() as PerformanceResourceTiming[]) {
          rec.network.push({
            id: rec.nextId(), ts: Date.now(), method: "GET", url: e.name,
            ms: Math.round(e.duration), observed: true,
            resourceType: e.initiatorType, transferSize: e.transferSize
          });
        }
      });
      obs.observe({ type: "resource", buffered: true });
      restorers.push(() => obs.disconnect());
    } catch { /* observer unavailable — metadata-only degradation is acceptable */ }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm -F @aipagego/extension test -- main-world`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/content/recorder packages/extension/tests/content/recorder
git commit -m "feat(recorder): capture console output and network traffic in the MAIN world"
```

### Task 7: Dialog interception with passthrough default

**Files:**
- Modify: `packages/extension/src/content/recorder/main-world.ts`
- Test: `packages/extension/tests/content/recorder/dialog.test.ts`

**Interfaces:**
- Consumes: the `RecorderGlobal` from Tasks 5-6.
- Produces: `rec.dialogPolicy: { accept: boolean; promptText?: string; scope: "next" | "all" } | null` and `rec.setDialogPolicy(p): void`. While `config.dialog` is false the patched `alert`/`confirm`/`prompt` call straight through to the originals and record `handled: "passthrough"`. A `scope: "next"` policy is consumed by the first dialog and then cleared.

- [ ] **Step 1: Write the failing test**

```ts
// packages/extension/tests/content/recorder/dialog.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { install } from "@/content/recorder/main-world";

describe("dialog interception", () => {
  let rec: ReturnType<typeof install>;
  let nativeConfirm: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    delete (window as { __AIPAGEGO_REC__?: unknown }).__AIPAGEGO_REC__;
    nativeConfirm = vi.fn(() => true);
    window.confirm = nativeConfirm as unknown as typeof window.confirm;
    window.prompt = vi.fn(() => "native") as unknown as typeof window.prompt;
    window.alert = vi.fn() as unknown as typeof window.alert;
    rec = install();
  });

  it("passes through to the native dialog until armed", () => {
    expect(window.confirm("sure?")).toBe(true);
    expect(nativeConfirm).toHaveBeenCalledWith("sure?");
    expect(rec.dialog.toArray().at(-1)!.handled).toBe("passthrough");
  });

  it("answers from the policy once armed", () => {
    rec.configure({ dialog: true });
    rec.setDialogPolicy({ accept: false, scope: "all" });
    expect(window.confirm("sure?")).toBe(false);
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(rec.dialog.toArray().at(-1)!.handled).toBe("dismissed");
  });

  it("returns promptText for prompt and consumes a next-scoped policy", () => {
    rec.configure({ dialog: true });
    rec.setDialogPolicy({ accept: true, promptText: "typed", scope: "next" });
    expect(window.prompt("name?")).toBe("typed");
    expect(rec.dialogPolicy).toBeNull();
    expect(window.prompt("again?")).toBe("native");
  });

  it("records the message and kind", () => {
    rec.configure({ dialog: true });
    rec.setDialogPolicy({ accept: true, scope: "all" });
    window.alert("hello");
    const e = rec.dialog.toArray().at(-1)!;
    expect(e.kind).toBe("alert");
    expect(e.message).toBe("hello");
    expect(e.handled).toBe("accepted");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @aipagego/extension test -- dialog`
Expected: FAIL — `rec.setDialogPolicy is not a function`.

- [ ] **Step 3: Implement the dialog patches**

Extend `RecorderGlobal` with `dialogPolicy` and `setDialogPolicy`, then inside `install()`:

```ts
  const takePolicy = () => {
    const p = rec.dialogPolicy;
    if (p && p.scope === "next") rec.dialogPolicy = null;
    return p;
  };

  const record = (kind: DialogEntry["kind"], message: string, handled: DialogEntry["handled"], promptText?: string) => {
    rec.dialog.push({ id: rec.nextId(), ts: Date.now(), kind, message, handled, promptText });
  };

  const nativeAlert = window.alert;
  const nativeConfirm = window.confirm;
  const nativePrompt = window.prompt;

  window.alert = (message?: unknown) => {
    const text = String(message ?? "");
    const policy = rec.config.dialog ? takePolicy() : null;
    if (!policy) { record("alert", text, "passthrough"); nativeAlert.call(window, text); return; }
    record("alert", text, policy.accept ? "accepted" : "dismissed");
  };

  window.confirm = (message?: unknown) => {
    const text = String(message ?? "");
    const policy = rec.config.dialog ? takePolicy() : null;
    if (!policy) { record("confirm", text, "passthrough"); return nativeConfirm.call(window, text); }
    record("confirm", text, policy.accept ? "accepted" : "dismissed");
    return policy.accept;
  };

  window.prompt = (message?: unknown, defaultValue?: unknown) => {
    const text = String(message ?? "");
    const dflt = defaultValue == null ? undefined : String(defaultValue);
    const policy = rec.config.dialog ? takePolicy() : null;
    if (!policy) { record("prompt", text, "passthrough", dflt); return nativePrompt.call(window, text, dflt as string); }
    const answer = policy.accept ? (policy.promptText ?? dflt ?? "") : null;
    record("prompt", text, policy.accept ? "accepted" : "dismissed", answer ?? undefined);
    return answer;
  };

  restorers.push(() => {
    window.alert = nativeAlert;
    window.confirm = nativeConfirm;
    window.prompt = nativePrompt;
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -F @aipagego/extension test -- recorder`
Expected: PASS, 11 tests across both recorder files.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/content/recorder packages/extension/tests/content/recorder
git commit -m "feat(recorder): dialog interception, passthrough until armed"
```

### Task 8: Drain bridge and background recorder host

**Files:**
- Create: `packages/extension/src/content/recorder/drain.ts`
- Create: `packages/extension/src/background/recorder/main-world-host.ts`
- Create: `packages/extension/src/background/recorder/host.ts`
- Test: `packages/extension/tests/background/recorder-host.test.ts`

**Interfaces:**
- Consumes: `filterConsole`/`filterNetwork` from Task 2, `injectMainWorld` from `rpc-handlers.ts:497`.
- Produces: `getRecorder(tabId: number): PageRecorder` from `host.ts`, returning the CDP backend when attached (Phase 5) and the MAIN-world backend otherwise. `MainWorldRecorder` implements the `PageRecorder` interface from the spec by serialising a drain expression through `injectMainWorld`.

The drain expression runs in the MAIN world and returns plain JSON:

```ts
// packages/extension/src/content/recorder/drain.ts
export const DRAIN_SOURCE = `
  const rec = window.__AIPAGEGO_REC__;
  if (!rec) return { missing: true };
  const op = ctx.op;
  if (op === "configure") return { config: rec.configure(ctx.patch) };
  if (op === "setDialogPolicy") { rec.setDialogPolicy(ctx.policy); return { ok: true }; }
  if (op === "read") return {
    config: rec.config,
    console: { dropped: rec.console.dropped, entries: rec.console.toArray() },
    network: { dropped: rec.network.dropped, entries: rec.network.toArray() },
    dialog: { dropped: rec.dialog.dropped, entries: rec.dialog.toArray() },
  };
  if (op === "detail") return { detail: rec.details.get(ctx.id) ?? null };
  if (op === "uninstall") { rec.uninstall(); return { ok: true }; }
  return { error: "unknown op " + op };
`;
```

`MainWorldRecorder` filters the drained arrays with `filterConsole`/`filterNetwork` on the background side, so filtering logic stays pure and unit-tested once. A `{ missing: true }` drain means the recorder never installed — return an empty result with `disabled: "recorder not installed on this page"` rather than throwing.

- [ ] **Step 1: Write the failing test**

```ts
// packages/extension/tests/background/recorder-host.test.ts
import { describe, expect, it, vi } from "vitest";
import { MainWorldRecorder } from "@/background/recorder/main-world-host";

const drainOk = () => ({
  config: { console: true, network: true, bodies: false, dialog: false },
  console: { dropped: 2, entries: [
    { id: 1, ts: 1, level: "log", text: "a" },
    { id: 2, ts: 2, level: "error", text: "b" }
  ] },
  network: { dropped: 0, entries: [
    { id: 3, ts: 3, method: "GET", url: "https://a.test/x", status: 200 },
    { id: 4, ts: 4, method: "GET", url: "https://a.test/y.css", observed: true }
  ] },
  dialog: { dropped: 0, entries: [] }
});

describe("MainWorldRecorder", () => {
  it("tags results with the main-world backend and applies filters", async () => {
    const r = new MainWorldRecorder(1, vi.fn(async () => drainOk()));
    const out = await r.readConsole({ level: "error" });
    expect(out.backend).toBe("main-world");
    expect(out.dropped).toBe(2);
    expect(out.messages.map((m) => m.id)).toEqual([2]);

    const net = await r.readNetwork({});
    expect(net.requests.map((e) => e.id)).toEqual([3]);
  });

  it("reports a missing recorder instead of throwing", async () => {
    const r = new MainWorldRecorder(1, vi.fn(async () => ({ missing: true })));
    const out = await r.readConsole({});
    expect(out.messages).toEqual([]);
    expect(out.disabled).toContain("not installed");
  });

  it("explains why a body is unavailable when capture is disarmed", async () => {
    const r = new MainWorldRecorder(1, vi.fn(async (ctx: { op: string }) =>
      ctx.op === "detail"
        ? { detail: { id: 3, ts: 3, method: "GET", url: "https://a.test/x", status: 200 } }
        : drainOk()
    ));
    const d = await r.readNetworkDetail({ id: 3 });
    expect(d.bodyUnavailable).toContain("recorderConfig");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @aipagego/extension test -- recorder-host`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `MainWorldRecorder`**

Constructor takes `(tabId: number, drain: (ctx: unknown) => Promise<unknown>)` so tests can inject a fake; production passes `(ctx) => injectMainWorld(tabId, DRAIN_SOURCE, ctx)`. Each read calls `drain({op:"read"})` once, then filters. `readNetworkDetail` calls `drain({op:"detail", id})`; when the returned detail has no `responseBody` and the drained `config.bodies` is false, set `bodyUnavailable: "body capture is off — call recorderConfig({bodies:true}) and re-run the request"`.

- [ ] **Step 4: Implement `host.ts`**

```ts
export function getRecorder(tabId: number): PageRecorder {
  const cdp = getAttachedCdpRecorder(tabId); // Phase 5; returns null until then
  return cdp ?? new MainWorldRecorder(tabId, (ctx) => injectMainWorld(tabId, DRAIN_SOURCE, ctx as Json));
}
```

Until Phase 5 lands, `getAttachedCdpRecorder` is a stub returning `null`.

- [ ] **Step 5: Register the MAIN-world script from the service worker**

In `packages/extension/src/background/index.ts`, on startup call the registration chosen in Task 5 Step 1, guarded so a duplicate id is not an error:

```ts
await chrome.scripting.unregisterContentScripts({ ids: ["aipagego-recorder"] }).catch(() => {});
if (await recorderEnabled()) await chrome.scripting.registerContentScripts([RECORDER_SCRIPT]);
```

(Skip this step entirely if Task 5 took the manifest-declared branch.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm -F @aipagego/extension test -- recorder`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/content/recorder packages/extension/src/background/recorder packages/extension/tests/background
git commit -m "feat(recorder): drain bridge and background recorder host"
```

## Phase 3 — New content-script tools

### Task 9: `findElements`

**Files:**
- Create: `packages/extension/src/content/tools/find-elements.ts`
- Modify: `packages/extension/src/content/tools/index.ts`
- Test: `packages/extension/tests/content/find-elements.test.ts`

**Interfaces:**
- Consumes: `INTERACTIVE_SELECTOR`, `elRole`, `elName`, `bounds` — extract these from `take-snapshot.ts` into an exported helper module `packages/extension/src/content/tools/element-meta.ts` and have `take-snapshot.ts` import them, so the two tools cannot drift.
- Produces: `findElements(args: Json): Promise<Json>` returning `{ matches: Array<{uid, role, name, tag, text, bounds}> }`. UIDs are recorded into the same `uid-cache` that `clickByUid`/`fillByUid` read, so a `findElements` result is directly actionable. Calling `findElements` does **not** reset the cache (unlike `takeSnapshot`); it appends.

- [ ] **Step 1: Write the failing test** — cover: substring match is case-insensitive; `regex` matches against the element name; `limit` truncates; returned uids resolve through `lookupUid`; passing neither `text` nor `regex` throws `findElements: text or regex required`.

```ts
// packages/extension/tests/content/find-elements.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { findElements } from "@/content/tools/find-elements";
import { lookupUid } from "@/content/tools/uid-cache";

describe("findElements", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button>Save changes</button>
      <button>Cancel</button>
      <a href="/x" aria-label="Download report">link</a>`;
  });

  it("matches text case-insensitively", async () => {
    const out = (await findElements({ text: "save" })) as { matches: Array<{ name: string }> };
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0].name).toBe("Save changes");
  });

  it("matches aria-label via regex", async () => {
    const out = (await findElements({ regex: "^Download" })) as { matches: Array<{ name: string }> };
    expect(out.matches.map((m) => m.name)).toEqual(["Download report"]);
  });

  it("honours limit", async () => {
    const out = (await findElements({ regex: ".", limit: 2 })) as { matches: unknown[] };
    expect(out.matches).toHaveLength(2);
  });

  it("returns uids that resolve against the cache", async () => {
    const out = (await findElements({ text: "Cancel" })) as { matches: Array<{ uid: string }> };
    expect(lookupUid(out.matches[0].uid)?.textContent).toBe("Cancel");
  });

  it("requires a query", async () => {
    await expect(findElements({})).rejects.toThrow("text or regex required");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** Run: `pnpm -F @aipagego/extension test -- find-elements`. Expected: FAIL, module not found.
- [ ] **Step 3: Extract `element-meta.ts`** from `take-snapshot.ts` (`INTERACTIVE_SELECTOR`, `elText`, `elRole`, `elName`, `bounds`) and re-import them there. Run the existing snapshot tests to confirm no regression.
- [ ] **Step 4: Implement `find-elements.ts`** using `document.querySelectorAll(INTERACTIVE_SELECTOR)`, matching `elName(el)` and `elText(el)`; on regex-parse failure throw `findElements: invalid regex`.
- [ ] **Step 5: Register in `TOOLS`** in `content/tools/index.ts`.
- [ ] **Step 6: Run the tests.** Run: `pnpm -F @aipagego/extension test -- "find-elements|take-snapshot"`. Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/content/tools packages/extension/tests/content/find-elements.test.ts
git commit -m "feat(tools): add findElements and share element metadata with takeSnapshot"
```

### Task 10: `drag` and `drop`

**Files:**
- Create: `packages/extension/src/content/tools/drag.ts`
- Create: `packages/extension/src/content/tools/drop.ts`
- Modify: `packages/extension/src/content/tools/index.ts`
- Test: `packages/extension/tests/content/drag-drop.test.ts`

**Interfaces:**
- Consumes: `lookupUid` from `uid-cache.ts`; a shared `resolveTarget(args, keys)` helper placed in `element-meta.ts` that accepts either a selector or a uid and throws `<tool>: target not found` otherwise.
- Produces: `drag(args): Promise<{consumed: {pointer: boolean; html5: boolean}}>` and `drop(args): Promise<{ok: true; fileCount: number}>`.

`drag` dispatches, in order, on the source: `pointerdown`, `mousedown`, `dragstart`; on the target: `dragenter`, `dragover`, `pointermove`, `drop`; then on the source: `dragend`, `pointerup`, `mouseup`. All `Drag*` events share one `DataTransfer`. `consumed.html5` is true when any `dragover`/`drop` listener called `preventDefault()`; `consumed.pointer` is true when any pointer event was `defaultPrevented`. happy-dom lacks a `DragEvent` constructor, so fall back to `new Event(type, {bubbles:true, cancelable:true})` with `dataTransfer` assigned as an own property.

`drop` builds `File` objects from base64 via `Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))`, attaches them to a `DataTransfer`, and dispatches `dragenter`/`dragover`/`drop`. When `files` is present the caller must have held `upload:file`, which the coordinator already enforced by the time the content script runs.

- [ ] **Step 1: Write the failing test** — a `#src`/`#dst` pair where `dst` calls `preventDefault()` on `dragover`; assert `consumed.html5` is true, assert the drop handler saw the payload set by `drag`, assert a target-less call rejects with "target not found", and assert `drop` with one base64 file surfaces `fileCount: 1` and a readable `dataTransfer.files[0].name` in the page's own `drop` listener.
- [ ] **Step 2: Run it to verify it fails.** Run: `pnpm -F @aipagego/extension test -- drag-drop`. Expected: FAIL.
- [ ] **Step 3: Add `resolveTarget` to `element-meta.ts`.**
- [ ] **Step 4: Implement `drag.ts`.**
- [ ] **Step 5: Implement `drop.ts`.**
- [ ] **Step 6: Register both in `TOOLS`.**
- [ ] **Step 7: Run the tests.** Expected: PASS.
- [ ] **Step 8: Commit**

```bash
git add packages/extension/src/content/tools packages/extension/tests/content/drag-drop.test.ts
git commit -m "feat(tools): add drag and drop with pointer and HTML5 event paths"
```

## Phase 4 — Lower meta tools into the background

### Task 11: Background meta-tool router

This is the task that makes "full exposure" actually work. `screenshot`, `listTabs`, `openTab`, `closeTab`, `switchToTab`, `searchBookmarks`, `searchHistory`, `downloadImage`, and `downloadSpreadsheet` are implemented in the side panel today (`sidepanel/chat/run-session.ts:391`, `sidepanel/chat/run-session.ts:505-600`, `sidepanel/lib/meta-tools.ts`). The coordinator/MCP `EXEC` path goes through `runOneStep`, which forwards straight to the content script, so none of them are reachable from MCP.

**Files:**
- Create: `packages/extension/src/background/bg-tools/tabs.ts`
- Create: `packages/extension/src/background/bg-tools/capture.ts`
- Create: `packages/extension/src/background/bg-tools/downloads.ts`
- Create: `packages/extension/src/background/bg-tools/search.ts`
- Create: `packages/extension/src/background/meta-tool-router.ts`
- Modify: `packages/extension/src/background/rpc-handlers.ts:186-235`
- Modify: `packages/extension/src/sidepanel/lib/meta-tools.ts`
- Modify: `packages/extension/src/sidepanel/chat/run-session.ts`
- Test: `packages/extension/tests/background/meta-tool-router.test.ts`

**Interfaces:**
- Consumes: `BuiltinTool`, `Json`.
- Produces: `META_TOOLS: Partial<Record<BuiltinTool, (args: Json, tabId: number) => Promise<Json>>>` and `isMetaTool(name: string): boolean` from `meta-tool-router.ts`. `runOneStep` consults `isMetaTool` **before** the `chrome.tabs.sendMessage` hop and dispatches locally when it hits.

Two porting hazards, both must be handled:

- `URL.createObjectURL` does not exist in an MV3 service worker, so `downloadSpreadsheet` and `downloadImage` cannot reuse the sidepanel blob-URL path. Build a `data:` URL instead and pass it to `chrome.downloads.download`. The existing `.xlsx` byte generation in `sidepanel/lib/xlsx.ts` is pure and moves to `packages/extension/src/background/bg-tools/xlsx.ts` unchanged; only the URL construction differs.
- `closeTab` in the side panel guards against tabs outside `attachedTabIds`. Preserve that: the router receives the session's allowed tab ids from `runOneStep` and applies the same check, so an MCP session cannot close arbitrary tabs.

- [ ] **Step 1: Write the failing test**

```ts
// packages/extension/tests/background/meta-tool-router.test.ts
import { describe, expect, it, vi } from "vitest";
import { META_TOOLS, isMetaTool } from "@/background/meta-tool-router";

describe("meta tool router", () => {
  it("claims exactly the sidepanel-era meta tools", () => {
    for (const n of ["screenshot", "listTabs", "openTab", "closeTab", "switchToTab",
                     "searchBookmarks", "searchHistory", "downloadImage", "downloadSpreadsheet"]) {
      expect(isMetaTool(n), n).toBe(true);
    }
    expect(isMetaTool("click")).toBe(false);
  });

  it("captures the visible tab as base64 png", async () => {
    globalThis.chrome = {
      tabs: { get: vi.fn(async () => ({ windowId: 9 })),
              captureVisibleTab: vi.fn(async () => "data:image/png;base64,AAAA") }
    } as unknown as typeof chrome;
    const out = (await META_TOOLS.screenshot!({}, 1)) as { data: string; media_type: string };
    expect(out.media_type).toBe("image/png");
    expect(out.data).toBe("AAAA");
  });

  it("refuses to close a tab outside the allowed set", async () => {
    await expect(META_TOOLS.closeTab!({ tabId: 77, allowedTabIds: [1] } as never, 1))
      .rejects.toThrow("not in attachedTabs");
  });

  it("downloads a spreadsheet through a data URL, not a blob URL", async () => {
    const download = vi.fn(async () => 5);
    globalThis.chrome = { downloads: { download } } as unknown as typeof chrome;
    await META_TOOLS.downloadSpreadsheet!({ filename: "a.xlsx", sheets: [{ name: "S", rows: [["x"]] }] }, 1);
    expect(download.mock.calls[0][0].url.startsWith("data:")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** Run: `pnpm -F @aipagego/extension test -- meta-tool-router`. Expected: FAIL.
- [ ] **Step 3: Move `xlsx.ts`** to `background/bg-tools/xlsx.ts`; re-export from the old sidepanel path so existing imports and tests keep working.
- [ ] **Step 4: Write `tabs.ts`, `capture.ts`, `downloads.ts`, `search.ts`**, porting the bodies from `sidepanel/lib/meta-tools.ts` and `run-session.ts` and swapping blob URLs for `data:` URLs.
- [ ] **Step 5: Write `meta-tool-router.ts`** assembling `META_TOOLS`.
- [ ] **Step 6: Wire `runOneStep`** — immediately after the `targetTabId` resolution block and before `ContentRequestSchema.parse`, add:

```ts
  if (step.kind === "tool" && isMetaTool(step.tool)) {
    return META_TOOLS[step.tool]!(
      { ...(step.args as Record<string, Json>), allowedTabIds: [rpcTabId, ...attachedTabIds] } as Json,
      targetTabId
    );
  }
```

- [ ] **Step 7: Point the side panel at the router** — `sidepanel/lib/meta-tools.ts` becomes a thin wrapper that sends `runs.runOneStep`, and the `screenshot` / `listTabs` / `openTab` branches in `run-session.ts` keep their result-shaping (the image `tool_result` block, `onCrossTabResult`) but source the data from the router. `attachTab`/`detachTab` stay side-panel-only — they are in the MCP block-list.
- [ ] **Step 8: Run the full extension suite.** Run: `pnpm -F @aipagego/extension test`. Expected: PASS with no regressions in the existing `run-session` tests.
- [ ] **Step 9: Commit**

```bash
git add packages/extension/src packages/extension/tests
git commit -m "refactor(bg): lower meta tools into a background router reachable from EXEC"
```

### Task 12: Navigation, resize, and the recorder tools in the router

**Files:**
- Create: `packages/extension/src/background/bg-tools/nav.ts`
- Create: `packages/extension/src/background/bg-tools/recorder-tools.ts`
- Modify: `packages/extension/src/background/meta-tool-router.ts`
- Test: `packages/extension/tests/background/nav-tools.test.ts`
- Test: `packages/extension/tests/background/recorder-tools.test.ts`

**Interfaces:**
- Consumes: `getRecorder(tabId)` from Task 8; `META_TOOLS` from Task 11.
- Produces: router entries for `navigateBack`, `navigateForward`, `resize`, `consoleMessages`, `networkRequests`, `networkRequestDetail`, `handleDialog`, `recorderConfig`. All eight are background-side, so they must be registered in `META_TOOLS` for `runOneStep` to reach them.

`resize` arithmetic — the viewport must land exactly on the requested size:

```ts
const [{ result: inner }] = await chrome.scripting.executeScript({
  target: { tabId }, func: () => ({ iw: window.innerWidth, ih: window.innerHeight,
                                    ow: window.outerWidth, oh: window.outerHeight })
});
const tab = await chrome.tabs.get(tabId);
await chrome.windows.update(tab.windowId, {
  width: width + (inner.ow - inner.iw),
  height: height + (inner.oh - inner.ih)
});
```

- [ ] **Step 1: Write the failing tests** — `navigateBack` returns `{ok:false, reason}` when `chrome.tabs.goBack` rejects with "Cannot find a next page in history"; `resize` compensates for a 16px horizontal and 90px vertical chrome; `consoleMessages` forwards `level`/`limit` to the recorder and passes `backend` through; `handleDialog` with `{accept:true, scope:"all"}` calls `setDialogPolicy` and returns the recorded dialogs; `recorderConfig({bodies:true})` reaches `configure`.
- [ ] **Step 2: Run them to verify they fail.** Run: `pnpm -F @aipagego/extension test -- "nav-tools|recorder-tools"`. Expected: FAIL.
- [ ] **Step 3: Implement `nav.ts`** — `goBack`/`goForward` wrapped in try/catch that converts the "no history" rejection into `{ok:false, reason}` rather than an error; `resize` as above.
- [ ] **Step 4: Implement `recorder-tools.ts`** — each tool is a thin adapter from tool args to a `getRecorder(tabId)` call. `handleDialog` calls `setDialogPolicy` then `readDialogs`, returning both the policy that was set and the log.
- [ ] **Step 5: Register all eight in `META_TOOLS`.**
- [ ] **Step 6: Run the tests.** Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/background packages/extension/tests/background
git commit -m "feat(tools): navigation, resize and recorder tools in the background router"
```

## Phase 5 — Extend existing tools

### Task 13: `click`, `fillInput`, and `waitFor` options

**Files:**
- Modify: `packages/extension/src/content/tools/click.ts`
- Modify: `packages/extension/src/content/tools/fill-input.ts`
- Modify: `packages/extension/src/content/tools/wait-for.ts`
- Test: `packages/extension/tests/content/click.test.ts` (extend)
- Test: `packages/extension/tests/content/fill-input.test.ts` (extend)
- Test: `packages/extension/tests/content/wait-for.test.ts` (extend)

**Interfaces:**
- Consumes: the schemas from Task 4.
- Produces: no signature changes; the tools read new optional args. `click` with `doubleClick` dispatches `dblclick` after the click pair; `button: "right"` dispatches `contextmenu`; `modifiers` set `altKey`/`ctrlKey`/`metaKey`/`shiftKey` on every dispatched mouse event. `fillInput` with `slowly` dispatches `keydown`/`keypress`/`input`/`keyup` per character and sets the value incrementally; with `submit` it dispatches an `Enter` `keydown`/`keyup` pair after filling. `waitFor` with `text` polls `document.body.innerText` on the same interval as the existing selector poll; `textGone` inverts the predicate. `text` and `textGone` respect the existing `timeoutMs` default of 5000 and throw the same timeout error shape.

- [ ] **Step 1: Write the failing tests** — one per new option, asserting the dispatched event sequence via listeners rather than internals.
- [ ] **Step 2: Run them to verify they fail.** Run: `pnpm -F @aipagego/extension test -- "click|fill-input|wait-for"`. Expected: FAIL.
- [ ] **Step 3: Implement the three tools.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/content/tools packages/extension/tests/content
git commit -m "feat(tools): click modifiers, slow typing, submit, and text waits"
```

### Task 14: Full-page screenshot

**Files:**
- Modify: `packages/extension/src/background/bg-tools/capture.ts`
- Create: `packages/extension/src/content/tools/page-metrics.ts`
- Test: `packages/extension/tests/background/capture.test.ts`

**Interfaces:**
- Consumes: `META_TOOLS.screenshot` from Task 11.
- Produces: `screenshot` honours `fullPage`, `format`, `scale`. Full-page capture is a background-driven loop: read `{scrollHeight, clientHeight, scrollWidth}` from the page, then for each viewport-sized band scroll the page, `captureVisibleTab`, and collect the data URLs; stitching happens in the content script on an `OffscreenCanvas`-free `<canvas>` because the service worker has no DOM. Restore the original scroll position when done, including on failure. Cap the loop at 20 bands and report `truncated: true` past that, so a pathological infinite-scroll page cannot hang the call.

`chrome.tabs.captureVisibleTab` is rate-limited (`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`); the loop must await at least 100 ms between bands or it will start throwing quota errors partway through a long page.

- [ ] **Step 1: Write the failing test** — a fake `chrome` where the page reports a 3-band height; assert three `captureVisibleTab` calls, three scroll positions, restoration of the initial scroll offset, and `truncated: true` at 21 bands.
- [ ] **Step 2: Run it to verify it fails.** Run: `pnpm -F @aipagego/extension test -- capture`. Expected: FAIL.
- [ ] **Step 3: Implement `page-metrics.ts`** (a content tool returning scroll metrics and performing a scroll-to) **and the band loop with the 100 ms delay and the 20-band cap.**
- [ ] **Step 4: Implement stitching and `format`/`scale`** in the content script.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add packages/extension/src packages/extension/tests
git commit -m "feat(tools): full-page screenshot with banded capture and stitching"
```

## Phase 6 — CDP backend

### Task 15: Opt-in permission and settings UI

**Files:**
- Modify: the Coordinator settings sub-page under `packages/extension/src/sidepanel/`
- Create: `packages/extension/src/background/recorder/cdp-permission.ts`
- Test: `packages/extension/tests/background/cdp-permission.test.ts`

**Interfaces:**
- Produces: `requestDebuggerPermission(): Promise<boolean>` wrapping `chrome.permissions.request({permissions:["debugger"]})`, `hasDebuggerPermission(): Promise<boolean>`, and a persisted `cdpRecorderEnabled` setting. The toggle is disabled in the UI until the permission is granted; revoking the permission flips the setting off.

- [ ] **Step 1: Write the failing test** — granting flips the setting; a denied request leaves it false and surfaces a reason; `hasDebuggerPermission` false forces `cdpRecorderEnabled` to read as false regardless of what is stored.
- [ ] **Step 2: Run it to verify it fails.** Run: `pnpm -F @aipagego/extension test -- cdp-permission`. Expected: FAIL.
- [ ] **Step 3: Implement `cdp-permission.ts`.**
- [ ] **Step 4: Add the settings row** under Coordinator, with copy that states the trade-off plainly: full-fidelity capture, a permanent "AIPageGo is debugging this browser" bar, and mutual exclusion with DevTools and other debugger clients.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add packages/extension/src packages/extension/tests
git commit -m "feat(recorder): opt-in debugger permission and settings toggle"
```

### Task 16: `CdpRecorder` with automatic degradation

**Files:**
- Create: `packages/extension/src/background/recorder/cdp.ts`
- Modify: `packages/extension/src/background/recorder/host.ts`
- Test: `packages/extension/tests/background/cdp-recorder.test.ts`

**Interfaces:**
- Consumes: `PageRecorder` from Task 8, `hasDebuggerPermission` from Task 15.
- Produces: `attachCdp(tabId): Promise<CdpRecorder | null>`, `getAttachedCdpRecorder(tabId): CdpRecorder | null`, `detachCdp(tabId): Promise<void>`. `host.ts`'s `getRecorder` stops stubbing and returns the CDP recorder when one is attached.

Behaviour:

- `attachCdp` returns `null` — never throws — when the permission is absent, the setting is off, or `chrome.debugger.attach` rejects. The rejection message is stored as the degradation reason for that tab.
- On attach: `Runtime.enable`, `Log.enable`, `Network.enable`, `Page.enable`. Events fill `Ring` instances of the same shapes used by the MAIN-world backend, so `filterConsole`/`filterNetwork` are reused unchanged.
- `readNetworkDetail` calls `Network.getResponseBody` lazily rather than buffering every body.
- `handleDialog` under CDP: if a `Page.javascriptDialogOpening` is currently pending, call `Page.handleJavaScriptDialog` immediately with `{accept, promptText}`; otherwise store the policy for the next one. Both paths return the same shape as the MAIN-world backend.
- `chrome.debugger.onDetach` clears the registry entry for that tab and records `degradedReason: "debugger detached: <reason>"`. The next `getRecorder(tabId)` therefore returns a `MainWorldRecorder`, and its reads carry the stored reason forward once, then clear it.
- `chrome.tabs.onRemoved` detaches and clears state so buffers cannot leak across tab lifetimes.

- [ ] **Step 1: Write the failing test** — with a fake `chrome.debugger`: attach failure returns `null` and stores the reason; a successful attach routes `Runtime.consoleAPICalled` into the console ring with `backend: "cdp"`; `onDetach` makes `getRecorder` fall back to MAIN-world with a populated `degradedReason`; a pending dialog is answered synchronously by `handleDialog`.
- [ ] **Step 2: Run it to verify it fails.** Run: `pnpm -F @aipagego/extension test -- cdp-recorder`. Expected: FAIL.
- [ ] **Step 3: Implement `cdp.ts`.**
- [ ] **Step 4: Un-stub `getAttachedCdpRecorder` in `host.ts`.**
- [ ] **Step 5: Route `resize` through `Emulation.setDeviceMetricsOverride`** when a CDP recorder is attached, leaving the window-arithmetic path for the MAIN-world case.
- [ ] **Step 6: Run the tests.** Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/background/recorder packages/extension/tests/background
git commit -m "feat(recorder): CDP backend with automatic degradation to MAIN-world"
```

## Phase 7 — MCP layer

### Task 17: Full tool exposure, `parity` mode, and image results

**Files:**
- Modify: `packages/mcp-server/src/tool-gen.ts`
- Modify: `packages/mcp-server/src/mcp-server.ts`
- Modify: `packages/mcp-server/src/handlers.ts`
- Test: `packages/mcp-server/tests/tool-gen.test.ts` (extend)
- Test: `packages/mcp-server/tests/mcp-server.test.ts`

**Interfaces:**
- Consumes: `TOOL_DEFS` (57 entries after Task 4), `capabilityForTool` (Task 3).
- Produces: `generateBrowserTools(mode: "full" | "parity" = "full"): GeneratedTool[]`; `GeneratedTool` gains `resultKind: "json" | "image"` and `stepKind: "tool" | "js"`. `BLOCKED_TOOLS = new Set(["askUser", "attachTab", "detachTab"])`. `PARITY_TOOLS` is the explicit 24-name list covering playwright-ext's surface. `readToolMode(env): "full" | "parity"` reads `AIPAGEGO_MCP_TOOLS`, defaulting to `full` and falling back to `full` with a stderr warning on an unrecognised value.

`runJS` needs a step-kind special case: `handleBrowserTool` currently always emits `{kind:"tool", ...}`, but `runJS` is a `{kind:"js", source}` step. Branch on `gen.stepKind`. Its capability comes from `capabilityForRunJs`, not `capabilityForTool`, and the `unsafe` flag comes from the static-scan verdict the extension applies — the MCP server passes `unsafe: true` conservatively, since it cannot run the scan itself.

The new dual-tier opts must reach `validateCall`: `dropHasFiles` from `Array.isArray(args.files) && args.files.length > 0`, `recorderArmsBodies` from `args.bodies === true`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/mcp-server/tests/tool-gen.test.ts (extend)
import { BLOCKED_TOOLS, generateBrowserTools, readToolMode } from "../src/tool-gen";

it("exposes every tool except the block-list", () => {
  const names = generateBrowserTools("full").map((t) => t.builtinTool);
  expect(names).toHaveLength(54);
  for (const b of BLOCKED_TOOLS) expect(names).not.toContain(b);
  expect(names).toContain("drag");
  expect(names).toContain("consoleMessages");
  expect(names).toContain("runJS");
});

it("parity mode is a strict subset", () => {
  const parity = generateBrowserTools("parity").map((t) => t.builtinTool);
  const full = new Set(generateBrowserTools("full").map((t) => t.builtinTool));
  expect(parity).toHaveLength(24);
  for (const n of parity) expect(full.has(n)).toBe(true);
});

it("marks screenshot as an image result", () => {
  const s = generateBrowserTools("full").find((t) => t.builtinTool === "screenshot")!;
  expect(s.resultKind).toBe("image");
});

it("defaults to full and warns on garbage", () => {
  expect(readToolMode({})).toBe("full");
  expect(readToolMode({ AIPAGEGO_MCP_TOOLS: "parity" })).toBe("parity");
  expect(readToolMode({ AIPAGEGO_MCP_TOOLS: "nonsense" })).toBe("full");
});
```

```ts
// packages/mcp-server/tests/mcp-server.test.ts
it("returns screenshots as an image content block", async () => {
  const deps = fakeDeps({ exec: async () => ({ ok: true, return: { data: "AAAA", media_type: "image/png" } }) });
  const res = await dispatchCall(deps, "browser_screenshot", { session_id: "s1" });
  expect(res.content[0]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
});
```

- [ ] **Step 2: Run them to verify they fail.** Run: `pnpm -F @attson/aipagego-mcp test`. Expected: FAIL.
- [ ] **Step 3: Rewrite `tool-gen.ts`** with the block-list, `PARITY_TOOLS`, `resultKind`, `stepKind`, and `readToolMode`.
- [ ] **Step 4: Widen `CallResult`** to `{ content: Array<{type:"text"; text:string} | {type:"image"; data:string; mimeType:string}>; isError?: boolean }` and branch in `ok()` on `resultKind`.
- [ ] **Step 5: Branch `handleBrowserTool`** on `stepKind` and pass the new capability opts.
- [ ] **Step 6: Run the tests.** Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server
git commit -m "feat(mcp): expose all built-ins, add parity mode and image results"
```

### Task 18: `supported_tools` negotiation

**Files:**
- Modify: `packages/shared/src/protocol/messages.ts`
- Modify: `packages/extension/src/background/coordinator-hello.ts`
- Modify: `packages/mcp-server/src/wire.ts`
- Modify: `packages/mcp-server/src/mcp-server.ts`
- Test: `packages/shared/tests/protocol/messages.test.ts` (extend)
- Test: `packages/mcp-server/tests/negotiation.test.ts`

**Interfaces:**
- Produces: `Hello.supported_tools: z.array(z.string()).optional()`; `Worker.supported_tools?: Set<string>`; `buildToolList(deps, mode)` intersects the generated list against the connected worker's set. When the field is absent the server falls back to the legacy 19-name list. When no worker is connected, advertise the full generated list so `tools/list` before connection is not empty.

- [ ] **Step 1: Write the failing tests** — a worker reporting `["click","snapshotDOM"]` yields exactly `browser_click` and `browser_snapshotDOM` plus the control tools; a worker with no `supported_tools` yields the legacy 19; no worker yields the full set.
- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Add the optional field to the zod schema and to `helloToWorker`.**
- [ ] **Step 4: Emit the list from `coordinator-hello.ts`** as `Object.keys(TOOLS)` plus the router's meta tool names — the union of everything the extension can actually execute.
- [ ] **Step 5: Intersect in `buildToolList`.**
- [ ] **Step 6: Run the tests.** Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add packages/shared packages/extension/src/background/coordinator-hello.ts packages/mcp-server
git commit -m "feat(protocol): negotiate the tool surface with supported_tools"
```

### Task 19: Documentation and skill bundle

**Files:**
- Modify: `skill/SKILL.md`
- Modify: `packages/mcp-server/README.md`
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update `skill/SKILL.md`** with the recorder arming model, the backend fidelity distinction, the `handleDialog` pre-set-policy semantics, and a worked debugging flow (`recorderConfig({bodies:true})` → reproduce → `networkRequests` → `networkRequestDetail`).
- [ ] **Step 2: Update `packages/mcp-server/README.md`** — replace "19 个 `browser_*`" with the new count, document `AIPAGEGO_MCP_TOOLS`, and add a short "replacing playwright-ext" section listing the tool correspondence.
- [ ] **Step 3: Update `README.md`** — the recorder, the privacy posture, the CDP opt-in, and the new tools in the capability tier lists.
- [ ] **Step 4: Update `AGENTS.md`** with the new directories.
- [ ] **Step 5: Run the whole suite and the build.**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS, no type errors, `dist/` produced.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: document the recorder, parity tools and MCP tool modes"
```

---

## Self-Review Notes

**Spec coverage.** Architecture → Tasks 1-2, 5-8, 15-16. Tool surface → Tasks 3-4, 9-14. Capability model → Task 3. MCP layer → Tasks 17-18. Error handling → folded into the task that owns each surface (Task 8 for missing recorders, Task 12 for navigation limits, Task 16 for degradation, Task 17 for tool filtering). Testing → each task carries its own; Task 19 runs the full gate.

**Known deviation to resolve during execution.** The spec states the MAIN-world script is dynamically registered so the master switch can unregister it. Task 5 Step 1 verifies whether the build actually emits a standalone asset for that. If it does not, the manifest-declared fallback changes the master-switch semantics, and Task 5 requires updating the spec's Backend 1 section to match rather than leaving the spec aspirational.

**Tool count arithmetic.** 46 existing `TOOL_DEFS` + 11 new = 57; minus the 3 block-listed = 54 `browser_*`. The spec says 53 because it counted the `BuiltinTool` union (45) rather than `TOOL_DEFS` (46) — `runJS` is a `TOOL_DEFS` entry without a `BuiltinTool` member, since it is a distinct step kind. Task 17's test asserts 54. Correct the spec's figure in Task 19.
