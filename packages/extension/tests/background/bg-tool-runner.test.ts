import { describe, it, expect, vi } from "vitest";
import type { ReplayableTool } from "@aipagego/shared/types";
import { BackgroundToolRunner } from "@/background/bg-tool-runner";
import * as rpc from "@/background/rpc-handlers";

describe("BackgroundToolRunner", () => {
  it("delegates runStep to runOneStep with the same args", async () => {
    const spy = vi.spyOn(rpc, "runOneStep").mockResolvedValue({ ok: true });
    const r = new BackgroundToolRunner();
    const step = { kind: "tool" as const, tool: "snapshotDOM" as ReplayableTool, args: { maxDepth: 2 } };
    const out = await r.runStep(step, 42, [43, 44], { binding: "v" });
    expect(spy).toHaveBeenCalledWith(
      step,
      42,
      [43, 44],
      { binding: "v" },
      { source: "coordinator" },
    );
    expect(out).toEqual({ ok: true });
    spy.mockRestore();
  });
});
