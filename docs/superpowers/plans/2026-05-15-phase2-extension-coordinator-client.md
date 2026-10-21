# Phase 2 — Extension Coordinator Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the AIPageGo extension act as a "worker" — connect to any coordinator that speaks our Phase 1 WS protocol, complete the HELLO handshake, receive EXEC messages, run tools using the existing rpc-handlers, and stream back RESULT. Pair/token UX is minimal (user pastes a URL + token); polished pair-code flow is Phase 3.

**Architecture:** A `CoordinatorClient` in the service worker owns a single WebSocket. State (worker_id, token, config) lives in `chrome.storage.local`. Heartbeat goes through `chrome.alarms` so MV3 doesn't kill the SW. EXEC messages are forwarded to existing `runOneStep` logic — zero changes to current sidepanel chat / tool library / per-tab session paths. A new sidepanel page lets the user paste a URL + token and watch connection status. An end-to-end test spins up a real `ws` server in vitest and verifies the protocol round-trip.

**Tech Stack:** Native `WebSocket` (browser API); `ws` npm package for test-only server; `chrome.storage.local` + `chrome.alarms`; existing zod schemas from `@aipagego/shared/protocol`; React 18 for the settings page; vitest 2 + happy-dom (existing).

**Phase 2 范围警告:** This plan does NOT implement /pair HTTP endpoint, 6-digit pair codes, daemon, MCP server, or anything in `packages/daemon/` (all Phase 3). It does NOT touch existing chat / tool library / per-tab session code. The sidepanel gets ONE new subpage; everything else is unchanged.

---

## 文件结构总览（Phase 2 结束态）

```
packages/extension/
├─ package.json                       ← 改：devDependencies 加 ws + @types/ws
├─ src/
│  ├─ background/
│  │  ├─ index.ts                     ← 改：SW 启动时拉起 coordinator-client
│  │  ├─ rpc-handlers.ts              (unchanged — 但导出 runOneStep 给 coordinator-exec 用)
│  │  ├─ http-proxy.ts                (unchanged)
│  │  ├─ tab-watcher.ts               (unchanged)
│  │  ├─ storage/                     (unchanged)
│  │  ├─ coordinator-state.ts         ← 新：worker_id / token / config 持久化
│  │  ├─ coordinator-hello.ts         ← 新：从扩展状态构造 HELLO payload
│  │  ├─ coordinator-exec.ts          ← 新：EXEC 消息 → 运行 step → 构造 RESULT
│  │  └─ coordinator-client.ts        ← 新：WS 主类（生命周期 / 心跳 / 重连）
│  └─ sidepanel/
│     ├─ app.tsx                      ← 改：加 "Coordinator" nav 按钮 + route
│     └─ pages/
│        └─ coordinator-settings-page.tsx  ← 新：URL/token 配置 + 状态展示
└─ tests/
   ├─ setup.ts                        (unchanged)
   ├─ background/
   │  ├─ coordinator-state.test.ts     ← 新
   │  ├─ coordinator-hello.test.ts     ← 新
   │  ├─ coordinator-exec.test.ts      ← 新
   │  └─ coordinator-client.test.ts    ← 新（mock WebSocket 单元测）
   ├─ background/
   │  └─ coordinator-e2e.test.ts       ← 新（用 ws 库起真 server 跑端到端）
   └─ sidepanel/pages/
      └─ coordinator-settings-page.test.tsx  ← 新
```

**几条关键设计**:

1. `CoordinatorClient` 是**单实例 + 单连接**——同一 SW 永远只持有一个 WS。设置页改 URL/token 触发 `disconnect() → connect()`。
2. `coordinator-exec.ts` 调 `runOneStep`（从 `rpc-handlers.ts` export 出来）——绝不重写 step 执行逻辑。
3. **不实现 catalog hash 校验**——Phase 2 worker 是被动接 EXEC，hash 校验是 coordinator 端职责（Phase 1 已落地）。
4. `chrome.alarms` 心跳定时器名固定为 `aipagego-coordinator-heartbeat`，避免和其他 alarm 冲突。
5. **不写 nonce 防重放逻辑**——nonce 由 server 检测；client 只负责每条 message 带新 nonce。
6. Settings page 暂用 `chrome.storage.local` 直接 await（不引 zustand store）——配置不频繁读，简单点。

---

## Task 1: 安装 ws + @types/ws (test dep) + 验证 baseline

**Files:**
- Modify: `packages/extension/package.json`

- [ ] **Step 1: 在 extension 包加 ws 作为 devDependency**

Run from worktree root:

```bash
pnpm --filter @aipagego/extension add -D ws @types/ws
```

Expected: `pnpm-lock.yaml` updated; `packages/extension/package.json` `devDependencies` has `ws` (latest, e.g. `^8.x`) + `@types/ws`.

- [ ] **Step 2: 验证 baseline 没坏**

```bash
pnpm typecheck
pnpm test
```

Expected: typecheck 0 errors; tests pass with prior 324 count (64 shared + 45 coordinator + 215 extension).

- [ ] **Step 3: Commit**

```bash
git add packages/extension/package.json pnpm-lock.yaml
git commit -m "chore(extension): add ws + @types/ws test deps for Phase 2 e2e"
```

---

## Task 2: coordinator-state.ts — persisted state

worker_id（一次生成）/ token / config（WS URL、enabled）都存 `chrome.storage.local`。

**Files:**
- Create: `packages/extension/src/background/coordinator-state.ts`
- Create: `packages/extension/tests/background/coordinator-state.test.ts`

- [ ] **Step 1: 写测试**

Create `packages/extension/tests/background/coordinator-state.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getOrCreateWorkerId,
  loadConfig,
  saveConfig,
  loadToken,
  saveToken,
  clearToken
} from "../../src/background/coordinator-state";

function fakeStorage() {
  const data = new Map<string, unknown>();
  return {
    storage: {
      local: {
        get: vi.fn(async (keys: string[] | string | null) => {
          const result: Record<string, unknown> = {};
          const requested = Array.isArray(keys)
            ? keys
            : typeof keys === "string"
              ? [keys]
              : [...data.keys()];
          for (const k of requested) {
            if (data.has(k)) result[k] = data.get(k);
          }
          return result;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) data.set(k, v);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          for (const k of ks) data.delete(k);
        })
      }
    }
  };
}

beforeEach(() => {
  vi.stubGlobal("chrome", fakeStorage());
});

describe("getOrCreateWorkerId", () => {
  it("generates a new id on first call and persists it", async () => {
    const id1 = await getOrCreateWorkerId();
    expect(id1).toMatch(/^worker_/);
    const id2 = await getOrCreateWorkerId();
    expect(id2).toBe(id1);
  });
});

describe("loadConfig / saveConfig", () => {
  it("returns undefined when no config saved", async () => {
    expect(await loadConfig()).toBeUndefined();
  });
  it("roundtrips a config", async () => {
    await saveConfig({ ws_url: "ws://localhost:7842/worker", enabled: true });
    const c = await loadConfig();
    expect(c).toEqual({ ws_url: "ws://localhost:7842/worker", enabled: true });
  });
});

describe("loadToken / saveToken / clearToken", () => {
  it("returns undefined when no token", async () => {
    expect(await loadToken()).toBeUndefined();
  });
  it("roundtrips a token", async () => {
    await saveToken("wpk_abc");
    expect(await loadToken()).toBe("wpk_abc");
  });
  it("clearToken removes the entry", async () => {
    await saveToken("wpk_abc");
    await clearToken();
    expect(await loadToken()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @aipagego/extension test tests/background/coordinator-state.test.ts`
Expected: FAIL — `Cannot find module ../../src/background/coordinator-state`.

- [ ] **Step 3: 实现**

Create `packages/extension/src/background/coordinator-state.ts`:

```ts
/**
 * Persisted state for the coordinator-client. Lives in chrome.storage.local
 * so it survives SW restarts. The worker_id is generated exactly once per
 * extension install and stays forever (it's how the coordinator identifies
 * the worker across reconnects).
 */

const STORAGE_KEYS = {
  worker_id: "aipagego.coordinator.worker_id",
  token: "aipagego.coordinator.token",
  config: "aipagego.coordinator.config"
} as const;

export interface CoordinatorConfig {
  ws_url: string;
  enabled: boolean;
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

export async function getOrCreateWorkerId(): Promise<string> {
  const got = await chrome.storage.local.get([STORAGE_KEYS.worker_id]);
  const existing = got[STORAGE_KEYS.worker_id] as string | undefined;
  if (existing) return existing;
  const fresh = randomId("worker");
  await chrome.storage.local.set({ [STORAGE_KEYS.worker_id]: fresh });
  return fresh;
}

export async function loadConfig(): Promise<CoordinatorConfig | undefined> {
  const got = await chrome.storage.local.get([STORAGE_KEYS.config]);
  return got[STORAGE_KEYS.config] as CoordinatorConfig | undefined;
}

export async function saveConfig(config: CoordinatorConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.config]: config });
}

export async function loadToken(): Promise<string | undefined> {
  const got = await chrome.storage.local.get([STORAGE_KEYS.token]);
  return got[STORAGE_KEYS.token] as string | undefined;
}

export async function saveToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.token]: token });
}

export async function clearToken(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.token);
}
```

- [ ] **Step 4: Confirm GREEN**

Run: `pnpm --filter @aipagego/extension test tests/background/coordinator-state.test.ts`
Expected: All 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/background/coordinator-state.ts packages/extension/tests/background/coordinator-state.test.ts
git commit -m "feat(extension): coordinator-state — worker_id + token + config persistence"
```

---

## Task 3: coordinator-hello.ts — build HELLO payload

从扩展状态（worker_id、能力清单、当前 tab 列表、saved tools 元数据）造一条合规的 HELLO 消息。

**Files:**
- Create: `packages/extension/src/background/coordinator-hello.ts`
- Create: `packages/extension/tests/background/coordinator-hello.test.ts`

- [ ] **Step 1: 写测试**

Create `packages/extension/tests/background/coordinator-hello.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildHello } from "../../src/background/coordinator-hello";
import { HelloSchema, PROTOCOL_VERSION } from "@aipagego/shared/protocol";

function fakeChrome(tabs: { id: number; url: string; title: string }[] = []) {
  return {
    tabs: {
      query: vi.fn(async () => tabs)
    },
    runtime: { id: "chrome-ext-id-fake", getManifest: () => ({ version: "0.0.8" }) }
  };
}

beforeEach(() => {
  vi.stubGlobal("chrome", fakeChrome([
    { id: 1, url: "https://example.com", title: "Example" },
    { id: 2, url: "https://shop.example.com/goods.html", title: "Shop goods" }
  ]));
});

describe("buildHello", () => {
  it("produces a payload that parses with HelloSchema", async () => {
    const payload = await buildHello({
      worker_id: "worker_abc",
      saved_tools: [],
      labels: []
    });
    const parsed = HelloSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("includes protocol_version + type=HELLO + worker_id", async () => {
    const payload = await buildHello({
      worker_id: "worker_abc",
      saved_tools: [],
      labels: []
    });
    expect(payload.type).toBe("HELLO");
    expect(payload.worker_id).toBe("worker_abc");
    expect(payload.protocol_version).toBe(PROTOCOL_VERSION);
  });

  it("advertises all 12 capabilities by default", async () => {
    const payload = await buildHello({
      worker_id: "w",
      saved_tools: [],
      labels: []
    });
    expect(payload.capabilities.length).toBe(12);
  });

  it("maps open tabs to available_tabs entries (tab_id as string)", async () => {
    const payload = await buildHello({
      worker_id: "w",
      saved_tools: [],
      labels: []
    });
    expect(payload.available_tabs).toEqual([
      { tab_id: "1", url: "https://example.com", title: "Example" },
      { tab_id: "2", url: "https://shop.example.com/goods.html", title: "Shop goods" }
    ]);
  });

  it("passes through saved_tools and labels", async () => {
    const payload = await buildHello({
      worker_id: "w",
      saved_tools: [
        { id: "shop_v3", version: 1, hash: "abc", url_pattern: ["https://*.example.com/**"] }
      ],
      labels: ["chrome:macos", "logged-in:shop"]
    });
    expect(payload.saved_tools[0].id).toBe("shop_v3");
    expect(payload.labels).toEqual(["chrome:macos", "logged-in:shop"]);
  });

  it("fingerprint has ext_hash/os/chrome fields filled", async () => {
    const payload = await buildHello({
      worker_id: "w",
      saved_tools: [],
      labels: []
    });
    expect(payload.fingerprint.ext_hash.length).toBeGreaterThan(0);
    expect(payload.fingerprint.chrome.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @aipagego/extension test tests/background/coordinator-hello.test.ts`
Expected: FAIL (file missing).

- [ ] **Step 3: 实现**

Create `packages/extension/src/background/coordinator-hello.ts`:

```ts
import {
  PROTOCOL_VERSION,
  type Hello
} from "@aipagego/shared/protocol";
import { CAPABILITIES } from "@aipagego/shared/capability";

export interface BuildHelloInput {
  worker_id: string;
  saved_tools: Hello["saved_tools"];
  labels: string[];
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function detectOs(): string {
  const ua = (globalThis.navigator?.userAgent ?? "").toLowerCase();
  if (ua.includes("mac")) return "darwin";
  if (ua.includes("win")) return "win32";
  if (ua.includes("linux")) return "linux";
  return "unknown";
}

function detectChromeVersion(): string {
  const ua = globalThis.navigator?.userAgent ?? "";
  const m = ua.match(/Chrome\/([\d.]+)/);
  return m?.[1] ?? "unknown";
}

export async function buildHello(input: BuildHelloInput): Promise<Hello> {
  const tabs = await chrome.tabs.query({});
  const available_tabs = tabs
    .filter((t) => t.id != null)
    .map((t) => ({
      tab_id: String(t.id),
      url: t.url ?? "",
      title: t.title ?? ""
    }));

  return {
    type: "HELLO",
    nonce: randomNonce(),
    ts: Date.now(),
    protocol_version: PROTOCOL_VERSION,
    worker_id: input.worker_id,
    fingerprint: {
      ext_hash: chrome.runtime.id ?? "unknown",
      os: detectOs(),
      chrome: detectChromeVersion()
    },
    capabilities: [...CAPABILITIES],
    attended: true,
    available_tabs,
    saved_tools: input.saved_tools,
    labels: input.labels
  };
}
```

- [ ] **Step 4: Confirm GREEN**

Run: `pnpm --filter @aipagego/extension test tests/background/coordinator-hello.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/background/coordinator-hello.ts packages/extension/tests/background/coordinator-hello.test.ts
git commit -m "feat(extension): coordinator-hello — build HELLO payload from worker state"
```

---

## Task 4: coordinator-exec.ts — handle EXEC, call runOneStep, build RESULT

收到 EXEC → 运行 step（复用 rpc-handlers 的 `runOneStep`）→ 构造 RESULT。

**Files:**
- Modify: `packages/extension/src/background/rpc-handlers.ts` (export `runOneStep`)
- Create: `packages/extension/src/background/coordinator-exec.ts`
- Create: `packages/extension/tests/background/coordinator-exec.test.ts`

- [ ] **Step 1: Export runOneStep from rpc-handlers.ts**

Open `packages/extension/src/background/rpc-handlers.ts` and find the line:

```ts
async function runOneStep(
```

Change to:

```ts
export async function runOneStep(
```

(Only that one-word change. Nothing else.)

- [ ] **Step 2: 写测试**

Create `packages/extension/tests/background/coordinator-exec.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleExec } from "../../src/background/coordinator-exec";
import { PROTOCOL_VERSION } from "@aipagego/shared/protocol";
import type { Exec } from "@aipagego/shared/protocol";

// Replace runOneStep with a stub for unit tests
vi.mock("../../src/background/rpc-handlers", () => ({
  runOneStep: vi.fn()
}));

import { runOneStep } from "../../src/background/rpc-handlers";

beforeEach(() => {
  vi.clearAllMocks();
});

const baseExec: Exec = {
  type: "EXEC",
  nonce: "n1",
  ts: 1,
  protocol_version: PROTOCOL_VERSION,
  req_id: "r1",
  session_id: "s1",
  tab_id: "42",
  step: { tool: "snapshotDOM", args: {} }
};

describe("handleExec", () => {
  it("calls runOneStep with parsed step + numeric tab id", async () => {
    (runOneStep as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { html: "<div/>" }
    });
    await handleExec(baseExec);
    const args = (runOneStep as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args[0]).toEqual({ tool: "snapshotDOM", args: {} });
    expect(args[1]).toBe(42);
  });

  it("returns RESULT with ok=true on success", async () => {
    (runOneStep as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { html: "<div/>" }
    });
    const r = await handleExec(baseExec);
    expect(r.type).toBe("RESULT");
    expect(r.req_id).toBe("r1");
    expect(r.ok).toBe(true);
    expect(r.return).toEqual({ html: "<div/>" });
  });

  it("returns RESULT with ok=false + ErrorBody on runOneStep failure", async () => {
    (runOneStep as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "tab closed"
    });
    const r = await handleExec(baseExec);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("PageScriptError");
    expect(r.error?.message).toContain("tab closed");
    expect(r.error?.retryable).toBe(false);
  });

  it("returns RESULT with ok=false on runOneStep throwing", async () => {
    (runOneStep as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("boom")
    );
    const r = await handleExec(baseExec);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("InternalError");
    expect(r.error?.message).toContain("boom");
  });

  it("returns InvalidArgs when tab_id is not a number", async () => {
    const bad: Exec = { ...baseExec, tab_id: "not-a-number" };
    const r = await handleExec(bad);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("InvalidArgs");
  });
});
```

- [ ] **Step 3: Confirm RED**

Run: `pnpm --filter @aipagego/extension test tests/background/coordinator-exec.test.ts`
Expected: FAIL — coordinator-exec module not found.

- [ ] **Step 4: 实现**

Create `packages/extension/src/background/coordinator-exec.ts`:

```ts
import { PROTOCOL_VERSION, type Exec, type Result, type ErrorBody } from "@aipagego/shared/protocol";
import type { Step } from "@aipagego/shared/types";
import { runOneStep } from "./rpc-handlers";

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function makeError(code: ErrorBody["code"], message: string, retryable = false): ErrorBody {
  return { code, message, retryable };
}

function makeResult(req_id: string, ok: boolean, ret?: unknown, error?: ErrorBody): Result {
  return {
    type: "RESULT",
    nonce: randomNonce(),
    ts: Date.now(),
    protocol_version: PROTOCOL_VERSION,
    req_id,
    ok,
    ...(ret !== undefined ? { return: ret } : {}),
    ...(error ? { error } : {})
  };
}

/**
 * Handle a single EXEC message from the coordinator: parse tab id, delegate
 * to runOneStep, and wrap the outcome in a RESULT envelope. Never throws —
 * any error becomes an `ok: false` RESULT.
 */
export async function handleExec(exec: Exec): Promise<Result> {
  const tabId = Number.parseInt(exec.tab_id, 10);
  if (!Number.isFinite(tabId)) {
    return makeResult(exec.req_id, false, undefined, makeError(
      "InvalidArgs",
      `tab_id "${exec.tab_id}" is not a number`
    ));
  }

  try {
    const stepResult = await runOneStep(exec.step as Step, tabId);
    if (stepResult.ok) {
      return makeResult(exec.req_id, true, stepResult.data);
    }
    return makeResult(exec.req_id, false, undefined, makeError(
      "PageScriptError",
      stepResult.error
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeResult(exec.req_id, false, undefined, makeError(
      "InternalError",
      message,
      true
    ));
  }
}
```

- [ ] **Step 5: Confirm GREEN**

Run: `pnpm --filter @aipagego/extension test tests/background/coordinator-exec.test.ts`
Expected: 5 tests pass.

- [ ] **Step 6: Verify the runOneStep export change didn't break anything**

Run: `pnpm --filter @aipagego/extension test tests/background/rpc-handlers.test.ts`
Expected: existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/background/rpc-handlers.ts packages/extension/src/background/coordinator-exec.ts packages/extension/tests/background/coordinator-exec.test.ts
git commit -m "feat(extension): coordinator-exec — EXEC → runOneStep → RESULT"
```

---

## Task 5: coordinator-client.ts — WS client主类

The big one: lifecycle, HELLO handshake, PING/PONG, EXEC routing, reconnect, chrome.alarms keepalive.

**Files:**
- Create: `packages/extension/src/background/coordinator-client.ts`
- Create: `packages/extension/tests/background/coordinator-client.test.ts`

- [ ] **Step 1: 写测试**

Create `packages/extension/tests/background/coordinator-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CoordinatorClient } from "../../src/background/coordinator-client";
import { PROTOCOL_VERSION } from "@aipagego/shared/protocol";

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0; // CONNECTING
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  onopen: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string, public protocols?: string | string[]) {
    FakeWS.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.({ code: 1000, reason: "client close" } as CloseEvent);
  }
  // helpers
  fakeOpen() {
    this.readyState = FakeWS.OPEN;
    this.onopen?.(new Event("open"));
  }
  fakeMessage(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) } as MessageEvent);
  }
}

function fakeChrome() {
  const listeners: ((alarm: { name: string }) => void)[] = [];
  return {
    tabs: { query: vi.fn(async () => []) },
    runtime: { id: "ext-abc", getManifest: () => ({ version: "0.0.8" }) },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) } },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: {
        addListener: vi.fn((cb: (alarm: { name: string }) => void) => listeners.push(cb)),
        removeListener: vi.fn()
      },
      _fire(name: string) {
        for (const cb of listeners) cb({ name });
      }
    }
  };
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("chrome", fakeChrome());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CoordinatorClient.connect", () => {
  it("opens a WebSocket to the configured URL with Authorization protocol", async () => {
    const client = new CoordinatorClient({
      ws_url: "ws://localhost:7842/worker",
      token: "wpk_xyz",
      worker_id: "worker_abc",
      savedToolsProvider: async () => [],
      labelsProvider: async () => []
    });
    await client.connect();
    const ws = FakeWS.instances[0];
    expect(ws.url).toBe("ws://localhost:7842/worker");
    expect(ws.protocols).toEqual(["bearer.wpk_xyz", `proto.${PROTOCOL_VERSION}`]);
  });

  it("sends HELLO on open", async () => {
    const client = new CoordinatorClient({
      ws_url: "ws://localhost:7842",
      token: "t",
      worker_id: "w1",
      savedToolsProvider: async () => [],
      labelsProvider: async () => []
    });
    await client.connect();
    FakeWS.instances[0].fakeOpen();
    await new Promise((r) => setTimeout(r, 0));
    const first = JSON.parse(FakeWS.instances[0].sent[0]);
    expect(first.type).toBe("HELLO");
    expect(first.worker_id).toBe("w1");
  });

  it("after WELCOME, status is connected", async () => {
    const client = new CoordinatorClient({
      ws_url: "ws://localhost:7842",
      token: "t",
      worker_id: "w1",
      savedToolsProvider: async () => [],
      labelsProvider: async () => []
    });
    await client.connect();
    const ws = FakeWS.instances[0];
    ws.fakeOpen();
    await new Promise((r) => setTimeout(r, 0));
    ws.fakeMessage({
      type: "WELCOME",
      nonce: "n",
      ts: 1,
      protocol_version: PROTOCOL_VERSION,
      server_time: 1,
      heartbeat_interval_ms: 20000
    });
    expect(client.status).toBe("connected");
  });

  it("PING from server triggers PONG response", async () => {
    const client = new CoordinatorClient({
      ws_url: "ws://localhost:7842",
      token: "t",
      worker_id: "w1",
      savedToolsProvider: async () => [],
      labelsProvider: async () => []
    });
    await client.connect();
    const ws = FakeWS.instances[0];
    ws.fakeOpen();
    await new Promise((r) => setTimeout(r, 0));
    ws.fakeMessage({
      type: "WELCOME",
      nonce: "n",
      ts: 1,
      protocol_version: PROTOCOL_VERSION,
      server_time: 1,
      heartbeat_interval_ms: 20000
    });
    ws.sent.length = 0;
    ws.fakeMessage({
      type: "PING",
      nonce: "ping-nonce",
      ts: 2,
      protocol_version: PROTOCOL_VERSION
    });
    await new Promise((r) => setTimeout(r, 0));
    const pong = JSON.parse(ws.sent[0]);
    expect(pong.type).toBe("PONG");
    expect(pong.echo_nonce).toBe("ping-nonce");
  });

  it("disconnect closes the socket and sets status=disconnected", async () => {
    const client = new CoordinatorClient({
      ws_url: "ws://localhost:7842",
      token: "t",
      worker_id: "w1",
      savedToolsProvider: async () => [],
      labelsProvider: async () => []
    });
    await client.connect();
    await client.disconnect();
    expect(client.status).toBe("disconnected");
    expect(FakeWS.instances[0].readyState).toBe(FakeWS.CLOSED);
  });

  it("rejects WELCOME with mismatched protocol_version and disconnects", async () => {
    const client = new CoordinatorClient({
      ws_url: "ws://localhost:7842",
      token: "t",
      worker_id: "w1",
      savedToolsProvider: async () => [],
      labelsProvider: async () => []
    });
    await client.connect();
    const ws = FakeWS.instances[0];
    ws.fakeOpen();
    await new Promise((r) => setTimeout(r, 0));
    ws.fakeMessage({
      type: "WELCOME",
      nonce: "n",
      ts: 1,
      protocol_version: PROTOCOL_VERSION + 99,
      server_time: 1,
      heartbeat_interval_ms: 20000
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(client.status).toBe("error");
    expect(ws.readyState).toBe(FakeWS.CLOSED);
  });

  it("EXEC delivery is forwarded to the injected handler", async () => {
    const execHandler = vi.fn().mockResolvedValue({
      type: "RESULT",
      nonce: "rn",
      ts: 1,
      protocol_version: PROTOCOL_VERSION,
      req_id: "r1",
      ok: true,
      return: { x: 1 }
    });
    const client = new CoordinatorClient({
      ws_url: "ws://localhost:7842",
      token: "t",
      worker_id: "w1",
      savedToolsProvider: async () => [],
      labelsProvider: async () => [],
      onExec: execHandler
    });
    await client.connect();
    const ws = FakeWS.instances[0];
    ws.fakeOpen();
    await new Promise((r) => setTimeout(r, 0));
    ws.fakeMessage({
      type: "WELCOME",
      nonce: "n",
      ts: 1,
      protocol_version: PROTOCOL_VERSION,
      server_time: 1,
      heartbeat_interval_ms: 20000
    });
    ws.sent.length = 0;
    ws.fakeMessage({
      type: "EXEC",
      nonce: "e",
      ts: 2,
      protocol_version: PROTOCOL_VERSION,
      req_id: "r1",
      session_id: "s1",
      tab_id: "42",
      step: { tool: "snapshotDOM", args: {} }
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(execHandler).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(ws.sent[0]);
    expect(sent.type).toBe("RESULT");
    expect(sent.req_id).toBe("r1");
  });
});
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @aipagego/extension test tests/background/coordinator-client.test.ts`
Expected: FAIL.

- [ ] **Step 3: 实现**

Create `packages/extension/src/background/coordinator-client.ts`:

```ts
import {
  PROTOCOL_VERSION,
  ClientToServerSchema,
  ServerToClientSchema,
  type Exec,
  type Hello,
  type Result,
  type ServerToClient
} from "@aipagego/shared/protocol";
import { buildHello } from "./coordinator-hello";

const HEARTBEAT_ALARM = "aipagego-coordinator-heartbeat";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type ClientStatus = "disconnected" | "connecting" | "connected" | "error";

export interface CoordinatorClientOptions {
  ws_url: string;
  token: string;
  worker_id: string;
  savedToolsProvider: () => Promise<Hello["saved_tools"]>;
  labelsProvider: () => Promise<string[]>;
  onExec?: (exec: Exec) => Promise<Result>;
  onStatusChange?: (s: ClientStatus) => void;
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class CoordinatorClient {
  private ws: WebSocket | null = null;
  private _status: ClientStatus = "disconnected";
  private reconnectAttempts = 0;
  private alarmListener: ((alarm: { name: string }) => void) | null = null;
  private intentionallyClosed = false;

  constructor(private opts: CoordinatorClientOptions) {}

  get status(): ClientStatus {
    return this._status;
  }

  private setStatus(s: ClientStatus): void {
    this._status = s;
    this.opts.onStatusChange?.(s);
  }

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    this.setStatus("connecting");
    const protocols = [`bearer.${this.opts.token}`, `proto.${PROTOCOL_VERSION}`];
    this.ws = new WebSocket(this.opts.ws_url, protocols);
    this.ws.onopen = () => this.handleOpen();
    this.ws.onclose = () => this.handleClose();
    this.ws.onerror = () => this.setStatus("error");
    this.ws.onmessage = (ev) => this.handleMessage(ev.data);
    this.installAlarm();
  }

  async disconnect(): Promise<void> {
    this.intentionallyClosed = true;
    this.uninstallAlarm();
    this.ws?.close();
    this.ws = null;
    this.setStatus("disconnected");
  }

  private async handleOpen(): Promise<void> {
    try {
      const saved_tools = await this.opts.savedToolsProvider();
      const labels = await this.opts.labelsProvider();
      const hello = await buildHello({
        worker_id: this.opts.worker_id,
        saved_tools,
        labels
      });
      this.send(hello);
    } catch (err) {
      console.error("[coordinator-client] failed to send HELLO", err);
      this.setStatus("error");
      this.ws?.close();
    }
  }

  private async handleMessage(raw: unknown): Promise<void> {
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      console.warn("[coordinator-client] malformed message", raw);
      return;
    }
    const result = ServerToClientSchema.safeParse(parsed);
    if (!result.success) {
      console.warn("[coordinator-client] failed to validate server message", parsed);
      return;
    }
    const msg: ServerToClient = result.data;
    switch (msg.type) {
      case "WELCOME":
        if (msg.protocol_version !== PROTOCOL_VERSION) {
          console.error("[coordinator-client] protocol version mismatch",
            msg.protocol_version, "expected", PROTOCOL_VERSION);
          this.setStatus("error");
          this.ws?.close();
          return;
        }
        this.reconnectAttempts = 0;
        this.setStatus("connected");
        return;
      case "PING":
        this.send({
          type: "PONG",
          nonce: randomNonce(),
          ts: Date.now(),
          protocol_version: PROTOCOL_VERSION,
          echo_nonce: msg.nonce
        });
        return;
      case "OPEN_TAB":
        // Phase 2: ignore — tab management is a Phase 3 concern when daemon ships
        return;
      case "EXEC":
        if (!this.opts.onExec) {
          console.warn("[coordinator-client] received EXEC but no onExec configured");
          return;
        }
        try {
          const result = await this.opts.onExec(msg);
          this.send(result);
        } catch (err) {
          console.error("[coordinator-client] onExec threw", err);
        }
        return;
      case "CLOSE_SESSION":
        // Phase 2: ignore — sessions are coordinator-managed
        return;
    }
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // Validate outgoing client-to-server messages catch silently-broken payloads.
    const r = ClientToServerSchema.safeParse(msg);
    if (!r.success) {
      console.error("[coordinator-client] outgoing message failed schema", r.error);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  private handleClose(): void {
    this.uninstallAlarm();
    if (this.intentionallyClosed) {
      this.setStatus("disconnected");
      return;
    }
    this.setStatus("disconnected");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const backoff = Math.min(
      RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1),
      RECONNECT_MAX_MS
    );
    setTimeout(() => {
      if (this.intentionallyClosed) return;
      void this.connect();
    }, backoff);
  }

  private installAlarm(): void {
    if (!chrome.alarms || this.alarmListener) return;
    chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.25 }); // 15s
    this.alarmListener = (alarm) => {
      if (alarm.name !== HEARTBEAT_ALARM) return;
      // Sending a PING here keeps the SW alive AND probes the connection.
      this.send({
        type: "PING",
        nonce: randomNonce(),
        ts: Date.now(),
        protocol_version: PROTOCOL_VERSION
      });
    };
    chrome.alarms.onAlarm.addListener(this.alarmListener);
  }

  private uninstallAlarm(): void {
    if (this.alarmListener) {
      chrome.alarms?.onAlarm.removeListener(this.alarmListener);
      this.alarmListener = null;
    }
    void chrome.alarms?.clear(HEARTBEAT_ALARM);
  }
}
```

- [ ] **Step 4: Confirm GREEN**

Run: `pnpm --filter @aipagego/extension test tests/background/coordinator-client.test.ts`
Expected: 7 tests pass.

If any test fails, do NOT silently weaken — the test specifies behavior the spec requires. Diagnose, fix, repeat.

- [ ] **Step 5: typecheck**

Run: `pnpm --filter @aipagego/extension typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/background/coordinator-client.ts packages/extension/tests/background/coordinator-client.test.ts
git commit -m "$(cat <<'EOF'
feat(extension): coordinator-client — WS lifecycle with HELLO/PING/EXEC

Connects with Bearer token via WebSocket subprotocols, sends HELLO on
open, validates WELCOME's protocol_version (mismatch closes the
connection), auto-PONGs every PING, routes EXEC to an injected
handler, and reconnects with exponential backoff (1s → 30s cap).
chrome.alarms keeps the MV3 service worker alive at 15s cadence.
EOF
)"
```

---

## Task 6: Wire CoordinatorClient into background SW

启动时根据持久化配置可选拉起 client；储存配置变更时重连。

**Files:**
- Modify: `packages/extension/src/background/index.ts`
- (No new test — covered by e2e in Task 8)

- [ ] **Step 1: 更新 index.ts**

Open `packages/extension/src/background/index.ts`. Currently:

```ts
import { RpcRequest as RpcRequestSchema } from "@aipagego/shared/messages";
import { handleRpc } from "./rpc-handlers";
import { installTabWatcher } from "./tab-watcher";

chrome.runtime.onInstalled.addListener(() => {
  console.info("[aipagego] service worker installed");
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("[aipagego] sidePanel setPanelBehavior", e));

installTabWatcher();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ... existing
});
```

Add coordinator-client startup logic at the bottom of the file (after the existing listeners):

```ts
import { RpcRequest as RpcRequestSchema } from "@aipagego/shared/messages";
import { handleRpc } from "./rpc-handlers";
import { installTabWatcher } from "./tab-watcher";
import { CoordinatorClient } from "./coordinator-client";
import { getOrCreateWorkerId, loadConfig, loadToken } from "./coordinator-state";
import { handleExec } from "./coordinator-exec";
import { listTools as listSavedTools } from "./storage/tools";

chrome.runtime.onInstalled.addListener(() => {
  console.info("[aipagego] service worker installed");
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("[aipagego] sidePanel setPanelBehavior", e));

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

// --- Coordinator client (Phase 2) ---
let activeClient: CoordinatorClient | null = null;

async function buildSavedToolsMetadata(): Promise<Array<{ id: string; version: number; hash: string; url_pattern: string[]; description?: string }>> {
  const tools = await listSavedTools();
  return tools.map((t) => ({
    id: t.id,
    version: t.versions?.length ?? 1,
    hash: t.id, // Phase 2 stub: hash from id; Phase 3 will introduce real content hashing
    url_pattern: t.urlPatterns,
    description: t.description
  }));
}

export async function startCoordinatorClient(): Promise<void> {
  if (activeClient) return;
  const config = await loadConfig();
  if (!config?.enabled || !config.ws_url) return;
  const token = await loadToken();
  if (!token) {
    console.warn("[aipagego] coordinator enabled but no token saved");
    return;
  }
  const worker_id = await getOrCreateWorkerId();
  activeClient = new CoordinatorClient({
    ws_url: config.ws_url,
    token,
    worker_id,
    savedToolsProvider: buildSavedToolsMetadata,
    labelsProvider: async () => [],
    onExec: handleExec
  });
  await activeClient.connect();
}

export async function stopCoordinatorClient(): Promise<void> {
  if (!activeClient) return;
  await activeClient.disconnect();
  activeClient = null;
}

void startCoordinatorClient();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = Object.keys(changes);
  if (
    keys.some(
      (k) =>
        k === "aipagego.coordinator.config" || k === "aipagego.coordinator.token"
    )
  ) {
    void (async () => {
      await stopCoordinatorClient();
      await startCoordinatorClient();
    })();
  }
});
```

If `listTools` is not the correct export name from `./storage/tools`, find the actual function with `grep -nE "^export.*tools|^export.*list" packages/extension/src/background/storage/tools.ts` and substitute.

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @aipagego/extension typecheck`
Expected: 0 errors. If `listSavedTools` doesn't resolve, fix the import to the actual function name and re-run.

- [ ] **Step 3: full test run on extension package**

Run: `pnpm --filter @aipagego/extension test`
Expected: previous 215 tests + new ~22 from Tasks 2-5 = ~237 tests, all green.

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/background/index.ts
git commit -m "feat(extension): start coordinator-client on SW boot when configured

Reads worker_id/token/config from chrome.storage.local. If config is
enabled and a token is saved, connects on every SW startup. Listens
on storage.onChanged to restart the client when settings change."
```

---

## Task 7: Sidepanel CoordinatorSettings page + router integration

**Files:**
- Create: `packages/extension/src/sidepanel/pages/coordinator-settings-page.tsx`
- Modify: `packages/extension/src/sidepanel/app.tsx`
- Create: `packages/extension/tests/sidepanel/pages/coordinator-settings-page.test.tsx`

- [ ] **Step 1: 写测试**

Create `packages/extension/tests/sidepanel/pages/coordinator-settings-page.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CoordinatorSettingsPage } from "../../../src/sidepanel/pages/coordinator-settings-page";

function fakeChromeStorage() {
  const data = new Map<string, unknown>();
  return {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[] | null) => {
          const result: Record<string, unknown> = {};
          const requested = Array.isArray(keys)
            ? keys
            : typeof keys === "string"
              ? [keys]
              : [...data.keys()];
          for (const k of requested) {
            if (data.has(k)) result[k] = data.get(k);
          }
          return result;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) data.set(k, v);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          for (const k of ks) data.delete(k);
        }),
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  };
}

beforeEach(() => {
  vi.stubGlobal("chrome", fakeChromeStorage());
});

describe("CoordinatorSettingsPage", () => {
  it("loads saved config + token on mount", async () => {
    render(<CoordinatorSettingsPage />);
    await waitFor(() => screen.getByLabelText(/WS URL/i));
    expect(screen.getByLabelText(/WS URL/i)).toHaveValue("");
  });

  it("typing URL + token + clicking 连接 saves them", async () => {
    render(<CoordinatorSettingsPage />);
    await waitFor(() => screen.getByLabelText(/WS URL/i));
    fireEvent.change(screen.getByLabelText(/WS URL/i), {
      target: { value: "ws://localhost:7842/worker" }
    });
    fireEvent.change(screen.getByLabelText(/Token/i), {
      target: { value: "wpk_xyz" }
    });
    fireEvent.click(screen.getByRole("button", { name: /连接/ }));
    await waitFor(() => {
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        "aipagego.coordinator.config": {
          ws_url: "ws://localhost:7842/worker",
          enabled: true
        }
      });
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        "aipagego.coordinator.token": "wpk_xyz"
      });
    });
  });

  it("断开 button clears enabled flag", async () => {
    const chromeMock = fakeChromeStorage();
    chromeMock.storage.local.get = vi.fn(async () => ({
      "aipagego.coordinator.config": {
        ws_url: "ws://localhost:7842/worker",
        enabled: true
      },
      "aipagego.coordinator.token": "wpk"
    }));
    vi.stubGlobal("chrome", chromeMock);
    render(<CoordinatorSettingsPage />);
    await waitFor(() => screen.getByRole("button", { name: /断开/ }));
    fireEvent.click(screen.getByRole("button", { name: /断开/ }));
    await waitFor(() => {
      expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
        "aipagego.coordinator.config": {
          ws_url: "ws://localhost:7842/worker",
          enabled: false
        }
      });
    });
  });
});
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm --filter @aipagego/extension test tests/sidepanel/pages/coordinator-settings-page.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: 实现 page**

Create `packages/extension/src/sidepanel/pages/coordinator-settings-page.tsx`:

```tsx
import { useEffect, useState } from "react";
import {
  loadConfig,
  saveConfig,
  loadToken,
  saveToken,
  clearToken,
  type CoordinatorConfig
} from "../../background/coordinator-state";

export function CoordinatorSettingsPage() {
  const [wsUrl, setWsUrl] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const cfg = await loadConfig();
      if (cfg) {
        setWsUrl(cfg.ws_url);
        setEnabled(cfg.enabled);
      }
      const t = await loadToken();
      if (t) setToken(t);
      setLoaded(true);
    })();
  }, []);

  async function handleConnect() {
    const cfg: CoordinatorConfig = { ws_url: wsUrl, enabled: true };
    await saveConfig(cfg);
    if (token) await saveToken(token);
    setEnabled(true);
    setSavedMsg("已连接");
  }

  async function handleDisconnect() {
    await saveConfig({ ws_url: wsUrl, enabled: false });
    setEnabled(false);
    setSavedMsg("已断开");
  }

  async function handleClearToken() {
    await clearToken();
    setToken("");
    setSavedMsg("Token 已清除");
  }

  if (!loaded) return <div className="p-4">载入中…</div>;

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-lg font-semibold">Coordinator 连接</h2>

      <p className="text-sm text-gray-600">
        把扩展作为 worker 接到一个 coordinator（本地 daemon 或远程 server）。Phase 2
        仅支持手动 paste token；6 位配对码 + daemon UX 在 Phase 3 完成。
      </p>

      <label className="block">
        <span className="text-sm font-medium">WS URL</span>
        <input
          type="text"
          className="mt-1 block w-full rounded border px-2 py-1"
          placeholder="ws://localhost:7842/worker"
          value={wsUrl}
          onChange={(e) => setWsUrl(e.target.value)}
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium">Token</span>
        <input
          type="password"
          className="mt-1 block w-full rounded border px-2 py-1"
          placeholder="wpk_..."
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>

      <div className="flex gap-2">
        {enabled ? (
          <button
            type="button"
            className="rounded bg-gray-200 px-3 py-1 text-sm"
            onClick={handleDisconnect}
          >
            断开
          </button>
        ) : (
          <button
            type="button"
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            disabled={!wsUrl || !token}
            onClick={handleConnect}
          >
            连接
          </button>
        )}
        {token && (
          <button
            type="button"
            className="rounded bg-red-100 px-3 py-1 text-sm text-red-700"
            onClick={handleClearToken}
          >
            清 Token
          </button>
        )}
      </div>

      {savedMsg && <div className="text-sm text-green-700">{savedMsg}</div>}

      <div className="border-t pt-3 text-xs text-gray-500">
        <div>状态: {enabled ? "已配置（启用）" : "已配置（关闭）"}</div>
        <div>连接状态请看 chrome://serviceworker-internals 或 SW 日志。Phase 3 会接入实时状态推送。</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 接入 app.tsx router**

Open `packages/extension/src/sidepanel/app.tsx`. Add the import + nav button + route case:

Add to imports:
```tsx
import { CoordinatorSettingsPage } from "./pages/coordinator-settings-page";
```

Find the `type Route =` declaration and add `"coordinator"` to the union:
```tsx
type Route =
  | { name: "chat" }
  | { name: "run" }
  | { name: "tools" }
  | { name: "tool"; id: string; autoRun?: boolean }
  | { name: "settings" }
  | { name: "coordinator" };
```

Find the nav buttons block (where existing `NavBtn` for "chat" / "tools" / "run" / "settings" appear) and add one more:

```tsx
<NavBtn
  active={route.name === "coordinator"}
  onClick={() => setRoute({ name: "coordinator" })}
>
  Coordinator
</NavBtn>
```

Place it AFTER the settings NavBtn (rightmost) — settings remains the last "core" nav, coordinator is the new advanced one.

Find the route rendering block (where `route.name === "settings"` renders `<SettingsPage />`) and add:

```tsx
{route.name === "coordinator" && <CoordinatorSettingsPage />}
```

- [ ] **Step 5: Confirm GREEN**

Run:
```bash
pnpm --filter @aipagego/extension test tests/sidepanel/pages/coordinator-settings-page.test.tsx
pnpm --filter @aipagego/extension typecheck
```

Expected: 3 page tests pass; typecheck 0 errors (the `Route` union expansion + new route case both type-check).

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/sidepanel/pages/coordinator-settings-page.tsx packages/extension/src/sidepanel/app.tsx packages/extension/tests/sidepanel/pages/coordinator-settings-page.test.tsx
git commit -m "feat(extension): sidepanel CoordinatorSettings page

URL/token paste, enable/disable, clear-token. Phase 2 deliberately
skips pair-code UX — Phase 3 daemon will introduce the 6-digit code
flow + live status."
```

---

## Task 8: End-to-end integration test (real ws server + extension client)

跑通 HELLO → WELCOME → EXEC → RESULT 全链路在 vitest 内。

**Files:**
- Create: `packages/extension/tests/background/coordinator-e2e.test.ts`

- [ ] **Step 1: 写 e2e test**

Create `packages/extension/tests/background/coordinator-e2e.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { CoordinatorClient } from "../../src/background/coordinator-client";
import {
  PROTOCOL_VERSION,
  ClientToServerSchema,
  type Hello
} from "@aipagego/shared/protocol";

function fakeChrome() {
  return {
    tabs: { query: vi.fn(async () => []) },
    runtime: { id: "ext-id", getManifest: () => ({ version: "0.0.8" }) },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  };
}

let wss: WebSocketServer | null = null;
let baseUrl = "";

beforeEach(async () => {
  vi.stubGlobal("chrome", fakeChrome());
  // Node 18+ has global WebSocket; vitest's environment may already provide it.
  // If not, fall back to the `ws` package's WebSocket on globalThis.
  if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
    const ws = await import("ws");
    (globalThis as { WebSocket: unknown }).WebSocket = ws.WebSocket;
  }
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss!.on("listening", () => resolve()));
  const addr = wss.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${addr.port}/worker`;
});

afterEach(async () => {
  if (wss) await new Promise<void>((r) => wss!.close(() => r()));
  wss = null;
});

describe("coordinator-client end-to-end with ws server", () => {
  it("completes HELLO → WELCOME → EXEC → RESULT round trip", async () => {
    let helloReceived: Hello | null = null;
    let resultReceived: unknown = null;

    const serverDone = new Promise<void>((resolve) => {
      wss!.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const parsed = JSON.parse(raw.toString());
          const r = ClientToServerSchema.safeParse(parsed);
          if (!r.success) {
            socket.close();
            return;
          }
          if (r.data.type === "HELLO") {
            helloReceived = r.data;
            socket.send(JSON.stringify({
              type: "WELCOME",
              nonce: "server-n",
              ts: Date.now(),
              protocol_version: PROTOCOL_VERSION,
              server_time: Date.now(),
              heartbeat_interval_ms: 20000
            }));
            socket.send(JSON.stringify({
              type: "EXEC",
              nonce: "exec-n",
              ts: Date.now(),
              protocol_version: PROTOCOL_VERSION,
              req_id: "req-1",
              session_id: "sess-1",
              tab_id: "1",
              step: { tool: "snapshotDOM", args: {} }
            }));
          } else if (r.data.type === "RESULT") {
            resultReceived = r.data;
            resolve();
          }
        });
      });
    });

    const client = new CoordinatorClient({
      ws_url: baseUrl,
      token: "wpk_test",
      worker_id: "worker_e2e",
      savedToolsProvider: async () => [],
      labelsProvider: async () => [],
      onExec: async (exec) => ({
        type: "RESULT",
        nonce: "client-n",
        ts: Date.now(),
        protocol_version: PROTOCOL_VERSION,
        req_id: exec.req_id,
        ok: true,
        return: { handled_by: "test stub", req_id: exec.req_id }
      })
    });

    await client.connect();
    await serverDone;
    await client.disconnect();

    expect(helloReceived).not.toBeNull();
    expect(helloReceived!.type).toBe("HELLO");
    expect(helloReceived!.worker_id).toBe("worker_e2e");
    expect(resultReceived).not.toBeNull();
    const r = resultReceived as { type: string; req_id: string; ok: boolean };
    expect(r.type).toBe("RESULT");
    expect(r.req_id).toBe("req-1");
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Confirm GREEN**

Run: `pnpm --filter @aipagego/extension test tests/background/coordinator-e2e.test.ts`
Expected: 1 test pass within a couple seconds (the entire WS round trip).

If `WebSocket` is not on globalThis in vitest's node env, the test will fail with a clear error — fix by ensuring the test imports `ws` and patches globalThis as shown.

- [ ] **Step 3: Full repo verification**

Run from worktree root:
```bash
pnpm typecheck
pnpm test
pnpm build
```

Expected:
- typecheck 0 errors across all 3 packages
- test: total 324 (baseline) + 6 + 6 + 5 + 7 + 3 + 1 = ~352. Exact count depends on individual test grouping. All green.
- build produces `packages/extension/dist/manifest.json` with version 0.0.8 (or whichever is current after any release bumps in this branch).

- [ ] **Step 4: Commit**

```bash
git add packages/extension/tests/background/coordinator-e2e.test.ts
git commit -m "$(cat <<'EOF'
test(extension): coordinator-client end-to-end with real ws server

Spins up a WebSocketServer on a random port, walks the
HELLO → WELCOME → EXEC → RESULT contract, and asserts the worker
side parses + emits according to @aipagego/shared/protocol. Proves
the wire works without needing Phase 3's daemon to exist yet.
EOF
)"
```

---

## Phase 2 收尾验证

- [ ] **Step 1: Full suite**

```bash
pnpm typecheck
pnpm test
pnpm build
```

Expected:
- typecheck 0 errors
- test all green, total ≥ 350
- build produces extension dist artifacts

- [ ] **Step 2: Smoke walk (optional manual)**

Load `packages/extension/dist/` in chrome://extensions. Open side panel, click new "Coordinator" tab. Verify URL/Token fields render. Don't actually connect (no daemon yet — that's Phase 3).

- [ ] **Step 3: Repo hygiene**

```bash
git status
git log --oneline origin/main..HEAD | head -10
```

Expected: 8 Phase 2 commits, clean working tree.

---

## Self-Review Checklist

- ✅ Spec §4.2 worker connect/HELLO flow → Tasks 3 + 5
- ✅ Spec §4.4 EXEC handling → Tasks 4 + 5
- ✅ Spec §3 extension/coordinator-client.ts file boundary → Task 5
- ✅ Spec §3 sidepanel CoordinatorSettings page → Task 7
- ✅ Spec §4.2 PROTOCOL_VERSION validation on WELCOME → Task 5 test
- ✅ Spec §7.5 "MV3 SW idle kill" — `chrome.alarms` heartbeat → Task 5
- ✅ Spec §7.5 "reconnect" → Task 5 backoff schedule
- ✅ Phase 2 negative-space respected (no /pair, no daemon, no MCP)
- ✅ No TBD / TODO / "fill in" in steps
- ✅ Type/name consistency: `CoordinatorClient`, `CoordinatorClientOptions`, `ClientStatus`, `CoordinatorConfig`, `handleExec`, `buildHello`, `getOrCreateWorkerId` — all used identically wherever they appear
- ✅ Each step gives full file content; no "similar to X" shortcuts
- ✅ Exact commands with expected output everywhere
