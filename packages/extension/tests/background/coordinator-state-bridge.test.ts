import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoordinatorStateBridge } from "@/background/coordinator-state-bridge";
import type { ServerToClient, ClientToServer } from "@aipagego/shared/protocol";

function makeEnv() { return { nonce: "n", ts: 0, protocol_version: 1 }; }

function fakeRuntime(): {
  send: ReturnType<typeof vi.fn>;
  listener: ((msg: unknown) => void) | null;
  addListener: (fn: (msg: unknown) => void) => void;
} {
  let listener: ((msg: unknown) => void) | null = null;
  return {
    send: vi.fn(),
    get listener() { return listener; },
    addListener(fn) { listener = fn; }
  };
}

beforeEach(() => { vi.useFakeTimers(); });

describe("CoordinatorStateBridge", () => {
  it("requests state and returns reply with snapshot when sidepanel responds", async () => {
    const out: ClientToServer[] = [];
    const rt = fakeRuntime();
    const bridge = new CoordinatorStateBridge({
      sendRuntimeMessage: rt.send,
      onRuntimeMessage: rt.addListener,
      timeoutMs: 500
    });
    const msg: ServerToClient = {
      ...makeEnv(), type: "READ_SIDEPANEL_STATE", req_id: "r1", tab_id: "42"
    };
    const p = bridge.handle(msg, (m) => out.push(m));
    // simulate sidepanel pong
    expect(rt.send).toHaveBeenCalledWith({
      type: "ping.sidepanelState", req_id: "r1", tab_id: "42"
    });
    rt.listener?.({
      type: "pong.sidepanelState", req_id: "r1", found: true,
      snapshot: { status: "idle", messagesCount: 0, attachedTabs: [] }
    });
    await p;
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("SIDEPANEL_STATE_REPLY");
    if (out[0].type !== "SIDEPANEL_STATE_REPLY") throw new Error();
    expect(out[0].req_id).toBe("r1");
    expect(out[0].found).toBe(true);
    expect(out[0].snapshot).toEqual({ status: "idle", messagesCount: 0, attachedTabs: [] });
  });

  it("returns found:false on timeout when no sidepanel responds", async () => {
    const out: ClientToServer[] = [];
    const rt = fakeRuntime();
    const bridge = new CoordinatorStateBridge({
      sendRuntimeMessage: rt.send,
      onRuntimeMessage: rt.addListener,
      timeoutMs: 500
    });
    const msg: ServerToClient = {
      ...makeEnv(), type: "READ_SIDEPANEL_STATE", req_id: "r2", tab_id: "42"
    };
    const p = bridge.handle(msg, (m) => out.push(m));
    vi.advanceTimersByTime(500);
    await p;
    expect(out).toHaveLength(1);
    if (out[0].type !== "SIDEPANEL_STATE_REPLY") throw new Error();
    expect(out[0].found).toBe(false);
    expect(out[0].snapshot).toBeUndefined();
  });

  it("dispose() removes the runtime listener", () => {
    const removed: Array<(m: unknown) => void> = [];
    const added: Array<(m: unknown) => void> = [];
    const bridge = new CoordinatorStateBridge({
      sendRuntimeMessage: () => undefined,
      onRuntimeMessage: (fn) => { added.push(fn); },
      offRuntimeMessage: (fn) => { removed.push(fn); }
    });
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(0);
    bridge.dispose();
    expect(removed).toHaveLength(1);
    expect(removed[0]).toBe(added[0]);
  });

  it("ignores pongs for mismatched req_id", async () => {
    const out: ClientToServer[] = [];
    const rt = fakeRuntime();
    const bridge = new CoordinatorStateBridge({
      sendRuntimeMessage: rt.send,
      onRuntimeMessage: rt.addListener,
      timeoutMs: 500
    });
    const p = bridge.handle({
      ...makeEnv(), type: "READ_SIDEPANEL_STATE", req_id: "r3", tab_id: "42"
    }, (m) => out.push(m));
    rt.listener?.({ type: "pong.sidepanelState", req_id: "other", found: true });
    vi.advanceTimersByTime(500);
    await p;
    if (out[0].type !== "SIDEPANEL_STATE_REPLY") throw new Error();
    expect(out[0].found).toBe(false);
  });
});
