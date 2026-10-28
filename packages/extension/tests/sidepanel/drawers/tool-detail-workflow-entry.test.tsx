import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUi } from "@/sidepanel/chat/ui-store";
import { ToolDetailPane } from "@/sidepanel/drawers/tool-detail-pane";

const rpcMocks = vi.hoisted(() => ({
  getTool: vi.fn(),
  runTool: vi.fn(),
}));
vi.mock("@/sidepanel/rpc", () => ({
  rpc: rpcMocks,
  currentTabId: vi.fn(async () => 7),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ToolDetailPane workflow entry", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useUi.setState({ openedDrawer: "tools", drawerSubPath: "tool-1" });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    useUi.setState({ openedDrawer: null, drawerSubPath: null });
  });

  it("opens Workflow Studio for a steps tool", async () => {
    rpcMocks.getTool.mockResolvedValue({
      kind: "steps",
      id: "tool-1",
      name: "Workflow",
      description: "",
      urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
      outputSchema: {},
      activeVersion: 1,
      createdAt: 1,
      updatedAt: 1,
      versions: [{
        version: 1,
        kind: "steps",
        parameters: [],
        steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
        outputSchema: {},
        createdAt: 1
      }],
      stats: { runs: 0 }
    });
    await act(async () => root.render(<ToolDetailPane id="tool-1" />));

    const edit = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("编辑工作流")) as HTMLButtonElement;
    expect(edit).toBeTruthy();
    act(() => edit.click());
    expect(useUi.getState()).toMatchObject({
      openedDrawer: "workflow",
      drawerSubPath: "tool-1"
    });

    const createJob = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("创建 Job")) as HTMLButtonElement;
    expect(createJob).toBeTruthy();
    act(() => createJob.click());
    expect(useUi.getState()).toMatchObject({ openedDrawer: "jobs", drawerSubPath: "tool-1" });
  });

  it("does not show the workflow editor for a prompt tool", async () => {
    rpcMocks.getTool.mockResolvedValue({
      kind: "prompt",
      id: "prompt-1",
      name: "Prompt",
      description: "",
      urlPatterns: ["https://example.com/**"],
      prompt: "总结",
      createdAt: 1,
      updatedAt: 1,
      versions: [{ version: 1, kind: "prompt", prompt: "总结", createdAt: 1 }],
      stats: { runs: 0 }
    });
    await act(async () => root.render(<ToolDetailPane id="prompt-1" />));

    expect(container.textContent).not.toContain("编辑工作流");
  });
});
