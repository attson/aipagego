import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock chrome.runtime
(globalThis as any).chrome = {
  runtime: {
    sendMessage: vi.fn(),
  },
  permissions: { request: vi.fn() },
};

// Mock settings store — apiKey empty triggers early return.
// `loaded: true` bypasses runFromInput's defensive re-load path (see impl).
const mockLoad = vi.fn(() => Promise.resolve());
const mockSettings = {
  apiKey: "",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  maxRounds: 20,
  maxContinuationNudges: 1,
  defaultPermissionMode: "default",
  trustedDangerTools: [] as string[],
  selfHealEnabled: false,
  loaded: true,
  load: mockLoad,
};
vi.mock("@/sidepanel/chat/settings-store", () => ({
  useSettings: {
    getState: () => mockSettings,
  },
}));

// Mock session-store
const mockSetError = vi.fn();
const mockSetAbortController = vi.fn();
const mockSetStatus = vi.fn();
const mockUseStore = {
  getState: () => ({
    sessionsByTab: {
      1: { url: "https://example.com", permissionMode: "default", cards: [], messages: [] },
    },
  }),
};

vi.mock("@/sidepanel/chat/session-store", () => ({
  useStore: mockUseStore,
  addLlmExchange: vi.fn(),
  appendAssistantText: vi.fn(),
  beginAssistantTurn: vi.fn(),
  finalizeAssistantTurn: vi.fn(),
  incrementRound: vi.fn(),
  upsertCard: vi.fn(),
  setCardStatus: vi.fn(),
  setStatus: mockSetStatus,
  setError: mockSetError,
  setAbortController: mockSetAbortController,
  pushExecutedStep: vi.fn(),
  setLastOutput: vi.fn(),
}));

// Mock runChatSession — should NOT be called when apiKey is empty
const mockRunChatSession = vi.fn();
vi.mock("@/sidepanel/chat/run-session", () => ({
  runChatSession: mockRunChatSession,
}));

// Mock other deps that would fail in test env
vi.mock("@/sidepanel/llm/client", () => ({
  pickClient: vi.fn(() => ({})),
}));
vi.mock("@/sidepanel/llm/recording-client", () => ({
  createRecordingClient: vi.fn(() => ({})),
}));
vi.mock("@/sidepanel/chat/approval", () => {
  // Minimal Approver class stub for WidgetApprover to subclass
  class Approver {
    request(_id: string) {
      return Promise.resolve({ kind: "run" as const });
    }
    resolve(_id: string, _d: unknown) {}
    resolveAllPending(_d: unknown) {}
    has(_id: string) { return false; }
  }
  return {
    Approver,
    registerApproverForTab: vi.fn(),
    broadcastApprovalDecision: vi.fn(),
  };
});
const mockPermissionRequest = vi.fn(async () => ({ granted: true as const }));
const mockResolveAllPermissions = vi.fn();
vi.mock("@/sidepanel/chat/permission-request", () => ({
  PermissionRequester: class PermissionRequester {
    request = mockPermissionRequest;
    resolveAllPending = mockResolveAllPermissions;
  },
  registerPermissionRequesterForTab: vi.fn(),
  disposePermissionRequesterForTab: vi.fn(),
}));
vi.mock("@/sidepanel/llm/tool-schema", () => ({
  TOOL_DEFS: [],
}));
vi.mock("@/sidepanel/llm/system-prompt", () => ({
  buildSystemPrompt: vi.fn(() => ""),
}));
vi.mock("@/sidepanel/rpc", () => ({
  rpc: {
    startSession: vi.fn(),
    appendStepLog: vi.fn(),
    finalizeSession: vi.fn(),
    listTabs: vi.fn(),
    openTab: vi.fn(),
    widgetOpenSidepanel: vi.fn(async () => null),
  },
}));
vi.mock("@/sidepanel/chat/tool-runner", () => ({
  RpcToolRunner: vi.fn(() => ({})),
}));

describe("runFromInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.apiKey = "";
  });

  it("early-returns and sets error when apiKey is empty", async () => {
    const { runFromInput } = await import("@/content/widget/run-widget-session");
    await runFromInput(1, "hello");

    expect(mockSetError).toHaveBeenCalledWith(1, expect.stringContaining("API Key"));
    expect(mockRunChatSession).not.toHaveBeenCalled();
  });

  it("hands a missing optional permission to the sidepanel without requesting it in the widget", async () => {
    mockSettings.apiKey = "key";
    mockRunChatSession.mockImplementationOnce(async (args) => {
      args.onEvent({
        type: "permission_required",
        toolUseId: "history-1",
        permission: "history",
        capability: "searchHistory",
      });
      const result = await args.requestPermission({
        code: "permission_required",
        permission: "history",
        capability: "searchHistory",
        requestable: true,
        toolUseId: "history-1",
      });
      expect(result).toEqual({ granted: true });
      args.onEvent({
        type: "permission_resolved",
        toolUseId: "history-1",
        permission: "history",
        granted: true,
      });
      return { status: "done" };
    });

    const { runFromInput } = await import("@/content/widget/run-widget-session");
    const { rpc } = await import("@/sidepanel/rpc");
    await runFromInput(1, "find history");

    expect(rpc.widgetOpenSidepanel).toHaveBeenCalledWith({
      tabId: 1,
      pendingPermission: {
        code: "permission_required",
        permission: "history",
        capability: "searchHistory",
        requestable: true,
        toolUseId: "history-1",
      },
    });
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(mockSetStatus).toHaveBeenCalledWith(1, "awaiting");
    expect(mockSetStatus).toHaveBeenCalledWith(1, "running");
    expect(mockSetAbortController).toHaveBeenCalledWith(1, expect.any(AbortController));
    expect(mockSetAbortController).toHaveBeenLastCalledWith(1, null);
  });
});
