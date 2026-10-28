import { describe, expect, it, vi, beforeEach } from "vitest";

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

describe("widget RPCs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("widget.openSidepanel calls chrome.sidePanel.open and stores pendingApproval", async () => {
    const { dispatch } = await import("@/background/rpc-handlers");
    await dispatch({ type: "widget.openSidepanel", tabId: 42, pendingApprovalId: "abc" } as any);
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({ "aipagego.pendingApproval": expect.objectContaining({ tabId: 42, approvalId: "abc" }) })
    );
  });

  it("stores and announces a pending optional permission before opening the sidepanel", async () => {
    const { dispatch } = await import("@/background/rpc-handlers");
    await dispatch({
      type: "widget.openSidepanel",
      tabId: 42,
      pendingPermission: {
        toolUseId: "history-1",
        code: "permission_required",
        permission: "history",
        capability: "searchHistory",
        requestable: true,
      },
    } as any);

    expect(chrome.storage.session.set).toHaveBeenCalledWith({
      "aipagego.pendingPermission.42.history-1": expect.objectContaining({
        tabId: 42,
        toolUseId: "history-1",
        permission: "history",
        capability: "searchHistory",
      }),
    });
    expect((chrome.storage.session.set as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((chrome.sidePanel.open as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "permission.pending.available",
      tabId: 42,
      storageKey: "aipagego.pendingPermission.42.history-1",
    });
  });

  it("widget.markHostHidden appends an assistant-disabled site rule", async () => {
    (chrome.storage.local.get as any).mockResolvedValueOnce({
      "aipagego.llm": {
        siteInjectionRules: [
          { pattern: "foo.com", injectionMode: "read", assistant: "inherit" }
        ]
      }
    });
    const { dispatch } = await import("@/background/rpc-handlers");
    await dispatch({ type: "widget.markHostHidden", host: "bar.com" } as any);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      {
        "aipagego.llm": {
          siteInjectionRules: [
            { pattern: "foo.com", injectionMode: "read", assistant: "inherit" },
            { pattern: "bar.com", injectionMode: "inherit", assistant: "disabled" }
          ]
        }
      }
    );
  });
});
