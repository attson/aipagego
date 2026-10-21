import { describe, expect, it } from "vitest";
import { createRecordingClient } from "@/sidepanel/llm/recording-client";
import type { LlmClient, LlmStreamEvent } from "@/sidepanel/llm/types";
import type { LlmExchange } from "@aipagego/shared/types";

function fakeClient(events: LlmStreamEvent[]): LlmClient {
  return {
    async *stream() {
      for (const e of events) yield e;
    }
  };
}

const baseInput = {
  apiKey: "sk-SECRET",
  model: "m",
  system: "sys",
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [{ name: "snapshotDOM", description: "", input_schema: {} }]
};

async function drain(it: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("createRecordingClient", () => {
  it("passes events through unchanged", async () => {
    const events: LlmStreamEvent[] = [
      { type: "text_delta", text: "Hi" },
      { type: "message_end", usage: { input_tokens: 1, output_tokens: 2 }, stop_reason: "end_turn" }
    ];
    const rec = createRecordingClient(fakeClient(events), () => {}, { provider: "anthropic" });
    expect(await drain(rec.stream(baseInput))).toEqual(events);
  });

  it("records one exchange with assembled response and no apiKey", async () => {
    let captured: LlmExchange | null = null;
    const events: LlmStreamEvent[] = [
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "tool_use_start", id: "t1", name: "snapshotDOM" },
      { type: "tool_use_end", id: "t1", input: { maxDepth: 3 } },
      { type: "message_end", usage: { input_tokens: 9, output_tokens: 4 }, stop_reason: "tool_use" }
    ];
    const rec = createRecordingClient(fakeClient(events), (ex) => { captured = ex; }, { provider: "anthropic" });
    await drain(rec.stream(baseInput));

    expect(captured).not.toBeNull();
    const ex = captured!;
    expect(ex.request.model).toBe("m");
    expect(ex.request.provider).toBe("anthropic");
    expect(ex.request.toolNames).toEqual(["snapshotDOM"]);
    expect(ex.response.text).toBe("Hello");
    expect(ex.response.toolUses).toEqual([{ id: "t1", name: "snapshotDOM", input: { maxDepth: 3 } }]);
    expect(ex.response.usage).toEqual({ input_tokens: 9, output_tokens: 4 });
    expect(ex.response.stopReason).toBe("tool_use");
    expect(JSON.stringify(ex)).not.toContain("SECRET");
  });

  it("truncates oversized message content per cap", async () => {
    let captured: LlmExchange | null = null;
    const big = { ...baseInput, messages: [{ role: "user" as const, content: "z".repeat(100) }] };
    const rec = createRecordingClient(
      fakeClient([{ type: "message_end", usage: { input_tokens: 0, output_tokens: 0 } }]),
      (ex) => { captured = ex; },
      { provider: "anthropic", maxContentChars: 10 }
    );
    await drain(rec.stream(big));
    expect(captured!.request.messages[0].content as string).toContain("[截断");
  });

  it("records partial exchange (aborted) when consumer breaks early", async () => {
    let captured: LlmExchange | null = null;
    const events: LlmStreamEvent[] = [
      { type: "text_delta", text: "partial" },
      { type: "text_delta", text: " more" },
      { type: "message_end", usage: { input_tokens: 1, output_tokens: 1 } }
    ];
    const rec = createRecordingClient(fakeClient(events), (ex) => { captured = ex; }, { provider: "anthropic" });
    for await (const e of rec.stream(baseInput)) {
      if (e.type === "text_delta") break;
    }
    expect(captured).not.toBeNull();
    expect(captured!.response.aborted).toBe(true);
    expect(captured!.response.text).toBe("partial");
  });

  it("records error from inner error event", async () => {
    let captured: LlmExchange | null = null;
    const rec = createRecordingClient(
      fakeClient([{ type: "error", error: "boom" }]),
      (ex) => { captured = ex; },
      { provider: "anthropic" }
    );
    await drain(rec.stream(baseInput));
    expect(captured!.response.error).toBe("boom");
  });

  it("increments round per stream() call", async () => {
    const rounds: number[] = [];
    const rec = createRecordingClient(
      fakeClient([{ type: "message_end", usage: { input_tokens: 0, output_tokens: 0 } }]),
      (ex) => rounds.push(ex.round),
      { provider: "anthropic" }
    );
    await drain(rec.stream(baseInput));
    await drain(rec.stream(baseInput));
    expect(rounds).toEqual([0, 1]);
  });
});
