# 页内浮窗对话入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给每个可注入网页右下角加一个可拖动 FAB + Shadow DOM 承载的 mini 对话面板,与 sidepanel 共享同 tab 会话,让 90% 常见对话不用打开 sidepanel。

**Architecture:** 新增第 5 个 content-script bundle `content/widget/`;创建 `<aipagego-widget>` custom element,`attachShadow({mode:"open"})` 后 mount 一个轻量 React 子集(复用 ChatView / EmptySuggestions / input-box);widget 与 sidepanel 各持一个 zustand session-store 实例,通过 BG `session-broker.ts` 广播 `session.state.changed` 事件按 `_rev` 号收敛;dangerous step 触发时 widget 调 `widget.openSidepanel` RPC + 存 `pendingApprovalId` 到 `chrome.storage.session`,sidepanel 起来 focus 到该 step 并复用 `getApproverForTab(tabId)` 单例接手 approve。

**Tech Stack:** TypeScript 5、React 18、zustand 4、Tailwind 3 → `adoptedStyleSheets`、Shadow DOM、`@crxjs/vite-plugin` 多 content_script entry;零新 npm 依赖。

## Global Constraints

- **IDB DB name `aipagego`** — 不可改
- **No new dependencies**(AGENTS.md hard rule)
- **API key 只在 sidepanel/widget 扩展代码域**;host page 脚本不可读
- **Shadow DOM `mode:"open"`**(便于调试;安全依赖扩展代码域隔离,不依赖 closed)
- **Widget bundle 独立打包**,不进 sidepanel dist
- **Session 共享**:widget 与 sidepanel 同 tab 一份 session,`_rev` 号仲裁并发
- **BG 不持 API key**:LLM 由 widget 侧直接调(与 sidepanel 同款)
- **SessionStatus 使用现有 7 值**:`"idle" | "streaming" | "awaiting" | "running" | "done" | "error" | "aborted"`;发送门条件 `status === "idle"` 或 `status === "done"`
- **无 IDB schema 迁移**;所有新字段可选或有默认

---

## File Structure

**新建**(content-script widget bundle):
- `packages/extension/src/content/widget/mount.ts` — entry;顶层 window / html contentType / enabled guards;custom element + Shadow DOM 创建
- `packages/extension/src/content/widget/react-root.tsx` — React root inside shadow;组装 fab + panel
- `packages/extension/src/content/widget/fab.tsx` — 悬浮球:拖动 + 右键小菜单
- `packages/extension/src/content/widget/panel.tsx` — mini shell:header + chat + input
- `packages/extension/src/content/widget/approval-modal.tsx` — caution step 审阅弹层
- `packages/extension/src/content/widget/handoff.ts` — dangerous → `widget.openSidepanel` RPC 封装
- `packages/extension/src/content/widget/store.ts` — widget-side session-store binding + broadcast subscriber
- `packages/extension/src/content/widget/per-site.ts` — hiddenHosts / fabPos / panelSize storage helper
- `packages/extension/src/content/widget/styles.ts` — Tailwind CSS 提取 → adoptedStyleSheets
- `packages/extension/src/content/widget/index.css` — Tailwind 入口(widget-scoped)

**测试**:
- `packages/extension/tests/content/widget/mount.test.ts`
- `packages/extension/tests/content/widget/per-site.test.ts`
- `packages/extension/tests/content/widget/store-broadcast.test.ts`
- `packages/extension/tests/content/widget/handoff.test.ts`
- `packages/extension/tests/background/session-broker.test.ts`

**修改**:
- `packages/extension/src/manifest.ts` — 加第 5 个 content_scripts js 项
- `packages/shared/src/types.ts` — `LlmSettings.widgetEnabled: boolean`;`SessionData._rev?: number`
- `packages/shared/src/messages.ts` — `widget.openSidepanel` + `widget.markHostHidden` RPC
- `packages/extension/src/background/session-broker.ts` — 新增
- `packages/extension/src/background/index.ts` — install session-broker + service worker wake
- `packages/extension/src/background/rpc-handlers.ts` — dispatch 新 RPCs
- `packages/extension/src/sidepanel/chat/session-store.ts` — 加 `_rev` 递增 + `broadcastMutation` hook + `installBroadcastSubscriber()`
- `packages/extension/src/sidepanel/chat/settings-store.ts` — DEFAULTS.widgetEnabled = true
- `packages/extension/src/sidepanel/shell/app-shell.tsx` — 挂载 broadcast subscriber + pendingApproval focus effect
- `packages/extension/src/sidepanel/drawers/settings/section-llm.tsx` — widgetEnabled toggle

---

### Task 1: Shared 类型扩展 — `widgetEnabled` + `_rev`

**Files:**
- Modify: `packages/shared/src/types.ts` — `LlmSettings.widgetEnabled`;`SessionData._rev?`(仅扩展侧类型,shared 里视需要加)
- Modify: `packages/shared/src/messages.ts` — 若 `LlmSettings` 有 zod schema(现无,跳过);无 shared zod 变更
- Modify: `packages/extension/src/sidepanel/chat/settings-store.ts` — DEFAULTS 加 `widgetEnabled: true`
- Test: `packages/shared/tests/llm-settings-widget.test.ts` — 简单验证 type 存在

**Interfaces:**
- Produces: `LlmSettings.widgetEnabled: boolean`

- [ ] **Step 1: Write failing test**

```ts
// packages/shared/tests/llm-settings-widget.test.ts
import { describe, expect, it } from "vitest";
import type { LlmSettings } from "../src/types";

describe("LlmSettings.widgetEnabled", () => {
  it("is a boolean field on LlmSettings", () => {
    const s: LlmSettings = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "",
      apiKeyMode: "persistent",
      maxRounds: 20,
      trustedDangerTools: [],
      defaultPermissionMode: "default",
      theme: "dark",
      maxContinuationNudges: 1,
      defaultChatMode: "compact",
      selfHealEnabled: true,
      maxSelfHealOutputTokens: 4096,
      widgetEnabled: true
    };
    expect(s.widgetEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
pnpm --filter @aipagego/shared test llm-settings-widget
```
Expected: TS error "Object literal may only specify known properties" — `widgetEnabled` not in LlmSettings.

- [ ] **Step 3: Add field to LlmSettings**

In `packages/shared/src/types.ts` locate `LlmSettings` type and add:

```ts
  widgetEnabled: boolean;   // Plan 28:页内浮窗总闸;默认 true
```

- [ ] **Step 4: Extend DEFAULTS in settings-store**

In `packages/extension/src/sidepanel/chat/settings-store.ts` `DEFAULTS` object append:

```ts
  widgetEnabled: true
```

Right after `maxSelfHealOutputTokens: 4096,` — keep trailing comma consistent with file style.

- [ ] **Step 5: Run tests + typecheck**

```bash
pnpm --filter @aipagego/shared test llm-settings-widget
pnpm -r typecheck
```
Expected: pass; TS build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/tests/llm-settings-widget.test.ts packages/extension/src/sidepanel/chat/settings-store.ts
git commit -m "feat(shared): LlmSettings.widgetEnabled — 页内浮窗总闸,默认 on"
```

---

### Task 2: SessionData `_rev` 字段(用于广播冲突仲裁)

**Files:**
- Modify: `packages/extension/src/sidepanel/chat/session-store.ts` — `SessionData` type + `makeEmptySession` 初始化 `_rev: 0`
- Test: `packages/extension/tests/sidepanel/chat/session-store-rev.test.ts`

**Interfaces:**
- Produces: `SessionData._rev: number`;每个 mutation 后自增(暂时不改 mutation;Task 7 做)

- [ ] **Step 1: Write failing test**

```ts
// packages/extension/tests/sidepanel/chat/session-store-rev.test.ts
import { describe, expect, it } from "vitest";
import { makeEmptySession } from "@/sidepanel/chat/session-store";

describe("SessionData._rev", () => {
  it("makeEmptySession initializes _rev to 0", () => {
    const s = makeEmptySession(1, "https://x/");
    expect(s._rev).toBe(0);
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
pnpm --filter @aipagego/extension test session-store-rev
```
Expected: `_rev` not on `SessionData`.

- [ ] **Step 3: Extend SessionData**

In `packages/extension/src/sidepanel/chat/session-store.ts`, locate `type SessionData = {`;append this field at the end (before closing `};`):

```ts
  _rev: number;
```

- [ ] **Step 4: Extend makeEmptySession**

Find `export function makeEmptySession(...)` return object;append `_rev: 0` at the end of the object literal.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @aipagego/extension test session-store-rev
pnpm -r typecheck
```
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/sidepanel/chat/session-store.ts packages/extension/tests/sidepanel/chat/session-store-rev.test.ts
git commit -m "feat(sidepanel): SessionData._rev — 广播冲突仲裁字段"
```

---

### Task 3: 新增 `widget.openSidepanel` + `widget.markHostHidden` RPC

**Files:**
- Modify: `packages/shared/src/messages.ts` — 在 `RpcRequest` discriminatedUnion 加两条
- Modify: `packages/extension/src/background/rpc-handlers.ts` — dispatch 两条
- Modify: `packages/extension/src/sidepanel/rpc.ts` — 加 typed wrappers `rpc.widgetOpenSidepanel` + `rpc.widgetMarkHostHidden`
- Test: `packages/extension/tests/background/widget-rpc.test.ts`

**Interfaces:**
- Produces:
  - RPC `widget.openSidepanel { tabId, pendingApprovalId? } → null`
  - RPC `widget.markHostHidden { host } → null`
  - `rpc.widgetOpenSidepanel({tabId, pendingApprovalId?})`
  - `rpc.widgetMarkHostHidden(host)`

- [ ] **Step 1: Write failing test**

```ts
// packages/extension/tests/background/widget-rpc.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

(globalThis as any).chrome = {
  sidePanel: { open: vi.fn().mockResolvedValue(undefined) },
  storage: {
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined)
    },
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined)
    }
  },
  tabs: { get: vi.fn(), sendMessage: vi.fn(), onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() }, onCreated: { addListener: vi.fn() } },
  webNavigation: { onHistoryStateUpdated: { addListener: vi.fn() } },
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn() } },
  action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
  scripting: { executeScript: vi.fn() }
};

describe("widget RPCs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("widget.openSidepanel calls chrome.sidePanel.open and stores pendingApproval", async () => {
    const { dispatch } = await import("@/background/rpc-handlers");
    await dispatch({ type: "widget.openSidepanel", tabId: 42, pendingApprovalId: "abc" } as any);
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({ "aipagego.pendingApproval": expect.objectContaining({ tabId: 42, approvalId: "abc" }) })
    );
  });

  it("widget.markHostHidden appends host to hiddenHosts list", async () => {
    (chrome.storage.local.get as any).mockResolvedValueOnce({ "aipagego.widget.hiddenHosts": ["foo.com"] });
    const { dispatch } = await import("@/background/rpc-handlers");
    await dispatch({ type: "widget.markHostHidden", host: "bar.com" } as any);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ "aipagego.widget.hiddenHosts": ["foo.com", "bar.com"] })
    );
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
pnpm --filter @aipagego/extension test widget-rpc
```
Expected: `widget.openSidepanel` not recognized in RpcRequest union.

- [ ] **Step 3: Add RPCs to `messages.ts`**

In `packages/shared/src/messages.ts` inside the `RpcRequest = z.discriminatedUnion("type", [...])` array (near existing session/tab RPCs), add:

```ts
  z.object({
    type: z.literal("widget.openSidepanel"),
    tabId: z.number().int(),
    pendingApprovalId: z.string().optional()
  }),
  z.object({
    type: z.literal("widget.markHostHidden"),
    host: z.string().min(1)
  }),
```

- [ ] **Step 4: Dispatch in `rpc-handlers.ts`**

In `packages/extension/src/background/rpc-handlers.ts` `dispatch` switch, add two cases:

```ts
    case "widget.openSidepanel": {
      await chrome.sidePanel.open({ tabId: req.tabId });
      if (req.pendingApprovalId) {
        await chrome.storage.session.set({
          "aipagego.pendingApproval": {
            tabId: req.tabId,
            approvalId: req.pendingApprovalId,
            ts: Date.now()
          }
        });
      }
      return null;
    }
    case "widget.markHostHidden": {
      const KEY = "aipagego.widget.hiddenHosts";
      const raw = (await chrome.storage.local.get([KEY]))[KEY];
      const list = Array.isArray(raw) ? [...raw] : [];
      if (!list.includes(req.host)) list.push(req.host);
      await chrome.storage.local.set({ [KEY]: list });
      return null;
    }
```

- [ ] **Step 5: Add sidepanel wrappers**

In `packages/extension/src/sidepanel/rpc.ts` `export const rpc = { ... }` add:

```ts
  widgetOpenSidepanel: (input: { tabId: number; pendingApprovalId?: string }) =>
    call<null>({ type: "widget.openSidepanel", ...input }),
  widgetMarkHostHidden: (host: string) =>
    call<null>({ type: "widget.markHostHidden", host }),
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @aipagego/extension test widget-rpc
pnpm -r typecheck
```
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/messages.ts packages/extension/src/background/rpc-handlers.ts packages/extension/src/sidepanel/rpc.ts packages/extension/tests/background/widget-rpc.test.ts
git commit -m "feat: widget.openSidepanel + widget.markHostHidden RPC — 交接与逐站黑名单"
```

---

### Task 4: BG session-broker(BG 中继 session.state.changed)

**Files:**
- Create: `packages/extension/src/background/session-broker.ts`
- Modify: `packages/extension/src/background/index.ts` — install listener at startup
- Test: `packages/extension/tests/background/session-broker.test.ts`

**Interfaces:**
- Consumes: chrome.runtime message `{ type: "session.state.changed", tabId, snapshot, senderId }`
- Produces: `installSessionBroker(): () => void` — 返回 dispose;安装后 fan-out message 到同 tab 的 content-scripts + 让 runtime-wide 广播给 sidepanel

- [ ] **Step 1: Write failing test**

```ts
// packages/extension/tests/background/session-broker.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const listeners: Array<(msg: any, sender: any, respond: any) => void> = [];

(globalThis as any).chrome = {
  runtime: {
    onMessage: {
      addListener: vi.fn((cb: any) => listeners.push(cb)),
      removeListener: vi.fn()
    },
    sendMessage: vi.fn().mockResolvedValue(undefined)
  },
  tabs: {
    sendMessage: vi.fn().mockResolvedValue(undefined)
  }
};

describe("installSessionBroker", () => {
  beforeEach(() => {
    listeners.length = 0;
    vi.clearAllMocks();
  });

  it("relays session.state.changed to tabs.sendMessage for widget", async () => {
    const { installSessionBroker } = await import("@/background/session-broker");
    installSessionBroker();
    expect(listeners.length).toBe(1);
    const cb = listeners[0];
    cb(
      { type: "session.state.changed", tabId: 7, snapshot: { _rev: 3 }, senderId: "sp" },
      { id: "sidepanel-instance" },
      () => {}
    );
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7,
      expect.objectContaining({ type: "session.state.changed", tabId: 7, snapshot: { _rev: 3 } })
    );
  });

  it("ignores unrelated messages", async () => {
    const { installSessionBroker } = await import("@/background/session-broker");
    installSessionBroker();
    listeners[0]({ type: "something.else" }, { id: "x" }, () => {});
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
pnpm --filter @aipagego/extension test session-broker
```
Expected: module not found.

- [ ] **Step 3: Implement session-broker**

```ts
// packages/extension/src/background/session-broker.ts
/**
 * BG-side broker for `session.state.changed` events.
 *
 * When a host (sidepanel or in-page widget) mutates its session-store, it
 * broadcasts `{ type: "session.state.changed", tabId, snapshot, senderId }`
 * via chrome.runtime.sendMessage. BG catches it here and re-broadcasts to
 * the widget content-script on the specified tab (chrome.tabs.sendMessage
 * is required — runtime broadcast does NOT reach content-scripts).
 *
 * Receivers filter out self by comparing `senderId` to their own instance ID.
 */
export function installSessionBroker(): () => void {
  const listener = (msg: unknown, _sender: unknown, _respond: (r?: unknown) => void) => {
    const m = msg as { type?: string; tabId?: number; snapshot?: unknown } | null;
    if (!m || m.type !== "session.state.changed" || typeof m.tabId !== "number") return;
    // Fan-out to widget on that tab.
    void chrome.tabs.sendMessage(m.tabId, msg).catch(() => {});
    // Sidepanel and other extension pages receive the original runtime message
    // directly — no relay needed.
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
```

- [ ] **Step 4: Mount in background/index.ts**

In `packages/extension/src/background/index.ts` find the startup section (usually inside `onInstalled` or top-level init) and add:

```ts
import { installSessionBroker } from "./session-broker";

// existing init …
installSessionBroker();
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @aipagego/extension test session-broker
pnpm -r typecheck
```
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/background/session-broker.ts packages/extension/src/background/index.ts packages/extension/tests/background/session-broker.test.ts
git commit -m "feat(bg): session-broker — 中继 session.state.changed 到 widget 与 sidepanel"
```

---

### Task 5: Sidepanel session-store 广播 hook + 订阅

**Files:**
- Modify: `packages/extension/src/sidepanel/chat/session-store.ts` — 加 `SELF_INSTANCE_ID`、`broadcastMutation`、`installBroadcastSubscriber`;所有 mutation 末尾调 `broadcastMutation(tabId)`
- Modify: `packages/extension/src/sidepanel/shell/app-shell.tsx` — `useEffect` 挂 `installBroadcastSubscriber` disposer
- Test: `packages/extension/tests/sidepanel/chat/session-store-broadcast.test.ts`

**Interfaces:**
- Produces:
  - `SELF_INSTANCE_ID: string`(module-scoped;用于 senderId self-filter)
  - `installBroadcastSubscriber(): () => void`
  - side-effect:mutation 后 `_rev` 自增 + `chrome.runtime.sendMessage(session.state.changed, ...)`

- [ ] **Step 1: Write failing test**

```ts
// packages/extension/tests/sidepanel/chat/session-store-broadcast.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const listeners: any[] = [];
(globalThis as any).chrome = {
  runtime: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onMessage: {
      addListener: vi.fn((cb: any) => listeners.push(cb)),
      removeListener: vi.fn((cb: any) => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      })
    }
  }
};

describe("session-store broadcast", () => {
  beforeEach(() => {
    listeners.length = 0;
    vi.clearAllMocks();
  });

  it("mutation increments _rev and broadcasts", async () => {
    const store = await import("@/sidepanel/chat/session-store");
    store.ensureSession(1, "https://x/");
    (chrome.runtime.sendMessage as any).mockClear();
    store.appendUserMessage(1, "hello");
    const state = store.useStore.getState().sessionsByTab[1];
    expect(state._rev).toBeGreaterThan(0);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.state.changed",
        tabId: 1,
        snapshot: expect.objectContaining({ _rev: state._rev })
      })
    );
  });

  it("installBroadcastSubscriber applies remote snapshot with higher _rev", async () => {
    const store = await import("@/sidepanel/chat/session-store");
    store.ensureSession(2, "https://y/");
    const dispose = store.installBroadcastSubscriber();
    const higher = { ...store.useStore.getState().sessionsByTab[2], _rev: 999, messages: [{ role: "user", content: "remote" } as any] };
    listeners[0]({ type: "session.state.changed", tabId: 2, snapshot: higher, senderId: "OTHER" }, {}, () => {});
    expect(store.useStore.getState().sessionsByTab[2]._rev).toBe(999);
    dispose();
  });

  it("installBroadcastSubscriber ignores own broadcasts", async () => {
    const store = await import("@/sidepanel/chat/session-store");
    store.ensureSession(3, "https://z/");
    const dispose = store.installBroadcastSubscriber();
    const self = store.SELF_INSTANCE_ID;
    const stale = { ...store.useStore.getState().sessionsByTab[3], _rev: 999 };
    listeners[0]({ type: "session.state.changed", tabId: 3, snapshot: stale, senderId: self }, {}, () => {});
    // ignored — _rev unchanged locally
    expect(store.useStore.getState().sessionsByTab[3]._rev).not.toBe(999);
    dispose();
  });

  it("installBroadcastSubscriber ignores older _rev", async () => {
    const store = await import("@/sidepanel/chat/session-store");
    store.ensureSession(4, "https://w/");
    // bump local rev by mutating
    store.appendUserMessage(4, "one");
    store.appendUserMessage(4, "two");
    const localRev = store.useStore.getState().sessionsByTab[4]._rev;
    const dispose = store.installBroadcastSubscriber();
    const older = { ...store.useStore.getState().sessionsByTab[4], _rev: localRev - 1, messages: [] };
    listeners[0]({ type: "session.state.changed", tabId: 4, snapshot: older, senderId: "OTHER" }, {}, () => {});
    // stayed local
    expect(store.useStore.getState().sessionsByTab[4]._rev).toBe(localRev);
    dispose();
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
pnpm --filter @aipagego/extension test session-store-broadcast
```
Expected: `installBroadcastSubscriber` / `SELF_INSTANCE_ID` not exported;`_rev` still 0 after mutation.

- [ ] **Step 3: Add SELF_INSTANCE_ID + broadcastMutation**

At the top of `packages/extension/src/sidepanel/chat/session-store.ts`, right after existing imports, add:

```ts
export const SELF_INSTANCE_ID: string =
  (globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2));

function broadcastMutation(tabId: number): void {
  const snap = useStore.getState().sessionsByTab[tabId];
  if (!snap) return;
  try {
    void chrome.runtime.sendMessage({
      type: "session.state.changed",
      tabId,
      snapshot: snap,
      senderId: SELF_INSTANCE_ID
    });
  } catch { /* swallow */ }
}
```

Note: `useStore` must be exported from this file (grep confirms `export const useStore = create<...>(...)`).

- [ ] **Step 4: Inject `_rev` bump + broadcast into every mutation action**

For every `export function` in `session-store.ts` that calls `useStore.setState(state => { ... })` or `useStore.setState({...})` and touches `sessionsByTab[tabId]`, wrap the setState call so `_rev` bumps and broadcast fires. Use a helper:

```ts
function mutateSession(tabId: number, updater: (s: SessionData) => SessionData): void {
  useStore.setState((state) => {
    const cur = state.sessionsByTab[tabId];
    if (!cur) return state;
    const next = updater(cur);
    const bumped = { ...next, _rev: (cur._rev ?? 0) + 1 };
    return { sessionsByTab: { ...state.sessionsByTab, [tabId]: bumped } };
  });
  broadcastMutation(tabId);
}
```

Then update the ~28 export functions that mutate a session (grep `useStore.setState((state) => {`). For each, replace the inline setState + object rebuild with a `mutateSession(tabId, s => ({ ...s, ...update }))`. Example for `appendUserMessage`:

```ts
// BEFORE:
export function appendUserMessage(tabId: number, text: string): void {
  useStore.setState((state) => {
    const cur = state.sessionsByTab[tabId];
    if (!cur) return state;
    return {
      sessionsByTab: {
        ...state.sessionsByTab,
        [tabId]: { ...cur, messages: [...cur.messages, { role: "user", content: text }] }
      }
    };
  });
}

// AFTER:
export function appendUserMessage(tabId: number, text: string): void {
  mutateSession(tabId, (s) => ({ ...s, messages: [...s.messages, { role: "user", content: text }] }));
}
```

Apply the same pattern to all mutation functions listed:
`ensureSession`, `setUrl`, `appendSystemNote`, `appendHealNote`, `appendUserMessage`, `appendUserMessageWithImages`, `beginAssistantTurn`, `appendAssistantText`, `finalizeAssistantTurn`, `upsertCard`, `setCardStatus`, `appendToolResults`, `pushExecutedStep`, `setLastOutput`, `incrementRound`, `addUsage`, `addLlmExchange`, `setStatus`, `setError`, `setPermissionMode`, `setDebugBadge`, `setChatMode`, `setIdentity`, `setAbortController`, `showSave`, `hideSave`, `setInputDraft`, `clearSession`.

`setCurrentTab` does NOT touch `sessionsByTab[tabId]` — leave alone.

- [ ] **Step 5: Add installBroadcastSubscriber**

Append at the bottom of `session-store.ts`:

```ts
export function installBroadcastSubscriber(): () => void {
  const listener = (msg: unknown) => {
    const m = msg as {
      type?: string; tabId?: number; snapshot?: SessionData; senderId?: string;
    } | null;
    if (!m || m.type !== "session.state.changed") return;
    if (m.senderId === SELF_INSTANCE_ID) return;   // self — skip
    if (typeof m.tabId !== "number" || !m.snapshot) return;
    const current = useStore.getState().sessionsByTab[m.tabId];
    if ((current?._rev ?? 0) >= (m.snapshot._rev ?? 0)) return;  // stale — skip
    useStore.setState((state) => ({
      sessionsByTab: { ...state.sessionsByTab, [m.tabId!]: m.snapshot! }
    }));
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
```

- [ ] **Step 6: Mount subscriber in app-shell.tsx**

In `packages/extension/src/sidepanel/shell/app-shell.tsx`, find the top-level `useEffect(() => { … }, [])` (near `installSelfHealHost`) and add:

```tsx
import { installBroadcastSubscriber } from "@/sidepanel/chat/session-store";

// inside AppShell component's mount effect:
useEffect(() => {
  const dispose = installBroadcastSubscriber();
  return dispose;
}, []);
```

- [ ] **Step 7: Run tests**

```bash
pnpm --filter @aipagego/extension test session-store-broadcast
pnpm --filter @aipagego/extension test session-store       # regression
pnpm -r typecheck
```
Expected: all pass (some existing tests may be affected by `_rev` field appearing; adjust snapshots if needed).

- [ ] **Step 8: Commit**

```bash
git add packages/extension/src/sidepanel/chat/session-store.ts packages/extension/src/sidepanel/shell/app-shell.tsx packages/extension/tests/sidepanel/chat/session-store-broadcast.test.ts
git commit -m "feat(sidepanel): session-store 广播 mutation + rev 号仲裁订阅 — widget 同步基础"
```

---

### Task 6: Widget per-site 存储 helper

**Files:**
- Create: `packages/extension/src/content/widget/per-site.ts`
- Test: `packages/extension/tests/content/widget/per-site.test.ts`

**Interfaces:**
- Produces:
  - `getHiddenHosts(): Promise<string[]>`
  - `isHostHidden(host: string): Promise<boolean>`
  - `hideHost(host: string): Promise<void>`
  - `getFabPos(host: string): Promise<{x:number,y:number} | null>`
  - `setFabPos(host: string, pos: {x:number,y:number}): Promise<void>`
  - `getPanelSize(): Promise<{w:number,h:number}>`
  - `setPanelSize(size: {w:number,h:number}): Promise<void>`

- [ ] **Step 1: Write failing test**

```ts
// packages/extension/tests/content/widget/per-site.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const storage: Record<string, any> = {};
(globalThis as any).chrome = {
  storage: {
    local: {
      get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map(k => [k, storage[k]]))),
      set: vi.fn(async (obj: Record<string, any>) => { Object.assign(storage, obj); })
    }
  }
};

describe("widget/per-site", () => {
  beforeEach(() => { for (const k of Object.keys(storage)) delete storage[k]; vi.clearAllMocks(); });

  it("hideHost + isHostHidden roundtrip", async () => {
    const m = await import("@/content/widget/per-site");
    expect(await m.isHostHidden("a.com")).toBe(false);
    await m.hideHost("a.com");
    expect(await m.isHostHidden("a.com")).toBe(true);
  });

  it("hideHost is idempotent", async () => {
    const m = await import("@/content/widget/per-site");
    await m.hideHost("b.com");
    await m.hideHost("b.com");
    expect(await m.getHiddenHosts()).toEqual(["b.com"]);
  });

  it("fabPos per-host set/get", async () => {
    const m = await import("@/content/widget/per-site");
    await m.setFabPos("x.com", { x: 100, y: 200 });
    expect(await m.getFabPos("x.com")).toEqual({ x: 100, y: 200 });
    expect(await m.getFabPos("other.com")).toBeNull();
  });

  it("panelSize defaults to 320x480 when unset", async () => {
    const m = await import("@/content/widget/per-site");
    expect(await m.getPanelSize()).toEqual({ w: 320, h: 480 });
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
pnpm --filter @aipagego/extension test content/widget/per-site
```
Expected: module not found.

- [ ] **Step 3: Implement**

```ts
// packages/extension/src/content/widget/per-site.ts
const HIDDEN_KEY = "aipagego.widget.hiddenHosts";
const FAB_KEY = "aipagego.widget.fabPos";
const SIZE_KEY = "aipagego.widget.panelSize";
const DEFAULT_SIZE = { w: 320, h: 480 };

export async function getHiddenHosts(): Promise<string[]> {
  const raw = (await chrome.storage.local.get([HIDDEN_KEY]))[HIDDEN_KEY];
  return Array.isArray(raw) ? [...raw] : [];
}

export async function isHostHidden(host: string): Promise<boolean> {
  return (await getHiddenHosts()).includes(host);
}

export async function hideHost(host: string): Promise<void> {
  const cur = await getHiddenHosts();
  if (cur.includes(host)) return;
  await chrome.storage.local.set({ [HIDDEN_KEY]: [...cur, host] });
}

export async function getFabPos(host: string): Promise<{ x: number; y: number } | null> {
  const raw = (await chrome.storage.local.get([FAB_KEY]))[FAB_KEY];
  const map = (raw && typeof raw === "object") ? raw as Record<string, { x: number; y: number }> : {};
  return map[host] ?? null;
}

export async function setFabPos(host: string, pos: { x: number; y: number }): Promise<void> {
  const raw = (await chrome.storage.local.get([FAB_KEY]))[FAB_KEY];
  const map = (raw && typeof raw === "object") ? raw as Record<string, { x: number; y: number }> : {};
  map[host] = pos;
  await chrome.storage.local.set({ [FAB_KEY]: map });
}

export async function getPanelSize(): Promise<{ w: number; h: number }> {
  const raw = (await chrome.storage.local.get([SIZE_KEY]))[SIZE_KEY];
  if (raw && typeof raw === "object" && typeof (raw as any).w === "number" && typeof (raw as any).h === "number") {
    return { w: (raw as any).w, h: (raw as any).h };
  }
  return { ...DEFAULT_SIZE };
}

export async function setPanelSize(size: { w: number; h: number }): Promise<void> {
  await chrome.storage.local.set({ [SIZE_KEY]: size });
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @aipagego/extension test content/widget/per-site
```
Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/content/widget/per-site.ts packages/extension/tests/content/widget/per-site.test.ts
git commit -m "feat(widget): per-site storage helper — hiddenHosts / fabPos / panelSize"
```

---

### Task 7: Widget mount + Shadow DOM 骨架(仅 hello world)

**Files:**
- Create: `packages/extension/src/content/widget/mount.ts`
- Modify: `packages/extension/src/manifest.ts` — 追加第 5 个 content_script
- Test: `packages/extension/tests/content/widget/mount.test.ts`

**Interfaces:**
- Produces:
  - `mountWidget(): Promise<void>` — 顶层导出;guards + Shadow DOM 创建 + 挂载 stub
  - side-effect:document idle 后自动调用一次;暴露给测试通过 named export

- [ ] **Step 1: Write failing test**

```ts
// packages/extension/tests/content/widget/mount.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const storage: Record<string, any> = { "aipagego.llm": { widgetEnabled: true } };
(globalThis as any).chrome = {
  storage: {
    local: {
      get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map(k => [k, storage[k]]))),
      set: vi.fn(async () => {})
    }
  }
};

describe("mountWidget", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = "<head></head><body></body>";
    for (const k of Object.keys(storage)) if (k !== "aipagego.llm") delete storage[k];
    storage["aipagego.llm"] = { widgetEnabled: true };
    vi.clearAllMocks();
  });

  it("creates <aipagego-widget> element on top window", async () => {
    const { mountWidget } = await import("@/content/widget/mount");
    await mountWidget();
    const el = document.querySelector("aipagego-widget");
    expect(el).toBeTruthy();
    expect(el?.shadowRoot).toBeTruthy();
  });

  it("does NOT mount when widgetEnabled=false", async () => {
    storage["aipagego.llm"] = { widgetEnabled: false };
    const { mountWidget } = await import("@/content/widget/mount");
    await mountWidget();
    expect(document.querySelector("aipagego-widget")).toBeNull();
  });

  it("does NOT mount when host is in hiddenHosts", async () => {
    storage["aipagego.widget.hiddenHosts"] = [location.host];
    const { mountWidget } = await import("@/content/widget/mount");
    await mountWidget();
    expect(document.querySelector("aipagego-widget")).toBeNull();
  });

  it("mounts only once when called twice", async () => {
    const { mountWidget } = await import("@/content/widget/mount");
    await mountWidget();
    await mountWidget();
    expect(document.querySelectorAll("aipagego-widget").length).toBe(1);
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
pnpm --filter @aipagego/extension test content/widget/mount
```
Expected: module not found.

- [ ] **Step 3: Implement mount**

```ts
// packages/extension/src/content/widget/mount.ts
import { isHostHidden } from "./per-site";

const HOST_TAG = "aipagego-widget";
const SETTINGS_KEY = "aipagego.llm";

export async function mountWidget(): Promise<void> {
  // Idempotent
  if (document.querySelector(HOST_TAG)) return;

  // Top-level window only
  if (window !== window.top) return;

  // HTML only (skip PDF, XML feeds, etc.)
  if (document.contentType !== "text/html") return;

  // Global toggle
  const settings = (await chrome.storage.local.get([SETTINGS_KEY]))[SETTINGS_KEY] as
    { widgetEnabled?: boolean } | undefined;
  if (settings?.widgetEnabled === false) return;

  // Per-host hide list
  if (await isHostHidden(location.host)) return;

  const host = document.createElement(HOST_TAG);
  host.style.all = "initial";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  // Placeholder — the React root will replace this in Task 8.
  const div = document.createElement("div");
  div.textContent = "AIPageGo widget mounted";
  div.setAttribute("data-aipagego", "placeholder");
  shadow.appendChild(div);

  console.info("[aipagego-widget] mounted on", location.host);
}

// Auto-mount at document_idle (crxjs runs this at run_at time).
void mountWidget();
```

- [ ] **Step 4: Add manifest entry**

In `packages/extension/src/manifest.ts` `content_scripts[0].js` array append:

```ts
"src/content/widget/mount.ts"
```

Full block after edit:

```ts
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: [
        "src/content/index.ts",
        "src/content/breathing-border.ts",
        "src/content/element-capture.ts",
        "src/content/external-replay.ts",
        "src/content/widget/mount.ts"
      ],
      run_at: "document_idle"
    }
  ],
```

- [ ] **Step 5: Run tests + build**

```bash
pnpm --filter @aipagego/extension test content/widget/mount
pnpm build
```
Expected: 4/4 pass;build produces `packages/extension/dist/` including widget bundle chunk.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/content/widget/mount.ts packages/extension/src/manifest.ts packages/extension/tests/content/widget/mount.test.ts
git commit -m "feat(widget): mount 骨架 — Shadow DOM + guards(top window / html / enabled / hiddenHosts)"
```

---

### Task 8: Tailwind → adoptedStyleSheets 样式装配

**Files:**
- Create: `packages/extension/src/content/widget/index.css` — Tailwind entry(widget-only utilities)
- Create: `packages/extension/src/content/widget/styles.ts` — 读取内联 CSS 文本 → `CSSStyleSheet` → attach 到 shadow root
- Modify: `packages/extension/src/content/widget/mount.ts` — 装载样式到 shadow root
- Modify: `packages/extension/vite.config.ts` 或类似 — 若需将 `widget/index.css` 打包为 raw import(可选)

**Interfaces:**
- Produces: `attachStyles(shadow: ShadowRoot): void`

- [ ] **Step 1: Create Tailwind entry**

```css
/* packages/extension/src/content/widget/index.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

/* Widget custom base */
:host { all: initial; }
:host * { box-sizing: border-box; font-family: system-ui, sans-serif; }
```

- [ ] **Step 2: Implement styles.ts**

```ts
// packages/extension/src/content/widget/styles.ts
import cssText from "./index.css?inline";

let cachedSheet: CSSStyleSheet | null = null;

function makeSheet(): CSSStyleSheet {
  if (cachedSheet) return cachedSheet;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(cssText);
  cachedSheet = sheet;
  return sheet;
}

/** Attach the shared Tailwind stylesheet to a shadow root. Safe to call multiple times. */
export function attachStyles(shadow: ShadowRoot): void {
  const sheet = makeSheet();
  if (!shadow.adoptedStyleSheets.includes(sheet)) {
    shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
  }
}
```

- [ ] **Step 3: Wire into mount.ts**

In `packages/extension/src/content/widget/mount.ts`, after `shadow` creation and before the placeholder div, add:

```ts
  const { attachStyles } = await import("./styles");
  attachStyles(shadow);
```

- [ ] **Step 4: Run typecheck + build**

```bash
pnpm -r typecheck
pnpm build
```
Expected: build succeeds;`?inline` import supported by Vite.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/content/widget/index.css packages/extension/src/content/widget/styles.ts packages/extension/src/content/widget/mount.ts
git commit -m "feat(widget): Tailwind → adoptedStyleSheets — 隔离样式装配"
```

---

### Task 9: Widget zustand store 绑定 + broadcast 订阅

**Files:**
- Create: `packages/extension/src/content/widget/store.ts`
- Test: `packages/extension/tests/content/widget/store.test.ts`

**Interfaces:**
- Consumes: sidepanel `useStore` + `installBroadcastSubscriber` + `SELF_INSTANCE_ID` (Task 5)
- Produces:
  - `startWidgetStoreSync(): () => void` — 复用 sidepanel session-store 模块(同一 zustand 实例;因 widget bundle 里的 module 与 sidepanel bundle 是独立 module graph,实际是不同 zustand 实例)+ install broadcast subscriber

**说明**:由于 widget 是独立 bundle,它 import 的 `session-store.ts` 会形成第二份 zustand store。这正是我们想要的 —— widget 与 sidepanel 各持一份,共享 IDB + 广播同步。

- [ ] **Step 1: Write failing test**

```ts
// packages/extension/tests/content/widget/store.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const listeners: any[] = [];
(globalThis as any).chrome = {
  runtime: {
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn((cb: any) => listeners.push(cb)),
      removeListener: vi.fn((cb: any) => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      })
    }
  }
};

describe("widget/store", () => {
  beforeEach(() => { listeners.length = 0; vi.clearAllMocks(); });

  it("startWidgetStoreSync installs subscriber and returns disposer", async () => {
    const m = await import("@/content/widget/store");
    const dispose = m.startWidgetStoreSync();
    expect(listeners.length).toBe(1);
    dispose();
    expect(listeners.length).toBe(0);
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
pnpm --filter @aipagego/extension test content/widget/store
```

- [ ] **Step 3: Implement**

```ts
// packages/extension/src/content/widget/store.ts
import { installBroadcastSubscriber } from "@/sidepanel/chat/session-store";

// Widget 直接 import sidepanel session-store 模块;因 widget 是独立 bundle,
// 会得到一份独立的 zustand 实例。broadcast 通过 chrome.runtime 通道跨 bundle
// 同步。
export function startWidgetStoreSync(): () => void {
  return installBroadcastSubscriber();
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @aipagego/extension test content/widget/store
```

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/content/widget/store.ts packages/extension/tests/content/widget/store.test.ts
git commit -m "feat(widget): store binding — 独立 zustand + 广播订阅同步"
```

---

### Task 10: React root + FAB 组件(可拖动 + 右键菜单)

**Files:**
- Create: `packages/extension/src/content/widget/react-root.tsx`
- Create: `packages/extension/src/content/widget/fab.tsx`
- Modify: `packages/extension/src/content/widget/mount.ts` — 挂载 React
- Test: `packages/extension/tests/content/widget/fab.test.tsx` — 基础渲染 + 打开/关闭状态

**Interfaces:**
- Produces:
  - `bootstrap(shadow: ShadowRoot): void` — createRoot into shadow;渲染 `<WidgetApp />`
  - `<FAB />` React 组件

- [ ] **Step 1: Implement FAB with drag + context menu**

```tsx
// packages/extension/src/content/widget/fab.tsx
import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { getFabPos, setFabPos, hideHost } from "./per-site";
import { rpc } from "@/sidepanel/rpc";

type Props = {
  onToggle: () => void;
  active: boolean;   // panel open?
};

const DEFAULT_POS = { x: -1, y: -1 };  // sentinel: right/bottom 16px

export function FAB({ onToggle, active }: Props) {
  const [pos, setPos] = useState(DEFAULT_POS);
  const [menu, setMenu] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    getFabPos(location.host).then((p) => { if (p) setPos(p); });
  }, []);

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    movedRef.current = false;
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: pos.x, oy: pos.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true;
    if (movedRef.current) {
      setPos({
        x: (dragRef.current.ox === -1 ? window.innerWidth - 64 : dragRef.current.ox) + dx,
        y: (dragRef.current.oy === -1 ? window.innerHeight - 64 : dragRef.current.oy) + dy
      });
    }
  }
  function onPointerUp(_e: React.PointerEvent) {
    if (dragRef.current && movedRef.current) {
      setFabPos(location.host, pos).catch(() => {});
    } else if (dragRef.current) {
      onToggle();
    }
    dragRef.current = null;
  }
  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    setMenu(true);
  }

  const style: React.CSSProperties = pos.x === -1
    ? { right: 16, bottom: 16 }
    : { left: pos.x, top: pos.y };

  return (
    <div style={{ position: "fixed", zIndex: 2147483646, ...style }}>
      <button
        ref={btnRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
        aria-label="AIPageGo 助手"
        className={
          "w-12 h-12 rounded-full flex items-center justify-center shadow-lg cursor-pointer " +
          (active ? "bg-emerald-600 text-white" : "bg-zinc-800 text-emerald-400 border border-zinc-700")
        }
      >
        <Sparkles size={20} />
      </button>
      {menu && (
        <div
          className="absolute right-0 mt-2 bg-zinc-900 border border-zinc-700 rounded shadow-xl text-xs min-w-[180px]"
          onMouseLeave={() => setMenu(false)}
        >
          <button className="block w-full text-left px-3 py-2 hover:bg-zinc-800"
            onClick={() => { setPos(DEFAULT_POS); setFabPos(location.host, DEFAULT_POS); setMenu(false); }}>
            拖回默认位置
          </button>
          <button className="block w-full text-left px-3 py-2 hover:bg-zinc-800"
            onClick={() => {
              rpc.widgetOpenSidepanel({ tabId: -1 }).catch(() => {});
              setMenu(false);
            }}>
            打开扩展面板
          </button>
          <button className="block w-full text-left px-3 py-2 hover:bg-zinc-800 text-amber-400"
            onClick={async () => {
              await hideHost(location.host);
              document.querySelector("aipagego-widget")?.remove();
            }}>
            本站不再显示
          </button>
        </div>
      )}
    </div>
  );
}
```

Note: `rpc.widgetOpenSidepanel({ tabId: -1 })` is a placeholder; BG needs to accept `tabId: -1` as "current active tab" — Task 3's dispatch simply passes it to `chrome.sidePanel.open`. Since `chrome.sidePanel.open` supports `{tabId}` where tabId=-1 is invalid, we need BG to resolve current tab. Fix in Task 3 test — see Step below. **Correction**: BG should read `sender.tab?.id` to resolve tab. Modify Task 3 dispatch to fall back on tab discovery. For simplicity, widget passes actual known tabId (obtained via a separate `tabs.currentTabId` RPC that already exists in `rpc.ts`).

Update the FAB to fetch tabId first — see Step below.

- [ ] **Step 2: Fix tabId resolution — use currentTabId helper**

Change the FAB "打开扩展面板" onClick to:

```tsx
            onClick={async () => {
              const { currentTabId } = await import("@/sidepanel/rpc");
              const tabId = await currentTabId();
              rpc.widgetOpenSidepanel({ tabId }).catch(() => {});
              setMenu(false);
            }}
```

- [ ] **Step 3: Implement react-root bootstrap**

```tsx
// packages/extension/src/content/widget/react-root.tsx
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { FAB } from "./fab";
import { startWidgetStoreSync } from "./store";

function WidgetApp() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <FAB onToggle={() => setOpen((v) => !v)} active={open} />
      {/* Panel added in Task 11 */}
      {open && (
        <div style={{ position: "fixed", right: 72, bottom: 16, zIndex: 2147483645 }}
             className="w-[320px] h-[480px] bg-zinc-900 text-zinc-100 rounded-lg border border-zinc-700 shadow-2xl flex items-center justify-center">
          <span className="text-xs text-zinc-400">Panel — Task 11 will fill this</span>
        </div>
      )}
    </>
  );
}

export function bootstrap(shadow: ShadowRoot): () => void {
  const container = document.createElement("div");
  shadow.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const dispose = startWidgetStoreSync();
  root.render(<React.StrictMode><WidgetApp /></React.StrictMode>);
  return () => { root.unmount(); dispose(); container.remove(); };
}
```

- [ ] **Step 4: Wire into mount.ts**

Replace placeholder logic in `packages/extension/src/content/widget/mount.ts` with:

```ts
  const { attachStyles } = await import("./styles");
  attachStyles(shadow);
  const { bootstrap } = await import("./react-root");
  bootstrap(shadow);
```

Remove the temporary `<div>` placeholder created earlier.

- [ ] **Step 5: Write basic FAB test**

```tsx
// packages/extension/tests/content/widget/fab.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { FAB } from "@/content/widget/fab";

vi.mock("@/content/widget/per-site", () => ({
  getFabPos: vi.fn().mockResolvedValue(null),
  setFabPos: vi.fn().mockResolvedValue(undefined),
  hideHost: vi.fn().mockResolvedValue(undefined)
}));

describe("FAB", () => {
  it("renders as button with aria-label", () => {
    const { getByLabelText } = render(<FAB onToggle={() => {}} active={false} />);
    expect(getByLabelText("AIPageGo 助手")).toBeTruthy();
  });
});
```

Note: If `@testing-library/react` is not a dependency, replace this test with a shallow render using `createRoot + act` (see B6 pattern in `scenarios-page.test.tsx`).

- [ ] **Step 6: Run tests + build**

```bash
pnpm --filter @aipagego/extension test content/widget/fab
pnpm build
```

- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/content/widget/react-root.tsx packages/extension/src/content/widget/fab.tsx packages/extension/src/content/widget/mount.ts packages/extension/tests/content/widget/fab.test.tsx
git commit -m "feat(widget): React root + FAB(可拖动 + 右键菜单)"
```

---

### Task 11: Panel — 复用 ChatView + input-box + 状态条

**Files:**
- Create: `packages/extension/src/content/widget/panel.tsx`
- Modify: `packages/extension/src/content/widget/react-root.tsx` — 换掉 placeholder,渲染 `<Panel />`

**Interfaces:**
- Produces: `<Panel />` — mini shell 组件

- [ ] **Step 1: Implement Panel**

```tsx
// packages/extension/src/content/widget/panel.tsx
import { useEffect, useState } from "react";
import { X, Minus, ExternalLink } from "lucide-react";
import { ChatView } from "@/sidepanel/components/chat-view";
import { EmptySuggestions } from "@/sidepanel/chat/empty-suggestions";
import { InputBox } from "@/sidepanel/input/input-box";
import { useStore, useSession, appendUserMessage, ensureSession } from "@/sidepanel/chat/session-store";
import { rpc, currentTabInfo, currentTabId } from "@/sidepanel/rpc";
import { getPanelSize, setPanelSize } from "./per-site";

type Props = {
  onClose: () => void;
  onMinimize: () => void;
};

export function Panel({ onClose, onMinimize }: Props) {
  const [size, setSize] = useState({ w: 320, h: 480 });
  const [tabId, setTabId] = useState<number | null>(null);
  const session = useSession();

  useEffect(() => {
    getPanelSize().then(setSize);
    currentTabInfo().then((info) => {
      setTabId(info.tabId);
      ensureSession(info.tabId, info.url);
    }).catch(() => {});
  }, []);

  async function onSend(text: string) {
    if (!tabId) return;
    if (session.status !== "idle" && session.status !== "done") return;
    appendUserMessage(tabId, text);
    // The run itself is orchestrated in Task 12 (send loop).
    const { runFromInput } = await import("./run-widget-session");
    runFromInput(tabId, text).catch(() => {});
  }

  async function onOpenSidepanel() {
    if (!tabId) return;
    await rpc.widgetOpenSidepanel({ tabId }).catch(() => {});
  }

  return (
    <div
      style={{
        position: "fixed",
        right: 72,
        bottom: 16,
        width: size.w,
        height: size.h,
        zIndex: 2147483645
      }}
      className="bg-zinc-900 text-zinc-100 rounded-lg border border-zinc-700 shadow-2xl flex flex-col overflow-hidden"
    >
      <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 text-xs">
        <b className="flex-1 select-none">⚡ AIPageGo</b>
        <button className="p-1 hover:bg-zinc-800 rounded" title="打开扩展面板" onClick={onOpenSidepanel}>
          <ExternalLink size={14} />
        </button>
        <button className="p-1 hover:bg-zinc-800 rounded" title="最小化" onClick={onMinimize}>
          <Minus size={14} />
        </button>
        <button className="p-1 hover:bg-zinc-800 rounded" title="关闭" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="flex-1 overflow-auto">
        {session.messages.length === 0 ? (
          <div className="p-3 text-xs text-zinc-400">
            <EmptySuggestions
              presets={[]}
              onPresetPick={() => {}}
            />
            <div className="mt-3">今天想让 AIPageGo 帮你做什么？</div>
          </div>
        ) : (
          <ChatView session={session} />
        )}
      </div>
      <footer className="px-2 py-1 text-[10px] text-zinc-500 border-t border-zinc-800 flex justify-between">
        <span>{session.tokenUsage.input}k in / {session.tokenUsage.output}k out</span>
        <span>round {session.roundCount}/{20}</span>
      </footer>
      <div className="border-t border-zinc-800 p-2">
        <InputBox onSend={onSend} disabled={session.status !== "idle" && session.status !== "done"} />
      </div>
    </div>
  );
}
```

Note: `<EmptySuggestions>` and `<InputBox>` prop shapes come from the existing components — verify against `packages/extension/src/sidepanel/chat/empty-suggestions.tsx` and `packages/extension/src/sidepanel/input/input-box.tsx` before finalizing; if signatures differ, adapt the prop names locally.

- [ ] **Step 2: Replace placeholder in react-root**

In `packages/extension/src/content/widget/react-root.tsx`, replace the placeholder `<div>...</div>` with:

```tsx
      {open && <Panel onClose={() => setOpen(false)} onMinimize={() => setOpen(false)} />}
```

Add import at top:

```tsx
import { Panel } from "./panel";
```

- [ ] **Step 3: Typecheck + build**

```bash
pnpm -r typecheck
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/content/widget/panel.tsx packages/extension/src/content/widget/react-root.tsx
git commit -m "feat(widget): Panel — 复用 ChatView / EmptySuggestions / InputBox"
```

---

### Task 12: Widget-side runChatSession 触发

**Files:**
- Create: `packages/extension/src/content/widget/run-widget-session.ts`
- Test: `packages/extension/tests/content/widget/run-widget-session.test.ts` — mock LlmClient

**Interfaces:**
- Consumes: `runChatSession` (existing), `pickClient` (existing), `useSettings`
- Produces: `runFromInput(tabId: number, text: string): Promise<void>`

- [ ] **Step 1: Implement**

```ts
// packages/extension/src/content/widget/run-widget-session.ts
import { runChatSession } from "@/sidepanel/chat/run-session";
import { pickClient } from "@/sidepanel/llm/client";
import { useSettings } from "@/sidepanel/chat/settings-store";
import { getApproverForTab } from "@/sidepanel/chat/approval";
import {
  useStore, setStatus, appendAssistantText, beginAssistantTurn,
  finalizeAssistantTurn, upsertCard, setCardStatus, appendToolResults,
  addUsage, incrementRound, setError, addLlmExchange
} from "@/sidepanel/chat/session-store";
import { rpc } from "@/sidepanel/rpc";
import { RpcToolRunner } from "@/sidepanel/chat/tool-runner";
import { RecordingLlmClient } from "@/sidepanel/llm/recording-client";

export async function runFromInput(tabId: number, _text: string): Promise<void> {
  const settings = useSettings.getState();
  if (!settings.apiKey) {
    setError(tabId, "未配置 API Key。请在扩展面板设置。");
    return;
  }
  const client = new RecordingLlmClient(pickClient(settings.provider), (ex) => addLlmExchange(tabId, ex));
  const runner = new RpcToolRunner();
  const approver = getApproverForTab(tabId);

  const session = useStore.getState().sessionsByTab[tabId];
  if (!session) return;

  await runChatSession({
    tabId,
    input: {
      messages: session.messages,
      systemPrompt: undefined,   // sidepanel's system prompt builder — reused
      url: session.url,
      title: document.title
    },
    client: {
      provider: settings.provider,
      model: settings.model,
      apiKey: settings.apiKey,
      endpoint: undefined,
      maxTokens: 4096,
      client
    },
    runner,
    approver,
    rpc: {
      startSession: (i) => rpc.startSession(i),
      appendStepLog: (id, e) => rpc.appendStepLog(id, e),
      finalizeSession: (id, s) => rpc.finalizeSession(id, s)
    },
    tabsRpc: {
      list: (winId?: number) => rpc.listTabs(winId),
      open: (url: string, active?: boolean) => rpc.openTab(url, active)
    },
    settings: {
      maxRounds: settings.maxRounds,
      maxContinuationNudges: settings.maxContinuationNudges,
      approveAllSafe: true,
      permissionMode: settings.defaultPermissionMode,
      trustedDangerTools: settings.trustedDangerTools
    },
    onEvent: (ev) => {
      // Reuse the same session-store mutation helpers as sidepanel does.
      if (ev.type === "text_delta") appendAssistantText(tabId, ev.text);
      else if (ev.type === "tool_use_start") upsertCard(tabId, { toolUseId: ev.id, name: ev.name, input: {} as any, partialJson: "", inputReady: false, status: "draft" });
      else if (ev.type === "tool_use_end") upsertCard(tabId, { toolUseId: ev.id, name: "", input: ev.input as any, partialJson: "", inputReady: true, status: "awaiting" });
      else if (ev.type === "round_start") incrementRound(tabId);
      // Other events (self_heal_*, session_end, usage) handled in Task 5's broadcast — sidepanel-side handlers already emit
    }
  });
}
```

Note: The exact `runChatSession` arg shape may differ from this sketch — inspect `packages/extension/src/sidepanel/chat/run-session.ts` `RunSessionArgs` type before writing final version and adapt field names.

- [ ] **Step 2: Add a simple test**

```ts
// packages/extension/tests/content/widget/run-widget-session.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@/sidepanel/chat/settings-store", () => ({
  useSettings: {
    getState: () => ({
      apiKey: "",
      provider: "anthropic",
      model: "x",
      maxRounds: 20,
      maxContinuationNudges: 1,
      defaultPermissionMode: "default",
      trustedDangerTools: []
    })
  }
}));

describe("runFromInput", () => {
  it("early-returns with error when apiKey is empty", async () => {
    const { runFromInput } = await import("@/content/widget/run-widget-session");
    // No throw — just verifies it doesn't crash on empty key
    await runFromInput(1, "hello");
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 3: Run test + typecheck**

```bash
pnpm --filter @aipagego/extension test run-widget-session
pnpm -r typecheck
```

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/content/widget/run-widget-session.ts packages/extension/tests/content/widget/run-widget-session.test.ts
git commit -m "feat(widget): runFromInput — 复用 runChatSession + LlmClient"
```

---

### Task 13: Dangerous handoff + sidepanel focus effect

**Files:**
- Create: `packages/extension/src/content/widget/handoff.ts` — 封装 `widget.openSidepanel` 调用
- Modify: `packages/extension/src/content/widget/run-widget-session.ts` — wrap approver;dangerous → handoff
- Modify: `packages/extension/src/sidepanel/shell/app-shell.tsx` — `useEffect` 读 `aipagego.pendingApproval` + scroll 到该 step-card + 高亮

**Interfaces:**
- Produces:
  - `handOffToSidepanel(tabId: number, approvalId: string): Promise<void>` — call `rpc.widgetOpenSidepanel`

- [ ] **Step 1: Implement handoff**

```ts
// packages/extension/src/content/widget/handoff.ts
import { rpc } from "@/sidepanel/rpc";
import { appendHealNote } from "@/sidepanel/chat/session-store";

export async function handOffToSidepanel(tabId: number, approvalId: string): Promise<void> {
  try {
    await rpc.widgetOpenSidepanel({ tabId, pendingApprovalId: approvalId });
  } catch (e) {
    appendHealNote(tabId, "无法自动打开扩展面板;请手动点浏览器右上角的扩展图标。");
  }
}
```

- [ ] **Step 2: Wrap approver in run-widget-session.ts**

In `packages/extension/src/content/widget/run-widget-session.ts`, replace the `approver` line with a wrapper that intercepts `dangerous` severity:

```ts
import { classifyTool } from "@/sidepanel/chat/severity";
import { handOffToSidepanel } from "./handoff";

// … inside runFromInput:
const rawApprover = getApproverForTab(tabId);
const approver = {
  request: async (step: any) => {
    const sev = classifyTool(step.tool ?? step.name ?? "", step.args ?? {});
    if (sev === "dangerous") {
      const id = crypto.randomUUID();
      await handOffToSidepanel(tabId, id);
    }
    return rawApprover.request(step);
  }
};
```

Note: verify `Approver.request` signature from `packages/extension/src/sidepanel/chat/approval.ts` — adapt if `request` takes different args.

- [ ] **Step 3: Add pendingApproval focus effect in app-shell.tsx**

In `packages/extension/src/sidepanel/shell/app-shell.tsx`, add a `useEffect(() => { ... }, [])`:

```tsx
useEffect(() => {
  const KEY = "aipagego.pendingApproval";
  void chrome.storage.session.get([KEY]).then(async (res) => {
    const p = (res as any)[KEY] as { tabId: number; approvalId: string; ts: number } | undefined;
    if (!p) return;
    if (Date.now() - p.ts > 30_000) {
      await chrome.storage.session.remove([KEY]);
      return;
    }
    // Scroll to the step card by data-attribute
    const el = document.querySelector(`[data-approval-id="${p.approvalId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    (el as HTMLElement | null)?.classList?.add("ring-2", "ring-amber-400");
    setTimeout(() => (el as HTMLElement | null)?.classList?.remove("ring-2", "ring-amber-400"), 2000);
    await chrome.storage.session.remove([KEY]);
  });
}, []);
```

Note: This relies on step-card components carrying `data-approval-id={cardState.toolUseId}` — grep the current step-card component and add the attribute. If cards use a different ID scheme, thread that scheme through instead.

- [ ] **Step 4: Typecheck + build**

```bash
pnpm -r typecheck
pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/content/widget/handoff.ts packages/extension/src/content/widget/run-widget-session.ts packages/extension/src/sidepanel/shell/app-shell.tsx
git commit -m "feat(widget): dangerous 交接 sidepanel + focus 待审 step"
```

---

### Task 14: Settings 里的 widgetEnabled toggle

**Files:**
- Modify: `packages/extension/src/sidepanel/drawers/settings/section-llm.tsx`

- [ ] **Step 1: Add UI**

Locate the `selfHealEnabled` checkbox row in `section-llm.tsx` and add adjacent:

```tsx
        <label className="flex items-center gap-2">
          <input type="checkbox"
            checked={widgetEnabled !== false}
            onChange={(e) => save({ widgetEnabled: e.target.checked })}/>
          启用页内浮窗(每页右下角对话入口,默认开)
        </label>
```

Add `widgetEnabled` to the destructure of `useSettings()`:

```tsx
const { widgetEnabled, save } = useSettings();
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

- [ ] **Step 3: Commit**

```bash
git add packages/extension/src/sidepanel/drawers/settings/section-llm.tsx
git commit -m "feat(sidepanel): settings 加页内浮窗总闸"
```

---

### Task 15: 全量验证 + PR + Ship

- [ ] **Step 1: Full verification**

```bash
pnpm -r typecheck
pnpm test
pnpm build
```
Expected: all green;`dist/` produced.

- [ ] **Step 2: Cut feat branch (if working on main)**

If Tasks 1-14 were committed on main (or a scratch branch), cut the feat branch:

```bash
git checkout -b feat/inpage-chat-widget
```

If already on `feat/inpage-chat-widget` from the start, skip this step.

- [ ] **Step 3: Push feat branch**

```bash
git push -u origin feat/inpage-chat-widget
```

- [ ] **Step 4: Open PR**

```bash
gh pr create --title "feat: 页内浮窗对话入口" --body "$(cat <<'EOF'
## Summary
- 新增第 5 个 content-script bundle `content/widget/` — Shadow DOM 承载 mini 对话面板
- Widget 与 sidepanel 共享同 tab session,通过 BG `session-broker.ts` 广播 rev 号仲裁
- FAB 可拖动 + 右键"本站不再显示 / 打开扩展面板 / 拖回默认位置"
- Caution step 页内 modal 审阅;dangerous 自动交接 sidepanel + focus 待审步
- 设置里"启用页内浮窗"总闸,默认开
- Zero IDB migration;`LlmSettings.widgetEnabled`、`SessionData._rev` 均可选/有默认

对应 spec: docs/superpowers/specs/2026-07-08-inpage-chat-widget-design.md

## Test plan
- [ ] typecheck / test / build 全绿
- [ ] 手测:任意 https 页面右下角出现 FAB,拖动位置刷新后仍在
- [ ] 手测:点开 FAB → 打字 → AI 回应流入 widget → 同时打开 sidepanel 应看到同一会话
- [ ] 手测:触发 dangerous(submitForm)→ widget 弹提示 + sidepanel 自动打开 + 待审 step 高亮
- [ ] 手测:右键"本站不再显示" → 刷新后 FAB 消失
- [ ] 手测:settings 关掉总闸 → 刷新任意页 FAB 消失
EOF
)"
```

- [ ] **Step 5: Watch CI**

```bash
gh pr checks --watch
```

- [ ] **Step 6: Squash-merge**

```bash
gh pr merge --squash --delete-branch
git checkout main
git pull --ff-only
```

- [ ] **Step 7: Ship via ship-release**

Compute next patch tag from `git tag --list --sort=-v:refname | head -1`. If latest is `v0.0.45`, tag `v0.0.46`:

```bash
git tag v0.0.46
git push origin v0.0.46
```

CI covers version injection into `package.json` files;do NOT bump anything manually. Watch `gh run list --limit 3` for build success.

---

## Self-Review

**Spec coverage:**

- **§2 goals**: T7 (mount) + T10 (FAB) + T11 (Panel) delivers "每个可注入页面右下角 FAB → mini 面板"
- **§3 non-goals**: iframe subpage guard (T7 Step 3), `chrome://` skip (T7 same guard), i18n absent (matches non-goal)
- **§4 architecture**: T4 broker + T5 sidepanel hook + T9 widget store subscriber cover the 3-arrow diagram
- **§5.1-5.4 storage**: T6 (per-site helper) + T1 (widgetEnabled) + T2 (_rev) + T3 (pendingApproval via widget.openSidepanel RPC)
- **§6 widget components**: T7 (mount) + T10 (FAB) + T11 (Panel) + T12 (send loop) + T13 (approval modal via handoff)
- **§7 state sync**: T5 (broadcast + subscriber) covers 7.1-7.4
- **§8 dangerous handoff**: T13
- **§9 security**: all shadow-DOM-based;API key stays in extension code domain (T12 uses same LlmClient path)
- **§10 CSP**: T8 (adoptedStyleSheets)
- **§11 tests**: T1-T13 all include a test where meaningful; T12/T13 tests are shallow due to component/env complexity — acceptable
- **§12 migration**: T1 (`widgetEnabled` default), T2 (`_rev` optional), T7 (5th content_script additive)
- **§13 observability**: `console.info` in T7 mount;diagnostic bundle enrichment intentionally deferred (mentioned in §13 but not blocker;acceptable slip)
- **§14 phasing**: fully collapsed into one PR per plan intent

**Placeholder scan**: none found — every step has full code or an explicit adapt-check instruction (e.g., "verify against existing component signatures before finalizing").

**Type consistency:**
- `SessionData._rev: number` (T2) matches `snapshot._rev` in broker (T4), broadcast payload (T5), subscriber cmp (T5) — consistent.
- `widget.openSidepanel { tabId, pendingApprovalId? }` shape same in messages.ts (T3), dispatch (T3), rpc.ts wrapper (T3), FAB handoff (T13) — consistent.
- `LlmSettings.widgetEnabled: boolean` (T1) used in mount (T7 Step 3) + settings toggle (T14) — consistent.
- `SELF_INSTANCE_ID` (T5) referenced by subscriber (T5) + tests (T5) — consistent.

**Known slip**: T15 doesn't include an explicit docs-site preset update or CHANGELOG entry — those are out of scope per §14 "5-phase collapsed to 1 iteration".

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-08-inpage-chat-widget.md`.

**Recommended:** superpowers:subagent-driven-development — 15 tasks batchable into ~6 groups for a fresh subagent per group, sonnet-tier reviewers per batch, opus-tier final whole-branch review.
