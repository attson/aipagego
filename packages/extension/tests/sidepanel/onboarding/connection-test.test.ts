import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmStreamEvent } from "@aipagego/shared/llm";

import { testLlmConnection } from "@/sidepanel/onboarding/connection-test";

const settings = {
  provider: "openai" as const,
  model: "gpt-test",
  apiKey: "sk-supersecret",
  endpoint: "https://llm.example.test/v1",
};

function clientWith(events: LlmStreamEvent[]): LlmClient {
  return {
    stream: vi.fn(async function* () {
      yield* events;
    }),
  };
}

describe("testLlmConnection", () => {
  it("uses a minimal request without page context, history, or tools", async () => {
    const client = clientWith([
      { type: "message_end", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);

    await expect(testLlmConnection(settings, client)).resolves.toEqual({ ok: true });
    expect(client.stream).toHaveBeenCalledWith({
      apiKey: "sk-supersecret",
      model: "gpt-test",
      endpoint: "https://llm.example.test/v1",
      maxTokens: 16,
      system: "You are testing whether this LLM configuration can answer.",
      messages: [{ role: "user", content: "Reply with OK." }],
      tools: [],
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("classifies authentication errors and redacts the configured key", async () => {
    const client = clientWith([
      { type: "error", error: "OpenAI 401: invalid API key sk-supersecret" },
    ]);

    const result = await testLlmConnection(settings, client);

    expect(result).toMatchObject({ ok: false, category: "authentication" });
    expect(result.ok ? "" : result.message).not.toContain("sk-supersecret");
    expect(result.ok ? "" : result.message).toContain("检查 API Key");
  });

  it.each([
    ["OpenAI 429: rate limit exceeded", "rate_limit"],
    ["OpenAI 404: model_not_found", "model"],
    ["Failed to fetch", "network"],
  ] as const)("classifies %s as %s", async (message, category) => {
    const client = clientWith([{ type: "error", error: message }]);

    await expect(testLlmConnection(settings, client)).resolves.toMatchObject({
      ok: false,
      category,
    });
  });

  it("aborts a stalled connection test and classifies it as a network problem", async () => {
    const client: LlmClient = {
      stream: vi.fn(async function* (input) {
        await new Promise<void>((_resolve, reject) => {
          input.abortSignal?.addEventListener("abort", () => reject(new Error("AbortError")));
        });
      }),
    };

    await expect(testLlmConnection(settings, client, 1)).resolves.toMatchObject({
      ok: false,
      category: "network",
    });
  });
});

