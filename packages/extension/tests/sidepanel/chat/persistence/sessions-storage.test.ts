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
    await ss.putSessionData("a", newData, 9, URL);
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
    expect(remaining.map((s) => s.id).sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `s${i + 2}`).sort()
    );
    expect(evictedRunIds.length).toBe(0);
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
