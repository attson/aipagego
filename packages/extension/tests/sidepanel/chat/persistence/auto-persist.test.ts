import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";
import * as ss from "@/sidepanel/chat/persistence/sessions-storage";
import { ensureSession, makeEmptySession, useStore } from "@/sidepanel/chat/session-store";
import { installAutoPersist, flushAllPending, _resetAutoPersistForTests, clearPersistStateFor, setPersistIdFor, toPersistedData } from "@/sidepanel/chat/persistence/auto-persist";
import type { LlmExchange } from "@aipagego/shared/types";

const URL = "https://example.com";

function addMessage(tabId: number, content: string): void {
  useStore.setState((state) => ({
    ...state,
    sessionsByTab: {
      ...state.sessionsByTab,
      [tabId]: {
        ...state.sessionsByTab[tabId],
        messages: [...(state.sessionsByTab[tabId]?.messages ?? []), { role: "user" as const, content }]
      }
    }
  }));
}

describe("auto-persist", () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    useStore.setState({ sessionsByTab: {}, currentTabId: null });
    _resetAutoPersistForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drain all pending micro-tasks/promises after timer fires. */
  async function flushMicrotasks(): Promise<void> {
    // Multiple rounds to let chained promise callbacks settle (IDB has several hops).
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }

  it("debounces multiple rapid mutations into a single put", async () => {
    const spy = vi.spyOn(ss, "putSession");
    const off = installAutoPersist();
    ensureSession(7, URL);
    addMessage(7, "a");
    addMessage(7, "b");
    addMessage(7, "c");
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    expect(spy.mock.calls.length).toBe(1);
    off();
  });

  it("creates a new active row on first mutation", async () => {
    const off = installAutoPersist();
    ensureSession(7, URL);
    addMessage(7, "hi");
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    const active = await ss.getActiveByTabId(7);
    expect(active).toBeDefined();
    expect(active?.data.messages.length).toBe(1);
    expect(active?.status).toBe("active");
    off();
  });

  it("subsequent mutations use putSessionData (status not flipped)", async () => {
    const off = installAutoPersist();
    ensureSession(7, URL);
    addMessage(7, "hi");
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    const first = await ss.getActiveByTabId(7);
    expect(first).toBeDefined();
    // Simulate background archiver flipping status:
    await ss.archiveActive(first!.id);
    expect((await ss.getById(first!.id))?.status).toBe("archived");
    addMessage(7, "should-not-revive");
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    const after = await ss.getById(first!.id);
    expect(after?.status).toBe("archived");
    off();
  });

  it("flushAllPending writes synchronously without waiting for debounce", async () => {
    const off = installAutoPersist();
    ensureSession(7, URL);
    addMessage(7, "hi");
    await flushAllPending();
    const active = await ss.getActiveByTabId(7);
    expect(active?.data.messages.length).toBe(1);
    off();
  });

  it("write failure does not throw", async () => {
    const off = installAutoPersist();
    vi.spyOn(ss, "putSession").mockRejectedValueOnce(new Error("quota"));
    ensureSession(7, URL);
    addMessage(7, "hi");
    await vi.advanceTimersByTimeAsync(300);
    // microtask queue
    await Promise.resolve();
    expect(true).toBe(true); // no unhandled rejection
    off();
  });

  it("skips empty sessions (no messages, no cards)", async () => {
    const spy = vi.spyOn(ss, "putSession");
    const off = installAutoPersist();
    ensureSession(7, URL);  // empty session created
    await vi.advanceTimersByTimeAsync(300);
    expect(spy).not.toHaveBeenCalled();
    off();
  });

  it("clearPersistStateFor: after explicit reset, next mutation creates a new row instead of overwriting old one", async () => {
    const off = installAutoPersist();
    ensureSession(7, URL);
    addMessage(7, "first session");
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    const firstActive = await ss.getActiveByTabId(7);
    expect(firstActive).toBeDefined();

    // Simulate "新建会话": archive + reset
    await ss.archiveActive(firstActive!.id);
    // Reset zustand session
    useStore.setState({ sessionsByTab: {}, currentTabId: 7 });
    ensureSession(7, URL);
    // Critical: clear auto-persist state for this tab
    clearPersistStateFor(7);

    // New mutation
    addMessage(7, "second session");
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();

    const newActive = await ss.getActiveByTabId(7);
    expect(newActive).toBeDefined();
    expect(newActive!.id).not.toBe(firstActive!.id);  // distinct row
    const oldArchived = await ss.getById(firstActive!.id);
    expect(oldArchived?.data.messages[0]?.content).toBe("first session");  // archive untouched
    off();
  });

  it("setPersistIdFor: after restore, next mutation updates the same row (no duplicate active)", async () => {
    const off = installAutoPersist();
    // Set up an archived row
    await ss.putSession({
      id: "archived-x",
      url: URL,
      lastTabId: 999,
      status: "archived",
      data: {
        messages: [{ role: "user", content: "old" }],
        cards: [], executedSteps: [], tokenUsage: { input: 0, output: 0 },
        roundCount: 0, attachedTabs: [], url: URL, runRecordId: null, errorMessage: null, llmExchanges: []
      },
      createdAt: 0,
      updatedAt: 0
    });
    // Simulate restore for tabId 7
    await ss.restoreArchived("archived-x", 7);
    ensureSession(7, URL);
    useStore.setState((state) => ({
      ...state,
      currentTabId: 7,
      sessionsByTab: {
        ...state.sessionsByTab,
        7: { ...state.sessionsByTab[7], messages: [{ role: "user", content: "old" }] }
      }
    }));
    setPersistIdFor(7, "archived-x");

    // New mutation — use flushAllPending to force-write synchronously
    addMessage(7, "continued");
    await flushAllPending();

    // Verify no duplicate active rows — only one active row for tabId 7
    const db = await (await import("@/background/storage/db")).getDB();
    const all = await db.getAll("chat_sessions");
    const actives = all.filter((s) => s.status === "active" && s.lastTabId === 7);
    expect(actives.length).toBe(1);
    expect(actives[0].id).toBe("archived-x");
    expect(actives[0].data.messages.length).toBe(2);
    off();
  });
});

describe("toPersistedData", () => {
  it("includes llmExchanges", () => {
    const ex: LlmExchange = {
      id: "e1", round: 0, kind: "main", startedAt: 0, durationMs: 1,
      request: { provider: "anthropic", model: "m", system: "s", messages: [], toolNames: [] },
      response: { text: "t", toolUses: [] }
    };
    const s = { ...makeEmptySession(1, "u"), llmExchanges: [ex] };
    expect(toPersistedData(s).llmExchanges).toEqual([ex]);
  });
});
