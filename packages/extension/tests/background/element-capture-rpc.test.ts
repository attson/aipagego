import { beforeEach, describe, expect, it, vi } from "vitest";

function stubChrome() {
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: vi.fn(() => ({
        content_scripts: [
          {
            js: ["src/content/bootstrap.ts"]
          }
        ]
      })),
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn() }
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: "https://example.com/" })),
      query: vi.fn(),
      create: vi.fn(),
      sendMessage: vi.fn()
    },
    scripting: {
      executeScript: vi.fn(async () => undefined)
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined)
      }
    },
    sidePanel: { open: vi.fn() },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    webNavigation: { onHistoryStateUpdated: { addListener: vi.fn() } }
  });
}

describe("elementCapture.start RPC", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    stubChrome();
  });

  it("injects content scripts and retries when the tab has no receiver", async () => {
    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
      .mockResolvedValueOnce(undefined);

    const { handleRpc } = await import("@/background/rpc-handlers");
    const res = await handleRpc({ type: "elementCapture.start", tabId: 42 });

    expect(res).toEqual({ ok: true, data: null });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: ["src/content/bootstrap.ts"]
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(42, {
      type: "aipagego.startCapture"
    });
  });
});
