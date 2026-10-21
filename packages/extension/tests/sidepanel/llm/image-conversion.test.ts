import { describe, expect, it } from "vitest";
import type { ChatMessage, ImagePart } from "@aipagego/shared/types";
import { toAnthropicMessage } from "@/sidepanel/llm/anthropic";

const img: ImagePart = { type: "image", media_type: "image/png", data: "AAAA" };

describe("toAnthropicMessage", () => {
  it("string content passes through unchanged", () => {
    const m: ChatMessage = { role: "user", content: "hello" };
    expect(toAnthropicMessage(m)).toEqual(m);
  });

  it("image part becomes anthropic image block", () => {
    const m: ChatMessage = {
      role: "user",
      content: [img, { type: "text", text: "what is this?" }],
    };
    const out = toAnthropicMessage(m) as { role: string; content: unknown[] };
    expect(out.role).toBe("user");
    expect(out.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "what is this?" },
    ]);
  });

  it("assistant message untouched", () => {
    const m: ChatMessage = { role: "assistant", content: [{ type: "text", text: "ok" }] };
    expect(toAnthropicMessage(m)).toEqual(m);
  });
});
