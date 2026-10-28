import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { InputToolbar } from "@/sidepanel/input/input-toolbar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactNode) {
  const c = document.createElement("div");
  document.body.appendChild(c);
  const r = createRoot(c);
  act(() => r.render(node));
  return { c, cleanup: () => { act(() => r.unmount()); c.remove(); } };
}

function defaultProps(over: Partial<React.ComponentProps<typeof InputToolbar>> = {}) {
  return {
    value: "",
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    currentTabUrl: "https://x",
    attachedTabs: [],
    pickableTabs: [],
    pickableTools: [],
    pickableBookmarks: [],
    bookmarkPermission: { state: "required" as const },
    onRequestBookmarkPermission: vi.fn(),
    onAttachTab: vi.fn(),
    onMentionTool: vi.fn(),
    onMentionBookmark: vi.fn(),
    stagedImages: [],
    stagedSelectors: [],
    onImageFiles: vi.fn(),
    onRemoveImage: vi.fn(),
    onRemoveSelector: vi.fn(),
    onStartCapture: vi.fn(),
    onDetachTab: vi.fn(),
    onOpenTabPicker: vi.fn(),
    permissionMode: "default" as const,
    onPermissionChange: vi.fn(),
    trustedDangerTools: [],
    onTrustedChange: vi.fn(),
    status: "idle" as const,
    roundCount: 0,
    maxRounds: 20,
    tokensIn: 0,
    tokensOut: 0,
    settings: {
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      apiKey: "",
      apiKeyMode: "persistent" as const,
      maxRounds: 20,
      trustedDangerTools: [],
      defaultPermissionMode: "default" as const,
      theme: "dark" as const,
      selfHealEnabled: true,
      maxSelfHealOutputTokens: 4096,
      defaultInjectionMode: "operate" as const, defaultAssistantEnabled: true, siteInjectionRules: [],
    },
    currentTabId: null,
    ...over,
  };
}

describe("InputToolbar", () => {
  it("idle: shows send button which submits the current value", () => {
    const onSubmit = vi.fn();
    const { c, cleanup } = mount(
      <InputToolbar {...defaultProps({ value: "hello", onSubmit })} />
    );
    const send = c.querySelector('button[aria-label="发送"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    act(() => send.click());
    expect(onSubmit).toHaveBeenCalledWith("hello");
    cleanup();
  });

  it("streaming: shows stop button instead of send", () => {
    const onStop = vi.fn();
    const { c, cleanup } = mount(
      <InputToolbar {...defaultProps({ status: "streaming", onStop })} />
    );
    const stop = c.querySelector('button[aria-label="停止"]') as HTMLButtonElement;
    expect(stop).toBeTruthy();
    act(() => stop.click());
    expect(onStop).toHaveBeenCalled();
    expect(c.querySelector('button[aria-label="发送"]')).toBeNull();
    cleanup();
  });

  it("renders round pill and token meter when non-zero", () => {
    const { c, cleanup } = mount(
      <InputToolbar
        {...defaultProps({ roundCount: 7, tokensIn: 5200, tokensOut: 1800 })}
      />
    );
    expect(c.querySelector('[data-testid="round-pill"]')?.textContent).toBe("7/20");
    expect(c.querySelector('[data-testid="token-meter"]')?.textContent).toBe("7.0k");
    cleanup();
  });

  it("send button is disabled with empty input", () => {
    const { c, cleanup } = mount(<InputToolbar {...defaultProps({ value: "  " })} />);
    const send = c.querySelector('button[aria-label="发送"]') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    cleanup();
  });

  it("send button is enabled with staged images even when text is empty", () => {
    const onSubmit = vi.fn();
    const { c, cleanup } = mount(
      <InputToolbar
        {...defaultProps({
          value: "  ",
          stagedImages: [{ type: "image", media_type: "image/png", data: "abc" }],
          onSubmit,
        })}
      />
    );
    const send = c.querySelector('button[aria-label="发送"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    act(() => send.click());
    expect(onSubmit).toHaveBeenCalledWith("  ");
    cleanup();
  });

  it("renders selected element as a removable reference chip", () => {
    const onRemoveSelector = vi.fn();
    const { c, cleanup } = mount(
      <InputToolbar
        {...defaultProps({
          stagedSelectors: ["body > main > button:nth-of-type(1)"],
          onRemoveSelector
        })}
      />
    );

    expect(c.querySelector('[data-testid="staged-selectors"]')?.textContent).toContain("已选元素");
    const input = c.querySelector('[data-testid="input-box"]') as HTMLTextAreaElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toContain("针对已选元素");

    const remove = c.querySelector('button[aria-label="移除已选元素 1"]') as HTMLButtonElement;
    act(() => remove.click());
    expect(onRemoveSelector).toHaveBeenCalledWith(0);
    cleanup();
  });
});
