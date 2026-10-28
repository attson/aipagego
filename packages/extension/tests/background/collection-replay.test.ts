import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const llmBridgeMocks = vi.hoisted(() => ({ requestSidepanelLlm: vi.fn() }));
vi.mock("@/background/self-heal-bridge", () => llmBridgeMocks);

const recipe = {
  version: 1 as const,
  mode: "list" as const,
  itemSelector: ".item",
  fields: [
    { id: "title", name: "标题", selector: ".title", valueMode: "text" as const, required: true },
  ],
  pagination: { kind: "single" as const },
  dedupeBy: ["title"],
  maxRows: 2_000,
  maxBytes: 5 * 1024 * 1024,
};

function installChrome(extraction: { ok: true; data: unknown } | { ok: false; error: string }) {
  const sendMessage = vi.fn(async (_tabId: number, request: { type?: string }) => {
    if (request.type === "content.collectionExtractPage") return extraction;
    throw new Error(`unexpected content request: ${request.type}`);
  });
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: vi.fn(() => ({ content_scripts: [{ js: ["assets/bootstrap.js"] }] })),
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: vi.fn() },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: "https://example.com/products/2" })),
      sendMessage,
    },
    scripting: { executeScript: vi.fn() },
    storage: {
      local: {
        get: vi.fn(async () => ({
          "aipagego.llm": {
            apiKey: "must-not-be-used",
            selfHealEnabled: true,
            defaultInjectionMode: "read",
            defaultAssistantEnabled: true,
            siteInjectionRules: [],
          },
        })),
      },
      session: { get: vi.fn(async () => ({})) },
    },
  });
  return { sendMessage };
}

async function saveCollectionTool(handleRpc: (request: unknown) => Promise<any>) {
  const saved = await handleRpc({
    type: "tools.save",
    draft: {
      kind: "steps",
      name: "商品采集",
      urlPatterns: ["https://example.com/products/**"],
      description: "本地采集",
      steps: [{
        kind: "tool",
        tool: "collectStructuredData",
        args: { recipe },
        timeoutMs: 600_000,
      }],
      outputSchema: { type: "object" },
    },
  });
  if (!saved.ok) throw new Error(saved.error);
  return saved.data as { id: string };
}

describe("saved collection replay", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    globalThis.indexedDB = new IDBFactory();
  });

  it("runs the saved recipe through the shared orchestrator without LLM or a content.runStep hop", async () => {
    const { sendMessage } = installChrome({
      ok: true,
      data: {
        rows: [{ values: { title: "商品 B" }, missingRequired: [] }],
        pageUrl: "https://example.com/products/2",
        fingerprint: "page-2",
        matchedCount: 1,
      },
    });
    const { handleRpc } = await import("@/background/rpc-handlers");
    const tool = await saveCollectionTool(handleRpc);

    const response = await handleRpc({
      type: "runs.start",
      target: { kind: "tool", id: tool.id },
      tabId: 73,
    });
    if (!response.ok) throw new Error(response.error);

    expect(response).toMatchObject({
      ok: true,
      data: {
        status: "ok",
        output: {
          sourceUrl: "https://example.com/products/2",
          status: "completed",
          rowCount: 1,
          resultId: expect.any(String),
        },
      },
    });
    expect(sendMessage.mock.calls.map((call) => call[1]?.type)).toEqual([
      "content.collectionExtractPage",
    ]);
    expect(llmBridgeMocks.requestSidepanelLlm).not.toHaveBeenCalled();
  });

  it("records a collection failure without invoking autonomous self-heal", async () => {
    installChrome({ ok: false, error: "selector missing" });
    const { handleRpc } = await import("@/background/rpc-handlers");
    const tool = await saveCollectionTool(handleRpc);

    const response = await handleRpc({
      type: "runs.start",
      target: { kind: "tool", id: tool.id },
      tabId: 73,
    });
    if (!response.ok) throw new Error(response.error);

    expect(response).toMatchObject({
      ok: true,
      data: {
        status: "error",
        stepLog: [{ error: expect.stringContaining("selector missing") }],
      },
    });
    expect(llmBridgeMocks.requestSidepanelLlm).not.toHaveBeenCalled();
  });
});
