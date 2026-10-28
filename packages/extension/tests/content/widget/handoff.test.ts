import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock chrome (not used by handoff directly but imported transitively)
(globalThis as any).chrome = {
  runtime: { sendMessage: vi.fn() },
};

// Mock appendHealNote
const mockAppendHealNote = vi.fn();
vi.mock("@/sidepanel/chat/session-store", () => ({
  appendHealNote: mockAppendHealNote,
}));

// Mock rpc
const mockWidgetOpenSidepanel = vi.fn();
vi.mock("@/sidepanel/rpc", () => ({
  rpc: {
    widgetOpenSidepanel: mockWidgetOpenSidepanel,
  },
}));

describe("handOffToSidepanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls rpc.widgetOpenSidepanel with tabId and pendingApprovalId", async () => {
    mockWidgetOpenSidepanel.mockResolvedValue(null);

    const { handOffToSidepanel } = await import("@/content/widget/handoff");
    await handOffToSidepanel(42, "approval-abc");

    expect(mockWidgetOpenSidepanel).toHaveBeenCalledWith({
      tabId: 42,
      pendingApprovalId: "approval-abc",
    });
    expect(mockAppendHealNote).not.toHaveBeenCalled();
  });

  it("calls appendHealNote if rpc throws", async () => {
    mockWidgetOpenSidepanel.mockRejectedValue(new Error("panel unavailable"));

    const { handOffToSidepanel } = await import("@/content/widget/handoff");
    await handOffToSidepanel(42, "approval-abc");

    expect(mockAppendHealNote).toHaveBeenCalledWith(42, expect.stringContaining("扩展面板"));
  });

  it("returns false when an optional-permission handoff cannot open the sidepanel", async () => {
    mockWidgetOpenSidepanel.mockRejectedValue(new Error("panel unavailable"));
    const { handOffPermissionToSidepanel } = await import("@/content/widget/handoff");

    await expect(handOffPermissionToSidepanel(42, {
      code: "permission_required",
      permission: "downloads",
      capability: "downloadImage",
      requestable: true,
      toolUseId: "download-1",
    })).resolves.toBe(false);

    expect(mockAppendHealNote).toHaveBeenCalledWith(42, expect.stringContaining("本次操作已取消"));
  });
});
