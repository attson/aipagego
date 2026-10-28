// packages/shared/tests/protocol/chat-event.test.ts
import { describe, it, expect } from "vitest";
import { ChatSessionEventSchema, ChatSessionStatusSchema } from "../../src/protocol/chat-event";

describe("ChatSessionStatusSchema", () => {
  it.each(["idle","streaming","awaiting","running","done","error","aborted"] as const)(
    "accepts %s", (s) => {
      const r = ChatSessionStatusSchema.safeParse(s);
      expect(r.success).toBe(true);
    });
  it("rejects unknown", () => {
    expect(ChatSessionStatusSchema.safeParse("frobnicated").success).toBe(false);
  });
});

describe("ChatSessionEventSchema", () => {
  const variants: Array<unknown> = [
    { type: "round_start", round: 0 },
    { type: "text_delta", text: "hi" },
    { type: "tool_use_start", id: "t1", name: "snapshotDOM" },
    { type: "tool_use_input_delta", id: "t1", partial_json: "{" },
    { type: "tool_use_end", id: "t1", input: { a: 1 } },
    { type: "assistant_turn_end", toolUses: [] },
    { type: "tool_running", id: "t1" },
    { type: "tool_done", id: "t1", output: { ok: true }, ms: 12 },
    { type: "tool_error", id: "t1", error: "boom", ms: 5 },
    { type: "tool_skipped", id: "t1" },
    { type: "usage", input_tokens: 100, output_tokens: 50 },
    { type: "continuation_nudge", round: 2, attempt: 1 },
    { type: "stream_error", error: "x" },
    { type: "exception", error: "x" },
    { type: "session_end", status: "done", lastOutput: null },
    { type: "session_end", status: "error", lastOutput: null, reason: "explicit" }
  ];
  it.each(variants)("round-trips variant %#", (v) => {
    const r = ChatSessionEventSchema.safeParse(v);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(v);
  });

  it("rejects unknown variant", () => {
    expect(ChatSessionEventSchema.safeParse({ type: "imaginary" }).success).toBe(false);
  });
});

describe("self_heal_* SessionEvents", () => {
  const cases = [
    { type: "self_heal_started", toolId: "t1", toolName: "Shop 采集", failedStepIndex: 2 },
    { type: "self_heal_completed", toolId: "t1", newVersion: 2, fixedStepIndex: 2 },
    { type: "self_heal_failed", toolId: "t1", reason: "invalid_output" }
  ];
  for (const c of cases) {
    it(`round-trip ${c.type}`, () => {
      const r = ChatSessionEventSchema.safeParse(c);
      expect(r.success).toBe(true);
    });
  }
});

describe("permission_* SessionEvents", () => {
  const cases = [
    {
      type: "permission_required",
      toolUseId: "t1",
      permission: "bookmarks",
      capability: "searchBookmarks",
    },
    {
      type: "permission_resolved",
      toolUseId: "t1",
      permission: "bookmarks",
      granted: false,
    },
  ];

  it.each(cases)("round-trips $type", (event) => {
    expect(ChatSessionEventSchema.parse(event)).toEqual(event);
  });
});
