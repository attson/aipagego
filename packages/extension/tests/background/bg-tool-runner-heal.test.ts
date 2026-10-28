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

  it("heals the actual historical active snapshot into global max+1 and updates run lineage", async () => {
    const {
      activateWorkflowVersion,
      appendVersion,
      getTool,
      saveDraft,
    } = await import("@/background/storage/tools");
    const { requestSidepanelLlm } = await import("@/background/self-heal-bridge");
    const { handleRpc } = await import("@/background/rpc-handlers");
    vi.mocked(requestSidepanelLlm).mockResolvedValueOnce({
      patchedSteps: [{
        kind: "tool",
        tool: "extractText",
        args: { selector: "h1.healed" },
        bindResultTo: "final",
      }],
      usage: { in: 500, out: 200 },
    });
    const original = await saveDraft({
      kind: "steps",
      name: "Historical heal",
      description: "",
      urlPatterns: ["https://demo/**"],
      parameters: [{
        key: "secret",
        label: "Secret",
        type: "string",
        required: true,
        sensitive: true,
      }],
      steps: [{
        kind: "tool",
        tool: "extractText",
        args: { selector: "${secret}" },
        bindResultTo: "final",
      }],
      outputBinding: "final",
      outputSchema: { type: "string", title: "v1-output" },
    });
    if (original.kind !== "steps") throw new Error("expected steps tool");
    await appendVersion(original.id, {
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h2" }, bindResultTo: "final" }],
      outputSchema: { type: "object", title: "v2-output" },
    });
    await appendVersion(original.id, {
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h3" }, bindResultTo: "final" }],
      outputSchema: { type: "array", title: "v3-output" },
    });
    await activateWorkflowVersion(original.id, 1);

    let callCount = 0;
    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { ok: false, error: "selector leaked sk-private" };
      return { ok: true, data: { text: "healed" } };
    });

    const response = await handleRpc({
      type: "runs.start",
      target: { kind: "tool", id: original.id },
      tabId: 1,
      inputs: { secret: "sk-private" },
    });

    const healed = await getTool(original.id);
    expect(healed?.kind).toBe("steps");
    if (healed?.kind !== "steps") throw new Error("expected steps tool");
    expect(healed.activeVersion).toBe(4);
    expect(healed.versions).toHaveLength(4);
    expect(healed.versions[3]).toMatchObject({
      version: 4,
      basedOnVersion: 1,
      parameters: [{ key: "secret", sensitive: true }],
      outputBinding: "final",
      outputSchema: { type: "string", title: "v1-output" },
      steps: [expect.objectContaining({ args: { selector: "h1.healed" } })],
    });
    expect(response).toMatchObject({
      ok: true,
      data: {
        status: "ok",
        toolVersion: 4,
        healed: { fromVersion: 1, toVersion: 4, fixedStepIndex: 0 },
      },
    });
    const healContext = vi.mocked(requestSidepanelLlm).mock.calls[0][0];
    expect(healContext.tool.steps).toEqual(original.versions[0].steps);
    expect(healContext.tool.outputSchema).toEqual({ type: "string", title: "v1-output" });
    expect(JSON.stringify(healContext)).not.toContain("sk-private");
  });

  it("rejects a healed patch with an unknown binding as invalid output", async () => {
    const { getTool, saveDraft } = await import("@/background/storage/tools");
    const { requestSidepanelLlm } = await import("@/background/self-heal-bridge");
    const { handleRpc } = await import("@/background/rpc-handlers");
    vi.mocked(requestSidepanelLlm).mockResolvedValueOnce({
      patchedSteps: [{
        kind: "tool",
        tool: "fillInput",
        args: { selector: "#q", value: "${future}" },
      }],
      usage: { in: 100, out: 50 },
    });
    const tool = await saveDraft({
      kind: "steps",
      name: "Invalid healed binding",
      description: "",
      urlPatterns: ["https://demo/**"],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h1" } }],
      outputSchema: null,
    });
    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, error: "selector failed" })
      .mockResolvedValueOnce({ ok: true, data: { html: "snapshot" } });

    const response = await handleRpc({
      type: "runs.start",
      target: { kind: "tool", id: tool.id },
      tabId: 1,
    });

    expect(response).toMatchObject({
      ok: true,
      data: { status: "error", stepLog: [expect.objectContaining({ error: expect.stringContaining("heal:invalid_output") })] },
    });
    expect((await getTool(tool.id))?.versions).toHaveLength(1);
  });

  it("rejects a healed patch that resolves to a dangerous tool input", async () => {
    const { getTool, saveDraft } = await import("@/background/storage/tools");
    const { requestSidepanelLlm } = await import("@/background/self-heal-bridge");
    const { handleRpc } = await import("@/background/rpc-handlers");
    vi.mocked(requestSidepanelLlm).mockResolvedValueOnce({
      patchedSteps: [{
        kind: "tool",
        tool: "httpRequest",
        args: {
          url: "https://demo/private",
          withCredentials: "${credentialed}",
        },
      }],
      usage: { in: 100, out: 50 },
    });
    const tool = await saveDraft({
      kind: "steps",
      name: "Resolved dangerous heal",
      description: "",
      urlPatterns: ["https://demo/**"],
      parameters: [{
        key: "credentialed",
        label: "Credentialed",
        type: "boolean",
        required: true,
      }],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "#missing" } }],
      outputSchema: null,
    });
    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, error: "selector failed" })
      .mockResolvedValueOnce({ ok: true, data: { html: "snapshot" } })
      .mockResolvedValueOnce({ ok: true, data: { leaked: true } });

    const response = await handleRpc({
      type: "runs.start",
      target: { kind: "tool", id: tool.id },
      tabId: 1,
      inputs: { credentialed: true },
    });

    expect(response).toMatchObject({
      ok: true,
      data: {
        status: "error",
        stepLog: [expect.objectContaining({ error: expect.stringContaining("heal:static_scan_reject") })],
      },
    });
    expect((await getTool(tool.id))?.versions).toHaveLength(1);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("lets the sidepanel reject heal when self-heal is disabled without reading the API key in the runner", async () => {
    const { saveDraft, getTool } = await import("@/background/storage/tools");
    const { requestSidepanelLlm } = await import("@/background/self-heal-bridge");
    const { handleRpc } = await import("@/background/rpc-handlers");
    vi.mocked(requestSidepanelLlm).mockRejectedValueOnce(new Error("self_heal_disabled"));

    const draft = await saveDraft({
      kind: "steps",
      name: "T2",
      description: "",
      urlPatterns: ["https://demo/**"],
      steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
      outputSchema: null
    });

    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, error: "selector not found" })
      .mockResolvedValueOnce({ ok: true, data: { html: "snapshot" } });

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
      expect(rec.stepLog[0].error).toContain("heal:self_heal_disabled");
    }
    expect(requestSidepanelLlm).toHaveBeenCalledOnce();
    expect(requestSidepanelLlm).toHaveBeenCalledWith(expect.any(Object), 8192);
  });

  it("does not cascade self-heal when the patched step still fails", async () => {
    const { saveDraft, getTool } = await import("@/background/storage/tools");
    const { requestSidepanelLlm } = await import("@/background/self-heal-bridge");
    const { handleRpc } = await import("@/background/rpc-handlers");
    const tool = await saveDraft({
      kind: "steps",
      name: "Single heal only",
      description: "",
      urlPatterns: ["https://demo/**"],
      steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
      outputSchema: null,
    });
    (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, error: "original selector failed" })
      .mockResolvedValueOnce({ ok: true, data: { html: "snapshot" } })
      .mockResolvedValueOnce({ ok: false, error: "patched selector failed" });

    const response = await handleRpc({
      type: "runs.start",
      target: { kind: "tool", id: tool.id },
      tabId: 1,
    });

    expect(response).toMatchObject({
      ok: true,
      data: {
        status: "error",
        toolVersion: 2,
        healed: { fromVersion: 1, toVersion: 2, fixedStepIndex: 0 },
      },
    });
    expect(requestSidepanelLlm).toHaveBeenCalledOnce();
    expect((await getTool(tool.id))?.versions).toHaveLength(2);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "session.event",
      event: {
        type: "self_heal_failed",
        toolId: tool.id,
        reason: "step_still_fails",
      },
    });
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
