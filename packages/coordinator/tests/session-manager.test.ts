import { describe, it, expect } from "vitest";
import { SessionManager, type OpenSessionInput } from "../src/session-manager";
import { FakeClock, FakeIdGen } from "../src/clock";
import {
  SESSION_IDLE_TIMEOUT_MS,
  ORPHAN_RECOVERY_MS
} from "@aipagego/shared/protocol";

function newMgr() {
  const clock = new FakeClock(1000);
  const idGen = new FakeIdGen();
  return { mgr: new SessionManager(clock, idGen), clock, idGen };
}

const baseOpen: OpenSessionInput = {
  ai_client_fingerprint: "ai-1",
  worker_id: "w1",
  tab_id: "t1",
  scope: new Set(["interact:form"]),
  idle_timeout_ms: SESSION_IDLE_TIMEOUT_MS
};

describe("SessionManager.open", () => {
  it("creates a session in active state", () => {
    const { mgr, clock } = newMgr();
    const s = mgr.open(baseOpen);
    expect(s.id).toBe("session_1");
    expect(s.state).toBe("active");
    expect(s.created_at).toBe(clock.now());
    expect(s.last_activity_at).toBe(clock.now());
  });
});

describe("SessionManager.touch", () => {
  it("updates last_activity_at and step_count", () => {
    const { mgr, clock } = newMgr();
    const { id } = mgr.open(baseOpen);
    clock.tick(5_000);
    mgr.touch(id, { dangerous: false });
    const s = mgr.get(id)!;
    expect(s.last_activity_at).toBe(clock.now());
    expect(s.step_count).toBe(1);
    expect(s.dangerous_count).toBe(0);
  });

  it("increments dangerous_count when dangerous=true", () => {
    const { mgr, clock } = newMgr();
    const { id } = mgr.open(baseOpen);
    clock.tick(1);
    mgr.touch(id, { dangerous: true });
    expect(mgr.get(id)?.dangerous_count).toBe(1);
  });

  it("throws if session is not active", () => {
    const { mgr } = newMgr();
    const { id } = mgr.open(baseOpen);
    mgr.close(id);
    expect(() => mgr.touch(id, { dangerous: false })).toThrow(/not active/);
  });
});

describe("SessionManager.close", () => {
  it("transitions to closed", () => {
    const { mgr } = newMgr();
    const { id } = mgr.open(baseOpen);
    mgr.close(id);
    expect(mgr.get(id)?.state).toBe("closed");
  });
});

describe("SessionManager.tick (idle expiry)", () => {
  it("expires sessions idle longer than idle_timeout_ms", () => {
    const { mgr, clock } = newMgr();
    const { id } = mgr.open(baseOpen);
    clock.tick(SESSION_IDLE_TIMEOUT_MS + 1);
    const expired = mgr.tick();
    expect(expired).toContain(id);
    expect(mgr.get(id)?.state).toBe("expired");
  });

  it("does not expire still-active sessions", () => {
    const { mgr, clock } = newMgr();
    const { id } = mgr.open(baseOpen);
    clock.tick(SESSION_IDLE_TIMEOUT_MS - 1);
    mgr.tick();
    expect(mgr.get(id)?.state).toBe("active");
  });
});

describe("SessionManager.pauseByWorker / resumeByWorker", () => {
  it("pauses all sessions for a disconnected worker", () => {
    const { mgr } = newMgr();
    const a = mgr.open(baseOpen);
    const b = mgr.open({ ...baseOpen, tab_id: "t2" });
    mgr.pauseByWorker("w1");
    expect(mgr.get(a.id)?.state).toBe("paused");
    expect(mgr.get(b.id)?.state).toBe("paused");
  });

  it("resumes paused sessions when worker reconnects", () => {
    const { mgr } = newMgr();
    const { id } = mgr.open(baseOpen);
    mgr.pauseByWorker("w1");
    mgr.resumeByWorker("w1", new Set([id]));
    expect(mgr.get(id)?.state).toBe("active");
  });

  it("paused sessions not in the reconnect snapshot become error", () => {
    const { mgr } = newMgr();
    const { id } = mgr.open(baseOpen);
    mgr.pauseByWorker("w1");
    mgr.resumeByWorker("w1", new Set());
    expect(mgr.get(id)?.state).toBe("error");
  });
});

describe("SessionManager orphan flow", () => {
  it("orphan marks the session orphaned_at and disowns fingerprint", () => {
    const { mgr, clock } = newMgr();
    const { id } = mgr.open(baseOpen);
    mgr.orphan("ai-1");
    const s = mgr.get(id)!;
    expect(s.state).toBe("orphan");
    expect(s.orphaned_at).toBe(clock.now());
  });

  it("recover within ORPHAN_RECOVERY_MS restores active", () => {
    const { mgr, clock } = newMgr();
    const { id } = mgr.open(baseOpen);
    mgr.orphan("ai-1");
    clock.tick(ORPHAN_RECOVERY_MS - 1);
    const recovered = mgr.recover("ai-1");
    expect(recovered).toContain(id);
    expect(mgr.get(id)?.state).toBe("active");
  });

  it("recover after ORPHAN_RECOVERY_MS closes them instead", () => {
    const { mgr, clock } = newMgr();
    const { id } = mgr.open(baseOpen);
    mgr.orphan("ai-1");
    clock.tick(ORPHAN_RECOVERY_MS + 1);
    mgr.tick(); // tick processes orphan timeout too
    expect(mgr.get(id)?.state).toBe("closed");
  });
});
