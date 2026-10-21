import type { ChatMessage, ImagePart, Json, TextPart, ToolResultPart } from "@aipagego/shared/types";

/**
 * Anthropic accepts `image` content blocks natively. We also need to
 * recursively transform image blocks nested inside tool_result.content
 * (used by the `screenshot` tool).
 */
function imageBlock(p: ImagePart): unknown {
  return {
    type: "image",
    source: { type: "base64", media_type: p.media_type, data: p.data }
  };
}

function toAnthropicPart(p: TextPart | ImagePart | ToolResultPart): unknown {
  if (p.type === "image") return imageBlock(p);
  if (p.type === "tool_result" && Array.isArray(p.content)) {
    return {
      ...p,
      content: p.content.map((inner) => (inner.type === "image" ? imageBlock(inner) : inner))
    };
  }
  return p;
}

function toAnthropicMessage(m: ChatMessage): unknown {
  if (m.role === "user" && Array.isArray(m.content)) {
    return { role: "user", content: m.content.map(toAnthropicPart) };
  }
  return m;
}

export { toAnthropicMessage };
import { formatLlmHttpError } from "./http-error";
import type { LlmClient, LlmStreamEvent, LlmTool } from "./types";

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

export async function* parseAnthropicStream(
  stream: ReadableStream<Uint8Array>
): AsyncIterable<LlmStreamEvent> {
  const blocks = new Map<
    number,
    { kind: "text" | "tool_use"; id?: string; name?: string; inputBuf: string }
  >();
  let usageInput = 0;
  let usageOutput = 0;
  let stopReason: string | undefined;

  for await (const event of readSseEvents(stream)) {
    if (!event.data) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.data);
    } catch {
      continue;
    }
    const type = payload.type as string;

    if (type === "message_start") {
      const msg = payload.message as { usage?: { input_tokens?: number } } | undefined;
      if (msg?.usage?.input_tokens != null) usageInput = msg.usage.input_tokens;
    } else if (type === "content_block_start") {
      const idx = payload.index as number;
      const cb = payload.content_block as {
        type: "text" | "tool_use";
        id?: string;
        name?: string;
      };
      blocks.set(idx, { kind: cb.type, id: cb.id, name: cb.name, inputBuf: "" });
      if (cb.type === "tool_use" && cb.id && cb.name) {
        yield { type: "tool_use_start", id: cb.id, name: cb.name };
      }
    } else if (type === "content_block_delta") {
      const idx = payload.index as number;
      const delta = payload.delta as { type: string; text?: string; partial_json?: string };
      const block = blocks.get(idx);
      if (!block) continue;
      if (delta.type === "text_delta" && delta.text != null) {
        yield { type: "text_delta", text: delta.text };
      } else if (delta.type === "input_json_delta" && delta.partial_json != null && block.id) {
        block.inputBuf += delta.partial_json;
        yield { type: "tool_use_input_delta", id: block.id, partial_json: delta.partial_json };
      }
    } else if (type === "content_block_stop") {
      const idx = payload.index as number;
      const block = blocks.get(idx);
      if (!block) continue;
      if (block.kind === "tool_use" && block.id) {
        let input: Json;
        try {
          input = block.inputBuf ? (JSON.parse(block.inputBuf) as Json) : ({} as Json);
        } catch (e) {
          yield {
            type: "error",
            error: `tool_use ${block.id} input JSON parse failed: ${
              e instanceof Error ? e.message : String(e)
            }`
          };
          blocks.delete(idx);
          continue;
        }
        yield { type: "tool_use_end", id: block.id, input };
      }
      blocks.delete(idx);
    } else if (type === "message_delta") {
      const delta = payload.delta as { stop_reason?: string } | undefined;
      if (delta?.stop_reason) stopReason = delta.stop_reason;
      const usage = payload.usage as { output_tokens?: number } | undefined;
      if (usage?.output_tokens != null) usageOutput = usage.output_tokens;
    } else if (type === "message_stop") {
      yield {
        type: "message_end",
        usage: { input_tokens: usageInput, output_tokens: usageOutput },
        ...(stopReason ? { stop_reason: stopReason } : {})
      };
    }
  }
}

type SseEvent = { event?: string; data?: string };

async function* readSseEvents(stream: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    if (done) break;
    let nl = buf.indexOf("\n\n");
    while (nl >= 0) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      yield parseSseEvent(raw);
      nl = buf.indexOf("\n\n");
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield parseSseEvent(buf);
}

function parseSseEvent(raw: string): SseEvent {
  const out: SseEvent = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) out.event = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const piece = line.slice(5).trimStart();
      out.data = (out.data ?? "") + piece;
    }
  }
  return out;
}

export const anthropicClient: LlmClient = {
  async *stream(input) {
    const body = {
      model: input.model,
      max_tokens: input.maxTokens ?? 4096,
      system: input.system,
      messages: input.messages.map(toAnthropicMessage),
      tools: input.tools.map((t: LlmTool) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema
      })),
      stream: true
    };
    const base = input.endpoint?.trim() || ANTHROPIC_DEFAULT_BASE;
    const url = /\/v\d/.test(base) ? joinUrl(base, "/messages") : joinUrl(base, "/v1/messages");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(body),
      signal: input.abortSignal
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "<no body>");
      yield {
        type: "error",
        error: formatLlmHttpError("Anthropic", res.status, bodyText)
      };
      return;
    }
    if (!res.body) {
      yield { type: "error", error: "Anthropic: empty body" };
      return;
    }
    yield* parseAnthropicStream(res.body);
  }
};
