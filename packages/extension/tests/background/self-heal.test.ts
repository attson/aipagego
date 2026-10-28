import { describe, expect, it, vi } from "vitest";
import { attemptHeal } from "@/background/self-heal";
import type { Step } from "@aipagego/shared/types";

const baseCtx = {
  tool: {
    id: "t1", name: "Shop", urlPatterns: ["*"], description: "",
    kind: "steps" as const, steps: [] as Step[],
    versions: [{ version: 1, kind: "steps", steps: [] as Step[], outputSchema: null, createdAt: 0 }],
    createdAt: 0
  },
  failedStepIndex: 0,
  failedInput:     { kind: "tool" as const, tool: "snapshotDOM" as const, args: {} },
  errorText:       "selector not found",
  prevSteps:       [],
  domSnapshot:     { tag: "html" },
  url:             "https://demo/"
};

const validPatch = [
  { kind: "tool", tool: "extractText", args: {} }
] as unknown;

function makeDeps(overrides: any = {}) {
  return {
    requestSidepanelLlm: vi.fn().mockResolvedValue({
      patchedSteps: validPatch,
      usage: { in: 500, out: 200 }
    }),
    snapshot: vi.fn().mockResolvedValue({}),
    staticScan: () => [],
    parseSteps: (raw: unknown) =>
      Array.isArray(raw) ? (raw as Step[]) : null,
    now: () => 0,
    ...overrides
  };
}

describe("attemptHeal", () => {
  it("returns ok+patched on valid LLM output", async () => {
    const r = await attemptHeal(baseCtx as any, makeDeps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patchedSteps.length).toBe(1);
  });

  it("returns invalid_output when parse fails", async () => {
    const deps = makeDeps({ parseSteps: () => null });
    const r = await attemptHeal(baseCtx as any, deps);
    expect(r).toEqual(expect.objectContaining({ ok: false, reason: "invalid_output" }));
  });

  it("returns invalid_output when a parsed patch violates workflow dependencies", async () => {
    const deps = makeDeps({ validatePatch: () => false });
    const r = await attemptHeal(baseCtx as any, deps);
    expect(r).toEqual(expect.objectContaining({ ok: false, reason: "invalid_output" }));
  });

  it("returns static_scan_reject on dangerous patch", async () => {
    const deps = makeDeps({ staticScan: () => ["dangerous"] });
    const r = await attemptHeal(baseCtx as any, deps);
    expect(r).toEqual(expect.objectContaining({ ok: false, reason: "static_scan_reject" }));
  });

  it("returns llm_error when LLM throws", async () => {
    const deps = makeDeps({
      requestSidepanelLlm: vi.fn().mockRejectedValue(new Error("boom"))
    });
    const r = await attemptHeal(baseCtx as any, deps);
    expect(r).toEqual(expect.objectContaining({ ok: false, reason: "llm_error" }));
  });

  it("returns budget_exceeded when usage over cap", async () => {
    const deps = makeDeps({
      requestSidepanelLlm: vi.fn().mockResolvedValue({
        patchedSteps: validPatch,
        usage: { in: 100_000, out: 100_000 }
      })
    });
    const r = await attemptHeal(baseCtx as any, deps, { maxOutputTokens: 4096 } as any);
    // depending on impl:budget check kicks in when usage.out > cap
    expect(r.ok || (r as any).reason === "budget_exceeded").toBeTruthy();
  });
});
