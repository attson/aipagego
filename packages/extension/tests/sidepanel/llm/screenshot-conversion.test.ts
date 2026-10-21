import { describe, expect, it } from "vitest";
import type { ChatMessage, ImagePart, ToolResultPart } from "@aipagego/shared/types";
import { toAnthropicMessage } from "@/sidepanel/llm/anthropic";

const screenshotPng: ImagePart = { type: "image", media_type: "image/png", data: "AAAA" };

describe("toAnthropicMessage — screenshot tool_result", () => {
  it("transforms image blocks nested inside tool_result.content", () => {
    const trp: ToolResultPart = {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: [
        { type: "text", text: "screenshot:ok" },
        screenshotPng
      ]
    };
    const m: ChatMessage = { role: "user", content: [trp] };
    const out = toAnthropicMessage(m) as { role: string; content: unknown[] };
    expect(out.role).toBe("user");
    const trpOut = out.content[0] as { type: string; content: unknown[] };
    expect(trpOut.type).toBe("tool_result");
    expect(trpOut.content).toEqual([
      { type: "text", text: "screenshot:ok" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }
    ]);
  });

  it("string tool_result.content untouched", () => {
    const trp: ToolResultPart = {
      type: "tool_result",
      tool_use_id: "tu_2",
      content: "{}"
    };
    const m: ChatMessage = { role: "user", content: [trp] };
    const out = toAnthropicMessage(m) as { role: string; content: ToolResultPart[] };
    expect(out.content[0].content).toBe("{}");
  });
});
