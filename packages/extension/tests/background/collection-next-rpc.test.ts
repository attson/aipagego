import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recipe = {
  version: 1 as const,
  mode: "single" as const,
  fields: [{ id: "title", name: "标题", selector: "h1", valueMode: "text" as const, required: true }],
  pagination: { kind: "next" as const, selector: ".next", maxPages: 3 },
  dedupeBy: ["title"],
  maxRows: 2_000,
  maxBytes: 5 * 1024 * 1024,
};

function page(index: number) {
  return {
    rows: [{ values: { title: `P${index}` }, missingRequired: [] }],
    pageUrl: `https://example.com/${index}`,
    fingerprint: `page-${index}`,
    matchedCount: 1,
    duplicateCount: 0,
    truncatedBy: null,
  };
}

describe("collections.start next navigation RPC", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    globalThis.indexedDB = new IDBFactory();
  });

  it("reinjects after normal navigation and continues on the captured tab", async () => {
    let currentPage = 1;
    let receiverMissing = false;
    const sendMessage = vi.fn(async (tabId: number, request: { type?: string }) => {
      expect(tabId).toBe(73);
      if (request.type === "content.collectionAdvanceNext") {
        if (currentPage === 1) {
          currentPage = 2;
          receiverMissing = true;
          return { ok: true, data: { status: "clicked" } };
        }
        return { ok: true, data: { status: "missing" } };
      }
      if (request.type === "content.collectionExtractPage") {
        if (receiverMissing) {
          receiverMissing = false;
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        return { ok: true, data: page(currentPage) };
      }
      throw new Error(`unexpected request ${request.type}`);
    });
    const executeScript = vi.fn(async () => [{ result: null }]);
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: vi.fn(() => ({ content_scripts: [{ js: ["assets/bootstrap.js"] }] })),
        sendMessage: vi.fn(async () => undefined),
        onMessage: { addListener: vi.fn() },
      },
      tabs: {
        get: vi.fn(async () => ({
          id: 73,
          url: `https://example.com/${currentPage}`,
          status: "complete",
        })),
        sendMessage,
      },
      scripting: { executeScript },
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

    const started = await handleRpc({ type: "collections.start", tabId: 73, recipe });
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
    });
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 73 },
      files: ["assets/bootstrap.js"],
    });
  });
});
