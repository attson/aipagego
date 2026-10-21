import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsDrawer } from "@/sidepanel/drawers/settings-drawer";
import { useUi } from "@/sidepanel/chat/ui-store";
import { useSettings } from "@/sidepanel/chat/settings-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SettingsDrawer tabs", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    useUi.setState({ openedDrawer: "settings", stack: ["settings"] } as Partial<ReturnType<typeof useUi.getState>>);
    useSettings.setState({
      loaded: true,
      provider: "openai",
      model: "gpt-4o",
      apiKey: "",
      apiKeyMode: "persistent",
      maxRounds: 20,
      trustedDangerTools: [],
      defaultPermissionMode: "default",
      theme: "dark",
      selfHealEnabled: true,
      maxSelfHealOutputTokens: 4096,
      defaultInjectionMode: "operate" as const, defaultAssistantEnabled: true, siteInjectionRules: [],
      contextPolicy: "auto",
      save: vi.fn(async (patch) => useSettings.setState(patch)),
    } as Partial<ReturnType<typeof useSettings.getState>>);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows one settings section at a time and switches to context settings", async () => {
    await act(async () => {
      root.render(<SettingsDrawer />);
    });

    expect(container.textContent).toContain("LLM");
    expect(container.textContent).toContain("Provider");
    expect(container.textContent).not.toContain("权限默认值");

    const contextTab = container.querySelector('button[aria-label="设置分类: 上下文"]') as HTMLButtonElement;
    expect(contextTab).toBeTruthy();

    await act(async () => {
      contextTab.click();
    });

    expect(container.textContent).toContain("上下文策略");
    expect(container.textContent).not.toContain("Provider");
  });

  it("switches to MCP setup instructions", async () => {
    await act(async () => {
      root.render(<SettingsDrawer />);
    });

    const mcpTab = container.querySelector('button[aria-label="设置分类: MCP"]') as HTMLButtonElement;
    expect(mcpTab).toBeTruthy();

    await act(async () => {
      mcpTab.click();
    });

    expect(container.textContent).toContain("MCP 配置");
    expect(container.textContent).toContain("@attson/aipagego-mcp");
    expect(container.textContent).not.toContain("Provider");
  });
});
