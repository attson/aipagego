import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import { _resetDBForTests, getDB } from "@/background/storage/db";

describe("database migrations", () => {
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

  it("upgrades a populated v1 database to v5 without losing tools or runs", async () => {
    const legacy = await openDB("aipagego", 1, {
      upgrade(db) {
        const tools = db.createObjectStore("tools", { keyPath: "id" });
        tools.createIndex("byUpdatedAt", "updatedAt");
        const runs = db.createObjectStore("runs", { keyPath: "id" });
        runs.createIndex("byToolId", "toolId");
        runs.createIndex("byStartedAt", "startedAt");
      },
    });
    await legacy.put("tools", { id: "v1-tool", updatedAt: 1 });
    await legacy.put("runs", { id: "v1-run", toolId: "v1-tool", startedAt: 1 });
    legacy.close();

    const db = await getDB();
    expect(db.version).toBe(5);
    expect((await db.get("tools", "v1-tool"))?.id).toBe("v1-tool");
    expect((await db.get("runs", "v1-run"))?.id).toBe("v1-run");
    expect(db.objectStoreNames.contains("chat_sessions")).toBe(true);
    expect(db.objectStoreNames.contains("collection_results")).toBe(true);
    expect(db.objectStoreNames.contains("jobs")).toBe(true);
    expect(db.objectStoreNames.contains("job_runs")).toBe(true);
    expect(db.objectStoreNames.contains("connectors")).toBe(true);
    expect(db.objectStoreNames.contains("connector_deliveries")).toBe(true);
  });

  it("upgrades a populated v2 database to v5 without replacing legacy stores or data", async () => {
    const legacy = await openDB("aipagego", 2, {
      upgrade(db) {
        const tools = db.createObjectStore("tools", { keyPath: "id" });
        tools.createIndex("byUpdatedAt", "updatedAt");
        const runs = db.createObjectStore("runs", { keyPath: "id" });
        runs.createIndex("byToolId", "toolId");
        runs.createIndex("byStartedAt", "startedAt");
        const sessions = db.createObjectStore("chat_sessions", { keyPath: "id" });
        sessions.createIndex("by_url_status", ["url", "status"]);
        sessions.createIndex("by_lastTabId_status", ["lastTabId", "status"]);
        sessions.createIndex("by_url_updatedAt", ["url", "updatedAt"]);
      },
    });
    await legacy.put("tools", { id: "legacy-tool", updatedAt: 1 });
    await legacy.put("runs", { id: "legacy-run", toolId: null, startedAt: 1 });
    await legacy.put("chat_sessions", {
      id: "legacy-session",
      url: "https://example.com",
      status: "archived",
      lastTabId: 1,
      updatedAt: 1,
    });
    legacy.close();

    const db = await getDB();
    expect(db.version).toBe(5);
    expect(db.name).toBe("aipagego");
    expect(db.objectStoreNames.contains("collection_results")).toBe(true);
    expect(db.objectStoreNames.contains("tools")).toBe(true);
    expect(db.objectStoreNames.contains("runs")).toBe(true);
    expect(db.objectStoreNames.contains("chat_sessions")).toBe(true);
    expect(db.objectStoreNames.contains("jobs")).toBe(true);
    expect(db.objectStoreNames.contains("job_runs")).toBe(true);
    expect(db.objectStoreNames.contains("connectors")).toBe(true);
    expect(db.objectStoreNames.contains("connector_deliveries")).toBe(true);
    const store = db.transaction("collection_results", "readonly").objectStore("collection_results");
    expect(store.indexNames.contains("by_runId")).toBe(true);
    expect(store.indexNames.contains("by_lastAccessedAt")).toBe(true);
    expect((await db.get("tools", "legacy-tool"))?.id).toBe("legacy-tool");
    expect((await db.get("runs", "legacy-run"))?.id).toBe("legacy-run");
    expect((await db.get("chat_sessions", "legacy-session"))?.id).toBe("legacy-session");
  });

  it("creates jobs and job_runs stores with scheduler indexes", async () => {
    const db = await getDB();
    const jobs = db.transaction("jobs", "readonly").objectStore("jobs");
    expect(jobs.indexNames.contains("byStatus")).toBe(true);
    expect(jobs.indexNames.contains("byNextRunAt")).toBe(true);
    expect(jobs.indexNames.contains("byToolId")).toBe(true);
    const runs = db.transaction("job_runs", "readonly").objectStore("job_runs");
    expect(runs.indexNames.contains("byJobIdStartedAt")).toBe(true);
    expect(runs.indexNames.contains("byStatus")).toBe(true);
  });

  it("upgrades a populated v3 database to v5 without losing collection results", async () => {
    const legacy = await openDB("aipagego", 3, {
      upgrade(db) {
        const tools = db.createObjectStore("tools", { keyPath: "id" });
        tools.createIndex("byUpdatedAt", "updatedAt");
        const runs = db.createObjectStore("runs", { keyPath: "id" });
        runs.createIndex("byToolId", "toolId");
        runs.createIndex("byStartedAt", "startedAt");
        const sessions = db.createObjectStore("chat_sessions", { keyPath: "id" });
        sessions.createIndex("by_url_status", ["url", "status"]);
        sessions.createIndex("by_lastTabId_status", ["lastTabId", "status"]);
        sessions.createIndex("by_url_updatedAt", ["url", "updatedAt"]);
        const results = db.createObjectStore("collection_results", { keyPath: "resultId" });
        results.createIndex("by_runId", "runId", { unique: true });
        results.createIndex("by_lastAccessedAt", "lastAccessedAt");
      },
    });
    await legacy.put("collection_results", {
      resultId: "v3-result",
      runId: "v3-run",
      lastAccessedAt: 3,
    });
    legacy.close();

    const db = await getDB();
    expect(db.version).toBe(5);
    expect((await db.get("collection_results", "v3-result"))?.resultId).toBe("v3-result");
    expect(db.objectStoreNames.contains("jobs")).toBe(true);
    expect(db.objectStoreNames.contains("job_runs")).toBe(true);
    expect(db.objectStoreNames.contains("connectors")).toBe(true);
    expect(db.objectStoreNames.contains("connector_deliveries")).toBe(true);
  });

  it("creates connector stores with lookup indexes", async () => {
    const db = await getDB();
    const connectors = db.transaction("connectors", "readonly").objectStore("connectors");
    expect(connectors.indexNames.contains("byKind")).toBe(true);
    expect(connectors.indexNames.contains("byStatus")).toBe(true);
    expect(connectors.indexNames.contains("byUpdatedAt")).toBe(true);
    const deliveries = db.transaction("connector_deliveries", "readonly").objectStore("connector_deliveries");
    expect(deliveries.indexNames.contains("byConnectorCreatedAt")).toBe(true);
    expect(deliveries.indexNames.contains("byStatus")).toBe(true);
    expect(deliveries.indexNames.contains("bySource")).toBe(true);
  });

  it("upgrades a populated v4 database to v5 without rewriting existing stores", async () => {
    const legacy = await openDB("aipagego", 4, {
      upgrade(db) {
        const tools = db.createObjectStore("tools", { keyPath: "id" });
        tools.createIndex("byUpdatedAt", "updatedAt");
        const runs = db.createObjectStore("runs", { keyPath: "id" });
        runs.createIndex("byToolId", "toolId");
        runs.createIndex("byStartedAt", "startedAt");
        const sessions = db.createObjectStore("chat_sessions", { keyPath: "id" });
        sessions.createIndex("by_url_status", ["url", "status"]);
        sessions.createIndex("by_lastTabId_status", ["lastTabId", "status"]);
        sessions.createIndex("by_url_updatedAt", ["url", "updatedAt"]);
        const results = db.createObjectStore("collection_results", { keyPath: "resultId" });
        results.createIndex("by_runId", "runId", { unique: true });
        results.createIndex("by_lastAccessedAt", "lastAccessedAt");
        const jobs = db.createObjectStore("jobs", { keyPath: "id" });
        jobs.createIndex("byStatus", "status");
        jobs.createIndex("byNextRunAt", "nextRunAt");
        jobs.createIndex("byToolId", "toolId");
        const jobRuns = db.createObjectStore("job_runs", { keyPath: "id" });
        jobRuns.createIndex("byJobIdStartedAt", ["jobId", "startedAt"]);
        jobRuns.createIndex("byStatus", "status");
      },
    });
    await legacy.put("tools", { id: "v4-tool", updatedAt: 4 });
    legacy.close();
    const db = await getDB();
    expect(db.version).toBe(5);
    expect((await db.get("tools", "v4-tool"))?.id).toBe("v4-tool");
    expect(db.objectStoreNames.contains("connectors")).toBe(true);
    expect(db.objectStoreNames.contains("connector_deliveries")).toBe(true);
  });
});
