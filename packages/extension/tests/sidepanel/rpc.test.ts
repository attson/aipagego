import { beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "@/sidepanel/rpc";

describe("sidepanel workflow run RPC", () => {
  const sendMessage = vi.fn(async (_request: unknown) => ({
    ok: true,
    data: {
      id: "run-1",
      toolId: null,
      toolVersion: null,
      url: "https://example.com/",
      startedAt: 1,
      status: "ok",
      stepLog: [],
      source: "user"
    }
  }));

  beforeEach(() => {
    sendMessage.mockClear();
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
  });

  it("passes inputs when running a persisted workflow", async () => {
    await rpc.runTool("tool-1", 7, { query: "耳机", limit: 20 });

    expect(sendMessage).toHaveBeenCalledWith({
      type: "runs.start",
      target: { kind: "tool", id: "tool-1" },
      tabId: 7,
      inputs: { query: "耳机", limit: 20 }
    });
  });

  it("keeps inputs optional for legacy draft calls", async () => {
    await rpc.runDraft({
      kind: "steps",
      name: "Legacy",
      description: "",
      urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
      outputSchema: null
    }, 7);

    expect(sendMessage).toHaveBeenCalledWith({
      type: "runs.start",
      target: {
        kind: "draft",
        draft: expect.objectContaining({ name: "Legacy" })
      },
      tabId: 7
    });
  });

  it("activates a workflow version without a publish payload", async () => {
    await rpc.activateWorkflow("tool-1", 3);

    expect(sendMessage).toHaveBeenCalledWith({
      type: "workflows.activate",
      id: "tool-1",
      version: 3,
    });
  });

  it("requests a secure multi-tool share package", async () => {
    await rpc.exportToolSharePackage(["tool-1", "tool-2"], "Research kit", "Portable tools");

    expect(sendMessage).toHaveBeenCalledWith({
      type: "tools.share.export",
      toolIds: ["tool-1", "tool-2"],
      name: "Research kit",
      description: "Portable tools",
    });
  });
});
