import { describe, expect, it } from "vitest";
import { buildJobOutputSnapshot, diffJobOutputs } from "@/background/jobs/history";

describe("Job output history", () => {
  it("hashes the full output while keeping a structured preview within 64 KiB", async () => {
    const output = { title: "report", rows: Array.from({ length: 5_000 }, (_, i) => ({ i, text: "x".repeat(40) })) };
    const snapshot = await buildJobOutputSnapshot(output);
    expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.originalBytes).toBeGreaterThan(64 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(snapshot.preview)).byteLength)
      .toBeLessThanOrEqual(64 * 1024);
    expect(snapshot.preview).toMatchObject({ title: "report" });
  });

  it("produces JSON-path changes and caps them at 100", () => {
    expect(diffJobOutputs(
      { price: 10, nested: { state: "old" }, removed: true },
      { price: 12, nested: { state: "new" }, added: true },
    )).toEqual({
      changes: [
        { path: "$.added", after: true },
        { path: "$.nested.state", before: "old", after: "new" },
        { path: "$.price", before: 10, after: 12 },
        { path: "$.removed", before: true },
      ],
      truncated: false,
    });
    const manyBefore = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`k${i}`, i]));
    const manyAfter = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`k${i}`, i + 1]));
    const capped = diffJobOutputs(manyBefore, manyAfter);
    expect(capped.changes).toHaveLength(100);
    expect(capped.truncated).toBe(true);
  });
});
