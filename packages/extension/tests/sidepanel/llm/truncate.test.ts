import { describe, expect, it } from "vitest";
import { truncateContent, truncateMessages } from "@/sidepanel/llm/truncate";
import type { ChatMessage } from "@aipagego/shared/types";

describe("truncateContent", () => {
  it("returns as-is when within cap", () => {
    expect(truncateContent("hello", 10)).toBe("hello");
  });
  it("returns as-is when exactly at cap", () => {
    expect(truncateContent("12345", 5)).toBe("12345");
  });
  it("truncates head+tail with marker when over cap", () => {
    const s = "a".repeat(100);
    const out = truncateContent(s, 10);
    expect(out).toContain("[截断 90 字]");
    expect(out.length).toBeLessThan(s.length);
  });
  it("handles empty string", () => {
    expect(truncateContent("", 10)).toBe("");
  });
});

describe("truncateMessages", () => {
  it("truncates a long user string content", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "x".repeat(50) }];
    const out = truncateMessages(msgs, 10);
    expect(typeof out[0].content).toBe("string");
    expect(out[0].content as string).toContain("[截断");
  });
  it("truncates tool_result content but keeps structure", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "y".repeat(50) }] }
    ];
    const out = truncateMessages(msgs, 10);
    const part = (out[0].content as Array<{ type: string; tool_use_id?: string; content?: string }>)[0];
    expect(part.type).toBe("tool_result");
    expect(part.tool_use_id).toBe("t1");
    expect(part.content).toContain("[截断");
  });
  it("leaves tool_use parts untouched", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "snapshotDOM", input: { a: 1 } }] }
    ];
    const out = truncateMessages(msgs, 10);
    const part = (out[0].content as Array<{ type: string; input?: unknown }>)[0];
    expect(part.type).toBe("tool_use");
    expect(part.input).toEqual({ a: 1 });
  });
});
