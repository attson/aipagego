import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recipe = {
  version: 1 as const,
  mode: "list" as const,
  itemSelector: ".item",
  fields: [{ id: "title", name: "标题", selector: ".title", valueMode: "text" as const, required: true }],
  pagination: { kind: "loadMore" as const, selector: ".more", maxPages: 5 },
  dedupeBy: ["title"],
  maxRows: 2_000,
  maxBytes: 5 * 1024 * 1024,
};

function page(index: number) {
  return {
    rows: Array.from({ length: index }, (_, offset) => ({
      values: { title: `P${offset + 1}` },
      missingRequired: [],
    })),
    pageUrl: "https://example.com/list",
    fingerprint: `page-${index}`,
    matchedCount: index,
    duplicateCount: 0,
    truncatedBy: null,
  };
}

describe("collections.start dynamic pagination RPC", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    globalThis.indexedDB = new IDBFactory();
  });

  it("routes load-more through the content primitive and the shared orchestrator", async () => {
    let currentPage = 1;
    const sendMessage = vi.fn(async (tabId: number, request: {
      type?: string;
      action?: { kind?: string; selector?: string };
    }) => {
      expect(tabId).toBe(74);
      if (request.type === "content.collectionAdvanceDynamic") {
        expect(request.action).toEqual({ kind: "loadMore", selector: ".more" });
        if (currentPage === 1) {
          currentPage = 2;
          return { ok: true, data: { status: "clicked" } };
        }
        return { ok: true, data: { status: "missing" } };
      }
      if (request.type === "content.collectionExtractPage") {
        return { ok: true, data: page(currentPage) };
      }
      throw new Error(`unexpected request ${request.type}`);
    });
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: vi.fn(() => ({ content_scripts: [{ js: ["assets/bootstrap.js"] }] })),
        sendMessage: vi.fn(async () => undefined),
        onMessage: { addListener: vi.fn() },
      },
      tabs: {
        get: vi.fn(async () => ({ id: 74, url: "https://example.com/list", status: "complete" })),
        sendMessage,
      },
      scripting: { executeScript: vi.fn(async () => [{ result: null }]) },
      storage: {
        local: { get: vi.fn(async () => ({
          "aipagego.llm": {
            defaultInjectionMode: "operate",
            defaultAssistantEnabled: true,
            siteInjectionRules: [],
          },
        })) },
        session: { get: vi.fn(async () => ({})) },
      },
    });
    const { handleRpc } = await import("@/background/rpc-handlers");

    const started = await handleRpc({ type: "collections.start", tabId: 74, recipe });
    if (!started.ok) throw new Error(started.error);
    const runId = (started.data as { runId: string }).runId;
    let snapshot: any;
    await vi.waitFor(async () => {
      const response = await handleRpc({ type: "collections.runs.get", runId });
      if (!response.ok) throw new Error(response.error);
      snapshot = response.data;
      expect(snapshot.status).not.toBe("running");
    });

    expect(snapshot).toMatchObject({
      status: "partial",
      stopReason: "pagination_missing",
      pageCount: 2,
      rowCount: 2,
      duplicateCount: 1,
    });
  });
});
