# Multi-Session Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let N Claude Code sessions drive the same browser at once, each through its own connection, with lazy port binding and one-time user consent.

**Architecture:** The MCP server stops binding a port at startup and does so lazily, on an ephemeral port it reuses across restarts. It serves a `/pair` page that hands the extension a port the extension could not otherwise discover; the extension — not the page — renders the approval UI. The extension replaces its single `CoordinatorClient` with a pool of them, tracks which session owns which tab, and pushes tab updates so `list_tabs` stops being a connect-time snapshot.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest + happy-dom, Chrome MV3 (`chrome.storage`, `chrome.alarms`, `chrome.tabs`), `ws`, `node:http`, zod.

**Spec:** [`../specs/2026-08-18-multi-session-pairing-design.md`](../specs/2026-08-18-multi-session-pairing-design.md)

## Global Constraints

- Identity file `~/.aipagego/identity.json`, mode `0600`, holding `{ installId, secret }` only. `sessionId`, cwd `label`, and `pid` are per-process and never persisted.
- Trust is install-level. `sessionId` and `label` are display and management only; they take no part in the trust decision.
- The `/pair` page is a carrier. Approval is rendered by the extension as a shadow-DOM overlay; a served page must never be able to authorise itself.
- No port scanning and no port range. The pairing page is the only discovery channel.
- Port preference order: recorded `lastPort`, then ephemeral (`0`).
- Graceful shutdown uses WS close code `4000` with reason `server-shutting-down`.
- Dormancy threshold: 10 consecutive connection failures. Dormancy stops retries but never clears the trust record.
- Tab ownership is advisory. `busy` is reported; nothing is ever blocked.
- `packages/shared` stays free of `chrome.*` and DOM globals.
- `packages/mcp-server` must never write non-MCP output to stdout; logs go to stderr.
- `AIPAGEGO_WS_PORT` remains supported as a fixed-port override.

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `packages/mcp-server/src/identity.ts` | Read/create `~/.aipagego/identity.json`; per-process `sessionId`/`label`/`pid` |
| `packages/mcp-server/src/pair-page.ts` | The `/pair` HTML and its postMessage payload |
| `packages/mcp-server/src/ensure-hub.ts` | Lazy hub creation, port preference, one-shot page opening |
| `packages/shared/src/pairing/types.ts` | `PairPayload`, `TrustRecord`, `PoolEntryState` — shared by server and extension |
| `packages/shared/src/pairing/reconnect.ts` | Pure backoff + dormancy state machine |
| `packages/shared/src/pairing/tab-view.ts` | Pure per-connection tab view derivation |
| `packages/extension/src/background/coordinator-pool.ts` | N `CoordinatorClient` instances, add/remove/dormant |
| `packages/extension/src/background/pairing-host.ts` | Trust store, pairing decisions, overlay dispatch |
| `packages/extension/src/background/tab-ownership.ts` | `tabId → owner` map and change notification |
| `packages/extension/src/content/pairing-relay.ts` | Relays the page's postMessage to the worker; hosts the approval overlay |

**Modified**

| Path | Change |
|---|---|
| `packages/mcp-server/src/index.ts:9-21` | Stop binding at startup; wire `ensureHub` |
| `packages/mcp-server/src/loopback-ws-hub.ts:52-63` | Explicit `http.createServer`, `EADDRINUSE` handling, graceful close |
| `packages/mcp-server/src/handlers.ts` | `ensureHub()` before anything needing a worker; no-worker error carries the pair URL |
| `packages/shared/src/protocol/messages.ts` | `SESSION_OPENED` (S→C), `TABS_UPDATE` (C→S), `TabInfo` gains `mine`/`busy`/`busy_label` |
| `packages/coordinator/src/types.ts:59` | `TabInfo` fields |
| `packages/coordinator/src/coordinator.ts` | Emit `SESSION_OPENED` on `openSession` |
| `packages/extension/src/background/coordinator-client.ts:184-249` | Backoff/dormancy; honour close code 4000; alarm stops overriding backoff |
| `packages/extension/src/background/index.ts:119-175` | `startCoordinatorClient` → pool |
| `packages/extension/src/background/tab-watcher.ts` | Fire `TABS_UPDATE` on tab change |
| `packages/extension/src/content/index.ts` | Register the pairing relay |
| `packages/extension/src/sidepanel/pages/coordinator-settings-page.tsx` | Two lists: connected sessions, trusted installs |
| `packages/extension/src/manifest.ts` | Content script entry for `pairing-relay.ts` |

---

## Phase 1 — Pure logic in shared

### Task 1: Reconnect backoff and dormancy state machine

**Files:**
- Create: `packages/shared/src/pairing/types.ts`
- Create: `packages/shared/src/pairing/reconnect.ts`
- Create: `packages/shared/src/pairing/index.ts`
- Test: `packages/shared/tests/pairing/reconnect.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `nextReconnect(state: ReconnectState, outcome: "failure" | "success" | "graceful-close"): ReconnectState` where `ReconnectState = { failures: number; status: "active" | "dormant"; delayMs: number }`; `INITIAL_RECONNECT_STATE`; `DORMANCY_THRESHOLD = 10`; `wake(state): ReconnectState`. Delay is `min(1000 * 2 ** (failures - 1), 30_000)` — matching the existing `RECONNECT_BASE_MS`/`RECONNECT_MAX_MS`. A `graceful-close` outcome goes straight to `dormant` regardless of the failure count.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/tests/pairing/reconnect.test.ts
import { describe, expect, it } from "vitest";
import {
  DORMANCY_THRESHOLD, INITIAL_RECONNECT_STATE, nextReconnect, wake
} from "../../src/pairing/reconnect";

const failN = (n: number) => {
  let s = INITIAL_RECONNECT_STATE;
  for (let i = 0; i < n; i++) s = nextReconnect(s, "failure");
  return s;
};

describe("nextReconnect", () => {
  it("backs off exponentially from one second", () => {
    expect(failN(1).delayMs).toBe(1000);
    expect(failN(2).delayMs).toBe(2000);
    expect(failN(3).delayMs).toBe(4000);
  });

  it("caps the delay at thirty seconds", () => {
    expect(failN(9).delayMs).toBe(30_000);
  });

  it("goes dormant at the threshold", () => {
    expect(failN(DORMANCY_THRESHOLD - 1).status).toBe("active");
    expect(failN(DORMANCY_THRESHOLD).status).toBe("dormant");
  });

  it("stays dormant on further failures without growing the delay", () => {
    const d = nextReconnect(failN(DORMANCY_THRESHOLD), "failure");
    expect(d.status).toBe("dormant");
    expect(d.delayMs).toBe(30_000);
  });

  it("success resets everything", () => {
    expect(nextReconnect(failN(5), "success")).toEqual(INITIAL_RECONNECT_STATE);
  });

  it("a graceful close goes dormant immediately", () => {
    const g = nextReconnect(INITIAL_RECONNECT_STATE, "graceful-close");
    expect(g.status).toBe("dormant");
    expect(g.failures).toBe(0);
  });

  it("wake reactivates a dormant entry", () => {
    expect(wake(failN(DORMANCY_THRESHOLD))).toEqual(INITIAL_RECONNECT_STATE);
  });

  it("wake is a no-op on an active entry", () => {
    const active = failN(2);
    expect(wake(active)).toEqual(INITIAL_RECONNECT_STATE);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** Run: `pnpm -F @aipagego/shared test -- pairing`. Expected: FAIL, module not found.
- [ ] **Step 3: Write `types.ts`**

```ts
/** Payload the /pair page posts to the extension. */
export type PairPayload = {
  v: 1;
  installId: string;
  secret: string;
  sessionId: string;
  label: string;   // the server's working directory
  pid: number;
  port: number;
};

/** What the extension persists once an install is approved. */
export type TrustRecord = { installId: string; secret: string; approvedAt: number };

export type ReconnectStatus = "active" | "dormant";
export type ReconnectState = { failures: number; status: ReconnectStatus; delayMs: number };
export type ReconnectOutcome = "failure" | "success" | "graceful-close";

/** WS close code the server sends when shutting down cleanly. */
export const GRACEFUL_CLOSE_CODE = 4000;
export const GRACEFUL_CLOSE_REASON = "server-shutting-down";
```

- [ ] **Step 4: Write `reconnect.ts`**

```ts
import type { ReconnectOutcome, ReconnectState } from "./types";

const BASE_MS = 1000;
const MAX_MS = 30_000;

export const DORMANCY_THRESHOLD = 10;

export const INITIAL_RECONNECT_STATE: ReconnectState = {
  failures: 0,
  status: "active",
  delayMs: 0
};

export function nextReconnect(state: ReconnectState, outcome: ReconnectOutcome): ReconnectState {
  if (outcome === "success") return INITIAL_RECONNECT_STATE;
  // A clean shutdown is not a failure to retry through — the peer is gone on
  // purpose, so there is nothing to back off from.
  if (outcome === "graceful-close") {
    return { failures: 0, status: "dormant", delayMs: 0 };
  }
  if (state.status === "dormant") return state;
  const failures = state.failures + 1;
  return {
    failures,
    status: failures >= DORMANCY_THRESHOLD ? "dormant" : "active",
    delayMs: Math.min(BASE_MS * 2 ** (failures - 1), MAX_MS)
  };
}

export function wake(_state: ReconnectState): ReconnectState {
  return INITIAL_RECONNECT_STATE;
}
```

- [ ] **Step 5: Write `index.ts`** — `export * from "./types"; export * from "./reconnect";`
- [ ] **Step 6: Add `"./pairing": "./src/pairing/index.ts"` to `packages/shared/package.json` exports.**
- [ ] **Step 7: Run the tests.** Run: `pnpm -F @aipagego/shared test -- pairing`. Expected: PASS, 8 tests.
- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/pairing packages/shared/tests/pairing packages/shared/package.json
git commit -m "feat(pairing): reconnect backoff and dormancy state machine"
```

### Task 2: Per-connection tab view

**Files:**
- Create: `packages/shared/src/pairing/tab-view.ts`
- Modify: `packages/shared/src/pairing/index.ts`
- Test: `packages/shared/tests/pairing/tab-view.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `deriveTabView(tabs, owners, forConnection)` where `tabs: Array<{tab_id: string; url: string; title?: string}>`, `owners: Record<string, { connectionId: string; label: string }>`, `forConnection: string`; returns `Array<{tab_id, url, title?, mine: boolean, busy: boolean, busy_label?: string}>`. `mine` is true when the viewer owns it; `busy` is true only when someone *else* does. A tab with no owner is neither.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/tests/pairing/tab-view.test.ts
import { describe, expect, it } from "vitest";
import { deriveTabView } from "../../src/pairing/tab-view";

const tabs = [
  { tab_id: "1", url: "https://a.test", title: "A" },
  { tab_id: "2", url: "https://b.test", title: "B" },
  { tab_id: "3", url: "https://c.test", title: "C" }
];
const owners = {
  "1": { connectionId: "conn-a", label: "~/code/caiji2" },
  "2": { connectionId: "conn-b", label: "~/code/wanxin" }
};

describe("deriveTabView", () => {
  it("marks the viewer's own tabs as mine, not busy", () => {
    const v = deriveTabView(tabs, owners, "conn-a");
    expect(v[0]).toMatchObject({ tab_id: "1", mine: true, busy: false });
    expect(v[0].busy_label).toBeUndefined();
  });

  it("marks tabs owned by others as busy and names the owner", () => {
    const v = deriveTabView(tabs, owners, "conn-a");
    expect(v[1]).toMatchObject({ tab_id: "2", mine: false, busy: true, busy_label: "~/code/wanxin" });
  });

  it("leaves unowned tabs free", () => {
    const v = deriveTabView(tabs, owners, "conn-a");
    expect(v[2]).toMatchObject({ tab_id: "3", mine: false, busy: false });
  });

  it("gives each connection its own view of the same state", () => {
    const a = deriveTabView(tabs, owners, "conn-a");
    const b = deriveTabView(tabs, owners, "conn-b");
    expect(a[0].busy).toBe(false);
    expect(b[0].busy).toBe(true);
  });

  it("preserves url and title", () => {
    expect(deriveTabView(tabs, {}, "conn-a")[0]).toMatchObject({
      url: "https://a.test",
      title: "A"
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement `tab-view.ts`**

```ts
export type TabBase = { tab_id: string; url: string; title?: string };
export type TabOwner = { connectionId: string; label: string };
export type TabView = TabBase & { mine: boolean; busy: boolean; busy_label?: string };

/**
 * Ownership is per-viewer: the same tab is "mine" to its owner and "busy" to
 * everyone else, so each connection gets its own derived list.
 */
export function deriveTabView(
  tabs: TabBase[],
  owners: Record<string, TabOwner>,
  forConnection: string
): TabView[] {
  return tabs.map((t) => {
    const owner = owners[t.tab_id];
    const mine = owner?.connectionId === forConnection;
    const busy = owner != null && !mine;
    return {
      ...t,
      mine,
      busy,
      ...(busy ? { busy_label: owner!.label } : {})
    };
  });
}
```

- [ ] **Step 4: Export from the barrel and run the tests.** Run: `pnpm -F @aipagego/shared test -- pairing`. Expected: PASS, 13 tests.
- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/pairing packages/shared/tests/pairing
git commit -m "feat(pairing): per-connection tab view derivation"
```

### Task 3: Protocol messages and TabInfo fields

**Files:**
- Modify: `packages/shared/src/protocol/messages.ts`
- Modify: `packages/coordinator/src/types.ts:59`
- Test: `packages/shared/tests/protocol/messages.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SessionOpenedSchema` (S→C) `{ type: "SESSION_OPENED", session_id, tab_id }`; `TabsUpdateSchema` (C→S) `{ type: "TABS_UPDATE", tabs: TabView[] }`; the existing HELLO `available_tabs` entries gain optional `mine`, `busy`, `busy_label`. Both new schemas join the existing `ClientMessage` / `ServerMessage` unions. `TabInfo` in the coordinator gains the same three optional fields.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/shared/tests/protocol/messages.test.ts
describe("Plan 33 — multi-session messages", () => {
  const env = { nonce: "n", ts: 1, protocol_version: 1 };

  it("accepts SESSION_OPENED", () => {
    const r = SessionOpenedSchema.safeParse({
      ...env, type: "SESSION_OPENED", session_id: "s1", tab_id: "42"
    });
    expect(r.success).toBe(true);
  });

  it("rejects SESSION_OPENED without a tab", () => {
    expect(
      SessionOpenedSchema.safeParse({ ...env, type: "SESSION_OPENED", session_id: "s1" }).success
    ).toBe(false);
  });

  it("accepts TABS_UPDATE with derived fields", () => {
    const r = TabsUpdateSchema.safeParse({
      ...env,
      type: "TABS_UPDATE",
      tabs: [{ tab_id: "1", url: "https://a.test", mine: true, busy: false }]
    });
    expect(r.success).toBe(true);
  });

  it("keeps the derived tab fields optional in HELLO", () => {
    const base = {
      ...env, type: "HELLO", worker_id: "w",
      fingerprint: { ext_hash: "x", os: "mac", chrome: "120" },
      capabilities: [], attended: true, saved_tools: [], labels: [],
      available_tabs: [{ tab_id: "1", url: "https://a.test" }]
    };
    expect(HelloSchema.safeParse(base).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** Run: `pnpm -F @aipagego/shared test -- messages`. Expected: FAIL, `SessionOpenedSchema` is not exported.
- [ ] **Step 3: Add the schemas**

```ts
const DerivedTabFields = {
  mine: z.boolean().optional(),
  busy: z.boolean().optional(),
  busy_label: z.string().optional()
};

export const SessionOpenedSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("SESSION_OPENED"),
  session_id: z.string(),
  tab_id: z.string()
});

export const TabsUpdateSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("TABS_UPDATE"),
  tabs: z.array(
    z.object({
      tab_id: z.string(),
      url: z.string(),
      title: z.string().optional(),
      ...DerivedTabFields
    })
  )
});
```

Spread `DerivedTabFields` into the existing `available_tabs` element schema in `HelloSchema`, add `TabsUpdateSchema` to the client-message union and `SessionOpenedSchema` to the server-message union, and add the matching three optional fields to `TabInfo` in `packages/coordinator/src/types.ts`.

- [ ] **Step 4: Run the tests.** Run: `pnpm -r test && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/shared packages/coordinator
git commit -m "feat(protocol): SESSION_OPENED, TABS_UPDATE and derived tab fields"
```

---

## Phase 2 — Server: identity, lazy binding, pairing page

### Task 4: Install identity

**Files:**
- Create: `packages/mcp-server/src/identity.ts`
- Test: `packages/mcp-server/tests/identity.test.ts`

**Interfaces:**
- Consumes: `PairPayload` from Task 1.
- Produces: `loadOrCreateIdentity(dir?: string): { installId: string; secret: string }` writing `<dir>/identity.json` (default `~/.aipagego`) with mode `0600` and the directory `0700`; `processInfo(): { sessionId: string; label: string; pid: number }` where `label` is `process.cwd()` with `$HOME` collapsed to `~`; `loadLastPort(dir?) / saveLastPort(port, dir?)` persisting to the same file under `lastPort`.

- [ ] **Step 1: Write the failing test** — cover: a fresh directory produces a file with mode 0600; a second call returns the identical `installId` and `secret`; a corrupt file is replaced rather than throwing; `label` collapses the home prefix to `~`; `sessionId` differs between calls; `saveLastPort` round-trips and leaves the identity untouched.

```ts
// packages/mcp-server/tests/identity.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadLastPort, loadOrCreateIdentity, processInfo, saveLastPort
} from "../src/identity";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "aipagego-id-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadOrCreateIdentity", () => {
  it("creates a 0600 file with an install id and secret", () => {
    const d = tmp();
    const id = loadOrCreateIdentity(d);
    expect(id.installId).toMatch(/^inst_/);
    expect(id.secret.length).toBeGreaterThanOrEqual(32);
    expect(statSync(join(d, "identity.json")).mode & 0o777).toBe(0o600);
  });

  it("is stable across calls", () => {
    const d = tmp();
    expect(loadOrCreateIdentity(d)).toEqual(loadOrCreateIdentity(d));
  });

  it("replaces a corrupt file instead of throwing", () => {
    const d = tmp();
    writeFileSync(join(d, "identity.json"), "{not json");
    expect(loadOrCreateIdentity(d).installId).toMatch(/^inst_/);
  });
});

describe("lastPort", () => {
  it("round-trips without disturbing the identity", () => {
    const d = tmp();
    const id = loadOrCreateIdentity(d);
    saveLastPort(51234, d);
    expect(loadLastPort(d)).toBe(51234);
    expect(loadOrCreateIdentity(d)).toEqual(id);
  });

  it("is undefined before anything is saved", () => {
    expect(loadLastPort(tmp())).toBeUndefined();
  });
});

describe("processInfo", () => {
  it("collapses the home prefix in the label", () => {
    const info = processInfo();
    expect(info.label.startsWith(process.env.HOME ?? " ")).toBe(false);
    expect(info.pid).toBe(process.pid);
  });

  it("gives each call a distinct session id", () => {
    expect(processInfo().sessionId).not.toBe(processInfo().sessionId);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** Run: `pnpm -F @attson/aipagego-mcp test -- identity`. Expected: FAIL.
- [ ] **Step 3: Implement `identity.ts`** using `node:crypto` `randomUUID`/`randomBytes(24).toString("base64url")`, `mkdirSync(dir, { recursive: true, mode: 0o700 })` and `writeFileSync(path, json, { mode: 0o600 })`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/identity.ts packages/mcp-server/tests/identity.test.ts
git commit -m "feat(mcp): install identity and last-port persistence"
```

### Task 5: Explicit HTTP server, pair page, graceful close

**Files:**
- Create: `packages/mcp-server/src/pair-page.ts`
- Modify: `packages/mcp-server/src/loopback-ws-hub.ts:52-63`
- Test: `packages/mcp-server/tests/pair-page.test.ts`
- Test: `packages/mcp-server/tests/loopback-ws-hub.test.ts` (extend)

**Interfaces:**
- Consumes: `PairPayload`, `GRACEFUL_CLOSE_CODE`, `GRACEFUL_CLOSE_REASON` from Task 1.
- Produces: `renderPairPage(payload: PairPayload): string`; `LoopbackWSHubOpts` gains `pairPayload?: () => PairPayload`; `LoopbackWSHub` gains `shutdown(): Promise<void>` which closes every socket with code 4000 before closing the server. The hub now builds its own `http.createServer()` and passes it to `WebSocketServer` as `server`, serving `GET /pair` from it. An `EADDRINUSE` on listen rejects `ready()` with an actionable message instead of crashing the process.

- [ ] **Step 1: Write the failing tests** — `renderPairPage` embeds the payload as JSON and posts it with `window.postMessage`, and HTML-escapes the label so a directory named `<script>` cannot inject; `GET /pair` returns 200 `text/html`; an unknown path returns 404; `shutdown()` closes clients with code 4000; a second hub on a taken explicit port rejects `ready()` with a message naming `AIPAGEGO_WS_PORT` rather than throwing unhandled.
- [ ] **Step 2: Run them to verify they fail.** Run: `pnpm -F @attson/aipagego-mcp test -- "pair-page|loopback"`. Expected: FAIL.
- [ ] **Step 3: Write `pair-page.ts`.** The page shows the label, pid and port, and posts the payload on load:

```ts
export function renderPairPage(payload: PairPayload): string {
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html><meta charset="utf-8"><title>AIPageGo 配对</title>
<body style="font:14px system-ui;padding:2rem;max-width:32rem;margin:auto">
<h1 style="font-size:1.1rem">AIPageGo 配对</h1>
<p id="s">正在联系扩展…</p>
<p style="color:#666">会话：${escapeHtml(payload.label)} · pid ${payload.pid} · 端口 ${payload.port}</p>
<p style="color:#666">没有反应？请确认已安装并启用 AIPageGo 扩展。</p>
<script>
const p = ${json};
window.postMessage({ source: "aipagego-pair", payload: p }, "*");
window.addEventListener("message", (e) => {
  if (e.data && e.data.source === "aipagego-pair-result") {
    document.getElementById("s").textContent =
      e.data.ok ? (e.data.trusted ? "已信任，连接中…" : "已连接") : "已拒绝";
    if (e.data.ok) setTimeout(() => window.close(), 1200);
  }
});
</script>`;
}
```

`escapeHtml` replaces `&<>"'`. The label is attacker-influenced only insofar as a user can name a directory, but escaping it costs one function and removes the question.

- [ ] **Step 4: Rework the hub constructor** to build `http.createServer((req,res) => …)`, mount `WebSocketServer({ server, path: "/worker", handleProtocols })`, and `server.on("error", …)` so `ready()` rejects with `port <n> already in use — another aipagego-mcp may be running; set AIPAGEGO_WS_PORT to choose another`.
- [ ] **Step 5: Implement `shutdown()`** iterating `wss.clients` with `socket.close(GRACEFUL_CLOSE_CODE, GRACEFUL_CLOSE_REASON)` before closing.
- [ ] **Step 6: Run the tests.** Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server
git commit -m "feat(mcp): explicit http server, pairing page and graceful close"
```

### Task 6: Lazy hub creation

**Files:**
- Create: `packages/mcp-server/src/ensure-hub.ts`
- Modify: `packages/mcp-server/src/index.ts:9-21`
- Modify: `packages/mcp-server/src/handlers.ts`
- Test: `packages/mcp-server/tests/ensure-hub.test.ts`

**Interfaces:**
- Consumes: `loadOrCreateIdentity`, `processInfo`, `loadLastPort`, `saveLastPort` (Task 4); `LoopbackWSHub`, `renderPairPage` (Task 5).
- Produces: `createHubEnsurer(deps)` returning `ensureHub(): Promise<{ hub; coordinator; port }>` — idempotent, binding on first call only. `deps` carries `openUrl(url: string): void` so tests can assert the page opens without spawning anything. `singleWorkerId` in `handlers.ts` throws an error containing the pair URL when no worker is connected, and every handler that needs a worker awaits `ensureHub()` first.

- [ ] **Step 1: Write the failing test**

```ts
// packages/mcp-server/tests/ensure-hub.test.ts
it("binds nothing until a browser-needing tool runs", async () => {
  const opened: string[] = [];
  const { ensureHub, bound } = makeEnsurer({ openUrl: (u) => opened.push(u) });
  expect(bound()).toBe(false);
  await ensureHub();
  expect(bound()).toBe(true);
});

it("is idempotent", async () => {
  const { ensureHub } = makeEnsurer({});
  const a = await ensureHub();
  const b = await ensureHub();
  expect(a.port).toBe(b.port);
});

it("opens the pairing page at most once", async () => {
  const opened: string[] = [];
  const { ensureHub } = makeEnsurer({ openUrl: (u) => opened.push(u) });
  await ensureHub();
  await ensureHub();
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pair$/);
});

it("prefers the remembered port and records the one it got", async () => { /* … */ });
```

- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implement `ensure-hub.ts`** — a module-level promise so concurrent calls share one bind.
- [ ] **Step 4: Rewire `index.ts`** so `main()` only builds the stdio server, and register a `process.on("SIGTERM")` / stdin-close handler that calls `hub.shutdown()` when a hub exists.
- [ ] **Step 5: Await `ensureHub()`** in `handleListTabs`, `handleOpenSession`, `handleBrowserTool`, and make the no-worker message carry the pair URL.
- [ ] **Step 6: Run the tests.** Run: `pnpm -F @attson/aipagego-mcp test`. Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server
git commit -m "feat(mcp): bind the ws port lazily, on first browser use"
```

---

## Phase 3 — Extension: relay, trust, pool

### Task 7: Pairing relay and approval overlay

**Files:**
- Create: `packages/extension/src/content/pairing-relay.ts`
- Modify: `packages/extension/src/manifest.ts`
- Modify: `packages/extension/src/content/index.ts`
- Test: `packages/extension/tests/content/pairing-relay.test.ts`

**Interfaces:**
- Consumes: `PairPayload` from Task 1.
- Produces: `installPairingRelay()` listening for `window.postMessage` with `source: "aipagego-pair"`, forwarding to the worker as `{ type: "pairing.request", payload }`, and posting back `{ source: "aipagego-pair-result", ok, trusted }`. When the worker answers `{ decision: "ask" }` the relay renders a shadow-DOM overlay with Allow and Deny and sends the outcome as `{ type: "pairing.decision", sessionId, approved }`.

- [ ] **Step 1: Write the failing test** — a `postMessage` from the page reaches `chrome.runtime.sendMessage` with the payload intact; a message from a different `source` is ignored; a payload failing shape validation is ignored; `decision: "trusted"` posts a result without rendering an overlay; `decision: "ask"` renders an overlay whose Allow button sends `approved: true`.
- [ ] **Step 2: Run it to verify it fails.** Run: `pnpm -F @aipagego/extension test -- pairing-relay`. Expected: FAIL.
- [ ] **Step 3: Implement the relay** — validate the payload shape defensively before forwarding, since any page can post anything.
- [ ] **Step 4: Implement the overlay** in a closed shadow root so page CSS cannot restyle it into something misleading.
- [ ] **Step 5: Register it** in `content/index.ts` and add the file to the existing content-script `js` array in the manifest.
- [ ] **Step 6: Run the tests.** Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/content packages/extension/src/manifest.ts packages/extension/tests/content/pairing-relay.test.ts
git commit -m "feat(pairing): content-script relay and extension-rendered approval overlay"
```

### Task 8: Trust store and pairing decisions

**Files:**
- Create: `packages/extension/src/background/pairing-host.ts`
- Test: `packages/extension/tests/background/pairing-host.test.ts`

**Interfaces:**
- Consumes: `PairPayload`, `TrustRecord` (Task 1).
- Produces: `decidePairing(payload): Promise<"trusted" | "ask">`; `approve(payload): Promise<void>` writing the `TrustRecord`; `listTrusted(): Promise<TrustRecord[]>`; `revokeTrust(installId): Promise<void>`. Storage key `aipagego.pairing.trusted` in `chrome.storage.local`.

- [ ] **Step 1: Write the failing test** — an unknown `installId` decides `ask`; after `approve` the same install decides `trusted`; a matching `installId` with the wrong `secret` decides `ask` and warns; `revokeTrust` returns the install to `ask`; `listTrusted` reports the approval timestamp.
- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implement `pairing-host.ts`.** Compare secrets with a constant-time comparison rather than `===`, since the value is a credential.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/background/pairing-host.ts packages/extension/tests/background/pairing-host.test.ts
git commit -m "feat(pairing): install trust store and pairing decisions"
```

### Task 9: Reconnection governance in CoordinatorClient

**Files:**
- Modify: `packages/extension/src/background/coordinator-client.ts:184-249`
- Test: `packages/extension/tests/background/coordinator-client.test.ts` (extend)

**Interfaces:**
- Consumes: `nextReconnect`, `wake`, `GRACEFUL_CLOSE_CODE` (Task 1).
- Produces: `CoordinatorClient` gains `readonly reconnectState: ReconnectState` and `wakeUp(): void`. `handleClose(event)` now reads the close code: code 4000 goes straight to dormant and schedules nothing. The heartbeat alarm skips reconnecting while dormant and while a backoff is still pending, instead of reconnecting any CLOSED socket.

- [ ] **Step 1: Write the failing test** — a close with code 4000 leaves the client dormant with no pending reconnect; ten ordinary failures reach dormant; the alarm does not reconnect a dormant client; the alarm still reconnects an active client whose backoff has elapsed; `wakeUp()` restores retrying; a successful connection resets the state.
- [ ] **Step 2: Run it to verify it fails.** Run: `pnpm -F @aipagego/extension test -- coordinator-client`. Expected: FAIL.
- [ ] **Step 3: Implement.** Track `nextAttemptAt` so the alarm can tell "waiting out a backoff" from "nobody is going to retry this".
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/background/coordinator-client.ts packages/extension/tests/background
git commit -m "fix(coordinator): give reconnection a terminating condition"
```

### Task 10: Connection pool

**Files:**
- Create: `packages/extension/src/background/coordinator-pool.ts`
- Modify: `packages/extension/src/background/index.ts:119-175`
- Test: `packages/extension/tests/background/coordinator-pool.test.ts`

**Interfaces:**
- Consumes: `CoordinatorClient` (Task 9), `decidePairing`/`approve` (Task 8).
- Produces: `CoordinatorPool` with `addFromPairing(payload): Promise<void>`, `remove(sessionId)`, `list(): PoolEntry[]`, `wake(sessionId)`, `disposeAll()`. `PoolEntry` is `{ endpoint, installId, sessionId, label, pid, status, failures }` plus the client. Re-pairing an existing `sessionId` is idempotent. The legacy single-URL config still produces one pool entry, so an existing manual setup keeps working.

- [ ] **Step 1: Write the failing test** — two pairings produce two entries with distinct endpoints; a repeat pairing for the same `sessionId` does not add a second; `remove` disconnects and drops the entry; `list` reflects each client's status; a legacy `CoordinatorConfig` with `ws_url` yields exactly one entry.
- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implement the pool.**
- [ ] **Step 4: Replace `startCoordinatorClient`/`stopCoordinatorClient`** with pool equivalents, keeping the `chrome.storage.onChanged` restart hook working against the pool.
- [ ] **Step 5: Wire `pairing.request` / `pairing.decision`** runtime messages to `decidePairing` and `pool.addFromPairing`.
- [ ] **Step 6: Run the full extension suite.** Run: `pnpm -F @aipagego/extension test`. Expected: PASS, no regressions.
- [ ] **Step 7: Commit**

```bash
git add packages/extension/src packages/extension/tests
git commit -m "feat(coordinator): hold N connections in a pool"
```

---

## Phase 4 — Ownership, freshness, settings

### Task 11: Tab ownership and TABS_UPDATE

**Files:**
- Create: `packages/extension/src/background/tab-ownership.ts`
- Modify: `packages/extension/src/background/tab-watcher.ts`
- Modify: `packages/extension/src/background/coordinator-client.ts`
- Modify: `packages/coordinator/src/coordinator.ts`
- Test: `packages/extension/tests/background/tab-ownership.test.ts`

**Interfaces:**
- Consumes: `deriveTabView` (Task 2), `SessionOpenedSchema`/`TabsUpdateSchema` (Task 3), `CoordinatorPool` (Task 10).
- Produces: `TabOwnership` with `claim(tabId, {connectionId, sessionId, label})`, `releaseBySession(sessionId)`, `releaseByConnection(connectionId)`, `releaseTab(tabId)`, `owners(): Record<string, TabOwner>`, and `onChange(fn)`. The coordinator emits `SESSION_OPENED` from `openSession`; the extension claims on receipt and releases on `CLOSE_SESSION`, connection loss, or `chrome.tabs.onRemoved`.

- [ ] **Step 1: Write the failing test** — claiming marks the owner; `releaseBySession` clears only that session's tabs; closing a connection releases all of its tabs; `onChange` fires on claim and release; a tab closing releases it.
- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implement `tab-ownership.ts`.**
- [ ] **Step 4: Emit `SESSION_OPENED`** from `Coordinator.openSession` and handle it in `coordinator-client.ts`.
- [ ] **Step 5: Push `TABS_UPDATE`** from `tab-watcher.ts` and on ownership change — one derived view per pool entry.
- [ ] **Step 6: Consume it server-side** by updating `worker.available_tabs` in `wire.ts`, so `handleListTabs` stays synchronous.
- [ ] **Step 7: Run the tests.** Run: `pnpm -r test`. Expected: PASS.
- [ ] **Step 8: Commit**

```bash
git add packages/extension packages/coordinator packages/mcp-server
git commit -m "feat(tabs): advisory ownership and live tab updates"
```

### Task 12: Settings page and documentation

**Files:**
- Modify: `packages/extension/src/sidepanel/pages/coordinator-settings-page.tsx`
- Modify: `README.md`, `packages/mcp-server/README.md`, `AGENTS.md`, `skill/SKILL.md`
- Test: `packages/extension/tests/sidepanel/coordinator-settings.test.tsx`

**Interfaces:**
- Consumes: `CoordinatorPool.list()` (Task 10), `listTrusted`/`revokeTrust` (Task 8).
- Produces: two sections — connected sessions (label, pid, port, status, disconnect/reconnect) and trusted installs (install id, approval date, revoke).

- [ ] **Step 1: Write the failing test** — the connected list renders one row per pool entry with its label and status; disconnect calls `pool.remove`; a dormant row offers reconnect and calls `pool.wake`; revoke calls `revokeTrust` and empties the trusted list.
- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implement the two sections**, keeping the existing manual `ws_url` field under an "advanced" disclosure so existing setups remain reachable.
- [ ] **Step 4: Update the docs** — `README.md` gets the pairing flow and the trust model; `packages/mcp-server/README.md` replaces the "fill in ws://127.0.0.1:8787/worker" instruction with the pairing flow and documents that `AIPAGEGO_WS_PORT` is now an override rather than the default path; `AGENTS.md` gains the pool and pairing modules; `skill/SKILL.md` explains `busy` in `list_tabs` and that an agent should open its own tab rather than contend.
- [ ] **Step 5: Run everything.** Run: `pnpm typecheck && pnpm test && pnpm build`. Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(settings): connected sessions and trusted installs; document pairing"
```

---

## Self-Review Notes

**Spec coverage.** Why-the-extension-is-the-client → context only, no task. Session lifecycle → Tasks 4-6. Pairing → Tasks 5, 7, 8. Trust model → Tasks 4, 8. Connection pool → Tasks 9, 10. Tab ownership → Tasks 3, 11. Tab freshness → Tasks 2, 3, 11. Settings → Task 12. Error handling → distributed: no-worker URL (Task 6), extension-absent copy (Task 5), secret mismatch (Task 8), idempotent re-pairing (Tasks 7, 10), `EADDRINUSE` message (Task 5). Testing → per task, with Task 12 running the full gate.

**Deliberate ordering.** Task 9 lands before Task 10 because a pool of clients that never stop retrying is worse than one — the governance has to exist before it is multiplied.

**Not covered, by decision.** Chrome tab groups (spec Non-Goals). The end-to-end two-connection test named in the spec's testing section is folded into Task 11 rather than given its own task, since it exercises exactly that task's deliverable.
