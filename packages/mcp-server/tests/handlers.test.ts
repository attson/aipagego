import { describe, it, expect } from "vitest";
import { Coordinator, FakeClock, FakeIdGen, type Worker } from "@aipagego/coordinator";
import type { Result } from "@aipagego/shared/protocol";
import {
  handlePairingStatus, handleListTabs, handleBrowserStart, handleOpenSession, handleCloseSession, handleGetQuota, handleBrowserTool, type Deps, staticDeps
} from "../src/handlers";
import { PairingWaitTimeoutError } from "../src/pairing-errors";

function fakeWorker(): Worker {
  return {
    id: "w1", fingerprint: { ext_hash: "x", os: "mac", chrome: "120" },
    capabilities: new Set(["read:dom", "interact:form"]), attended: true, labels: new Set(),
    available_tabs: [{ tab_id: "42", url: "https://example.org", title: "Ex" }],
    saved_tools: [], protocol_version: 1, connected_at: 0, last_heartbeat_at: 0
  };
}

function makeDeps(execResult: Result): { deps: Deps; calls: any[] } {
  const clock = new FakeClock(1000);
  const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock, idGen: new FakeIdGen() });
  coordinator.registerWorker(fakeWorker());
  const calls: any[] = [];
  const hub = { exec: async (worker_id: string, params: any) => { calls.push({ worker_id, params }); return execResult; } };
  return { deps: staticDeps(coordinator, hub as any), calls };
}

const okResult: Result = { type: "RESULT", nonce: "n", ts: 1, protocol_version: 1, req_id: "req_1", ok: true, return: { clicked: true } };

describe("control-plane handlers", () => {
  it("browser_start opens a session when exactly one tab is available", async () => {
    const { deps } = makeDeps(okResult);

    const result = await handleBrowserStart(deps, {});

    expect(result).toMatchObject({
      status: "ready",
      tab: { tab_id: "42", url: "https://example.org" }
    });
    if (result.status !== "ready") throw new Error("expected browser_start to be ready");
    expect(deps.peek()!.coordinator.sessions.get(result.session_id)?.tab_id).toBe("42");
  });

  it("browser_start selects an explicit tab and preserves session options", async () => {
    const { deps } = makeDeps(okResult);
    deps.peek()!.coordinator.workers.list()[0].available_tabs = [
      { tab_id: "41", url: "https://one.example" },
      { tab_id: "42", url: "https://two.example" }
    ];

    const result = await handleBrowserStart(deps, {
      tab_id: "42",
      capabilities: ["read:dom"],
      idle_timeout_min: 5
    });

    expect(result).toMatchObject({ status: "ready", tab: { tab_id: "42" } });
    if (result.status !== "ready") throw new Error("expected browser_start to be ready");
    const session = deps.peek()!.coordinator.sessions.get(result.session_id)!;
    expect(session.scope).toEqual(new Set(["read:dom"]));
    expect(session.idle_timeout_ms).toBe(300_000);
  });

  it("browser_start selects the only exact URL match", async () => {
    const { deps } = makeDeps(okResult);
    deps.peek()!.coordinator.workers.list()[0].available_tabs = [
      { tab_id: "41", url: "https://example.org/one" },
      { tab_id: "42", url: "https://example.org/two" }
    ];

    const result = await handleBrowserStart(deps, { url: "https://example.org/two" });

    expect(result).toMatchObject({ status: "ready", tab: { tab_id: "42" } });
  });

  it("browser_start returns candidates instead of guessing between tabs", async () => {
    const { deps } = makeDeps(okResult);
    deps.peek()!.coordinator.workers.list()[0].available_tabs = [
      { tab_id: "41", url: "https://one.example" },
      { tab_id: "42", url: "https://two.example" }
    ];

    await expect(handleBrowserStart(deps, {})).resolves.toEqual({
      status: "select_tab",
      tabs: [
        { tab_id: "41", url: "https://one.example" },
        { tab_id: "42", url: "https://two.example" }
      ],
      message: "Choose a tab and call browser_start again with tab_id."
    });
  });

  it("browser_start returns all candidates when an URL has no exact match", async () => {
    const { deps } = makeDeps(okResult);
    deps.peek()!.coordinator.workers.list()[0].available_tabs = [
      { tab_id: "41", url: "https://one.example" },
      { tab_id: "42", url: "https://two.example" }
    ];

    const result = await handleBrowserStart(deps, { url: "https://missing.example" });

    expect(result).toMatchObject({ status: "select_tab" });
    if (result.status !== "select_tab") throw new Error("expected tab selection");
    expect(result.tabs).toHaveLength(2);
    expect(result.message).toContain("No exact URL match");
  });

  it("browser_start rejects an unavailable explicit tab instead of guessing", async () => {
    const { deps } = makeDeps(okResult);

    await expect(handleBrowserStart(deps, { tab_id: "missing" })).rejects.toThrow(
      /InvalidArgs.*missing.*not available/
    );
  });

  it("browser_start requires tab_id and url to identify the same tab", async () => {
    const { deps } = makeDeps(okResult);

    await expect(handleBrowserStart(deps, {
      tab_id: "42",
      url: "https://different.example"
    })).rejects.toThrow(/InvalidArgs.*same tab/);
  });

  it("browser_start preserves the bounded pairing result", async () => {
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
    const bundle = { coordinator, hub: {} as any, port: 8787 };
    const deps: Deps = {
      ensure: async () => bundle,
      peek: () => bundle,
      pairUrl: () => "http://127.0.0.1:8787/pair",
      waitForWorker: async (timeoutMs = 45_000) => {
        throw new PairingWaitTimeoutError(timeoutMs, "http://127.0.0.1:8787/pair");
      }
    };

    await expect(handleBrowserStart(deps, {})).resolves.toEqual({
      status: "pairing_required",
      pair_url: "http://127.0.0.1:8787/pair",
      tabs: []
    });
  });

  it("list_tabs returns the single worker's tabs", async () => {
    const { deps } = makeDeps(okResult);
    expect(await handleListTabs(deps)).toEqual({
      status: "connected",
      tabs: [{ tab_id: "42", url: "https://example.org", title: "Ex" }]
    });
  });

  it("pairing_status returns immediately with the pair URL when no worker is connected", async () => {
    const clock = new FakeClock(0);
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock, idGen: new FakeIdGen() });
    const bundle = { coordinator, hub: {} as any, port: 8787 };
    const deps: Deps = {
      ensure: async () => bundle,
      peek: () => bundle,
      pairUrl: () => "http://127.0.0.1:8787/pair",
      waitForWorker: async () => { throw new Error("must not wait"); }
    };

    await expect(handlePairingStatus(deps)).resolves.toEqual({
      status: "pairing_required",
      pair_url: "http://127.0.0.1:8787/pair"
    });
  });

  it("list_tabs waits for pairing and returns tabs from the same call", async () => {
    const clock = new FakeClock(0);
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock, idGen: new FakeIdGen() });
    const bundle = { coordinator, hub: {} as any, port: 8787 };
    const announced: string[] = [];
    const deps: Deps = {
      ensure: async () => bundle,
      peek: () => bundle,
      pairUrl: () => "http://127.0.0.1:8787/pair",
      waitForWorker: async (timeoutMs, onWaiting) => {
        expect(timeoutMs).toBe(45_000);
        await onWaiting?.("http://127.0.0.1:8787/pair");
        coordinator.registerWorker(fakeWorker());
        return "w1";
      }
    };

    await expect(handleListTabs(deps, (url) => { announced.push(url); })).resolves.toEqual({
      status: "connected",
      tabs: [{ tab_id: "42", url: "https://example.org", title: "Ex" }]
    });
    expect(announced).toEqual(["http://127.0.0.1:8787/pair"]);
  });

  it("list_tabs returns pairing_required only after its bounded wait times out", async () => {
    const clock = new FakeClock(0);
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock, idGen: new FakeIdGen() });
    const bundle = { coordinator, hub: {} as any, port: 8787 };
    const deps: Deps = {
      ensure: async () => bundle,
      peek: () => bundle,
      pairUrl: () => "http://127.0.0.1:8787/pair",
      waitForWorker: async (timeoutMs = 45_000) => {
        throw new PairingWaitTimeoutError(timeoutMs, "http://127.0.0.1:8787/pair");
      }
    };

    await expect(handleListTabs(deps)).resolves.toEqual({
      status: "pairing_required",
      pair_url: "http://127.0.0.1:8787/pair",
      tabs: []
    });
  });

  it("list_tabs preserves explicit pairing denial as an error", async () => {
    const clock = new FakeClock(0);
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock, idGen: new FakeIdGen() });
    const bundle = { coordinator, hub: {} as any, port: 8787 };
    const deps: Deps = {
      ensure: async () => bundle,
      peek: () => bundle,
      pairUrl: () => "http://127.0.0.1:8787/pair",
      waitForWorker: async () => { throw new Error("用户拒绝了浏览器配对授权。"); }
    };

    await expect(handleListTabs(deps)).rejects.toThrow(/拒绝/);
  });

  it("open_session → session_id; default scope = all capabilities", async () => {
    const { deps } = makeDeps(okResult);
    const { session_id } = await handleOpenSession(deps, { tab_id: "42" });
    expect(typeof session_id).toBe("string");
    const s = deps.peek()!.coordinator.sessions.get(session_id)!;
    expect(s.tab_id).toBe("42");
    expect(s.scope.has("submit:form")).toBe(true);
  });

  it("open_session rejects a tab that is not currently available", async () => {
    const { deps } = makeDeps(okResult);

    await expect(handleOpenSession(deps, { tab_id: "missing" })).rejects.toThrow(
      /InvalidArgs.*missing.*not available/
    );
    expect(deps.peek()!.coordinator.sessions.list()).toHaveLength(0);
  });

  it("open_session rejects malformed options instead of widening permissions", async () => {
    const { deps } = makeDeps(okResult);

    await expect(handleOpenSession(deps, {
      tab_id: "42",
      capabilities: ["read:dm"]
    })).rejects.toThrow(/InvalidArgs.*unknown capability/);
    await expect(handleOpenSession(deps, {
      tab_id: "42",
      idle_timeout_min: 0
    })).rejects.toThrow(/InvalidArgs.*positive/);
    await expect(handleBrowserStart(deps, {
      tab_id: "42",
      force_new: "yes"
    })).rejects.toThrow(/InvalidArgs.*boolean/);
    expect(deps.peek()!.coordinator.sessions.list()).toHaveLength(0);
  });

  it("open_session fails immediately instead of waiting when pairing is required", async () => {
    const clock = new FakeClock(0);
    const coordinator = new Coordinator({
      hub: { send: async () => undefined } as any,
      clock,
      idGen: new FakeIdGen()
    });
    const bundle = { coordinator, hub: {} as any, port: 8787 };
    const deps: Deps = {
      ensure: async () => bundle,
      peek: () => bundle,
      pairUrl: () => "http://127.0.0.1:8787/pair",
      waitForWorker: async () => { throw new Error("must not wait"); }
    };

    await expect(handleOpenSession(deps, { tab_id: "42" })).rejects.toThrow(
      /PAIRING_REQUIRED.*127\.0\.0\.1:8787\/pair/
    );
  });

  it("close_session closes the session", async () => {
    const { deps } = makeDeps(okResult);
    const { session_id } = await handleOpenSession(deps, { tab_id: "42" });
    expect(await handleCloseSession(deps, { session_id })).toEqual({ ok: true });
    expect(deps.peek()!.coordinator.sessions.get(session_id)!.state).toBe("closed");
  });

  it("get_quota returns quota for open session", async () => {
    const { deps } = makeDeps(okResult);
    const { session_id } = await handleOpenSession(deps, { tab_id: "42" });
    const q = await handleGetQuota(deps, { session_id }) as { steps_used: number };
    expect(q.steps_used).toBe(0);
  });

  it("get_quota throws for unknown session", async () => {
    const { deps } = makeDeps(okResult);
    await expect(handleGetQuota(deps, { session_id: "nope" })).rejects.toThrow(/not found/);
  });
});

describe("handleBrowserTool", () => {
  it("validates, records quota, sends EXEC, returns RESULT.return", async () => {
    const { deps, calls } = makeDeps(okResult);
    const { session_id } = await handleOpenSession(deps, { tab_id: "42" });
    const gen = { name: "browser_click", builtinTool: "click", builtinTools: ["click"], description: "", resultKind: "json" as const, stepKind: "tool" as const, inputSchema: {} as any };
    const out = await handleBrowserTool(deps, gen, { session_id, selector: ".b" });
    expect(out).toEqual({ clicked: true });
    expect(calls[0].params.step).toEqual({ kind: "tool", tool: "click", args: { selector: ".b" } });
    expect(calls[0].params.tab_id).toBe("42");
    expect(deps.peek()!.coordinator.quotaFor(session_id)!.steps_used).toBe(1);
  });

  it("maps httpRequest withCredentials → dangerous (httpCookied)", async () => {
    const { deps } = makeDeps(okResult);
    const { session_id } = await handleOpenSession(deps, { tab_id: "42" });
    const gen = { name: "browser_httpRequest", builtinTool: "httpRequest", builtinTools: ["httpRequest"], description: "", resultKind: "json" as const, stepKind: "tool" as const, inputSchema: {} as any };
    await handleBrowserTool(deps, gen, { session_id, url: "https://x", withCredentials: true });
    expect(deps.peek()!.coordinator.quotaFor(session_id)!.dangerous_used).toBe(1);
  });

  it("throws on unknown session", async () => {
    const { deps } = makeDeps(okResult);
    const gen = { name: "browser_click", builtinTool: "click", builtinTools: ["click"], description: "", resultKind: "json" as const, stepKind: "tool" as const, inputSchema: {} as any };
    await expect(handleBrowserTool(deps, gen, { session_id: "nope", selector: ".b" })).rejects.toThrow(/not found|SessionNotFound/);
  });

  it("throws when RESULT.ok is false", async () => {
    const bad: Result = { type: "RESULT", nonce: "n", ts: 1, protocol_version: 1, req_id: "req_1", ok: false, error: { code: "PageScriptError", message: "boom", retryable: false } };
    const { deps } = makeDeps(bad);
    const { session_id } = await handleOpenSession(deps, { tab_id: "42" });
    const gen = { name: "browser_click", builtinTool: "click", builtinTools: ["click"], description: "", resultKind: "json" as const, stepKind: "tool" as const, inputSchema: {} as any };
    await expect(handleBrowserTool(deps, gen, { session_id, selector: ".b" })).rejects.toThrow(/boom/);
  });
});
