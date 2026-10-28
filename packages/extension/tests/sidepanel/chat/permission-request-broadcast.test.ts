import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners: Array<(message: unknown) => void> = [];
(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onMessage: {
      addListener: vi.fn((listener: (message: unknown) => void) => listeners.push(listener)),
      removeListener: vi.fn((listener: (message: unknown) => void) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      }),
    },
  },
};

function deliver(message: unknown): void {
  for (const listener of listeners) listener(message);
}

describe("optional-permission decision relay", () => {
  beforeEach(() => {
    listeners.length = 0;
    vi.clearAllMocks();
  });

  it("broadcasts a sidepanel decision and resolves the widget requester", async () => {
    const {
      PermissionRequester,
      broadcastPermissionDecision,
      installPermissionDecisionListener,
      registerPermissionRequesterForTab,
    } = await import("@/sidepanel/chat/permission-request");
    const requester = new PermissionRequester();
    registerPermissionRequesterForTab(42, requester);
    const pending = requester.request("history-1");
    const dispose = installPermissionDecisionListener();

    broadcastPermissionDecision(42, "history-1", { granted: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "permission.decision",
      tabId: 42,
      toolUseId: "history-1",
      result: { granted: true },
    });
    deliver({
      type: "permission.decision",
      tabId: 42,
      toolUseId: "history-1",
      result: { granted: true },
    });

    await expect(pending).resolves.toEqual({ granted: true });
    dispose();
  });

  it("settles a pending widget request as denied when its chat is aborted", async () => {
    const { PermissionRequester } = await import("@/sidepanel/chat/permission-request");
    const requester = new PermissionRequester();
    const controller = new AbortController();
    const pending = requester.request("download-1", controller.signal);

    controller.abort();

    await expect(pending).resolves.toEqual({ granted: false, reason: "user_denied" });
    expect(requester.has("download-1")).toBe(false);
  });
});
