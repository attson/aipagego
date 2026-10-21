import type { LlmProvider } from "@aipagego/shared/types";
import { anthropicClient } from "./anthropic";
import { openaiClient } from "./openai";
import type { LlmClient } from "./types";

export function pickClient(provider: LlmProvider): LlmClient {
  return provider === "anthropic" ? anthropicClient : openaiClient;
}
