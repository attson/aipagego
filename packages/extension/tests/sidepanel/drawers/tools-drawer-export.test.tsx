import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptTool } from "@aipagego/shared/types";
import { ToolsDrawer } from "@/sidepanel/drawers/tools-drawer";
import { useUi } from "@/sidepanel/chat/ui-store";

const rpcMocks = vi.hoisted(() => ({
  listTools: vi.fn(),
  exportToolSharePackage: vi.fn(),
  importBundle: vi.fn(),
  deleteTool: vi.fn(),
}));
vi.mock("@/sidepanel/rpc", () => ({ rpc: rpcMocks }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tool: PromptTool = {
  kind: "prompt",
  id: "prompt-1",
  name: "Page summary",
  description: "",
  urlPatterns: ["https://example.com/**"],
  prompt: "Summarize",
  createdAt: 1,
  updatedAt: 1,
  versions: [{ version: 1, kind: "prompt", prompt: "Summarize", createdAt: 1 }],
  stats: { runs: 9 },
};

describe("ToolsDrawer secure export", () => {
  let host: HTMLDivElement;
  let root: Root;
  const createObjectURL = vi.fn(() => "blob:single-tool");

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useUi.setState({ openedDrawer: "tools", drawerSubPath: null });
    rpcMocks.listTools.mockResolvedValue([tool]);
    rpcMocks.exportToolSharePackage.mockResolvedValue({
      schema: "aipagego.tool-package/v1",
      exportedAt: 2,
      package: { name: tool.name },
      tools: [{ ...tool, stats: { runs: 0 } }],
    });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useUi.setState({ openedDrawer: null, drawerSubPath: null });
  });

  it("routes one-tool export through the background scanner", async () => {
    await act(async () => root.render(<ToolsDrawer />));
    await vi.waitFor(() => expect(host.textContent).toContain("Page summary"));

    const exportButton = [...host.querySelectorAll("button")].find((button) => button.textContent === "导出");
    await act(async () => exportButton?.click());

    expect(rpcMocks.exportToolSharePackage).toHaveBeenCalledWith(
      ["prompt-1"],
      "Page summary",
      "",
    );
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it("routes imports to the two-phase security review", async () => {
    await act(async () => root.render(<ToolsDrawer />));
    await vi.waitFor(() => expect(host.textContent).toContain("Page summary"));

    const importButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "安全导入",
    );
    await act(async () => importButton?.click());

    expect(useUi.getState()).toMatchObject({
      openedDrawer: "connectors",
      drawerSubPath: "packages",
    });
    expect(rpcMocks.importBundle).not.toHaveBeenCalled();
  });
});
