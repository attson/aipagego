# 侧边面板会话持久化与多会话历史 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 per-tab 内存会话扩展为 IDB 持久化；同 tab 支持多个历史会话 + "新建会话" + 从历史"恢复"；删除现有 5 分钟内存 closedSessions 层。

**Architecture:** 新增 IDB store `chat_sessions`（key `id`，索引 `(url, status)` / `(lastTabId, status)` / `(url, updatedAt)`）。Sidepanel 内 `auto-persist` 订阅 zustand mutation，debounced 300ms 写 IDB；`hydrate` 在 sidepanel 启动时按 tabId 主、URL 副决定 rehydrate / 弹 banner / 空白；`tab-close-archiver` 跑在 background SW，监听 `chrome.tabs.onRemoved` 改 IDB status。`auto-persist` 永不写 `status` 字段，避免 status flip-flop。

**Tech Stack:** TypeScript 5 strict, React 18, zustand 4, idb 8, vitest + happy-dom + fake-indexeddb, Vite 5 + @crxjs MV3。

**Spec:** [`docs/superpowers/specs/2026-05-19-sidepanel-session-persistence-design.md`](../specs/2026-05-19-sidepanel-session-persistence-design.md)

---

## File Map

**Create:**
- `packages/shared/src/types.ts`（扩展） — `PersistedSession` / `PersistedSessionData` 类型
- `packages/extension/src/sidepanel/chat/persistence/sessions-storage.ts` — IDB CRUD
- `packages/extension/src/sidepanel/chat/persistence/auto-persist.ts` — zustand → IDB debounced 写
- `packages/extension/src/sidepanel/chat/persistence/hydrate.ts` — sidepanel 启动 read
- `packages/extension/src/sidepanel/components/url-recovery-banner.tsx` — URL 命中 banner
- `packages/extension/src/sidepanel/components/session-history-drawer.tsx` — 历史 drawer
- `packages/extension/src/background/tab-close-archiver.ts` — background SW onRemoved → IDB
- 各 test 文件镜像 `tests/...`

**Modify:**
- `packages/extension/src/background/storage/db.ts` — schema v1 → v2，加 `chat_sessions` store + 3 索引
- `packages/extension/src/sidepanel/chat/session-store.ts` — 删 `closedSessions` / `closeTab` / `restoreClosed` / `pruneClosed` / `CLOSED_TTL_MS` / `ClosedSession` / `useClosedSessions`；加 `startNewSession(tabId)`、`restoreFromArchive(persistedId, tabId)`、`rehydrateFromPersisted(tabId, data)`
- `packages/extension/src/sidepanel/app.tsx` — 删 `useClosedSessionsPruner` 和 `<ClosedSessionsBanner />` 引用；boot 时挂 `useAutoPersist` + `useHydrate`；接 `<UrlRecoveryBanner />`
- `packages/extension/src/sidepanel/pages/chat-page.tsx` — 顶上加 ➕ 新建会话按钮 + ≡ 历史按钮
- `packages/extension/src/background/index.ts`（或 background entrypoint） — 挂 `installTabCloseArchiver()`
- `docs/superpowers/plans/README.md`、`docs/superpowers/specs/README.md`（已在 spec commit 更新）

**Delete:**
- `packages/extension/src/sidepanel/chat/closed-sessions-pruner.ts`
- `packages/extension/src/sidepanel/components/closed-sessions-banner.tsx`
- `packages/extension/tests/sidepanel/chat/closed-sessions-pruner.test.ts`（若存在）
- `packages/extension/tests/sidepanel/components/closed-sessions-banner.test.tsx`（若存在）

---

## Task 1: 共享类型 `PersistedSession` / `PersistedSessionData`

**Files:**
- Modify: `packages/shared/src/types.ts`
- Test: `packages/shared/tests/types-persisted.test.ts`（验证类型可被实例化、字段完整）

- [ ] **Step 1: 加测试 — `PersistedSession` 类型能用**

在 `packages/shared/tests/types-persisted.test.ts` 创建：

```ts
import { describe, expect, it } from "vitest";
import type {
  PersistedSession,
  PersistedSessionData,
  SessionData
} from "../src/types";

describe("PersistedSession", () => {
  it("PersistedSessionData is a subset of SessionData fields", () => {
    // 编译期断言：拿 SessionData 构一份能 spread 出 PersistedSessionData
    const fullSession: SessionData = {
      tabId: 1,
      url: "https://x.com",
      runRecordId: null,
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
      abortController: null,
      logs: [],
      logsOpen: false,
      inputDraft: "",
      attachedTabs: []
    };
    const persisted: PersistedSessionData = {
      messages: fullSession.messages,
      cards: fullSession.cards,
      executedSteps: fullSession.executedSteps,
      tokenUsage: fullSession.tokenUsage,
      roundCount: fullSession.roundCount,
      attachedTabs: fullSession.attachedTabs,
      url: fullSession.url,
      runRecordId: fullSession.runRecordId,
      errorMessage: fullSession.errorMessage
    };
    expect(persisted.messages).toBe(fullSession.messages);
  });

  it("PersistedSession includes routing meta", () => {
    const p: PersistedSession = {
      id: "uuid",
      url: "https://x.com",
      lastTabId: 1,
      status: "active",
      data: {
        messages: [],
        cards: [],
        executedSteps: [],
        tokenUsage: { input: 0, output: 0 },
        roundCount: 0,
        attachedTabs: [],
        url: "https://x.com",
        runRecordId: null,
        errorMessage: null
      },
      createdAt: 0,
      updatedAt: 0
    };
    expect(p.status).toBe("active");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```
pnpm --filter @aipagego/shared test -- --run types-persisted
```

Expected: FAIL — `PersistedSession` / `PersistedSessionData` not exported from `../src/types`.

- [ ] **Step 3: 在 `packages/shared/src/types.ts` 末尾追加类型**

```ts
// === Persistence (see specs/2026-05-19-sidepanel-session-persistence-design.md) ===

export type PersistedSessionData = Pick<
  SessionData,
  | "messages"
  | "cards"
  | "executedSteps"
  | "tokenUsage"
  | "roundCount"
  | "attachedTabs"
  | "url"
  | "runRecordId"
  | "errorMessage"
>;

export type PersistedSession = {
  id: string;
  url: string;
  lastTabId: number;
  status: "active" | "archived";
  data: PersistedSessionData;
  createdAt: number;
  updatedAt: number;
};
```

注意：`SessionData` 类型当前定义在 `packages/extension/src/sidepanel/chat/session-store.ts`，**不在 shared 包**。如果 shared 还没有 `SessionData`，把这个 Pick 改成手写一份：

```ts
import type { AttachedTab, ChatMessage, Json, Step } from "./types";  // 现有同文件

export type PersistedSessionData = {
  messages: ChatMessage[];
  cards: Array<{
    toolUseId: string;
    name: string;
    input: Json;
    partialJson: string;
    inputReady: boolean;
    status: "draft" | "awaiting" | "running" | "ok" | "error" | "skipped" | "denied";
    output?: Json;
    error?: string;
    ms?: number;
  }>;
  executedSteps: Step[];
  tokenUsage: { input: number; output: number };
  roundCount: number;
  attachedTabs: AttachedTab[];
  url: string;
  runRecordId: string | null;
  errorMessage: string | null;
};
```

先 grep 确认：

```
grep -n "export.*SessionData" packages/shared/src/types.ts
```

如果没有，用上面手写版本；如果有（未来重构后），用 Pick 版本。

- [ ] **Step 4: 运行测试验证通过**

```
pnpm --filter @aipagego/shared test -- --run types-persisted
```

Expected: PASS（2 tests）。

- [ ] **Step 5: Commit**

```
git add packages/shared/src/types.ts packages/shared/tests/types-persisted.test.ts
git commit -m "feat(shared): add PersistedSession / PersistedSessionData types"
```

---

## Task 2: IDB schema 升级 v1 → v2 加 `chat_sessions` store

**Files:**
- Modify: `packages/extension/src/background/storage/db.ts`
- Test: `packages/extension/tests/background/storage/db-v2-migration.test.ts`

- [ ] **Step 1: 加测试 — v2 升级后 `chat_sessions` store + 3 索引齐全**

```ts
// packages/extension/tests/background/storage/db-v2-migration.test.ts
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { _resetDBForTests, getDB } from "@/background/storage/db";

describe("db v2 migration", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
  });

  it("creates chat_sessions store with 3 indexes", async () => {
    const db = await getDB();
    expect(db.objectStoreNames.contains("chat_sessions")).toBe(true);
    const tx = db.transaction("chat_sessions", "readonly");
    const store = tx.objectStore("chat_sessions");
    expect(store.indexNames.contains("by_url_status")).toBe(true);
    expect(store.indexNames.contains("by_lastTabId_status")).toBe(true);
    expect(store.indexNames.contains("by_url_updatedAt")).toBe(true);
  });

  it("still has tools and runs stores after upgrade", async () => {
    const db = await getDB();
    expect(db.objectStoreNames.contains("tools")).toBe(true);
    expect(db.objectStoreNames.contains("runs")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```
pnpm --filter @aipagego/extension test -- --run db-v2-migration
```

Expected: FAIL — `chat_sessions` store does not exist。

- [ ] **Step 3: 升级 `packages/extension/src/background/storage/db.ts`**

整个文件替换为：

```ts
import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { PersistedSession, RunRecord, Tool } from "@aipagego/shared/types";

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
  chat_sessions: {
    key: string;
    value: PersistedSession;
    indexes: {
      by_url_status: [string, "active" | "archived"];
      by_lastTabId_status: [number, "active" | "archived"];
      by_url_updatedAt: [string, number];
    };
  };
}

const DB_NAME = "aipagego";
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<aipagegoDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<aipagegoDB>> {
  if (!dbPromise) {
    dbPromise = openDB<aipagegoDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const tools = db.createObjectStore("tools", { keyPath: "id" });
          tools.createIndex("byUpdatedAt", "updatedAt");
          const runs = db.createObjectStore("runs", { keyPath: "id" });
          runs.createIndex("byToolId", "toolId");
          runs.createIndex("byStartedAt", "startedAt");
        }
        if (oldVersion < 2) {
          const sessions = db.createObjectStore("chat_sessions", { keyPath: "id" });
          sessions.createIndex("by_url_status", ["url", "status"]);
          sessions.createIndex("by_lastTabId_status", ["lastTabId", "status"]);
          sessions.createIndex("by_url_updatedAt", ["url", "updatedAt"]);
        }
      }
    });
  }
  return dbPromise;
}

export function _resetDBForTests() {
  dbPromise = null;
}
```

- [ ] **Step 4: 运行测试验证通过**

```
pnpm --filter @aipagego/extension test -- --run db-v2-migration
```

Expected: PASS（2 tests）。

- [ ] **Step 5: 整包跑一遍确认旧 runs/tools 测试没破**

```
pnpm --filter @aipagego/extension test -- --run storage
```

Expected: 所有 storage 测试 PASS。

- [ ] **Step 6: Commit**

```
git add packages/extension/src/background/storage/db.ts \
        packages/extension/tests/background/storage/db-v2-migration.test.ts
git commit -m "feat(db): bump schema to v2 — add chat_sessions store + 3 indexes"
```

---

## Task 3: `sessions-storage` IDB CRUD

**Files:**
- Create: `packages/extension/src/sidepanel/chat/persistence/sessions-storage.ts`
- Test: `packages/extension/tests/sidepanel/chat/persistence/sessions-storage.test.ts`

- [ ] **Step 1: 加测试 — CRUD 覆盖**

```ts
// packages/extension/tests/sidepanel/chat/persistence/sessions-storage.test.ts
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";
import * as ss from "@/sidepanel/chat/persistence/sessions-storage";
import type { PersistedSession, PersistedSessionData } from "@aipagego/shared/types";

const URL = "https://example.com/path";
const EMPTY_DATA: PersistedSessionData = {
  messages: [],
  cards: [],
  executedSteps: [],
  tokenUsage: { input: 0, output: 0 },
  roundCount: 0,
  attachedTabs: [],
  url: URL,
  runRecordId: null,
  errorMessage: null
};

function makeSession(over: Partial<PersistedSession>): PersistedSession {
  return {
    id: crypto.randomUUID(),
    url: URL,
    lastTabId: 1,
    status: "active",
    data: EMPTY_DATA,
    createdAt: 0,
    updatedAt: 0,
    ...over
  };
}

describe("sessions-storage", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
  });

  it("putSession + getById round-trip", async () => {
    const s = makeSession({ id: "a" });
    await ss.putSession(s);
    expect(await ss.getById("a")).toEqual(s);
  });

  it("putSessionData merges without touching status", async () => {
    await ss.putSession(makeSession({ id: "a", status: "archived", updatedAt: 100 }));
    const newData = { ...EMPTY_DATA, roundCount: 5 };
    await ss.putSessionData("a", newData, /* lastTabId */ 9, /* url */ URL);
    const got = await ss.getById("a");
    expect(got?.status).toBe("archived");
    expect(got?.data.roundCount).toBe(5);
    expect(got?.lastTabId).toBe(9);
  });

  it("putSessionData on missing id is a no-op", async () => {
    await ss.putSessionData("nope", EMPTY_DATA, 1, URL);
    expect(await ss.getById("nope")).toBeUndefined();
  });

  it("getActiveByTabId returns matching active session", async () => {
    await ss.putSession(makeSession({ id: "a", lastTabId: 1, status: "active" }));
    await ss.putSession(makeSession({ id: "b", lastTabId: 1, status: "archived" }));
    await ss.putSession(makeSession({ id: "c", lastTabId: 2, status: "active" }));
    const got = await ss.getActiveByTabId(1);
    expect(got?.id).toBe("a");
  });

  it("listArchivedByUrl sorts by updatedAt desc", async () => {
    await ss.putSession(makeSession({ id: "old", status: "archived", updatedAt: 100 }));
    await ss.putSession(makeSession({ id: "new", status: "archived", updatedAt: 200 }));
    await ss.putSession(makeSession({ id: "active", status: "active", updatedAt: 300 }));
    const got = await ss.listArchivedByUrl(URL);
    expect(got.map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("archiveActive flips status and bumps updatedAt", async () => {
    await ss.putSession(makeSession({ id: "a", status: "active", updatedAt: 100 }));
    const before = Date.now();
    await ss.archiveActive("a");
    const got = await ss.getById("a");
    expect(got?.status).toBe("archived");
    expect(got!.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("restoreArchived flips status to active and sets lastTabId", async () => {
    await ss.putSession(makeSession({ id: "a", status: "archived", lastTabId: 1 }));
    await ss.restoreArchived("a", 9);
    const got = await ss.getById("a");
    expect(got?.status).toBe("active");
    expect(got?.lastTabId).toBe(9);
  });

  it("pruneOverLimit evicts oldest archived beyond N", async () => {
    for (let i = 0; i < 22; i++) {
      await ss.putSession(makeSession({ id: `s${i}`, status: "archived", updatedAt: i }));
    }
    const evictedRunIds = await ss.pruneOverLimit(URL, 20);
    const remaining = await ss.listArchivedByUrl(URL);
    expect(remaining.length).toBe(20);
    // 最老两个 s0, s1 被删
    expect(remaining.map((s) => s.id).sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `s${i + 2}`).sort()
    );
    expect(evictedRunIds.length).toBe(0); // 无 runRecordId
  });

  it("pruneOverLimit returns runRecordIds of evicted sessions", async () => {
    await ss.putSession(
      makeSession({
        id: "evicted",
        status: "archived",
        updatedAt: 1,
        data: { ...EMPTY_DATA, runRecordId: "run-1" }
      })
    );
    for (let i = 2; i <= 21; i++) {
      await ss.putSession(makeSession({ id: `s${i}`, status: "archived", updatedAt: i }));
    }
    const evicted = await ss.pruneOverLimit(URL, 20);
    expect(evicted).toEqual(["run-1"]);
  });

  it("deleteOne removes a single row", async () => {
    await ss.putSession(makeSession({ id: "a" }));
    await ss.deleteOne("a");
    expect(await ss.getById("a")).toBeUndefined();
  });

  it("clearAllForUrl deletes all rows for url and returns runRecordIds", async () => {
    await ss.putSession(
      makeSession({
        id: "a",
        url: URL,
        data: { ...EMPTY_DATA, runRecordId: "run-1" }
      })
    );
    await ss.putSession(
      makeSession({
        id: "b",
        url: URL,
        data: { ...EMPTY_DATA, runRecordId: "run-2" }
      })
    );
    await ss.putSession(makeSession({ id: "c", url: "https://other.com" }));
    const runIds = await ss.clearAllForUrl(URL);
    expect(runIds.sort()).toEqual(["run-1", "run-2"]);
    expect(await ss.listArchivedByUrl(URL)).toEqual([]);
    expect(await ss.getById("c")).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```
pnpm --filter @aipagego/extension test -- --run sessions-storage
```

Expected: FAIL — module not found。

- [ ] **Step 3: 实现 `sessions-storage.ts`**

```ts
// packages/extension/src/sidepanel/chat/persistence/sessions-storage.ts
import type { PersistedSession, PersistedSessionData } from "@aipagego/shared/types";
import { getDB } from "@/background/storage/db";

export async function putSession(s: PersistedSession): Promise<void> {
  const db = await getDB();
  await db.put("chat_sessions", s);
}

export async function getById(id: string): Promise<PersistedSession | undefined> {
  const db = await getDB();
  return db.get("chat_sessions", id);
}

/**
 * 更新 data + meta，但保持 status 不变。auto-persist 用此路径，避免 status flip-flop。
 * 如果 id 不存在则 no-op（防止恢复已删会话）。
 */
export async function putSessionData(
  id: string,
  data: PersistedSessionData,
  lastTabId: number,
  url: string
): Promise<void> {
  const db = await getDB();
  const cur = await db.get("chat_sessions", id);
  if (!cur) return;
  await db.put("chat_sessions", {
    ...cur,
    data,
    lastTabId,
    url,
    updatedAt: Date.now()
  });
}

export async function getActiveByTabId(tabId: number): Promise<PersistedSession | undefined> {
  const db = await getDB();
  const all = await db.getAllFromIndex("chat_sessions", "by_lastTabId_status", [tabId, "active"]);
  return all[0];
}

export async function listArchivedByUrl(
  url: string,
  limit = 20
): Promise<PersistedSession[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("chat_sessions", "by_url_status", [url, "archived"]);
  return all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

export async function archiveActive(id: string): Promise<void> {
  const db = await getDB();
  const cur = await db.get("chat_sessions", id);
  if (!cur) return;
  await db.put("chat_sessions", { ...cur, status: "archived", updatedAt: Date.now() });
}

export async function restoreArchived(id: string, lastTabId: number): Promise<void> {
  const db = await getDB();
  const cur = await db.get("chat_sessions", id);
  if (!cur) return;
  await db.put("chat_sessions", {
    ...cur,
    status: "active",
    lastTabId,
    updatedAt: Date.now()
  });
}

/**
 * 每 URL 至多保留 N 条 archived，超出按 updatedAt asc 淘汰最老。
 * 返回被淘汰会话的 runRecordIds（供 cascade 删 runs 表）。
 */
export async function pruneOverLimit(url: string, n = 20): Promise<string[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("chat_sessions", "by_url_status", [url, "archived"]);
  if (all.length <= n) return [];
  const sortedAsc = all.sort((a, b) => a.updatedAt - b.updatedAt);
  const toEvict = sortedAsc.slice(0, all.length - n);
  const runIds: string[] = [];
  for (const s of toEvict) {
    if (s.data.runRecordId) runIds.push(s.data.runRecordId);
    await db.delete("chat_sessions", s.id);
  }
  return runIds;
}

export async function deleteOne(id: string): Promise<string | null> {
  const db = await getDB();
  const cur = await db.get("chat_sessions", id);
  if (!cur) return null;
  await db.delete("chat_sessions", id);
  return cur.data.runRecordId ?? null;
}

export async function clearAllForUrl(url: string): Promise<string[]> {
  const db = await getDB();
  const active = await db.getAllFromIndex("chat_sessions", "by_url_status", [url, "active"]);
  const archived = await db.getAllFromIndex("chat_sessions", "by_url_status", [url, "archived"]);
  const all = [...active, ...archived];
  const runIds: string[] = [];
  for (const s of all) {
    if (s.data.runRecordId) runIds.push(s.data.runRecordId);
    await db.delete("chat_sessions", s.id);
  }
  return runIds;
}

/**
 * Cascade delete runs 表里指定 id 的行。失败静默（runs 增长无害）。
 */
export async function cascadeDeleteRuns(runIds: string[]): Promise<void> {
  if (runIds.length === 0) return;
  try {
    const db = await getDB();
    for (const id of runIds) {
      await db.delete("runs", id);
    }
  } catch (e) {
    console.warn("[persistence] cascadeDeleteRuns failed (non-fatal)", e);
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

```
pnpm --filter @aipagego/extension test -- --run sessions-storage
```

Expected: PASS（11 tests）。

- [ ] **Step 5: Commit**

```
git add packages/extension/src/sidepanel/chat/persistence/sessions-storage.ts \
        packages/extension/tests/sidepanel/chat/persistence/sessions-storage.test.ts
git commit -m "feat(persistence): chat_sessions IDB CRUD + cascade delete runs"
```

---

## Task 4: zustand store — 删 `closedSessions` 全套 + 加新方法

**Files:**
- Modify: `packages/extension/src/sidepanel/chat/session-store.ts`
- Test: `packages/extension/tests/sidepanel/chat/session-store.test.ts`

- [ ] **Step 1: 加测试 — 新方法**

在 `tests/sidepanel/chat/session-store.test.ts` 顶部插入（保留现有测试，新增 describe 块）：

```ts
describe("session-store new persistence-aware methods", () => {
  // ensureSession / getSessionFor 是项目里已有的辅助；保持引用
  // setupSession 用项目里已有的 import 即可

  it("startNewSession returns the archived session and resets sessionsByTab[tabId]", async () => {
    const { ensureSession, sendMessage, startNewSession, useStore } = await import(
      "@/sidepanel/chat/session-store"
    );
    ensureSession(7, "https://x.com");
    sendMessage(7, "hello");
    expect(useStore.getState().sessionsByTab[7].messages.length).toBe(1);

    const archivedData = startNewSession(7);
    expect(archivedData?.messages.length).toBe(1);
    expect(useStore.getState().sessionsByTab[7].messages.length).toBe(0);
    expect(useStore.getState().sessionsByTab[7].url).toBe("https://x.com");
  });

  it("rehydrateFromPersisted overwrites sessionsByTab[tabId] preserving tabId", async () => {
    const { ensureSession, rehydrateFromPersisted, useStore } = await import(
      "@/sidepanel/chat/session-store"
    );
    ensureSession(7, "https://x.com");
    rehydrateFromPersisted(7, {
      messages: [{ role: "user", content: "restored" }],
      cards: [],
      executedSteps: [],
      tokenUsage: { input: 0, output: 0 },
      roundCount: 1,
      attachedTabs: [],
      url: "https://x.com",
      runRecordId: null,
      errorMessage: null
    });
    const s = useStore.getState().sessionsByTab[7];
    expect(s.tabId).toBe(7);
    expect(s.messages.length).toBe(1);
    expect(s.roundCount).toBe(1);
    expect(s.status).toBe("idle"); // 强制重置
    expect(s.abortController).toBeNull();
  });

  it("rehydrateFromPersisted sanitizes streaming/running status to aborted", async () => {
    const { ensureSession, rehydrateFromPersisted, useStore } = await import(
      "@/sidepanel/chat/session-store"
    );
    ensureSession(7, "https://x.com");
    // Simulate a session that was mid-stream when persisted by manually setting status
    useStore.setState((state) => ({
      ...state,
      sessionsByTab: {
        ...state.sessionsByTab,
        7: { ...state.sessionsByTab[7], status: "streaming" }
      }
    }));
    rehydrateFromPersisted(7, {
      messages: [{ role: "user", content: "stale" }],
      cards: [],
      executedSteps: [],
      tokenUsage: { input: 0, output: 0 },
      roundCount: 0,
      attachedTabs: [],
      url: "https://x.com",
      runRecordId: null,
      errorMessage: null
    });
    expect(useStore.getState().sessionsByTab[7].status).toBe("idle");
  });
});
```

同时**删除 / 重命名**任何残留的旧 `describe("closedSessions"...)` 块（grep 一下）。

- [ ] **Step 2: 运行测试验证失败**

```
pnpm --filter @aipagego/extension test -- --run session-store
```

Expected: FAIL — `startNewSession` / `rehydrateFromPersisted` not exported；同时旧 `closedSessions` 测试也会失败（一会儿一起删）。

- [ ] **Step 3: 编辑 `session-store.ts` — 删旧、加新**

打开 `packages/extension/src/sidepanel/chat/session-store.ts`，做如下改动：

1. 删除 `ClosedSession` 类型定义（约 line 61-66）
2. `StoreShape` 中删除 `closedSessions: ClosedSession[]`
3. `useStore` 初始值删 `closedSessions: []`
4. 删除整个 `// === closed sessions ===` 注释块直到 `pruneClosed` 末尾（约 line 343-403）
5. 删除 `CLOSED_TTL_MS` 常量（约 line 97）
6. 删除任何 `useClosedSessions` 选择器（grep `useClosedSessions`）
7. 在 attachedTabs 块之前追加：

```ts
// === persistence-aware session ops ===

/**
 * 把 sessionsByTab[tabId] 当前内容快照出来（供归档持久化），并把该 tab 的
 * session 重置为空白（保留 url）。返回被归档的 SessionData（caller 负责写 IDB）。
 */
export function startNewSession(tabId: number): SessionData | null {
  let archived: SessionData | null = null;
  useStore.setState((state) => {
    const cur = state.sessionsByTab[tabId];
    if (!cur) return state;
    archived = cur;
    cur.abortController?.abort();
    return {
      ...state,
      sessionsByTab: { ...state.sessionsByTab, [tabId]: makeEmptySession(tabId, cur.url) }
    };
  });
  return archived;
}

/**
 * 把持久化的 PersistedSessionData 装回 sessionsByTab[tabId]。
 * 强制重置瞬时字段（status / abortController / streamingAssistantText）。
 */
export function rehydrateFromPersisted(
  tabId: number,
  data: import("@aipagego/shared/types").PersistedSessionData
): void {
  useStore.setState((state) => {
    const cur = state.sessionsByTab[tabId];
    cur?.abortController?.abort();
    const rehydrated: SessionData = {
      ...makeEmptySession(tabId, data.url),
      messages: data.messages,
      cards: data.cards,
      executedSteps: data.executedSteps,
      tokenUsage: data.tokenUsage,
      roundCount: data.roundCount,
      attachedTabs: data.attachedTabs,
      runRecordId: data.runRecordId,
      errorMessage: data.errorMessage
      // status: "idle" already from makeEmptySession (overriding any persisted streaming/running)
    };
    return {
      ...state,
      sessionsByTab: { ...state.sessionsByTab, [tabId]: rehydrated }
    };
  });
}
```

注意：`restoreFromArchive` 整合在 Task 9（drawer / banner UI）里调用 `rehydrateFromPersisted` + 写 IDB。store 这里只暴露原子操作。

- [ ] **Step 4: 同时清掉 `app.tsx` 中残留的 `useClosedSessionsPruner` import 调用**

读 `packages/extension/src/sidepanel/app.tsx`，删第 2 行的 import 和第 46 行的 `useClosedSessionsPruner();`（保留 placeholder 注释 `// pruner removed — see Task 11`，本任务里只是断引用，下一步删文件）。

- [ ] **Step 5: 同时清掉 `app.tsx` 中残留的 `ClosedSessionsBanner` 引用**

删第 5 行 import 和第 115 行 `<ClosedSessionsBanner />`。同样留 placeholder `{/* url-recovery-banner mounted in Task 11 */}`。

- [ ] **Step 6: 运行新测试验证通过**

```
pnpm --filter @aipagego/extension test -- --run session-store
```

Expected: 新增 3 个测试 PASS；旧 closedSessions 相关测试如果还在请一并删除（grep `closedSessions`, `restoreClosed`, `pruneClosed`, `closeTab`）。

- [ ] **Step 7: typecheck 确认无悬挂引用**

```
pnpm --filter @aipagego/extension typecheck
```

Expected: PASS。如果有引用 `closeTab` / `restoreClosed` / `ClosedSession` 的文件，把它们的引用一并删除（应该只剩 `closed-sessions-pruner.ts` 和 `closed-sessions-banner.tsx`，下一任务删掉）。

- [ ] **Step 8: Commit**

```
git add packages/extension/src/sidepanel/chat/session-store.ts \
        packages/extension/src/sidepanel/app.tsx \
        packages/extension/tests/sidepanel/chat/session-store.test.ts
git commit -m "refactor(session-store): remove closedSessions; add startNewSession + rehydrateFromPersisted"
```

---

## Task 5: 删旧文件 `closed-sessions-pruner.ts` + `closed-sessions-banner.tsx`

**Files:**
- Delete: `packages/extension/src/sidepanel/chat/closed-sessions-pruner.ts`
- Delete: `packages/extension/src/sidepanel/components/closed-sessions-banner.tsx`
- Delete (if exist): tests for the above

- [ ] **Step 1: 检查 grep 确认无其它引用**

```
grep -rn "closed-sessions-pruner\|ClosedSessionsBanner\|useClosedSessionsPruner" \
  packages/extension/src packages/extension/tests
```

Expected: 无输出（前一任务已断引用）。

- [ ] **Step 2: 删除文件**

```bash
rm packages/extension/src/sidepanel/chat/closed-sessions-pruner.ts
rm packages/extension/src/sidepanel/components/closed-sessions-banner.tsx
# 如果有对应测试也删
find packages/extension/tests -name "closed-sessions-*.test.*" -delete
```

- [ ] **Step 3: typecheck + 全测**

```
pnpm --filter @aipagego/extension typecheck && \
pnpm --filter @aipagego/extension test
```

Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```
git add -A packages/extension/src/sidepanel/chat/closed-sessions-pruner.ts \
          packages/extension/src/sidepanel/components/closed-sessions-banner.tsx \
          packages/extension/tests
git commit -m "refactor: remove closedSessions UI + pruner (replaced by persistence layer)"
```

---

## Task 6: `auto-persist` debounced zustand → IDB 写

**Files:**
- Create: `packages/extension/src/sidepanel/chat/persistence/auto-persist.ts`
- Test: `packages/extension/tests/sidepanel/chat/persistence/auto-persist.test.ts`

- [ ] **Step 1: 加测试 — debounce / flush / 失败不抛**

```ts
// packages/extension/tests/sidepanel/chat/persistence/auto-persist.test.ts
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";
import * as ss from "@/sidepanel/chat/persistence/sessions-storage";
import { ensureSession, sendMessage, useStore } from "@/sidepanel/chat/session-store";
import { installAutoPersist, flushAllPending } from "@/sidepanel/chat/persistence/auto-persist";

const URL = "https://example.com";

describe("auto-persist", () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
    vi.useFakeTimers();
    // Reset zustand state
    useStore.setState({ sessionsByTab: {}, currentTabId: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces multiple rapid mutations into a single put", async () => {
    const spy = vi.spyOn(ss, "putSession");
    const off = installAutoPersist();
    ensureSession(7, URL);
    sendMessage(7, "a");
    sendMessage(7, "b");
    sendMessage(7, "c");
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
    expect(spy.mock.calls.length).toBe(1);
    off();
  });

  it("creates a new active row on first mutation", async () => {
    const off = installAutoPersist();
    ensureSession(7, URL);
    sendMessage(7, "hi");
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
    const active = await ss.getActiveByTabId(7);
    expect(active).toBeDefined();
    expect(active?.data.messages.length).toBe(1);
    expect(active?.status).toBe("active");
    off();
  });

  it("subsequent mutations use putSessionData (status not flipped)", async () => {
    const off = installAutoPersist();
    ensureSession(7, URL);
    sendMessage(7, "hi");
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
    const first = await ss.getActiveByTabId(7);
    // Manually flip to archived simulating background archiver
    await ss.archiveActive(first!.id);
    sendMessage(7, "should-not-revive");
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
    const after = await ss.getById(first!.id);
    expect(after?.status).toBe("archived");  // status preserved
    off();
  });

  it("flushAllPending writes synchronously without waiting for debounce", async () => {
    const off = installAutoPersist();
    ensureSession(7, URL);
    sendMessage(7, "hi");
    await flushAllPending();
    const active = await ss.getActiveByTabId(7);
    expect(active?.data.messages.length).toBe(1);
    off();
  });

  it("write failure does not throw", async () => {
    const off = installAutoPersist();
    vi.spyOn(ss, "putSession").mockRejectedValueOnce(new Error("quota"));
    ensureSession(7, URL);
    sendMessage(7, "hi");
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    // Should not throw — uncaught rejection check
    expect(true).toBe(true);
    off();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```
pnpm --filter @aipagego/extension test -- --run auto-persist
```

Expected: FAIL — module not found。

- [ ] **Step 3: 实现 `auto-persist.ts`**

```ts
// packages/extension/src/sidepanel/chat/persistence/auto-persist.ts
import type { PersistedSession, PersistedSessionData } from "@aipagego/shared/types";
import { useStore, type SessionData } from "@/sidepanel/chat/session-store";
import * as ss from "./sessions-storage";

const DEBOUNCE_MS = 300;

/**
 * Map<tabId, { timer, persistedId? }>。persistedId 在第一次成功写入后填入；
 * 后续 mutation 走 putSessionData（不动 status）。
 */
const state = new Map<number, { timer: ReturnType<typeof setTimeout> | null; persistedId: string | null }>();

function toPersistedData(s: SessionData): PersistedSessionData {
  return {
    messages: s.messages,
    cards: s.cards,
    executedSteps: s.executedSteps,
    tokenUsage: s.tokenUsage,
    roundCount: s.roundCount,
    attachedTabs: s.attachedTabs,
    url: s.url,
    runRecordId: s.runRecordId,
    errorMessage: s.errorMessage
  };
}

async function writeFor(tabId: number, session: SessionData): Promise<void> {
  try {
    const entry = state.get(tabId);
    if (entry?.persistedId) {
      await ss.putSessionData(entry.persistedId, toPersistedData(session), tabId, session.url);
    } else {
      const now = Date.now();
      const row: PersistedSession = {
        id: crypto.randomUUID(),
        url: session.url,
        lastTabId: tabId,
        status: "active",
        data: toPersistedData(session),
        createdAt: now,
        updatedAt: now
      };
      await ss.putSession(row);
      state.set(tabId, { timer: null, persistedId: row.id });
    }
  } catch (e) {
    console.warn("[persistence] auto-persist write failed", e);
  }
}

function schedule(tabId: number, session: SessionData): void {
  let entry = state.get(tabId);
  if (!entry) {
    entry = { timer: null, persistedId: null };
    state.set(tabId, entry);
  }
  if (entry.timer != null) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry!.timer = null;
    void writeFor(tabId, useStore.getState().sessionsByTab[tabId]);
  }, DEBOUNCE_MS);
}

/**
 * 订阅 zustand sessionsByTab；每次 mutation 对发生变化的 tab schedule debounced 写。
 * 返回 unsubscribe 函数。
 */
export function installAutoPersist(): () => void {
  let prev = useStore.getState().sessionsByTab;
  const unsub = useStore.subscribe((state) => {
    const cur = state.sessionsByTab;
    if (cur === prev) return;
    for (const [k, s] of Object.entries(cur)) {
      const tabId = Number(k);
      if (s !== prev[tabId]) {
        // 跳过空 session（避免给 makeEmptySession 立刻创建一行）
        if (s.messages.length === 0 && s.cards.length === 0) continue;
        schedule(tabId, s);
      }
    }
    prev = cur;
  });
  // beforeunload flush
  const flush = () => { void flushAllPending(); };
  if (typeof window !== "undefined") window.addEventListener("beforeunload", flush);
  return () => {
    unsub();
    if (typeof window !== "undefined") window.removeEventListener("beforeunload", flush);
    for (const entry of state.values()) {
      if (entry.timer != null) clearTimeout(entry.timer);
    }
    state.clear();
  };
}

/**
 * 强制写入所有 pending session。供 beforeunload / 手动 flush 调用。
 */
export async function flushAllPending(): Promise<void> {
  const sessions = useStore.getState().sessionsByTab;
  for (const [k, entry] of state) {
    if (entry.timer != null) {
      clearTimeout(entry.timer);
      entry.timer = null;
      const s = sessions[k];
      if (s) await writeFor(k, s);
    }
  }
}

/**
 * 测试辅助：清空 state map。
 */
export function _resetAutoPersistForTests(): void {
  for (const entry of state.values()) {
    if (entry.timer != null) clearTimeout(entry.timer);
  }
  state.clear();
}
```

- [ ] **Step 4: 运行测试验证通过**

```
pnpm --filter @aipagego/extension test -- --run auto-persist
```

Expected: PASS（5 tests）。

- [ ] **Step 5: Commit**

```
git add packages/extension/src/sidepanel/chat/persistence/auto-persist.ts \
        packages/extension/tests/sidepanel/chat/persistence/auto-persist.test.ts
git commit -m "feat(persistence): debounced zustand → IDB auto-persist"
```

---

## Task 7: `hydrate` sidepanel 启动 read

**Files:**
- Create: `packages/extension/src/sidepanel/chat/persistence/hydrate.ts`
- Test: `packages/extension/tests/sidepanel/chat/persistence/hydrate.test.ts`

- [ ] **Step 1: 加测试 — 3 场景**

```ts
// packages/extension/tests/sidepanel/chat/persistence/hydrate.test.ts
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";
import * as ss from "@/sidepanel/chat/persistence/sessions-storage";
import { ensureSession, useStore } from "@/sidepanel/chat/session-store";
import { hydrateOnBoot } from "@/sidepanel/chat/persistence/hydrate";
import type { PersistedSession } from "@aipagego/shared/types";

const URL = "https://example.com";
const EMPTY_DATA = {
  messages: [],
  cards: [],
  executedSteps: [],
  tokenUsage: { input: 0, output: 0 },
  roundCount: 0,
  attachedTabs: [],
  url: URL,
  runRecordId: null,
  errorMessage: null
};

function makeRow(over: Partial<PersistedSession>): PersistedSession {
  return {
    id: crypto.randomUUID(),
    url: URL,
    lastTabId: 1,
    status: "active",
    data: EMPTY_DATA,
    createdAt: 0,
    updatedAt: 0,
    ...over
  };
}

describe("hydrateOnBoot", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
    useStore.setState({ sessionsByTab: {}, currentTabId: null });
  });

  it("scenario 1: tabId active match → rehydrates silently", async () => {
    await ss.putSession(
      makeRow({
        lastTabId: 7,
        status: "active",
        data: { ...EMPTY_DATA, messages: [{ role: "user", content: "hi" }] }
      })
    );
    ensureSession(7, URL);
    const result = await hydrateOnBoot(7, URL);
    expect(result.kind).toBe("rehydrated");
    expect(useStore.getState().sessionsByTab[7].messages.length).toBe(1);
  });

  it("scenario 2: url match without tabId → returns candidates", async () => {
    await ss.putSession(
      makeRow({
        id: "old",
        lastTabId: 999,
        status: "archived",
        updatedAt: 100,
        data: { ...EMPTY_DATA, messages: [{ role: "user", content: "old" }] }
      })
    );
    await ss.putSession(
      makeRow({
        id: "new",
        lastTabId: 998,
        status: "archived",
        updatedAt: 200,
        data: { ...EMPTY_DATA, messages: [{ role: "user", content: "new" }] }
      })
    );
    const result = await hydrateOnBoot(7, URL);
    expect(result.kind).toBe("url-candidates");
    if (result.kind === "url-candidates") {
      expect(result.candidates[0].id).toBe("new");
    }
  });

  it("scenario 3: nothing matches → empty", async () => {
    const result = await hydrateOnBoot(7, URL);
    expect(result.kind).toBe("empty");
  });

  it("scenario 1b: tabId active but url mismatch → treat as scenario 2/3", async () => {
    await ss.putSession(
      makeRow({
        lastTabId: 7,
        status: "active",
        url: "https://different.com"
      })
    );
    const result = await hydrateOnBoot(7, URL);
    expect(result.kind === "empty" || result.kind === "url-candidates").toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```
pnpm --filter @aipagego/extension test -- --run hydrate
```

Expected: FAIL — module not found。

- [ ] **Step 3: 实现 `hydrate.ts`**

```ts
// packages/extension/src/sidepanel/chat/persistence/hydrate.ts
import type { PersistedSession } from "@aipagego/shared/types";
import { rehydrateFromPersisted } from "@/sidepanel/chat/session-store";
import * as ss from "./sessions-storage";

export type HydrateResult =
  | { kind: "rehydrated"; persistedId: string }
  | { kind: "url-candidates"; candidates: PersistedSession[] }
  | { kind: "empty" };

/**
 * sidepanel 启动时调用。先按 tabId 查 active；命中且 url 一致 → 直接 rehydrate；
 * 否则按 url 查 archived 候选列表（≤5 条）；都没有 → empty。
 */
export async function hydrateOnBoot(tabId: number, url: string): Promise<HydrateResult> {
  try {
    const active = await ss.getActiveByTabId(tabId);
    if (active && active.url === url) {
      rehydrateFromPersisted(tabId, active.data);
      return { kind: "rehydrated", persistedId: active.id };
    }
    const candidates = await ss.listArchivedByUrl(url, 5);
    if (candidates.length > 0) return { kind: "url-candidates", candidates };
    return { kind: "empty" };
  } catch (e) {
    console.warn("[persistence] hydrate failed; falling back to empty", e);
    return { kind: "empty" };
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

```
pnpm --filter @aipagego/extension test -- --run hydrate
```

Expected: PASS（4 tests）。

- [ ] **Step 5: Commit**

```
git add packages/extension/src/sidepanel/chat/persistence/hydrate.ts \
        packages/extension/tests/sidepanel/chat/persistence/hydrate.test.ts
git commit -m "feat(persistence): hydrate on sidepanel boot (tabId / url / empty)"
```

---

## Task 8: `tab-close-archiver` background SW onRemoved 处理

**Files:**
- Create: `packages/extension/src/background/tab-close-archiver.ts`
- Test: `packages/extension/tests/background/tab-close-archiver.test.ts`

- [ ] **Step 1: 加测试 — onRemoved 触发归档 + prune**

```ts
// packages/extension/tests/background/tab-close-archiver.test.ts
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";
import * as ss from "@/sidepanel/chat/persistence/sessions-storage";
import { installTabCloseArchiver } from "@/background/tab-close-archiver";

const URL = "https://example.com";

function stubChromeTabs() {
  const listeners: Array<(tabId: number) => void> = [];
  vi.stubGlobal("chrome", {
    tabs: {
      onRemoved: {
        addListener: (cb: (tabId: number) => void) => listeners.push(cb),
        removeListener: (cb: (tabId: number) => void) => {
          const i = listeners.indexOf(cb);
          if (i >= 0) listeners.splice(i, 1);
        }
      }
    }
  });
  return { fire: (tabId: number) => listeners.forEach((cb) => cb(tabId)) };
}

describe("tab-close-archiver", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
  });

  it("on tab close, archives active session with that lastTabId", async () => {
    const { fire } = stubChromeTabs();
    await ss.putSession({
      id: "a",
      url: URL,
      lastTabId: 7,
      status: "active",
      data: {
        messages: [],
        cards: [],
        executedSteps: [],
        tokenUsage: { input: 0, output: 0 },
        roundCount: 0,
        attachedTabs: [],
        url: URL,
        runRecordId: null,
        errorMessage: null
      },
      createdAt: 0,
      updatedAt: 0
    });
    installTabCloseArchiver();
    fire(7);
    // wait microtask
    await new Promise((r) => setTimeout(r, 0));
    const got = await ss.getById("a");
    expect(got?.status).toBe("archived");
  });

  it("on tab close, runs pruneOverLimit and cascades runs delete", async () => {
    const { fire } = stubChromeTabs();
    // 21 archived + 1 active for tabId=7
    for (let i = 0; i < 21; i++) {
      await ss.putSession({
        id: `arc-${i}`,
        url: URL,
        lastTabId: 999,
        status: "archived",
        data: {
          messages: [],
          cards: [],
          executedSteps: [],
          tokenUsage: { input: 0, output: 0 },
          roundCount: 0,
          attachedTabs: [],
          url: URL,
          runRecordId: i === 0 ? "run-evict" : null,  // 最老一条会被淘汰
          errorMessage: null
        },
        createdAt: 0,
        updatedAt: i
      });
    }
    await ss.putSession({
      id: "active-7",
      url: URL,
      lastTabId: 7,
      status: "active",
      data: {
        messages: [],
        cards: [],
        executedSteps: [],
        tokenUsage: { input: 0, output: 0 },
        roundCount: 0,
        attachedTabs: [],
        url: URL,
        runRecordId: null,
        errorMessage: null
      },
      createdAt: 0,
      updatedAt: 1000
    });

    installTabCloseArchiver();
    fire(7);
    await new Promise((r) => setTimeout(r, 0));

    const archivedList = await ss.listArchivedByUrl(URL);
    expect(archivedList.length).toBe(20);
    // active-7 应该已变 archived；arc-0（最老，updatedAt=0）应该被淘汰
    expect(archivedList.find((s) => s.id === "active-7")).toBeDefined();
    expect(archivedList.find((s) => s.id === "arc-0")).toBeUndefined();
  });

  it("on tab close with no active session, is a no-op", async () => {
    const { fire } = stubChromeTabs();
    installTabCloseArchiver();
    fire(7);
    await new Promise((r) => setTimeout(r, 0));
    // no throw, no rows
    expect((await ss.listArchivedByUrl(URL)).length).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```
pnpm --filter @aipagego/extension test -- --run tab-close-archiver
```

Expected: FAIL — module not found。

- [ ] **Step 3: 实现 `tab-close-archiver.ts`**

```ts
// packages/extension/src/background/tab-close-archiver.ts
import * as ss from "@/sidepanel/chat/persistence/sessions-storage";

async function handleTabRemoved(tabId: number): Promise<void> {
  try {
    const active = await ss.getActiveByTabId(tabId);
    if (!active) return;
    await ss.archiveActive(active.id);
    const evicted = await ss.pruneOverLimit(active.url);
    if (evicted.length > 0) await ss.cascadeDeleteRuns(evicted);
  } catch (e) {
    console.warn("[persistence] tab-close-archiver failed (non-fatal)", e);
  }
}

export function installTabCloseArchiver(): () => void {
  const listener = (tabId: number) => { void handleTabRemoved(tabId); };
  chrome.tabs.onRemoved.addListener(listener);
  return () => chrome.tabs.onRemoved.removeListener(listener);
}
```

- [ ] **Step 4: 运行测试验证通过**

```
pnpm --filter @aipagego/extension test -- --run tab-close-archiver
```

Expected: PASS（3 tests）。

- [ ] **Step 5: 在 background entry 挂上**

读 `packages/extension/src/background/index.ts`（或 service worker 入口），在已有的 listener 注册附近加：

```ts
import { installTabCloseArchiver } from "./tab-close-archiver";
// ...在已有 init 块里加：
installTabCloseArchiver();
```

如果该入口文件路径不同，grep `chrome.runtime.onMessage.addListener` 找到 background entry。

- [ ] **Step 6: typecheck**

```
pnpm --filter @aipagego/extension typecheck
```

Expected: PASS。

- [ ] **Step 7: Commit**

```
git add packages/extension/src/background/tab-close-archiver.ts \
        packages/extension/src/background/index.ts \
        packages/extension/tests/background/tab-close-archiver.test.ts
git commit -m "feat(persistence): archive active session on tab close (background SW)"
```

---

## Task 9: `UrlRecoveryBanner` 组件

**Files:**
- Create: `packages/extension/src/sidepanel/components/url-recovery-banner.tsx`
- Test: `packages/extension/tests/sidepanel/components/url-recovery-banner.test.tsx`

- [ ] **Step 1: 加测试 — render / restore / dismiss / 打开 drawer**

```tsx
// packages/extension/tests/sidepanel/components/url-recovery-banner.test.tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";
import * as ss from "@/sidepanel/chat/persistence/sessions-storage";
import { UrlRecoveryBanner } from "@/sidepanel/components/url-recovery-banner";
import { useStore } from "@/sidepanel/chat/session-store";
import type { PersistedSession } from "@aipagego/shared/types";

const URL = "https://example.com";
const candidate: PersistedSession = {
  id: "cand-1",
  url: URL,
  lastTabId: 999,
  status: "archived",
  data: {
    messages: [{ role: "user", content: "hello there" }],
    cards: [],
    executedSteps: [],
    tokenUsage: { input: 0, output: 0 },
    roundCount: 0,
    attachedTabs: [],
    url: URL,
    runRecordId: null,
    errorMessage: null
  },
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000
};

describe("UrlRecoveryBanner", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
    useStore.setState({ sessionsByTab: {}, currentTabId: 7 });
  });

  it("renders nothing when no candidate", () => {
    const { container } = render(<UrlRecoveryBanner candidates={[]} onOpenDrawer={() => {}} onDismiss={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows preview of first user message", () => {
    render(<UrlRecoveryBanner candidates={[candidate]} onOpenDrawer={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText(/hello there/)).toBeInTheDocument();
  });

  it("restore button calls restoreArchived + rehydrates", async () => {
    await ss.putSession(candidate);
    render(<UrlRecoveryBanner candidates={[candidate]} onOpenDrawer={() => {}} onDismiss={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByText("恢复"));
    });
    const got = await ss.getById("cand-1");
    expect(got?.status).toBe("active");
    expect(got?.lastTabId).toBe(7);
    expect(useStore.getState().sessionsByTab[7].messages.length).toBe(1);
  });

  it("discard button deletes the row", async () => {
    await ss.putSession(candidate);
    const onDismiss = vi.fn();
    render(<UrlRecoveryBanner candidates={[candidate]} onOpenDrawer={() => {}} onDismiss={onDismiss} />);
    await act(async () => {
      fireEvent.click(screen.getByText("丢弃"));
    });
    expect(await ss.getById("cand-1")).toBeUndefined();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("'更多'opens drawer via callback when >1 candidates", () => {
    const onOpenDrawer = vi.fn();
    render(
      <UrlRecoveryBanner
        candidates={[candidate, { ...candidate, id: "cand-2" }]}
        onOpenDrawer={onOpenDrawer}
        onDismiss={() => {}}
      />
    );
    fireEvent.click(screen.getByText("更多"));
    expect(onOpenDrawer).toHaveBeenCalled();
  });

  it("'更多'is hidden when only 1 candidate", () => {
    render(<UrlRecoveryBanner candidates={[candidate]} onOpenDrawer={() => {}} onDismiss={() => {}} />);
    expect(screen.queryByText("更多")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```
pnpm --filter @aipagego/extension test -- --run url-recovery-banner
```

Expected: FAIL — module not found。

- [ ] **Step 3: 实现 `url-recovery-banner.tsx`**

```tsx
// packages/extension/src/sidepanel/components/url-recovery-banner.tsx
import { useState } from "react";
import type { PersistedSession } from "@aipagego/shared/types";
import * as ss from "@/sidepanel/chat/persistence/sessions-storage";
import { rehydrateFromPersisted, useStore } from "@/sidepanel/chat/session-store";

function firstUserText(s: PersistedSession): string {
  const m = s.data.messages.find((m) => m.role === "user" && typeof m.content === "string");
  if (!m || typeof m.content !== "string") return "(无文本)";
  return m.content.slice(0, 30) + (m.content.length > 30 ? "…" : "");
}

function ago(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s 前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m 前`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h 前`;
  return `${Math.floor(sec / 86_400)}d 前`;
}

export function UrlRecoveryBanner(props: {
  candidates: PersistedSession[];
  onOpenDrawer: () => void;
  onDismiss: () => void;
}): JSX.Element | null {
  const [hidden, setHidden] = useState(false);
  if (hidden || props.candidates.length === 0) return null;
  const top = props.candidates[0];

  async function onRestore() {
    const tabId = useStore.getState().currentTabId;
    if (tabId == null) return;
    await ss.restoreArchived(top.id, tabId);
    rehydrateFromPersisted(tabId, top.data);
    setHidden(true);
  }

  async function onDiscard() {
    await ss.deleteOne(top.id);
    setHidden(true);
    props.onDismiss();
  }

  return (
    <div className="bg-zinc-900/60 border-b border-zinc-800 p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-zinc-300">📁 上次会话</span>
        <span className="flex-1 truncate text-zinc-200">{firstUserText(top)}</span>
        <span className="text-zinc-500 shrink-0">
          {top.data.messages.length} 条 · {ago(top.updatedAt)}
        </span>
        <button onClick={() => void onRestore()} className="px-2 py-0.5 bg-emerald-700 rounded shrink-0">
          恢复
        </button>
        <button onClick={() => void onDiscard()} className="px-2 py-0.5 bg-zinc-700 rounded shrink-0">
          丢弃
        </button>
        {props.candidates.length > 1 && (
          <button onClick={props.onOpenDrawer} className="px-2 py-0.5 underline text-zinc-300 shrink-0">
            更多
          </button>
        )}
      </div>
    </div>
  );
}
```

注意：`更多`按钮只在候选数 >1 时显示，匹配 Step 1 的两个对应测试。

- [ ] **Step 4: 运行测试验证通过**

```
pnpm --filter @aipagego/extension test -- --run url-recovery-banner
```

Expected: PASS（6 tests）。

- [ ] **Step 5: Commit**

```
git add packages/extension/src/sidepanel/components/url-recovery-banner.tsx \
        packages/extension/tests/sidepanel/components/url-recovery-banner.test.tsx
git commit -m "feat(ui): UrlRecoveryBanner component"
```

---

## Task 10: `SessionHistoryDrawer` 组件

**Files:**
- Create: `packages/extension/src/sidepanel/components/session-history-drawer.tsx`
- Test: `packages/extension/tests/sidepanel/components/session-history-drawer.test.tsx`

- [ ] **Step 1: 加测试**

```tsx
// packages/extension/tests/sidepanel/components/session-history-drawer.test.tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";
import * as ss from "@/sidepanel/chat/persistence/sessions-storage";
import { SessionHistoryDrawer } from "@/sidepanel/components/session-history-drawer";
import { useStore } from "@/sidepanel/chat/session-store";

const URL = "https://example.com";

function mkRow(over: { id: string; messages?: string[]; updatedAt?: number; runRecordId?: string | null; status?: "active" | "archived" }) {
  return ss.putSession({
    id: over.id,
    url: URL,
    lastTabId: 999,
    status: over.status ?? "archived",
    data: {
      messages: (over.messages ?? []).map((c) => ({ role: "user" as const, content: c })),
      cards: [],
      executedSteps: [],
      tokenUsage: { input: 0, output: 0 },
      roundCount: 0,
      attachedTabs: [],
      url: URL,
      runRecordId: over.runRecordId ?? null,
      errorMessage: null
    },
    createdAt: 0,
    updatedAt: over.updatedAt ?? Date.now()
  });
}

describe("SessionHistoryDrawer", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
    useStore.setState({ sessionsByTab: { 7: { tabId: 7, url: URL } as any }, currentTabId: 7 });
  });

  it("lists archived sessions for current URL, desc by updatedAt", async () => {
    await mkRow({ id: "a", messages: ["old"], updatedAt: 100 });
    await mkRow({ id: "b", messages: ["new"], updatedAt: 200 });
    render(<SessionHistoryDrawer url={URL} open onClose={() => {}} />);
    await screen.findByText(/new/);
    const items = screen.getAllByTestId("history-item");
    expect(items[0]).toHaveTextContent("new");
    expect(items[1]).toHaveTextContent("old");
  });

  it("restore button archives current + restores target", async () => {
    await mkRow({ id: "target", messages: ["restore me"] });
    // 当前 tab 已有一个 active session id=cur
    await ss.putSession({
      id: "cur",
      url: URL,
      lastTabId: 7,
      status: "active",
      data: {
        messages: [{ role: "user", content: "current" }],
        cards: [],
        executedSteps: [],
        tokenUsage: { input: 0, output: 0 },
        roundCount: 0,
        attachedTabs: [],
        url: URL,
        runRecordId: null,
        errorMessage: null
      },
      createdAt: 0,
      updatedAt: 0
    });

    render(<SessionHistoryDrawer url={URL} open onClose={() => {}} />);
    await screen.findByText(/restore me/);
    await act(async () => {
      fireEvent.click(screen.getAllByText("恢复")[0]);
    });
    expect((await ss.getById("cur"))?.status).toBe("archived");
    expect((await ss.getById("target"))?.status).toBe("active");
    expect((await ss.getById("target"))?.lastTabId).toBe(7);
  });

  it("delete button removes one row + cascades", async () => {
    await mkRow({ id: "a", runRecordId: "run-a" });
    render(<SessionHistoryDrawer url={URL} open onClose={() => {}} />);
    await screen.findByTestId("history-item");
    await act(async () => {
      fireEvent.click(screen.getByText("删除"));
    });
    expect(await ss.getById("a")).toBeUndefined();
  });

  it("clear-all removes everything for this URL", async () => {
    await mkRow({ id: "a" });
    await mkRow({ id: "b" });
    render(<SessionHistoryDrawer url={URL} open onClose={() => {}} />);
    await screen.findAllByTestId("history-item");
    await act(async () => {
      vi.spyOn(window, "confirm").mockReturnValueOnce(true);
      fireEvent.click(screen.getByText(/清空此 URL/));
    });
    expect((await ss.listArchivedByUrl(URL)).length).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```
pnpm --filter @aipagego/extension test -- --run session-history-drawer
```

Expected: FAIL — module not found。

- [ ] **Step 3: 实现 `session-history-drawer.tsx`**

```tsx
// packages/extension/src/sidepanel/components/session-history-drawer.tsx
import { useEffect, useState } from "react";
import type { PersistedSession } from "@aipagego/shared/types";
import * as ss from "@/sidepanel/chat/persistence/sessions-storage";
import { rehydrateFromPersisted, useStore } from "@/sidepanel/chat/session-store";

function firstUserText(s: PersistedSession): string {
  const m = s.data.messages.find((m) => m.role === "user" && typeof m.content === "string");
  if (!m || typeof m.content !== "string") return "(无文本)";
  return m.content.slice(0, 30) + (m.content.length > 30 ? "…" : "");
}

function ago(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s 前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m 前`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h 前`;
  return `${Math.floor(sec / 86_400)}d 前`;
}

export function SessionHistoryDrawer(props: {
  url: string;
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const [rows, setRows] = useState<PersistedSession[]>([]);
  const tick = useState(0);

  useEffect(() => {
    if (!props.open) return;
    void (async () => {
      const list = await ss.listArchivedByUrl(props.url);
      setRows(list);
    })();
  }, [props.open, props.url, tick[0]]);

  if (!props.open) return null;

  async function refresh() {
    const list = await ss.listArchivedByUrl(props.url);
    setRows(list);
  }

  async function onRestore(target: PersistedSession) {
    const tabId = useStore.getState().currentTabId;
    if (tabId == null) return;
    // 先归档当前 active（如果有）
    const curActive = await ss.getActiveByTabId(tabId);
    if (curActive && curActive.id !== target.id) {
      await ss.archiveActive(curActive.id);
    }
    await ss.restoreArchived(target.id, tabId);
    rehydrateFromPersisted(tabId, target.data);
    await refresh();
    props.onClose();
  }

  async function onDelete(target: PersistedSession) {
    const runId = await ss.deleteOne(target.id);
    if (runId) await ss.cascadeDeleteRuns([runId]);
    await refresh();
  }

  async function onClearAll() {
    if (!confirm(`清空此 URL 的全部历史？（${rows.length} 条）`)) return;
    const runIds = await ss.clearAllForUrl(props.url);
    await ss.cascadeDeleteRuns(runIds);
    await refresh();
  }

  return (
    <div className="fixed inset-0 z-40 flex" onClick={props.onClose}>
      <div className="ml-auto h-full w-80 bg-zinc-900 border-l border-zinc-800 p-3 text-xs overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-zinc-200">历史会话（{rows.length}）</span>
          <button onClick={props.onClose} className="text-zinc-400">✕</button>
        </div>
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} data-testid="history-item" className="border border-zinc-800 rounded p-2">
              <div className="text-zinc-200 truncate">{firstUserText(r)}</div>
              <div className="text-zinc-500 flex justify-between mt-1">
                <span>{r.data.messages.length} 条 · {ago(r.updatedAt)}</span>
                <div className="flex gap-2">
                  <button onClick={() => void onRestore(r)} className="text-emerald-400">恢复</button>
                  <button onClick={() => void onDelete(r)} className="text-red-400">删除</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
        {rows.length > 0 && (
          <button
            onClick={() => void onClearAll()}
            className="mt-3 w-full px-2 py-1 bg-red-800 rounded text-zinc-100"
          >
            清空此 URL 历史
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试验证通过**

```
pnpm --filter @aipagego/extension test -- --run session-history-drawer
```

Expected: PASS（4 tests）。

- [ ] **Step 5: Commit**

```
git add packages/extension/src/sidepanel/components/session-history-drawer.tsx \
        packages/extension/tests/sidepanel/components/session-history-drawer.test.tsx
git commit -m "feat(ui): SessionHistoryDrawer component"
```

---

## Task 11: 串到 `app.tsx` + `chat-page.tsx`

**Files:**
- Modify: `packages/extension/src/sidepanel/app.tsx`
- Modify: `packages/extension/src/sidepanel/pages/chat-page.tsx`
- Test: `packages/extension/tests/sidepanel/app.boot.test.tsx`（boot 集成测试）

- [ ] **Step 1: 加 boot 集成测试**

```tsx
// packages/extension/tests/sidepanel/app.boot.test.tsx
import { render } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";
import * as ss from "@/sidepanel/chat/persistence/sessions-storage";
import { App } from "@/sidepanel/app";
import { useStore } from "@/sidepanel/chat/session-store";

const URL = "https://example.com";

describe("App boot", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
    useStore.setState({ sessionsByTab: {}, currentTabId: null });
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 7, url: URL }]),
        getCurrent: vi.fn().mockResolvedValue({ id: 7, url: URL }),
        get: vi.fn().mockResolvedValue({ id: 7, url: URL }),
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } }
    });
  });

  it("on boot, when tabId matches active session, rehydrates", async () => {
    await ss.putSession({
      id: "x",
      url: URL,
      lastTabId: 7,
      status: "active",
      data: {
        messages: [{ role: "user", content: "rehydrated" }],
        cards: [],
        executedSteps: [],
        tokenUsage: { input: 0, output: 0 },
        roundCount: 0,
        attachedTabs: [],
        url: URL,
        runRecordId: null,
        errorMessage: null
      },
      createdAt: 0,
      updatedAt: 0
    });
    render(<App />);
    // wait for async hydrate
    await new Promise((r) => setTimeout(r, 10));
    expect(useStore.getState().sessionsByTab[7]?.messages.length).toBe(1);
  });
});
```

- [ ] **Step 2: 改 `app.tsx`**

完整新版（注意 `useClosedSessionsPruner` 已在 Task 4 / 5 删除，本步骤补回 hydrate + auto-persist + url banner）：

```tsx
import { useEffect, useState } from "react";
import { hydrateOnBoot, type HydrateResult } from "./chat/persistence/hydrate";
import { installAutoPersist } from "./chat/persistence/auto-persist";
import { validateAttachedTabs, useStore } from "./chat/session-store";
import { installTabTracker } from "./chat/tab-tracker";
import { TabInfoBar } from "./components/tab-info-bar";
import { UrlRecoveryBanner } from "./components/url-recovery-banner";
import { SessionHistoryDrawer } from "./components/session-history-drawer";
import { ChatPage } from "./pages/chat-page";
import { CoordinatorSettingsPage } from "./pages/coordinator-settings-page";
import { RunPage } from "./pages/run-page";
import { SettingsPage } from "./pages/settings-page";
import { ToolDetailPage } from "./pages/tool-detail-page";
import { ToolsPage } from "./pages/tools-page";

// Route 类型保持原样

export function App() {
  const [route, setRoute] = useState<Route>({ name: "chat" });
  const [hydrate, setHydrate] = useState<HydrateResult | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const currentTabId = useStore((s) => s.currentTabId);
  const currentUrl = useStore((s) => (s.currentTabId != null ? s.sessionsByTab[s.currentTabId]?.url ?? "" : ""));

  useEffect(() => {
    const off = installTabTracker();
    return () => off();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const tabs = await chrome.tabs.query({});
        const known = new Set(tabs.map((t) => t.id).filter((id): id is number => id != null));
        validateAttachedTabs(known);
      } catch { /* test env */ }
    })();
  }, []);

  // boot: hydrate persistence —— sidepanel 不是 tab，不能用 chrome.tabs.getCurrent；
  // 等 installTabTracker() 把 currentTabId 写进 store 后再走 hydrate。
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;

    async function tryHydrate(): Promise<boolean> {
      const state = useStore.getState();
      const tabId = state.currentTabId;
      if (tabId == null) return false;
      const url = state.sessionsByTab[tabId]?.url ?? "";
      if (!url) return false;
      const result = await hydrateOnBoot(tabId, url);
      if (!cancelled) setHydrate(result);
      return true;
    }

    void tryHydrate().then((ok) => {
      if (ok || cancelled) return;
      // 还没就绪，订阅 store 等 currentTabId 被设置
      unsub = useStore.subscribe((s) => {
        if (s.currentTabId != null) {
          unsub?.();
          unsub = null;
          void tryHydrate();
        }
      });
    });

    // auto-persist 永远在背景跑
    const offPersist = installAutoPersist();

    return () => {
      cancelled = true;
      unsub?.();
      offPersist();
    };
  }, []);

  // ... fixWithAi / openTool / runPromptTool 保持原样 ...

  return (
    <div className="h-full flex flex-col">
      <nav className="flex gap-1 p-2 border-b border-zinc-800 text-xs">
        {/* 原 NavBtn 不变 */}
      </nav>
      {route.name === "chat" && (
        <>
          {hydrate?.kind === "url-candidates" && (
            <UrlRecoveryBanner
              candidates={hydrate.candidates}
              onOpenDrawer={() => setDrawerOpen(true)}
              onDismiss={() => setHydrate({ kind: "empty" })}
            />
          )}
          <TabInfoBar />
        </>
      )}
      <main className="flex-1 overflow-hidden">
        {route.name === "chat" && (
          <ChatPage
            // ... 原 props，附加：
            onOpenHistory={() => setDrawerOpen(true)}
          />
        )}
        {/* 其它 route 同前 */}
      </main>
      <SessionHistoryDrawer
        url={currentUrl}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
}
```

完整 paste 时保留原 NavBtn / Route 类型 / fixWithAi 等代码。

- [ ] **Step 3: 改 `chat-page.tsx` — 顶上加 ➕ 与 ≡ 按钮**

在文件顶部加 import：

```tsx
import { startNewSession, useStore } from "../chat/session-store";
import {
  archiveActive,
  cascadeDeleteRuns,
  getActiveByTabId,
  pruneOverLimit
} from "../chat/persistence/sessions-storage";
import { flushAllPending } from "../chat/persistence/auto-persist";
```

在 `ChatPageProps` 类型（或 inline props）加：

```tsx
onOpenHistory: () => void;
```

在 chat-page 组件渲染区最顶部（第一个 `<div>` 内、其它 toolbar 之前）插入：

```tsx
<div className="flex items-center gap-2 p-2 border-b border-zinc-800 text-xs">
  <button
    onClick={async () => {
      const tabId = useStore.getState().currentTabId;
      if (tabId == null) return;
      // 先把 auto-persist 的 pending 写 flush 到 IDB，确保 active 行最新
      await flushAllPending();
      const cur = await getActiveByTabId(tabId);
      if (cur) {
        await archiveActive(cur.id);
        const evicted = await pruneOverLimit(cur.url);
        if (evicted.length) await cascadeDeleteRuns(evicted);
      }
      // 再 reset zustand（auto-persist 看到空 session 不会写新行，直到下一次发消息）
      startNewSession(tabId);
    }}
    className="px-2 py-0.5 bg-zinc-800 rounded"
  >
    ➕ 新建会话
  </button>
  <button onClick={props.onOpenHistory} className="px-2 py-0.5 bg-zinc-800 rounded">
    ≡ 历史
  </button>
</div>
```

注意顺序：先 `flushAllPending` 把可能在 debounce 中的 mutation 落盘 → 再 `archiveActive` 切 status → 再 `startNewSession` 清 zustand（之后 auto-persist 不会再写这个空 session，因为 auto-persist 跳过 `messages.length===0 && cards.length===0`）。

App.tsx 调用 `<ChatPage>` 时已经传入 `onOpenHistory={() => setDrawerOpen(true)}`（见 Step 2）。

- [ ] **Step 4: 加单元测试覆盖"新建会话"按钮**

在 `tests/sidepanel/pages/chat-page.test.tsx`（如不存在则新建）加：

```tsx
it("➕ 新建会话 archives current active row + resets zustand", async () => {
  // setup: ensure an active row exists for tabId=7
  await ss.putSession({
    id: "cur",
    url: URL,
    lastTabId: 7,
    status: "active",
    data: { /* one user message */ ...EMPTY_DATA, messages: [{ role: "user", content: "old" }] },
    createdAt: 0,
    updatedAt: 0
  });
  useStore.setState({
    sessionsByTab: {
      7: { tabId: 7, url: URL, messages: [{ role: "user", content: "old" }], /* ...filled */ } as any
    },
    currentTabId: 7
  });

  render(<ChatPage onOpenHistory={() => {}} /* 其它必填 props */ />);
  await act(async () => {
    fireEvent.click(screen.getByText("➕ 新建会话"));
  });
  expect((await ss.getById("cur"))?.status).toBe("archived");
  expect(useStore.getState().sessionsByTab[7].messages.length).toBe(0);
});
```

- [ ] **Step 5: 运行测试 + typecheck**

```
pnpm --filter @aipagego/extension typecheck
pnpm --filter @aipagego/extension test
```

Expected: 全 PASS。

- [ ] **Step 6: Commit**

```
git add packages/extension/src/sidepanel/app.tsx \
        packages/extension/src/sidepanel/pages/chat-page.tsx \
        packages/extension/tests/sidepanel/app.boot.test.tsx \
        packages/extension/tests/sidepanel/pages/chat-page.test.tsx
git commit -m "feat(sidepanel): wire persistence — hydrate on boot, ➕ 新建会话, ≡ 历史"
```

---

## Task 12: README 索引 + 手测 + 收尾

**Files:**
- Modify: `docs/superpowers/plans/README.md`

- [ ] **Step 1: 加 plan 索引条目**

```
grep -n "2026-05-15" docs/superpowers/plans/README.md
```

参照现有条目格式加一行指向本 plan。

- [ ] **Step 2: 手测清单（每条测完打勾）**

按 spec §7.2 跑：

- [ ] sidepanel 内多次 reload → 当前会话保留
- [ ] 浏览器整个关掉重开 → 同 URL banner 出现，恢复后消息齐全
- [ ] 关 tab 后 reopen 同 URL 新 tab → banner 出现
- [ ] 单 URL 连续新建 25 个会话 → IDB 中只剩 20 条 archived（最老 5 条被 evict、对应 runs 也删了）。在 DevTools → Application → IndexedDB → aipagego 看 chat_sessions 行数确认
- [ ] 流式中途关 sidepanel → 重开后该会话 status 是 aborted、可以重发
- [ ] 恢复一个 attachedTabs 里 tab 已关的会话 → 系统消息提示 + 列表里那个 tab 消失
- [ ] history drawer "清空此 URL 历史" → 全清

- [ ] **Step 3: Commit + ship**

按照 [`ship-release`](../../../AGENTS.md) 流程发版。注意根 `package.json` bump（CI 自动注入扩展 package.json）。

```
git add docs/superpowers/plans/README.md
git commit -m "docs(plan): index 2026-05-19 sidepanel session persistence"
```

---

## 验收条件

1. `pnpm typecheck` + `pnpm test` 全过；总测试数较改前增加 ≥20（11 sessions-storage + 5 auto-persist + 4 hydrate + 3 tab-close-archiver + 5 url-recovery + 4 drawer + 2 store new methods + 1 boot integration ≈ 35）
2. 旧 `closed-sessions-pruner.ts` / `closed-sessions-banner.tsx` 文件与对应测试已删除
3. IDB DevTools 能看到 `aipagego` DB v2 + `chat_sessions` store
4. 手测清单 7 项全部通过
5. 关 sidepanel 后再开 sidepanel：当前 tab 的会话原样恢复（仅 status / streamingAssistantText 等瞬时字段重置）
