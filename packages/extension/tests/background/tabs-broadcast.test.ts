import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatorPool } from "@/background/coordinator-pool";
import { TabOwnership } from "@/background/tab-ownership";
import { broadcastTabs } from "@/background/tabs-broadcast";
import type { PairPayload } from "@aipagego/shared/pairing";

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 1; // OPEN, so sendTabsUpdate goes through
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  onopen: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = FakeWS.CLOSED;
  }
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn(async () => []) },
    runtime: { id: "ext", getManifest: () => ({ version: "0.0.1" }) },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const payload = (over: Partial<PairPayload> = {}): PairPayload => ({
  v: 1,
  installId: "inst",
  secret: "s",
  sessionId: "conn-a",
  label: "~/code/aipagego",
  pid: 1,
  port: 51234,
  ...over
});

function tabsUpdatesFrom(ws: FakeWS) {
  return ws.sent
    .map((raw) => JSON.parse(raw) as { type: string; tabs?: unknown[] })
    .filter((m) => m.type === "TABS_UPDATE");
}

async function twoConnectionPool() {
  const pool = new CoordinatorPool({
    clientOptions: () => ({
      token: "t",
      worker_id: "w1",
      savedToolsProvider: async () => [],
      labelsProvider: async () => []
    })
  });
  await pool.addFromPairing(payload());
  await pool.addFromPairing(
    payload({ sessionId: "conn-b", port: 51299, label: "~/code/wanxin" })
  );
  return pool;
}

describe("broadcastTabs", () => {
  it("sends every connection its own view", async () => {
    const pool = await twoConnectionPool();
    const ownership = new TabOwnership();
    ownership.claim("1", {
      connectionId: "conn-a",
      sessionId: "sess-a",
      label: "~/code/aipagego"
    });

    await broadcastTabs({
      pool,
      ownership,
      queryTabs: async () => [
        { tab_id: "1", url: "https://a.test", title: "A" },
        { tab_id: "2", url: "https://b.test", title: "B" }
      ]
    });

    const [wsA, wsB] = FakeWS.instances;
    const toA = tabsUpdatesFrom(wsA).at(-1)!.tabs as Array<Record<string, unknown>>;
    const toB = tabsUpdatesFrom(wsB).at(-1)!.tabs as Array<Record<string, unknown>>;

    // conn-a holds tab 1; it is "mine" to A and "busy" to B.
    expect(toA[0]).toMatchObject({ tab_id: "1", mine: true, busy: false });
    expect(toB[0]).toMatchObject({ tab_id: "1", mine: false, busy: true, busy_label: "~/code/aipagego" });
    // Nobody holds tab 2.
    expect(toA[1]).toMatchObject({ busy: false, mine: false });
    expect(toB[1]).toMatchObject({ busy: false, mine: false });
  });

  it("reflects a tab opened after the connections were established", async () => {
    const pool = await twoConnectionPool();
    const ownership = new TabOwnership();
    let tabs = [{ tab_id: "1", url: "https://a.test" }];

    await broadcastTabs({ pool, ownership, queryTabs: async () => tabs });
    tabs = [...tabs, { tab_id: "9", url: "https://new.test" }];
    await broadcastTabs({ pool, ownership, queryTabs: async () => tabs });

    const latest = tabsUpdatesFrom(FakeWS.instances[0]).at(-1)!.tabs as Array<{ tab_id: string }>;
    expect(latest.map((t) => t.tab_id)).toEqual(["1", "9"]);
  });

  it("releasing ownership makes the tab free again for everyone", async () => {
    const pool = await twoConnectionPool();
    const ownership = new TabOwnership();
    ownership.claim("1", { connectionId: "conn-a", sessionId: "sess-a", label: "x" });
    const query = async () => [{ tab_id: "1", url: "https://a.test" }];

    await broadcastTabs({ pool, ownership, queryTabs: query });
    ownership.releaseBySession("sess-a");
    await broadcastTabs({ pool, ownership, queryTabs: query });

    const toB = tabsUpdatesFrom(FakeWS.instances[1]).at(-1)!.tabs as Array<{ busy: boolean }>;
    expect(toB[0].busy).toBe(false);
  });

  it("skips a disconnected client without throwing", async () => {
    const pool = await twoConnectionPool();
    FakeWS.instances[0].readyState = FakeWS.CLOSED;
    await expect(
      broadcastTabs({
        pool,
        ownership: new TabOwnership(),
        queryTabs: async () => [{ tab_id: "1", url: "https://a.test" }]
      })
    ).resolves.toBeUndefined();
    expect(tabsUpdatesFrom(FakeWS.instances[0])).toHaveLength(0);
    expect(tabsUpdatesFrom(FakeWS.instances[1])).toHaveLength(1);
  });

  it("survives a tab query failure", async () => {
    const pool = await twoConnectionPool();
    await expect(
      broadcastTabs({
        pool,
        ownership: new TabOwnership(),
        queryTabs: async () => {
          throw new Error("no permission");
        }
      })
    ).resolves.toBeUndefined();
  });
});
