import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SectionLlm } from "@/sidepanel/drawers/settings/section-llm";
import { useSettings } from "@/sidepanel/chat/settings-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const streamMock = vi.fn();
const { restartFirstRunMock } = vi.hoisted(() => ({
  restartFirstRunMock: vi.fn(async () => undefined),
}));

vi.mock("@/sidepanel/llm/client", () => ({
  pickClient: vi.fn(() => ({ stream: streamMock }))
}));

vi.mock("@/sidepanel/onboarding/first-run-state", () => ({
  restartFirstRun: restartFirstRunMock,
}));

async function* okStream() {
  yield { type: "message_end" as const, usage: { input_tokens: 1, output_tokens: 1 } };
}

describe("SectionLlm", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    streamMock.mockImplementation(okStream);
    useSettings.setState({
      provider: "openai",
      model: "gpt-test",
      apiKey: "sk-test",
      endpoint: "https://example.test/v1",
      maxTokens: 4096,
      maxRounds: 20,
      maxContinuationNudges: 1,
      apiKeyMode: "persistent",
      trustedDangerTools: [],
      defaultPermissionMode: "default",
      defaultChatMode: "compact",
      selfHealEnabled: true,
      maxSelfHealOutputTokens: 4096,
      defaultInjectionMode: "operate" as const, defaultAssistantEnabled: true, siteInjectionRules: [],
      contextPolicy: "auto",
      loaded: true,
      save: vi.fn(async (patch) => {
        useSettings.setState(patch);
      })
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

  it("tests the current LLM configuration and shows success", async () => {
    await act(async () => {
      root.render(<SectionLlm />);
    });

    const testButton = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("测试")
    ) as HTMLButtonElement | undefined;
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-test",
        model: "gpt-test",
        endpoint: "https://example.test/v1",
        maxTokens: 16,
        tools: []
      })
    );
    expect(container.textContent).toContain("连接正常");
    expect(container.textContent).not.toContain("启用页内浮窗");
  });

  it("lets the user restart the first-run guide without clearing LLM settings", async () => {
    await act(async () => {
      root.render(<SectionLlm />);
    });

    const restart = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("重新运行首次引导")
    ) as HTMLButtonElement;
    await act(async () => restart.click());

    expect(restartFirstRunMock).toHaveBeenCalledOnce();
    expect(useSettings.getState().apiKey).toBe("sk-test");
  });

  it("surfaces a storage error when the first-run guide cannot be restarted", async () => {
    restartFirstRunMock.mockRejectedValueOnce(new Error("storage unavailable"));
    await act(async () => {
      root.render(<SectionLlm />);
    });

    const restart = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("重新运行首次引导")
    ) as HTMLButtonElement;
    await act(async () => restart.click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("storage unavailable");
  });

});
