import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type SelectionCase = {
  id: string;
  category: "use" | "do_not_use" | "clarify" | "fallback";
  prompt: string;
  expected: string;
};

async function readCases(): Promise<SelectionCase[]> {
  const path = fileURLToPath(new URL("../evals/tool-selection-cases.json", import.meta.url));
  return JSON.parse(await readFile(path, "utf8")) as SelectionCase[];
}

describe("tool-selection evaluation corpus", () => {
  it("covers positive, negative, ambiguous, and failure boundaries", async () => {
    const cases = await readCases();
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(new Set(cases.map((item) => item.category))).toEqual(
      new Set(["use", "do_not_use", "clarify", "fallback"])
    );
    expect(cases.filter((item) => item.category === "use").length).toBeGreaterThanOrEqual(4);
    expect(cases.filter((item) => item.category === "do_not_use").length).toBeGreaterThanOrEqual(3);
  });

  it("uses unique synthetic prompts with explicit expected behavior", async () => {
    const cases = await readCases();
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    for (const item of cases) {
      expect(item.id).toMatch(/^[a-z0-9-]+$/);
      expect(item.prompt.trim().length).toBeGreaterThan(10);
      expect(item.expected.trim().length).toBeGreaterThan(10);
    }
  });
});

