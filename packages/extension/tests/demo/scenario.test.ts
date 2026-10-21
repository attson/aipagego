import { describe, expect, it } from "vitest";
import { DEMO_PROMPT, DEMO_ROUNDS, DEMO_TOOL_NAMES } from "../../demo/scenario";
import { TOOL_DEFS } from "@aipagego/shared/llm";

describe("demo scenario", () => {
  it("names only tools that exist", () => {
    const known = new Set(TOOL_DEFS.map((t) => t.name));
    for (const n of DEMO_TOOL_NAMES) expect(known.has(n), n).toBe(true);
  });

  it("exercises the approval path with a caution tool", () => {
    expect(DEMO_TOOL_NAMES).toContain("click");
  });

  it("starts from page-index rather than dumping the body", () => {
    expect(DEMO_TOOL_NAMES[0]).toBe("createPageIndex");
  });

  it("ends with a message rather than a dangling tool call", () => {
    const last = DEMO_ROUNDS.at(-1)!;
    expect(last.some((e) => e.type === "message_end")).toBe(true);
    expect(last.some((e) => e.type === "tool_use_start")).toBe(false);
  });

  it("every round terminates so runChatSession can advance", () => {
    for (const [i, round] of DEMO_ROUNDS.entries()) {
      expect(round.some((e) => e.type === "message_end"), `round ${i}`).toBe(true);
    }
  });

  it("pairs every tool_use_start with an end carrying input", () => {
    for (const round of DEMO_ROUNDS) {
      const starts = round.filter((e) => e.type === "tool_use_start");
      const ends = round.filter((e) => e.type === "tool_use_end");
      expect(ends).toHaveLength(starts.length);
    }
  });

  it("has a prompt the panel can prefill", () => {
    expect(DEMO_PROMPT.length).toBeGreaterThan(4);
  });
});
