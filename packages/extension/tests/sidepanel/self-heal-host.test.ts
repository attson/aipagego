import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "@/sidepanel/chat/settings-store";

const stream = vi.fn();
vi.mock("@/sidepanel/llm/client", () => ({
  pickClient: vi.fn(() => ({ stream })),
}));

describe("sidepanel self-heal host", () => {
  let listener: (message: unknown) => Promise<void>;
  const sendMessage = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: vi.fn((fn) => { listener = fn; }),
          removeListener: vi.fn(),
        },
      },
    });
    useSettings.setState({
      selfHealEnabled: true,
      apiKey: "sk-sidepanel",
      maxSelfHealOutputTokens: 512,
      provider: "anthropic",
      model: "test-model",
    });
    const { installSelfHealHost } = await import("@/sidepanel/self-heal-host");
    installSelfHealHost();
  });

  it("rejects disabled self-heal before using the API key", async () => {
    useSettings.setState({ selfHealEnabled: false, apiKey: "sk-sidepanel" });

    await listener({ type: "selfheal.request", requestId: "r1", ctx: {}, maxOutputTokens: 8192 });

    expect(stream).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "selfheal.response",
      requestId: "r1",
      ok: false,
      error: "self_heal_disabled",
    });
  });

  it("caps the background request with the sidepanel token setting", async () => {
    stream.mockImplementation(async function* () {
      yield { type: "text_delta", text: '[{"kind":"tool","tool":"extractText","args":{}}]' };
      yield { type: "message_end", usage: { input_tokens: 10, output_tokens: 20 } };
    });

    await listener({
      type: "selfheal.request",
      requestId: "r2",
      maxOutputTokens: 8192,
      ctx: {
        tool: { name: "T", steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }] },
        failedStepIndex: 0,
        failedInput: { kind: "tool", tool: "snapshotDOM", args: {} },
        errorText: "failed",
        prevSteps: [],
        domSnapshot: {},
        url: "https://demo/",
      },
    });

    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "sk-sidepanel",
      maxTokens: 512,
    }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "selfheal.response",
      requestId: "r2",
      ok: true,
    }));
  });
});
