import "fake-indexeddb/auto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";

// Mock chrome API required by rpc-handlers
vi.stubGlobal("chrome", {
  tabs: {
    get: vi.fn().mockResolvedValue({ url: "https://demo/" }),
    sendMessage: vi.fn()
  },
  scripting: { executeScript: vi.fn() },
  runtime: {
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() }
  },
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({
        "aipagego.llm": { selfHealEnabled: true, apiKey: "sk-test", maxSelfHealOutputTokens: 4096 }
      })
    },
    session: {
      get: vi.fn().mockResolvedValue({})
    }
  }
});

vi.mock("@/background/self-heal-bridge", () => ({
  requestSidepanelLlm: vi.fn().mockResolvedValue({
    patchedSteps: [{ kind: "tool", tool: "extractText", args: {} }],
    usage: { in: 500, out: 200 }
  })
}));

describe("runTool self-heal integration", () => {
  beforeEach(() => {
    _resetDBForTests();
    indexedDB = new IDBFactory();
    vi.clearAllMocks();

    // Restore chrome mock after clearAllMocks clears implementations
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn().mockResolvedValue({ url: "https://demo/" }),
        sendMessage: vi.fn()
      },
      scripting: { executeScript: vi.fn() },
      runtime: {
        sendMessage: vi.fn(),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            "aipagego.llm": { selfHealEnabled: true, apiKey: "sk-test", maxSelfHealOutputTokens: 4096 }
          })
        },
        session: {
          get: vi.fn().mockResolvedValue({})
        }
      }
    });
  });

  it("failed step triggers heal and appends v2", async () => {
    const { saveDraft, getTool } = await import("@/background/storage/tools");
    const { handleRpc } = await import("@/background/rpc-handlers");

    const draft = await saveDraft({
      kind: "steps",
      name: "T1",
      description: "",
      urlPatterns: ["https://demo/**"],
      steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
      outputSchema: null
    });

    // Call sequence:
    // 1. First sendMessage for snapshotDOM (the failing step) → fail
    // 2. sendMessage for snapshotDOM during DOM snapshot capture for heal context → ok
    // 3. sendMessage for extractText (healed replacement step) → ok
    let callCount = 0;
    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tabId: number, _req: any) => {
        callCount++;
        if (callCount === 1) {
          // First call: the failing step
          return { ok: false, error: "selector not found" };
        }
        // Subsequent calls succeed (DOM snapshot, healed step)
        return { ok: true, data: { text: "ok" } };
      }
    );

    const runRecord = await handleRpc({
      type: "runs.start",
      target: { kind: "tool", id: draft.id },
      tabId: 1
    });

    const t = await getTool(draft.id);
    // v2 should exist after heal
    expect(t?.versions.length).toBe(2);
    // run record should have healed flag
    expect(runRecord.ok).toBe(true);
    if (runRecord.ok) {
      const rec = runRecord.data as any;
      expect(rec.healed).toBeTruthy();
      expect(rec.healed.fixedStepIndex).toBe(0);
    }
  });

  it("skips heal when selfHealEnabled is false", async () => {
    const { saveDraft, getTool } = await import("@/background/storage/tools");
    const { handleRpc } = await import("@/background/rpc-handlers");

    // Disable self-heal in settings
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      "aipagego.llm": { selfHealEnabled: false, apiKey: "sk-test" }
    });

    const draft = await saveDraft({
      kind: "steps",
      name: "T2",
      description: "",
      urlPatterns: ["https://demo/**"],
      steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
      outputSchema: null
    });

    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "selector not found"
    });

    const runRecord = await handleRpc({
      type: "runs.start",
      target: { kind: "tool", id: draft.id },
      tabId: 1
    });

    const t = await getTool(draft.id);
    // No v2 — heal was skipped
    expect(t?.versions.length).toBe(1);
    expect(runRecord.ok).toBe(true);
    if (runRecord.ok) {
      const rec = runRecord.data as any;
      expect(rec.status).toBe("error");
      expect(rec.healed).toBeUndefined();
    }
  });

  it("skips heal for draft runs (only persisted tools auto-heal)", async () => {
    const { handleRpc } = await import("@/background/rpc-handlers");

    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "selector not found"
    });

    const runRecord = await handleRpc({
      type: "runs.start",
      target: {
        kind: "draft",
        draft: {
          kind: "steps",
          name: "Draft",
          description: "",
          urlPatterns: ["https://demo/**"],
          steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
          outputSchema: null
        }
      },
      tabId: 1
    });

    expect(runRecord.ok).toBe(true);
    if (runRecord.ok) {
      const rec = runRecord.data as any;
      expect(rec.status).toBe("error");
      expect(rec.healed).toBeUndefined();
    }
  });
});
