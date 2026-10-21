import { describe, expect, it } from "vitest";
import { runSteps } from "@/content/runner";
import type { Step } from "@aipagego/shared/types";

describe("Step Runner", () => {
  it("runs tool steps in order and binds results", async () => {
    const steps: Step[] = [
      { kind: "tool", tool: "extractText", args: { selector: "x" }, bindResultTo: "title" },
      { kind: "tool", tool: "extractText", args: { selector: "${title}" } }
    ];
    const calls: { tool: string; args: unknown }[] = [];
    const result = await runSteps(steps, {
      runTool: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === "extractText") return "captured";
        return null;
      },
      runJs: async () => null
    });

    expect(result.status).toBe("ok");
    expect(calls).toEqual([
      { tool: "extractText", args: { selector: "x" } },
      { tool: "extractText", args: { selector: "captured" } }
    ]);
    expect(result.output).toBe("captured");
  });

  it("propagates tool error and stops", async () => {
    const steps: Step[] = [
      { kind: "tool", tool: "extractText", args: { selector: "x" } },
      { kind: "tool", tool: "extractText", args: { selector: "y" } }
    ];
    const calls: number[] = [];
    const result = await runSteps(steps, {
      runTool: async (_, __, idx) => {
        calls.push(idx);
        if (idx === 0) throw new Error("boom");
        return null;
      },
      runJs: async () => null
    });
    expect(result.status).toBe("error");
    expect(result.stepLog).toHaveLength(1);
    expect(result.stepLog[0].error).toContain("boom");
    expect(calls).toEqual([0]);
  });

  it("times out a long step", async () => {
    const steps: Step[] = [
      { kind: "tool", tool: "waitFor", args: { ms: 500 }, timeoutMs: 50 }
    ];
    const result = await runSteps(steps, {
      runTool: () => new Promise((res) => setTimeout(() => res(null), 500)),
      runJs: async () => null
    });
    expect(result.status).toBe("error");
    expect(result.stepLog[0].error).toMatch(/timeout/i);
  });

  it("substitutes ${var} in nested objects and arrays", async () => {
    const steps: Step[] = [
      { kind: "tool", tool: "extractText", args: { selector: "h1" }, bindResultTo: "t" },
      {
        kind: "tool",
        tool: "querySelectorAll",
        args: { selectors: ["${t}", { wrap: "${t}" }] }
      }
    ];
    let captured: unknown = null;
    await runSteps(steps, {
      runTool: async (_, args, idx) => {
        if (idx === 0) return "X";
        captured = args;
        return null;
      },
      runJs: async () => null
    });
    expect(captured).toEqual({ selectors: ["X", { wrap: "X" }] });
  });

  it("calls runJs for js steps", async () => {
    const steps: Step[] = [{ kind: "js", source: "return 1+1" }];
    const result = await runSteps(steps, {
      runTool: async () => null,
      runJs: async (src) => (src === "return 1+1" ? 2 : null)
    });
    expect(result.output).toBe(2);
  });
});
