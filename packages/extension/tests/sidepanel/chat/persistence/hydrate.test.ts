import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";
import * as ss from "@/sidepanel/chat/persistence/sessions-storage";
import { ensureSession, useStore } from "@/sidepanel/chat/session-store";
import { hydrateOnBoot } from "@/sidepanel/chat/persistence/hydrate";
import { _resetAutoPersistForTests } from "@/sidepanel/chat/persistence/auto-persist";
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
    _resetAutoPersistForTests();
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

  it("scenario 2: url match without tabId → returns candidates sorted by updatedAt desc", async () => {
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

  it("scenario 1b: tabId active but url mismatch → treated as scenario 2 or 3", async () => {
    await ss.putSession(
      makeRow({
        lastTabId: 7,
        status: "active",
        url: "https://different.com"
      })
    );
    const result = await hydrateOnBoot(7, URL);
    // No url match either (the archived session is for a different URL), so empty
    expect(result.kind).toBe("empty");
  });

  it("IDB error falls back to empty", async () => {
    vi.spyOn(ss, "getActiveByTabId").mockRejectedValueOnce(new Error("idb down"));
    const result = await hydrateOnBoot(7, URL);
    expect(result.kind).toBe("empty");
    vi.restoreAllMocks();
  });

  it("scenario 1: after rehydrate, next mutation updates the same persistedId row", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { installAutoPersist, flushAllPending } = await import("@/sidepanel/chat/persistence/auto-persist");

    await ss.putSession(makeRow({
      id: "rehy",
      lastTabId: 7,
      status: "active",
      data: { ...EMPTY_DATA, messages: [{ role: "user", content: "hi" }] }
    }));
    ensureSession(7, URL);
    await hydrateOnBoot(7, URL);

    // Now install auto-persist and mutate
    const off = installAutoPersist();
    useStore.setState((state) => ({
      ...state,
      currentTabId: 7,
      sessionsByTab: {
        ...state.sessionsByTab,
        7: {
          ...state.sessionsByTab[7],
          messages: [
            ...state.sessionsByTab[7].messages,
            { role: "user" as const, content: "more" }
          ]
        }
      }
    }));
    await flushAllPending();

    const got = await ss.getById("rehy");
    expect(got?.data.messages.length).toBe(2);
    off();
    vi.useRealTimers();
  });
});
