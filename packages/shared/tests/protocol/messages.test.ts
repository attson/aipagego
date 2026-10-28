import { describe, it, expect } from "vitest";
import {
  HelloSchema,
  SessionOpenedSchema,
  TabsUpdateSchema,
  ExecSchema,
  ResultSchema,
  ClientToServerSchema,
  ServerToClientSchema
} from "../../src/protocol/messages";

const envelope = { nonce: "n1", ts: 1, protocol_version: 1 };

describe("HelloSchema", () => {
  it("parses a complete HELLO", () => {
    const r = HelloSchema.safeParse({
      ...envelope,
      type: "HELLO",
      worker_id: "w1",
      fingerprint: { ext_hash: "h", os: "darwin", chrome: "120" },
      capabilities: ["read:dom"],
      attended: true,
      available_tabs: [{ tab_id: "t1", url: "https://example.com" }],
      saved_tools: [],
      labels: ["chrome:macos"]
    });
    expect(r.success).toBe(true);
  });

  it("rejects missing worker_id", () => {
    const r = HelloSchema.safeParse({
      ...envelope,
      type: "HELLO",
      fingerprint: { ext_hash: "", os: "", chrome: "" },
      capabilities: [],
      attended: false,
      available_tabs: [],
      saved_tools: [],
      labels: []
    });
    expect(r.success).toBe(false);
  });
});

describe("ExecSchema", () => {
  it("parses an EXEC whose step carries kind:'tool'", () => {
    const r = ExecSchema.safeParse({
      ...envelope,
      type: "EXEC",
      req_id: "r1",
      session_id: "s1",
      tab_id: "t1",
      step: { kind: "tool", tool: "snapshotDOM", args: {}, timeoutMs: 600000 }
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.step.timeoutMs).toBe(600000);
  });

  it("parses an EXEC whose step carries kind:'js'", () => {
    const r = ExecSchema.safeParse({
      ...envelope,
      type: "EXEC",
      req_id: "r1",
      session_id: "s1",
      tab_id: "t1",
      step: { kind: "js", source: "return document.title", timeoutMs: 5000 }
    });
    expect(r.success).toBe(true);
  });

  it("rejects an EXEC whose step is missing kind", () => {
    const r = ExecSchema.safeParse({
      ...envelope,
      type: "EXEC",
      req_id: "r1",
      session_id: "s1",
      tab_id: "t1",
      step: { tool: "snapshotDOM", args: {} }
    });
    expect(r.success).toBe(false);
  });
});

describe("ResultSchema", () => {
  it("parses ok=true result", () => {
    const r = ResultSchema.safeParse({
      ...envelope,
      type: "RESULT",
      req_id: "r1",
      ok: true,
      return: { html: "<div/>" }
    });
    expect(r.success).toBe(true);
  });

  it("parses ok=false result with error", () => {
    const r = ResultSchema.safeParse({
      ...envelope,
      type: "RESULT",
      req_id: "r1",
      ok: false,
      error: {
        code: "TabClosed",
        message: "tab gone",
        retryable: true
      }
    });
    expect(r.success).toBe(true);
  });
});

describe("ClientToServerSchema discriminated union", () => {
  it("routes HELLO to HelloSchema", () => {
    const r = ClientToServerSchema.safeParse({
      ...envelope,
      type: "HELLO",
      worker_id: "w",
      fingerprint: { ext_hash: "", os: "", chrome: "" },
      capabilities: [],
      attended: false,
      available_tabs: [],
      saved_tools: [],
      labels: []
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown type", () => {
    const r = ClientToServerSchema.safeParse({ ...envelope, type: "UNKNOWN" });
    expect(r.success).toBe(false);
  });
});

describe("ServerToClientSchema discriminated union", () => {
  it("routes OPEN_TAB", () => {
    const r = ServerToClientSchema.safeParse({
      ...envelope,
      type: "OPEN_TAB",
      session_id: "s1",
      url: "https://example.com"
    });
    expect(r.success).toBe(true);
  });
});

describe("HELLO.supported_tools (Plan 32)", () => {
  const base = {
    type: "HELLO" as const,
    nonce: "n",
    ts: 1,
    protocol_version: 1,
    worker_id: "w1",
    fingerprint: { ext_hash: "x", os: "mac", chrome: "120" },
    capabilities: ["read:dom"],
    attended: true,
    available_tabs: [],
    saved_tools: [],
    labels: []
  };

  it("accepts a HELLO without the field, for older extensions", () => {
    expect(HelloSchema.safeParse(base).success).toBe(true);
  });

  it("accepts and preserves a tool list", () => {
    const parsed = HelloSchema.safeParse({ ...base, supported_tools: ["click", "drag"] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.supported_tools).toEqual(["click", "drag"]);
  });

  it("rejects a non-string list", () => {
    expect(HelloSchema.safeParse({ ...base, supported_tools: [1, 2] }).success).toBe(false);
  });
});

describe("Plan 33 — multi-session messages", () => {
  const env = { nonce: "n", ts: 1, protocol_version: 1 };

  it("accepts SESSION_OPENED", () => {
    const r = SessionOpenedSchema.safeParse({
      ...env,
      type: "SESSION_OPENED",
      session_id: "s1",
      tab_id: "42"
    });
    expect(r.success).toBe(true);
  });

  it("rejects SESSION_OPENED without a tab", () => {
    expect(
      SessionOpenedSchema.safeParse({ ...env, type: "SESSION_OPENED", session_id: "s1" }).success
    ).toBe(false);
  });

  it("accepts TABS_UPDATE with derived fields", () => {
    const r = TabsUpdateSchema.safeParse({
      ...env,
      type: "TABS_UPDATE",
      tabs: [
        { tab_id: "1", url: "https://a.test", mine: true, busy: false },
        { tab_id: "2", url: "https://b.test", busy: true, busy_label: "~/code/wanxin" }
      ]
    });
    expect(r.success).toBe(true);
  });

  it("keeps the derived tab fields optional in HELLO", () => {
    const base = {
      ...env,
      type: "HELLO",
      worker_id: "w",
      fingerprint: { ext_hash: "x", os: "mac", chrome: "120" },
      capabilities: [],
      attended: true,
      saved_tools: [],
      labels: [],
      available_tabs: [{ tab_id: "1", url: "https://a.test" }]
    };
    expect(HelloSchema.safeParse(base).success).toBe(true);
  });
});
