import { beforeEach, describe, expect, it } from "vitest";
import {
  addLlmExchange,
  appendUserMessage,
  attachTab,
  detachTab,
  ensureSession,
  getSessionActions,
  getSessionFor,
  markAttachedUrlChanged,
  MAX_EXCHANGES,
  rehydrateFromPersisted,
  removeAttachedTab,
  resetSession,
  setCurrentTab,
  setDebugBadge,
  setInputDraft,
  setPermissionMode,
  setUrl,
  startNewSession,
  useStore,
  validateAttachedTabs
} from "@/sidepanel/chat/session-store";
import type { LlmExchange } from "@aipagego/shared/types";

function reset() {
  useStore.setState({ sessionsByTab: {}, currentTabId: null });
}

describe("session-store per-tab", () => {
  beforeEach(reset);

  it("makeEmptySession seeds an empty attachedTabs list", () => {
    ensureSession(7, "https://x.com");
    const s = getSessionFor(7);
    expect(s.attachedTabs).toEqual([]);
  });

  it("ensureSession creates empty SessionData and is idempotent", () => {
    ensureSession(7, "https://x.com");
    const s = getSessionFor(7);
    expect(s.tabId).toBe(7);
    expect(s.url).toBe("https://x.com");
    expect(s.messages).toEqual([]);

    appendUserMessage(7, "hi");
    ensureSession(7, "https://x.com");
    expect(getSessionFor(7).messages).toHaveLength(1);
  });

  it("appendUserMessage targets only the given tab", () => {
    ensureSession(1, "");
    ensureSession(2, "");
    appendUserMessage(1, "in tab 1");
    expect(getSessionFor(1).messages).toHaveLength(1);
    expect(getSessionFor(2).messages).toHaveLength(0);
  });

  it("setCurrentTab does not touch sessionsByTab", () => {
    ensureSession(5, "u");
    appendUserMessage(5, "x");
    setCurrentTab(5);
    expect(useStore.getState().currentTabId).toBe(5);
    expect(getSessionFor(5).messages).toHaveLength(1);
  });

  it("tab-bound actions keep targeting the captured tab after the current tab changes", () => {
    ensureSession(1, "https://one.example");
    ensureSession(2, "https://two.example");
    setCurrentTab(1);
    const runSession = getSessionActions(1);

    setCurrentTab(2);
    runSession.upsertCard({
      toolUseId: "call_1",
      name: "createPageIndex",
      input: {},
      inputReady: true,
      status: "awaiting",
    });
    runSession.setCardStatus("call_1", { status: "ok", output: { indexId: "idx-1" } });
    runSession.pushExecutedStep({ kind: "tool", tool: "createPageIndex", args: {} });

    expect(getSessionFor(1).cards[0]).toMatchObject({
      toolUseId: "call_1",
      status: "ok",
      output: { indexId: "idx-1" },
    });
    expect(getSessionFor(1).executedSteps).toHaveLength(1);
    expect(getSessionFor(2).cards).toEqual([]);
    expect(getSessionFor(2).executedSteps).toEqual([]);
  });

  it("setUrl updates only the target tab url", () => {
    ensureSession(1, "a");
    ensureSession(2, "b");
    setUrl(1, "a2");
    expect(getSessionFor(1).url).toBe("a2");
    expect(getSessionFor(2).url).toBe("b");
  });

  it("setInputDraft scopes to tab", () => {
    ensureSession(1, "");
    ensureSession(2, "");
    setInputDraft(1, "draft1");
    expect(getSessionFor(1).inputDraft).toBe("draft1");
    expect(getSessionFor(2).inputDraft).toBe("");
  });

  it("resetSession keeps url but clears messages and counters", () => {
    ensureSession(1, "u");
    appendUserMessage(1, "x");
    resetSession(1);
    const s = getSessionFor(1);
    expect(s.messages).toHaveLength(0);
    expect(s.url).toBe("u");
    expect(s.status).toBe("idle");
  });
});

describe("attachedTabs actions", () => {
  beforeEach(reset);

  it("attachTab adds a tab with given source and metadata", () => {
    ensureSession(7, "https://main");
    attachTab(7, {
      tabId: 167,
      windowId: 1,
      source: "mention",
      lastSeenUrl: "https://taobao",
      lastSeenTitle: "TB"
    });
    const a = getSessionFor(7).attachedTabs;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      tabId: 167,
      source: "mention",
      lastSeenUrl: "https://taobao",
      lastSeenTitle: "TB"
    });
    expect(typeof a[0].addedAt).toBe("number");
  });

  it("attachTab on same tabId keeps first source", () => {
    ensureSession(7, "https://main");
    attachTab(7, { tabId: 167, windowId: 1, source: "mention", lastSeenUrl: "u1", lastSeenTitle: "t1" });
    attachTab(7, { tabId: 167, windowId: 1, source: "ai-open", lastSeenUrl: "u2", lastSeenTitle: "t2" });
    const a = getSessionFor(7).attachedTabs;
    expect(a).toHaveLength(1);
    expect(a[0].source).toBe("mention");
    expect(a[0].lastSeenUrl).toBe("u1");
  });

  it("detachTab removes by tabId", () => {
    ensureSession(7, "https://main");
    attachTab(7, { tabId: 167, windowId: 1, source: "mention", lastSeenUrl: "u", lastSeenTitle: "t" });
    detachTab(7, 167);
    expect(getSessionFor(7).attachedTabs).toEqual([]);
  });

  it("markAttachedUrlChanged sets urlChanged and updates lastSeenUrl/Title", () => {
    ensureSession(7, "https://main");
    attachTab(7, { tabId: 167, windowId: 1, source: "mention", lastSeenUrl: "u1", lastSeenTitle: "t1" });
    markAttachedUrlChanged(7, 167, "u2", "t2");
    const a = getSessionFor(7).attachedTabs[0];
    expect(a.urlChanged).toBe(true);
    expect(a.lastSeenUrl).toBe("u2");
    expect(a.lastSeenTitle).toBe("t2");
  });

  it("removeAttachedTab affects every session that holds it", () => {
    ensureSession(7, "https://a");
    ensureSession(8, "https://b");
    attachTab(7, { tabId: 167, windowId: 1, source: "mention", lastSeenUrl: "u", lastSeenTitle: "t" });
    attachTab(8, { tabId: 167, windowId: 1, source: "approval", lastSeenUrl: "u", lastSeenTitle: "t" });
    removeAttachedTab(167);
    expect(getSessionFor(7).attachedTabs).toEqual([]);
    expect(getSessionFor(8).attachedTabs).toEqual([]);
  });
});

describe("validateAttachedTabs", () => {
  beforeEach(reset);
  it("removes attached tabs not in known set", () => {
    ensureSession(7, "https://x");
    attachTab(7, { tabId: 100, windowId: 1, source: "mention", lastSeenUrl: "u", lastSeenTitle: "t" });
    attachTab(7, { tabId: 200, windowId: 1, source: "mention", lastSeenUrl: "u", lastSeenTitle: "t" });
    validateAttachedTabs(new Set([100]));
    expect(getSessionFor(7).attachedTabs.map((a) => a.tabId)).toEqual([100]);
  });

  it("is a no-op when nothing changes", () => {
    ensureSession(7, "https://x");
    attachTab(7, { tabId: 100, windowId: 1, source: "mention", lastSeenUrl: "u", lastSeenTitle: "t" });
    const before = getSessionFor(7);
    validateAttachedTabs(new Set([100]));
    const after = getSessionFor(7);
    expect(after).toBe(before);
  });
});

describe("session-store persistence-aware methods", () => {
  beforeEach(reset);

  it("startNewSession returns the archived session and resets sessionsByTab[tabId]", () => {
    ensureSession(7, "https://x.com");
    useStore.setState((state) => ({
      ...state,
      sessionsByTab: {
        ...state.sessionsByTab,
        7: { ...state.sessionsByTab[7], messages: [{ role: "user", content: "hello" }] }
      }
    }));
    expect(useStore.getState().sessionsByTab[7].messages.length).toBe(1);

    const archivedData = startNewSession(7);
    expect(archivedData?.messages.length).toBe(1);
    expect(useStore.getState().sessionsByTab[7].messages.length).toBe(0);
    expect(useStore.getState().sessionsByTab[7].url).toBe("https://x.com");
  });

  it("startNewSession on a missing tab is a no-op (returns null)", () => {
    const result = startNewSession(999);
    expect(result).toBeNull();
  });

  it("rehydrateFromPersisted overwrites sessionsByTab[tabId] preserving tabId", () => {
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
      errorMessage: null,
      llmExchanges: []
    });
    const s = useStore.getState().sessionsByTab[7];
    expect(s.tabId).toBe(7);
    expect(s.messages.length).toBe(1);
    expect(s.roundCount).toBe(1);
    expect(s.status).toBe("idle");
    expect(s.abortController).toBeNull();
  });

  it("rehydrateFromPersisted sanitizes any stale streaming/running status to idle", () => {
    ensureSession(7, "https://x.com");
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
      errorMessage: null,
      llmExchanges: []
    });
    expect(useStore.getState().sessionsByTab[7].status).toBe("idle");
  });
});

describe("llmExchanges", () => {
  beforeEach(reset);

  function makeExchange(round: number): LlmExchange {
    return {
      id: `ex-${round}`,
      round,
      kind: "main",
      startedAt: 0,
      durationMs: 1,
      request: { provider: "anthropic", model: "m", system: "s", messages: [], toolNames: [] },
      response: { text: "t", toolUses: [] }
    };
  }

  it("appends exchanges to the session", () => {
    ensureSession(1, "u");
    addLlmExchange(1, makeExchange(0));
    addLlmExchange(1, makeExchange(1));
    expect(getSessionFor(1).llmExchanges.map((e) => e.round)).toEqual([0, 1]);
  });

  it("caps retained exchanges at MAX_EXCHANGES (FIFO)", () => {
    ensureSession(2, "u");
    for (let i = 0; i < MAX_EXCHANGES + 5; i++) addLlmExchange(2, makeExchange(i));
    const got = getSessionFor(2).llmExchanges;
    expect(got.length).toBe(MAX_EXCHANGES);
    expect(got[0].round).toBe(5);
    expect(got[got.length - 1].round).toBe(MAX_EXCHANGES + 4);
  });

  it("rehydrate restores llmExchanges (defaults to [] when absent)", () => {
    rehydrateFromPersisted(3, {
      messages: [],
      cards: [],
      executedSteps: [],
      tokenUsage: { input: 0, output: 0 },
      roundCount: 0,
      attachedTabs: [],
      url: "u",
      runRecordId: null,
      errorMessage: null,
      llmExchanges: [makeExchange(7)]
    });
    expect(getSessionFor(3).llmExchanges.map((e) => e.round)).toEqual([7]);
  });
});

describe("session-store permissionMode + debugBadge", () => {
  beforeEach(reset);

  it("makeEmptySession seeds default permission mode and null badge", () => {
    ensureSession(99, "https://example.com");
    const s = getSessionFor(99);
    expect(s.permissionMode).toBe("default");
    expect(s.debugBadge).toBeNull();
  });

  it("setPermissionMode flips the per-session mode", () => {
    ensureSession(100, "https://example.com");
    setPermissionMode(100, "yolo");
    expect(getSessionFor(100).permissionMode).toBe("yolo");
    setPermissionMode(100, "read");
    expect(getSessionFor(100).permissionMode).toBe("read");
  });

  it("setDebugBadge sets and clears", () => {
    ensureSession(101, "https://example.com");
    setDebugBadge(101, { kind: "error", count: 1 });
    expect(getSessionFor(101).debugBadge).toEqual({ kind: "error", count: 1 });
    setDebugBadge(101, null);
    expect(getSessionFor(101).debugBadge).toBeNull();
  });
});
