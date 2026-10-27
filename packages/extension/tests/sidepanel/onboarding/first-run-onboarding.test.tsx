import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { FirstRunOnboarding } from "@/sidepanel/onboarding/first-run-onboarding";
import { useSettings } from "@/sidepanel/chat/settings-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const streamMock = vi.fn();

vi.mock("@/sidepanel/llm/client", () => ({
  pickClient: vi.fn(() => ({ stream: streamMock })),
}));

async function* okStream() {
  yield { type: "message_end" as const, usage: { input_tokens: 1, output_tokens: 1 } };
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((item) =>
    (item.textContent ?? "").includes(text),
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found;
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function advanceToExample(container: HTMLElement): Promise<void> {
  const key = container.querySelector('input[aria-label="API Key"]') as HTMLInputElement;
  await setInputValue(key, "sk-test");
  await act(async () => {
    button(container, "保存并测试").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => button(container, "选择示例任务").click());
}

describe("FirstRunOnboarding", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onRunExample = vi.fn(async () => true);
  const onFinish = vi.fn(async () => undefined);

  beforeEach(() => {
    streamMock.mockImplementation(okStream);
    onRunExample.mockClear();
    onFinish.mockClear();
    useSettings.setState({
      loaded: true,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "",
      endpoint: undefined,
      apiKeyMode: "persistent",
      maxRounds: 20,
      trustedDangerTools: [],
      defaultPermissionMode: "default",
      defaultChatMode: "compact",
      theme: "dark",
      selfHealEnabled: true,
      maxSelfHealOutputTokens: 4096,
      defaultInjectionMode: "operate",
      defaultAssistantEnabled: true,
      siteInjectionRules: [],
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

  it("saves and tests configuration before running a real read-only example", async () => {
    await act(async () => {
      root.render(
        <FirstRunOnboarding
          currentUrl="https://example.com/article"
          onRunExample={onRunExample}
          onFinish={onFinish}
        />,
      );
    });

    const key = container.querySelector('input[aria-label="API Key"]') as HTMLInputElement;
    await setInputValue(key, "sk-test");
    await act(async () => {
      button(container, "保存并测试").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useSettings.getState().apiKey).toBe("sk-test");
    expect(container.textContent).toContain("连接正常");

    await act(async () => button(container, "选择示例任务").click());
    await act(async () => {
      button(container, "运行示例任务").click();
      await Promise.resolve();
    });

    expect(onRunExample).toHaveBeenCalledWith("用 5 个要点总结当前页面的核心内容");
    expect(onFinish).toHaveBeenCalledWith("task_completed");
  });

  it("does not mark a failed example as complete", async () => {
    onRunExample.mockResolvedValueOnce(false);
    await act(async () => {
      root.render(
        <FirstRunOnboarding
          currentUrl="https://example.com/article"
          onRunExample={onRunExample}
          onFinish={onFinish}
        />,
      );
    });
    await advanceToExample(container);

    await act(async () => {
      button(container, "运行示例任务").click();
      await Promise.resolve();
    });

    expect(onFinish).not.toHaveBeenCalled();
    expect(container.textContent).toContain("示例任务未完成");
  });

  it("explains restricted pages and records an explicit skip", async () => {
    await act(async () => {
      root.render(
        <FirstRunOnboarding
          currentUrl="chrome://extensions"
          onRunExample={onRunExample}
          onFinish={onFinish}
        />,
      );
    });
    await advanceToExample(container);

    expect(container.textContent).toContain("此页面不能被扩展读取");
    expect(container.textContent).not.toContain("运行示例任务");

    await act(async () => button(container, "跳过试用").click());
    expect(onFinish).toHaveBeenCalledWith("skipped");
  });
});

