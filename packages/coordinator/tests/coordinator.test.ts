import { describe, it, expect, vi } from "vitest";
import { Coordinator } from "../src/coordinator";
import { FakeClock, FakeIdGen } from "../src/clock";
import { SESSION_IDLE_TIMEOUT_MS } from "@aipagego/shared/protocol";
import type { WSHub } from "../src/ws-hub";
import type { Worker } from "../src/types";

function fakeHub(): WSHub {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    onDisconnect: vi.fn(),
    connectedWorkers: () => [],
    disconnect: vi.fn().mockResolvedValue(undefined)
  };
}

function newCoord() {
  const clock = new FakeClock(1000);
  const idGen = new FakeIdGen();
  const hub = fakeHub();
  return { coord: new Coordinator({ hub, clock, idGen }), clock, idGen, hub };
}

function makeWorker(id: string, overrides: Partial<Worker> = {}): Worker {
  return {
    id,
    fingerprint: { ext_hash: "h", os: "darwin", chrome: "120" },
    capabilities: new Set(["read:dom", "interact:form", "submit:form"]),
    attended: true,
    labels: new Set(),
    available_tabs: [{ tab_id: "t1", url: "https://shop.example.com/goods.html" }],
    saved_tools: [
      {
        id: "shop_v3",
        version: 1,
        hash: "abc",
        url_pattern: ["https://*.example.com/**"]
      }
    ],
    protocol_version: 1,
    connected_at: 0,
    last_heartbeat_at: 0,
    ...overrides
  };
}

describe("Coordinator happy path", () => {
  it("worker register → open session → list tools → call submitForm → close", () => {
    const { coord, hub } = newCoord();
    coord.registerWorker(makeWorker("w1"));

    const session = coord.openSession({
      ai_client_fingerprint: "ai-1",
      worker_id: "w1",
      tab_id: "t1",
      scope: new Set(["interact:form", "submit:form"])
    });
    expect(session.state).toBe("active");

    const tools = coord.listToolsForSession(session.id);
    expect(tools?.map((t) => t.id)).toEqual(["shop_v3"]);

    const validate = coord.validateCall({
      session_id: session.id,
      kind: "extension_tool",
      tool: "submitForm"
    });
    expect(validate.ok).toBe(true);

    if (validate.ok) coord.recordCall(session.id, validate.dangerous);
    expect(coord.sessions.get(session.id)?.dangerous_count).toBe(1);

    vi.mocked(hub.send).mockClear();
    coord.closeSession(session.id);
    expect(coord.sessions.get(session.id)?.state).toBe("closed");
    expect(hub.send).toHaveBeenCalledWith("w1", expect.objectContaining({
      type: "CLOSE_SESSION",
      session_id: session.id
    }));
  });
});

describe("Coordinator denials", () => {
  it("denies submitForm when not in scope", () => {
    const { coord } = newCoord();
    coord.registerWorker(makeWorker("w1"));
    const session = coord.openSession({
      ai_client_fingerprint: "ai-1",
      worker_id: "w1",
      tab_id: "t1",
      scope: new Set(["interact:form"])
    });
    const v = coord.validateCall({
      session_id: session.id,
      kind: "extension_tool",
      tool: "submitForm"
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error.code).toBe("PermissionDenied");
      expect(v.error.hints?.denied_capability).toBe("submit:form");
    }
  });
});

describe("Coordinator periodic tick", () => {
  it("expires idle sessions", () => {
    const { coord, clock, hub } = newCoord();
    coord.registerWorker(makeWorker("w1"));
    const session = coord.openSession({
      ai_client_fingerprint: "ai-1",
      worker_id: "w1",
      tab_id: "t1",
      scope: new Set([])
    });
    vi.mocked(hub.send).mockClear();
    clock.tick(SESSION_IDLE_TIMEOUT_MS + 1);
    const { expired_sessions } = coord.tick();
    expect(expired_sessions).toContain(session.id);
    expect(coord.sessions.get(session.id)?.state).toBe("expired");
    expect(hub.send).toHaveBeenCalledWith("w1", expect.objectContaining({
      type: "CLOSE_SESSION",
      session_id: session.id
    }));
  });
});

describe("Coordinator worker disconnect", () => {
  it("pauses sessions when worker unregisters", () => {
    const { coord } = newCoord();
    coord.registerWorker(makeWorker("w1"));
    const session = coord.openSession({
      ai_client_fingerprint: "ai-1",
      worker_id: "w1",
      tab_id: "t1",
      scope: new Set(["interact:form"])
    });
    coord.unregisterWorker("w1");
    expect(coord.sessions.get(session.id)?.state).toBe("paused");
  });
});
