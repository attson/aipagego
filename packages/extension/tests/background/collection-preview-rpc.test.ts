import { beforeEach, describe, expect, it, vi } from "vitest";

const recipe = {
  version: 1 as const,
  mode: "single" as const,
  fields: [
    { id: "title", name: "标题", selector: "h1", valueMode: "text" as const, required: true },
  ],
  pagination: { kind: "single" as const },
  dedupeBy: [],
  maxRows: 2_000,
  maxBytes: 5 * 1024 * 1024,
};

function stubChrome(mode: "disabled" | "read" = "read") {
  const preview = {
    rows: [{ values: { title: "Example" }, missingRequired: [], duplicate: false }],
    matchedCount: 1,
    returnedCount: 1,
    uniqueCount: 1,
    duplicateCount: 0,
    missingRequiredCount: 0,
    truncated: false,
  };
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: vi.fn(() => ({ content_scripts: [{ js: ["assets/bootstrap.js"] }] })),
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn() },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: "https://example.com/product" })),
      sendMessage: vi.fn(async () => ({ ok: true, data: preview })),
    },
    scripting: { executeScript: vi.fn() },
    storage: {
      local: {
        get: vi.fn(async () => ({
          "aipagego.llm": {
            defaultInjectionMode: mode,
            defaultAssistantEnabled: true,
            siteInjectionRules: [],
          },
        })),
      },
      session: { get: vi.fn(async () => ({})) },
    },
  });
  return preview;
}

describe("collections.preview RPC", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("previews the explicitly captured tab under read policy", async () => {
    const preview = stubChrome("read");
    const { handleRpc } = await import("@/background/rpc-handlers");

    const result = await handleRpc({ type: "collections.preview", tabId: 73, recipe });

    expect(result).toEqual({ ok: true, data: preview });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(73, {
      type: "content.collectionPreview",
      recipe,
    });
  });

  it("rejects preview when the site injection policy is disabled", async () => {
    stubChrome("disabled");
    const { handleRpc } = await import("@/background/rpc-handlers");

    const result = await handleRpc({ type: "collections.preview", tabId: 73, recipe });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("只读");
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
});
