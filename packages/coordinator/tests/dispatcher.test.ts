import { describe, it, expect } from "vitest";
import { Dispatcher } from "../src/dispatcher";
import { SessionManager } from "../src/session-manager";
import { FakeClock, FakeIdGen } from "../src/clock";
import { SESSION_IDLE_TIMEOUT_MS } from "@aipagego/shared/protocol";
import type { Capability } from "@aipagego/shared/capability";

function setup(scope: Capability[]) {
  const clock = new FakeClock(1000);
  const idGen = new FakeIdGen();
  const sessions = new SessionManager(clock, idGen);
  const { id } = sessions.open({
    ai_client_fingerprint: "ai-1",
    worker_id: "w1",
    tab_id: "t1",
    scope: new Set(scope),
    idle_timeout_ms: SESSION_IDLE_TIMEOUT_MS
  });
  const dispatcher = new Dispatcher(sessions);
  return { dispatcher, sessions, session_id: id, clock };
}

describe("Dispatcher.validate (low-level extension tool)", () => {
  it("allows snapshotDOM because read:dom is implicit", () => {
    const { dispatcher, session_id } = setup([]);
    const r = dispatcher.validate({
      session_id,
      kind: "extension_tool",
      tool: "snapshotDOM"
    });
    expect(r.ok).toBe(true);
  });

  it("denies submitForm when submit:form not in scope", () => {
    const { dispatcher, session_id } = setup([]);
    const r = dispatcher.validate({
      session_id,
      kind: "extension_tool",
      tool: "submitForm"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("PermissionDenied");
      expect(r.error.hints?.denied_capability).toBe("submit:form");
    }
  });

  it("allows submitForm when scope includes submit:form", () => {
    const { dispatcher, session_id } = setup(["submit:form"]);
    const r = dispatcher.validate({
      session_id,
      kind: "extension_tool",
      tool: "submitForm"
    });
    expect(r.ok).toBe(true);
  });

  it("httpRequest cookied requires httpRequest:cookied", () => {
    const { dispatcher, session_id } = setup(["httpRequest:no-cookie"]);
    const r = dispatcher.validate({
      session_id,
      kind: "extension_tool",
      tool: "httpRequest",
      httpCookied: true
    });
    expect(r.ok).toBe(false);
  });
});

describe("Dispatcher.validate (runJS)", () => {
  it("scanned runJS allowed when scope has runJS:scanned", () => {
    const { dispatcher, session_id } = setup(["runJS:scanned"]);
    const r = dispatcher.validate({
      session_id,
      kind: "runJS",
      unsafe: false
    });
    expect(r.ok).toBe(true);
  });

  it("unsafe runJS denied when only scanned in scope", () => {
    const { dispatcher, session_id } = setup(["runJS:scanned"]);
    const r = dispatcher.validate({ session_id, kind: "runJS", unsafe: true });
    expect(r.ok).toBe(false);
  });
});

describe("Dispatcher.validate (session lifecycle)", () => {
  it("rejects calls on missing session", () => {
    const { dispatcher } = setup([]);
    const r = dispatcher.validate({
      session_id: "nope",
      kind: "extension_tool",
      tool: "snapshotDOM"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SessionNotFound");
  });

  it("rejects calls on expired session", () => {
    const { dispatcher, sessions, session_id, clock } = setup([]);
    clock.tick(SESSION_IDLE_TIMEOUT_MS + 1);
    sessions.tick();
    const r = dispatcher.validate({
      session_id,
      kind: "extension_tool",
      tool: "snapshotDOM"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SessionExpired");
  });
});

describe("Dispatcher.validate (quota)", () => {
  it("rejects when step_count >= max_steps", () => {
    const { dispatcher, sessions, session_id } = setup([]);
    for (let i = 0; i < 200; i++) sessions.touch(session_id, { dangerous: false });
    const r = dispatcher.validate({
      session_id,
      kind: "extension_tool",
      tool: "snapshotDOM"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SessionExhausted");
  });

  it("rejects dangerous when dangerous_count >= max_dangerous", () => {
    const { dispatcher, sessions, session_id } = setup(["submit:form"]);
    for (let i = 0; i < 50; i++) sessions.touch(session_id, { dangerous: true });
    const r = dispatcher.validate({
      session_id,
      kind: "extension_tool",
      tool: "submitForm"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("DangerousQuotaExceeded");
  });
});
