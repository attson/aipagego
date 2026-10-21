import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { handleExec } from "../../src/background/coordinator-exec";
import { PROTOCOL_VERSION } from "@aipagego/shared/protocol";
import type { Exec } from "@aipagego/shared/protocol";

vi.mock("../../src/background/rpc-handlers", () => ({
  runOneStep: vi.fn()
}));

import { runOneStep } from "../../src/background/rpc-handlers";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

const baseExec: Exec = {
  type: "EXEC",
  nonce: "n1",
  ts: 1,
  protocol_version: PROTOCOL_VERSION,
  req_id: "r1",
  session_id: "s1",
  tab_id: "42",
  step: { kind: "tool", tool: "snapshotDOM", args: {} }
};

describe("handleExec", () => {
  it("calls runOneStep with (step, numeric tab id, [], {})", async () => {
    (runOneStep as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ html: "<div/>" });
    await handleExec(baseExec);
    const args = (runOneStep as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args[0]).toEqual({ kind: "tool", tool: "snapshotDOM", args: {} });
    expect(args[1]).toBe(42);
    expect(args[2]).toEqual([]);
    expect(args[3]).toEqual({});
  });

  it("returns RESULT with ok=true and return=<runOneStep return value>", async () => {
    (runOneStep as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ html: "<div/>" });
    const r = await handleExec(baseExec);
    expect(r.type).toBe("RESULT");
    expect(r.req_id).toBe("r1");
    expect(r.ok).toBe(true);
    expect(r.return).toEqual({ html: "<div/>" });
  });

  it("returns RESULT with ok=false + PageScriptError when runOneStep throws", async () => {
    (runOneStep as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("tab closed"));
    const r = await handleExec(baseExec);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("PageScriptError");
    expect(r.error?.message).toContain("tab closed");
    expect(r.error?.retryable).toBe(false);
  });

  it("returns InvalidArgs when tab_id is not a number", async () => {
    const bad: Exec = { ...baseExec, tab_id: "not-a-number" };
    const r = await handleExec(bad);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("InvalidArgs");
  });

  it("PROTOCOL_VERSION and type=RESULT are always set", async () => {
    (runOneStep as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await handleExec(baseExec);
    expect(r.type).toBe("RESULT");
    expect(r.protocol_version).toBe(PROTOCOL_VERSION);
  });

  it("returns a PageScriptError before the hub timeout when a step never settles", async () => {
    vi.useFakeTimers();
    (runOneStep as unknown as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => undefined));
    const pending = handleExec({
      ...baseExec,
      step: { kind: "js", source: "await new Promise(() => {})", timeoutMs: 1000 }
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("step timeout after 1000ms");
  });
});
