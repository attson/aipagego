import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recipe = {
  version: 1 as const,
  mode: "list" as const,
  itemSelector: ".item",
  fields: [
    { id: "title", name: "标题", selector: ".title", valueMode: "text" as const, required: true },
    { id: "sku", name: "SKU", selector: ".sku", valueMode: "text" as const, required: false },
  ],
  pagination: { kind: "single" as const },
  dedupeBy: ["title", "sku"],
  maxRows: 2_000,
  maxBytes: 5 * 1024 * 1024,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function stubChrome(extract: () => Promise<unknown>) {
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: vi.fn(() => ({ content_scripts: [{ js: ["assets/bootstrap.js"] }] })),
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: vi.fn() },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: "https://example.com/products" })),
      sendMessage: vi.fn(async (_tabId: number, request: { type?: string }) => {
        if (request.type === "content.collectionExtractPage") {
          return { ok: true, data: await extract() };
        }
        throw new Error(`unexpected content request: ${request.type}`);
      }),
    },
    scripting: { executeScript: vi.fn() },
    storage: {
      local: {
        get: vi.fn(async () => ({
          "aipagego.llm": {
            defaultInjectionMode: "read",
            defaultAssistantEnabled: true,
            siteInjectionRules: [],
          },
        })),
      },
      session: { get: vi.fn(async () => ({})) },
    },
  });
}

async function waitForCompleted(handleRpc: (request: unknown) => Promise<any>, runId: string) {
  let snapshot: any;
  await vi.waitFor(async () => {
    const response = await handleRpc({ type: "collections.runs.get", runId });
    expect(response.ok).toBe(true);
    snapshot = response.data;
    expect(snapshot.status).not.toBe("running");
  });
  return snapshot;
}

describe("collection run RPC", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    globalThis.indexedDB = new IDBFactory();
  });

  it("keeps full single-page rows in IDB and exposes only a bounded summary elsewhere", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      values: { title: index === 6 ? null : `商品 ${index}`, sku: `SKU-${index}` },
      missingRequired: index === 6 ? ["title"] : [],
    }));
    rows[7] = { values: { title: "商品 0", sku: "SKU-0" }, missingRequired: [] };
    stubChrome(async () => ({
      rows,
      pageUrl: "https://example.com/products",
      fingerprint: "page-1",
      matchedCount: rows.length,
    }));
    const { handleRpc } = await import("@/background/rpc-handlers");

    const started = await handleRpc({ type: "collections.start", tabId: 73, recipe });
    expect(started).toMatchObject({ ok: true, data: { runId: expect.any(String) } });
    if (!started.ok) throw new Error(started.error);
    const runId = (started.data as { runId: string }).runId;
    const snapshot = await waitForCompleted(handleRpc, runId);

    expect(snapshot).toMatchObject({
      runId,
      tabId: 73,
      status: "completed",
      rowCount: 7,
      pageCount: 1,
      duplicateCount: 1,
      missingRequiredCount: 1,
      summary: { runId, rowCount: 7, pageCount: 1, preview: expect.any(Array) },
    });
    expect(snapshot.summary.preview).toHaveLength(5);
    expect(snapshot).not.toHaveProperty("rows");

    const page = await handleRpc({
      type: "collections.results.read",
      resultId: snapshot.resultId,
      offset: 0,
      limit: 500,
    });
    expect(page).toMatchObject({ ok: true, data: { hasMore: false, nextOffset: null } });
    if (!page.ok) throw new Error(page.error);
    expect((page.data as { rows: unknown[] }).rows).toHaveLength(7);

    const run = await handleRpc({ type: "runs.get", id: runId });
    expect(run).toMatchObject({
      ok: true,
      data: { output: { runId, resultId: snapshot.resultId, preview: expect.any(Array) } },
    });
    if (!run.ok) throw new Error(run.error);
    expect((run.data as { output: { preview: unknown[] } }).output.preview).toHaveLength(5);
    expect(JSON.stringify(run.data)).not.toContain('"rows"');

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "collection.progress",
      runId,
      phase: "completed",
      rowCount: 7,
    }));

    const { pruneCollectionResults } = await import("@/background/storage/collection-results");
    expect(await pruneCollectionResults({ maxCount: 0, maxBytes: 0 })).toEqual([snapshot.resultId]);
    const expired = await handleRpc({ type: "collections.runs.get", runId });
    expect(expired).toMatchObject({
      ok: true,
      data: {
        runId,
        resultId: snapshot.resultId,
        status: "completed",
        resultExpired: true,
        summary: { rowCount: 7 },
      },
    });
    const expiredRows = await handleRpc({
      type: "collections.results.read",
      resultId: snapshot.resultId,
      offset: 0,
      limit: 10,
    });
    expect(expiredRows).toEqual({ ok: false, error: `result_expired: ${snapshot.resultId}` });
  });

  it("rejects a second run on the same tab without replacing the active run", async () => {
    const extraction = deferred<unknown>();
    stubChrome(() => extraction.promise);
    const { handleRpc } = await import("@/background/rpc-handlers");

    const first = await handleRpc({ type: "collections.start", tabId: 73, recipe });
    const second = await handleRpc({ type: "collections.start", tabId: 73, recipe });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: "collection_already_running" });
    if (!first.ok) throw new Error(first.error);
    await vi.waitFor(async () => {
      expect(await handleRpc({
        type: "collections.runs.get",
        runId: (first.data as { runId: string }).runId,
      })).toMatchObject({ ok: true, data: { status: "running", phase: "extracting" } });
    });
    extraction.resolve({
      rows: [],
      pageUrl: "https://example.com/products",
      fingerprint: "page-1",
      matchedCount: 0,
    });
    await waitForCompleted(handleRpc, (first.data as { runId: string }).runId);
  });

  it("cancels idempotently at the page boundary and keeps a partial result", async () => {
    const extraction = deferred<unknown>();
    stubChrome(() => extraction.promise);
    const { handleRpc } = await import("@/background/rpc-handlers");

    const started = await handleRpc({ type: "collections.start", tabId: 73, recipe });
    if (!started.ok) throw new Error(started.error);
    const runId = (started.data as { runId: string }).runId;

    expect(await handleRpc({ type: "collections.cancel", runId })).toEqual({ ok: true, data: null });
    expect(await handleRpc({ type: "collections.cancel", runId })).toEqual({ ok: true, data: null });
    extraction.resolve({
      rows: [{ values: { title: "已抽取但未提交", sku: "SKU-X" }, missingRequired: [] }],
      pageUrl: "https://example.com/products",
      fingerprint: "page-1",
      matchedCount: 1,
    });

    const snapshot = await waitForCompleted(handleRpc, runId);
    expect(snapshot).toMatchObject({
      status: "partial",
      stopReason: "aborted",
      rowCount: 0,
      summary: { status: "partial", stopReason: "aborted", rowCount: 0 },
    });
  });
});
