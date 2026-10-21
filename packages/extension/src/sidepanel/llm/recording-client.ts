import type { Json, LlmExchange, LlmExchangeResponse, LlmProvider } from "@aipagego/shared/types";
import type { LlmClient } from "./types";
import { truncateMessages } from "./truncate";

export type RecordingOptions = {
  provider: LlmProvider;
  kind?: LlmExchange["kind"];
  maxContentChars?: number;
};

const DEFAULT_MAX_CONTENT_CHARS = 8000;

export function createRecordingClient(
  inner: LlmClient,
  onExchange: (ex: LlmExchange) => void,
  opts: RecordingOptions
): LlmClient {
  let round = 0;
  const cap = opts.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const kind = opts.kind ?? "main";

  return {
    async *stream(input) {
      const startedAt = Date.now();
      const myRound = round++;
      const request = {
        provider: opts.provider,
        model: input.model,
        endpoint: input.endpoint,
        maxTokens: input.maxTokens,
        system: input.system,
        messages: truncateMessages(input.messages, cap),
        toolNames: input.tools.map((t) => t.name)
      };

      let text = "";
      const toolUses: { id: string; name: string; input: Json }[] = [];
      const names = new Map<string, string>();
      let usage: { input_tokens: number; output_tokens: number } | undefined;
      let stopReason: string | undefined;
      let error: string | undefined;
      let completed = false;

      try {
        for await (const ev of inner.stream(input)) {
          switch (ev.type) {
            case "text_delta":
              text += ev.text;
              break;
            case "tool_use_start":
              names.set(ev.id, ev.name);
              break;
            case "tool_use_end":
              toolUses.push({ id: ev.id, name: names.get(ev.id) ?? "", input: ev.input });
              break;
            case "message_end":
              usage = ev.usage;
              stopReason = ev.stop_reason;
              break;
            case "error":
              error = ev.error;
              break;
          }
          yield ev;
        }
        completed = true;
      } finally {
        const aborted = !completed && !error;
        const response: LlmExchangeResponse = {
          text,
          toolUses,
          ...(usage ? { usage } : {}),
          ...(stopReason ? { stopReason } : {}),
          ...(error ? { error } : {}),
          ...(aborted ? { aborted: true } : {})
        };
        try {
          onExchange({
            id: crypto.randomUUID(),
            round: myRound,
            kind,
            startedAt,
            durationMs: Date.now() - startedAt,
            request,
            response
          });
        } catch (err) {
          console.warn("[recording-client] onExchange threw", err);
        }
      }
    }
  };
}
