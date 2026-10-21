import type { LlmClient, LlmProvider, LlmStreamEvent } from "@aipagego/shared/llm";
import { DEMO_ROUNDS, ROUND_DELAY_MS } from "./scenario";

/**
 * Replaces `sidepanel/llm/client.ts` in the demo build via a Vite alias, so the
 * side panel runs unmodified and the product keeps no demo-only branches.
 *
 * Rounds are delayed so the run reads at human pace; without it the whole
 * scenario completes before a visitor's eyes land on the panel.
 */

function reducedMotion(): boolean {
  return (
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

class DemoLlmClient implements LlmClient {
  private i = 0;

  stream(_input?: Parameters<LlmClient["stream"]>[0]): AsyncIterable<LlmStreamEvent> {
    const events: LlmStreamEvent[] = DEMO_ROUNDS[this.i++] ?? [
      { type: "message_end", usage: { input_tokens: 0, output_tokens: 0 } }
    ];
    const delay = reducedMotion() ? 0 : ROUND_DELAY_MS;
    return (async function* () {
      await new Promise((r) => setTimeout(r, delay));
      for (const e of events) {
        // Text arrives in one chunk; the pacing that matters is between rounds,
        // where the tool actually runs against the page.
        yield e;
      }
    })();
  }
}

const demoClient = new DemoLlmClient();

export function pickClient(_provider: LlmProvider): LlmClient {
  return demoClient;
}
