import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmStreamEvent } from "@aipagego/shared/llm";
import type { LlmSettings } from "@aipagego/shared/types";

// Mock pickClient BEFORE importing the module under test
const streamSpy = vi.fn();
vi.mock("@/sidepanel/llm/client", () => ({
  pickClient: () => ({ stream: streamSpy }) as LlmClient,
}));

import { optimizePrompt } from "@/sidepanel/lib/optimize-prompt";

const BASE_SETTINGS: LlmSettings = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKey: "sk-fake",
  apiKeyMode: "persistent",
  maxRounds: 20,
  trustedDangerTools: [],
  defaultPermissionMode: "default",
  theme: "dark",
  maxContinuationNudges: 1,
  selfHealEnabled: true,
  maxSelfHealOutputTokens: 4096,
  defaultInjectionMode: "operate" as const, defaultAssistantEnabled: true, siteInjectionRules: [],
};

async function* fakeStream(events: LlmStreamEvent[]): AsyncIterable<LlmStreamEvent> {
  for (const e of events) yield e;
}

beforeEach(() => {
  streamSpy.mockReset();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      get: vi.fn(async (_tabId: number) => ({
        title: "Fake Product Page",
        url: "https://shop.example/p/1",
      })),
    },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("optimizePrompt", () => {
  it("prefers optimizerModel over settings.model", async () => {
    streamSpy.mockReturnValueOnce(fakeStream([{ type: "text_delta", text: "rewritten" }]));
    await optimizePrompt({
      draft: "hi",
      tabId: 42,
      settings: { ...BASE_SETTINGS, optimizerModel: "claude-haiku-4-5-20251001" },
      signal: new AbortController().signal,
    });
    expect(streamSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001" })
    );
  });

  it("falls back to settings.model when optimizerModel empty", async () => {
    streamSpy.mockReturnValueOnce(fakeStream([{ type: "text_delta", text: "x" }]));
    await optimizePrompt({
      draft: "hi",
      tabId: 42,
      settings: { ...BASE_SETTINGS, optimizerModel: "  " },
      signal: new AbortController().signal,
    });
    expect(streamSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6" })
    );
  });

  it("passes system prompt containing 改写 keyword", async () => {
    streamSpy.mockReturnValueOnce(fakeStream([{ type: "text_delta", text: "x" }]));
    await optimizePrompt({
      draft: "hi",
      tabId: 42,
      settings: BASE_SETTINGS,
      signal: new AbortController().signal,
    });
    const call = streamSpy.mock.calls[0][0];
    expect(call.system).toContain("改写");
  });

  it("user message includes tab title, tab url, tool catalog and draft", async () => {
    streamSpy.mockReturnValueOnce(fakeStream([{ type: "text_delta", text: "x" }]));
    await optimizePrompt({
      draft: "帮我找竞品",
      tabId: 42,
      settings: BASE_SETTINGS,
      signal: new AbortController().signal,
    });
    const call = streamSpy.mock.calls[0][0];
    const userContent = call.messages[0].content as string;
    expect(userContent).toContain("Fake Product Page");
    expect(userContent).toContain("https://shop.example/p/1");
    expect(userContent).toContain("takeSnapshot");
    expect(userContent).toContain("帮我找竞品");
  });

  it("accumulates text_delta and trims", async () => {
    streamSpy.mockReturnValueOnce(
      fakeStream([
        { type: "text_delta", text: "  hello " },
        { type: "text_delta", text: "world  \n" },
      ])
    );
    const out = await optimizePrompt({
      draft: "d",
      tabId: 42,
      settings: BASE_SETTINGS,
      signal: new AbortController().signal,
    });
    expect(out).toBe("hello world");
  });

  it("throws on error event", async () => {
    streamSpy.mockReturnValueOnce(fakeStream([{ type: "error", error: "429 rate limit" }]));
    await expect(
      optimizePrompt({
        draft: "d",
        tabId: 42,
        settings: BASE_SETTINGS,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/429 rate limit/);
  });

  it("throws when empty output", async () => {
    streamSpy.mockReturnValueOnce(fakeStream([{ type: "text_delta", text: "   " }]));
    await expect(
      optimizePrompt({
        draft: "d",
        tabId: 42,
        settings: BASE_SETTINGS,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/empty/);
  });

  it("passes abortSignal through", async () => {
    streamSpy.mockReturnValueOnce(fakeStream([{ type: "text_delta", text: "x" }]));
    const ac = new AbortController();
    await optimizePrompt({
      draft: "d",
      tabId: 42,
      settings: BASE_SETTINGS,
      signal: ac.signal,
    });
    expect(streamSpy.mock.calls[0][0].abortSignal).toBe(ac.signal);
  });
});
