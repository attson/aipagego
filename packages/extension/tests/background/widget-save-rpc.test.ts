import { beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as any).chrome = {
  sidePanel: { open: vi.fn().mockResolvedValue(undefined) },
  storage: {
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined)
    },
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined)
    }
  },
  tabs: { get: vi.fn(), sendMessage: vi.fn(), onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() }, onCreated: { addListener: vi.fn() } },
  webNavigation: { onHistoryStateUpdated: { addListener: vi.fn() } },
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn() } },
  action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
  scripting: { executeScript: vi.fn() }
};

describe("widget.openSidepanelWithSave", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens sidepanel and stores pendingSave in session storage", async () => {
    const { dispatch } = await import("@/background/rpc-handlers");
    await dispatch({ type: "widget.openSidepanelWithSave", tabId: 42 } as any);
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({
        "aipagego.pendingSave": expect.objectContaining({ tabId: 42 })
      })
    );
  });
});
