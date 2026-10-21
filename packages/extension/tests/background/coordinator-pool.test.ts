import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatorPool, endpointFor } from "@/background/coordinator-pool";
import type { PairPayload } from "@aipagego/shared/pairing";

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  onopen: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(public url: string, public protocols?: string | string[]) {
    FakeWS.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.({ code: 1000 } as CloseEvent);
  }
}

function fakeChrome() {
  return {
    tabs: { query: vi.fn(async () => []) },
    runtime: { id: "ext", getManifest: () => ({ version: "0.0.1" }) },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  };
}

const payload = (over: Partial<PairPayload> = {}): PairPayload => ({
  v: 1,
  installId: "inst_abc",
  secret: "s",
  sessionId: "sess_1",
  label: "~/code/aipagego",
  pid: 1,
  port: 51234,
  mcpVersion: "0.0.75",
  ...over
});

function makePool() {
  return new CoordinatorPool({
    clientOptions: () => ({
      token: "t",
      worker_id: "w1",
      savedToolsProvider: async () => [],
      labelsProvider: async () => []
    })
  });
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("chrome", fakeChrome());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CoordinatorPool", () => {
  it("holds one connection per paired session", async () => {
    const pool = makePool();
    await pool.addFromPairing(payload());
    await pool.addFromPairing(payload({ sessionId: "sess_2", port: 51299, label: "~/code/wanxin" }));

    expect(pool.size).toBe(2);
    expect(pool.list().map((e) => e.endpoint)).toEqual([
      endpointFor(51234),
      endpointFor(51299)
    ]);
    expect(FakeWS.instances.map((w) => w.url)).toEqual([
      "ws://127.0.0.1:51234/worker",
      "ws://127.0.0.1:51299/worker"
    ]);
  });

  it("is idempotent for a repeated pairing of the same session", async () => {
    const pool = makePool();
    await pool.addFromPairing(payload());
    await pool.addFromPairing(payload());
    expect(pool.size).toBe(1);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it("carries the label and pid for display", async () => {
    const pool = makePool();
    await pool.addFromPairing(payload());
    expect(pool.list()[0]).toMatchObject({
      label: "~/code/aipagego",
      pid: 1,
      port: 51234,
      installId: "inst_abc",
      mcpVersion: "0.0.75"
    });
  });

  it("remove disconnects and drops the entry", async () => {
    const pool = makePool();
    await pool.addFromPairing(payload());
    await pool.remove("sess_1");
    expect(pool.size).toBe(0);
    expect(FakeWS.instances[0].readyState).toBe(FakeWS.CLOSED);
  });

  it("preserves the caller status callback when disconnecting", async () => {
    const onStatusChange = vi.fn();
    const pool = new CoordinatorPool({
      clientOptions: () => ({
        token: "t",
        worker_id: "w1",
        savedToolsProvider: async () => [],
        labelsProvider: async () => [],
        onStatusChange
      })
    });
    await pool.addFromPairing(payload());
    onStatusChange.mockClear();

    await pool.remove("sess_1");

    expect(onStatusChange).toHaveBeenCalledWith("disconnected");
  });

  it("removing an unknown session is a no-op", async () => {
    const pool = makePool();
    await expect(pool.remove("nope")).resolves.toBeUndefined();
  });

  it("reports a dormant endpoint and can wake it", async () => {
    const pool = makePool();
    await pool.addFromPairing(payload());
    const ws = FakeWS.instances[0];
    ws.readyState = FakeWS.CLOSED;
    ws.onclose?.({ code: 4000, reason: "server-shutting-down" } as CloseEvent);

    expect(pool.list()[0].status).toBe("dormant");

    pool.wake("sess_1");
    expect(pool.list()[0].status).toBe("connecting");
    expect(FakeWS.instances.length).toBe(2);
  });

  it("a dormant entry is not overwritten by a later status change", async () => {
    const pool = makePool();
    await pool.addFromPairing(payload());
    const ws = FakeWS.instances[0];
    ws.readyState = FakeWS.CLOSED;
    ws.onclose?.({ code: 4000 } as CloseEvent);
    expect(pool.list()[0].status).toBe("dormant");
  });

  it("notifies on change", async () => {
    const onChange = vi.fn();
    const pool = new CoordinatorPool({
      clientOptions: () => ({
        token: "t",
        worker_id: "w1",
        savedToolsProvider: async () => [],
        labelsProvider: async () => []
      }),
      onChange
    });
    await pool.addFromPairing(payload());
    expect(onChange).toHaveBeenCalled();
  });

  it("the legacy single-URL config becomes exactly one entry", async () => {
    const pool = makePool();
    await pool.add({
      source: "manual",
      endpoint: "ws://127.0.0.1:8787/worker",
      installId: "legacy",
      sessionId: "legacy",
      label: "手动配置",
      pid: 0,
      port: 8787
    });
    expect(pool.size).toBe(1);
    expect(pool.list()[0].sessionId).toBe("legacy");
  });

  it("disposeAll clears everything", async () => {
    const pool = makePool();
    await pool.addFromPairing(payload());
    await pool.addFromPairing(payload({ sessionId: "sess_2", port: 51299 }));
    await pool.disposeAll();
    expect(pool.size).toBe(0);
    expect(FakeWS.instances.every((w) => w.readyState === FakeWS.CLOSED)).toBe(true);
  });
});
