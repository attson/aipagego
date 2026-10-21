import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SectionMcp } from "@/sidepanel/drawers/settings/section-mcp";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SectionMcp", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<SectionMcp />));
  }

  it("shows MCP setup commands and the extension coordinator URL", () => {
    mount();

    expect(container.textContent).toContain("MCP 配置");
    expect(container.textContent).toContain("claude mcp add aipagego");
    expect(container.textContent).toContain("@attson/aipagego-mcp");
    expect(container.textContent).toContain("ws://127.0.0.1:8787/worker");
  });

  it("copies the Claude Code command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mount();

    const button = container.querySelector('button[aria-label="复制 Claude Code MCP 命令"]') as HTMLButtonElement;
    expect(button).toBeTruthy();

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(
      "claude mcp add aipagego --scope user -- npx -y @attson/aipagego-mcp"
    );
  });
});
