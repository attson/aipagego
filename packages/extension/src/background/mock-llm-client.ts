import type { LlmClient, LlmStreamEvent } from "@aipagego/shared/llm";

/**
 * Deterministic LLM client driven by a pre-scripted list of rounds.
 * Each call to stream() yields the next round's events; exhausting the
 * script yields a single message_end so runChatSession terminates cleanly.
 */
export class MockLlmClient implements LlmClient {
  private i = 0;
  constructor(private rounds: LlmStreamEvent[][]) {}

  stream(_input?: Parameters<LlmClient["stream"]>[0]): AsyncIterable<LlmStreamEvent> {
    const events: LlmStreamEvent[] = this.rounds[this.i++] ?? [
      { type: "message_end", usage: { input_tokens: 0, output_tokens: 0 } }
    ];
    return (async function* () {
      for (const e of events) yield e;
    })();
  }
}
