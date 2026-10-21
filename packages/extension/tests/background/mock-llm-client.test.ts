import { describe, it, expect } from "vitest";
import { MockLlmClient } from "@/background/mock-llm-client";
import type { LlmStreamEvent } from "@aipagego/shared/llm";

async function collect(it: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const baseArgs = {
  apiKey: "k" as string, model: "m" as string, system: "" as string, messages: [] as never[], tools: [] as never[]
};

describe("MockLlmClient", () => {
  it("yields each round's events in order", async () => {
    const c = new MockLlmClient([
      [{ type: "text_delta", text: "hi" }, { type: "message_end" }]
    ]);
    expect(await collect(c.stream(baseArgs))).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "message_end" }
    ]);
  });

  it("advances rounds on subsequent stream() calls", async () => {
    const c = new MockLlmClient([
      [{ type: "text_delta", text: "r0" }, { type: "message_end" }],
      [{ type: "text_delta", text: "r1" }, { type: "message_end" }]
    ]);
    expect((await collect(c.stream(baseArgs))).find((e) => e.type === "text_delta")).toEqual(
      { type: "text_delta", text: "r0" }
    );
    expect((await collect(c.stream(baseArgs))).find((e) => e.type === "text_delta")).toEqual(
      { type: "text_delta", text: "r1" }
    );
  });

  it("emits default message_end when rounds are exhausted", async () => {
    const c = new MockLlmClient([]);
    const events = await collect(c.stream(baseArgs));
    expect(events).toEqual([
      { type: "message_end", usage: { input_tokens: 0, output_tokens: 0 } }
    ]);
  });
});
