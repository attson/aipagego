import { describe, expect, it } from "vitest";
import { Coordinator, FakeClock, FakeIdGen, type Worker } from "@atwebpilot/coordinator";
import { buildToolList } from "../src/mcp-server";
import { staticDeps } from "../src/handlers";
import { helloToWorker } from "../src/wire";
import type { Hello } from "@atwebpilot/shared/protocol";

function worker(supported?: string[]): Worker {
  return {
    id: "w1",
    fingerprint: { ext_hash: "x", os: "mac", chrome: "120" },
    capabilities: new Set(["read:dom"]),
    supported_tools: supported ? new Set(supported) : undefined,
    attended: true,
    labels: new Set(),
    available_tabs: [{ tab_id: "42", url: "https://example.org" }],
    saved_tools: [],
    protocol_version: 1,
    connected_at: 0,
    last_heartbeat_at: 0
  };
}

function depsWith(w?: Worker) {
  const coordinator = new Coordinator({
    hub: { send: async () => undefined } as never,
    clock: new FakeClock(0),
    idGen: new FakeIdGen()
  });
  if (w) coordinator.registerWorker(w);
  return staticDeps(coordinator, { exec: async () => ({}) } as never);
}

// MCP orchestration tools are unconditional (not filtered by worker support
// or advertised state), so exclude them from negotiated extension tools.
const browserNames = (list: Array<{ name: string }>) =>
  list.map((t) => t.name).filter((n) =>
    n.startsWith("browser_") &&
    n !== "browser_start" &&
    n !== "browser_discoverTools" &&
    n !== "browser_call" &&
    n !== "browser_runSteps"
  );

describe("supported_tools negotiation", () => {
  it("keeps browser schemas out of tools/list until a worker has connected", () => {
    expect(browserNames(buildToolList(depsWith()))).toHaveLength(0);
  });

  it("intersects against what the worker reports", () => {
    const list = buildToolList(depsWith(worker(["click", "snapshotDOM", "drag"])));
    // snapshotDOM is not part of the default core surface, so it never
    // reaches the advertised list even though the worker supports it.
    expect(browserNames(list).sort()).toEqual([
      "browser_click",
      "browser_drag"
    ]);
  });

  it("keeps the control plane and skill tool regardless", () => {
    const names = buildToolList(depsWith(worker(["click"]))).map((t) => t.name);
    for (const n of [
      "atwebpilot_skill_read",
      "browser_start",
      "pairing_status",
      "list_tabs",
      "open_session",
      "close_session",
      "get_quota",
      "browser_discoverTools",
      "browser_call",
      "browser_runSteps"
    ]) {
      expect(names).toContain(n);
    }
  });

  it("falls back to the legacy surface for an extension that predates the field", () => {
    const list = buildToolList(depsWith(worker(undefined)));
    // intersected against the default core surface: only names present in
    // both LEGACY_TOOLS and CORE_TOOLS are advertised.
    expect(browserNames(list)).toHaveLength(9);
    expect(browserNames(list)).toContain("browser_click");
    expect(browserNames(list)).not.toContain("browser_drag");
  });

  it("never advertises a tool the worker cannot run", () => {
    const supported = ["click", "consoleMessages"];
    const list = browserNames(buildToolList(depsWith(worker(supported))));
    for (const n of list) {
      expect(supported.map((s) => `browser_${s}`)).toContain(n);
    }
  });
});

describe("helloToWorker", () => {
  const base: Hello = {
    type: "HELLO",
    nonce: "n",
    ts: 1,
    protocol_version: 1,
    worker_id: "w1",
    fingerprint: { ext_hash: "x", os: "mac", chrome: "120" },
    capabilities: ["read:dom", "not-a-capability"],
    attended: true,
    available_tabs: [],
    saved_tools: [],
    labels: []
  };

  it("carries supported_tools through when present", () => {
    const w = helloToWorker({ ...base, supported_tools: ["click", "drag"] }, 0);
    expect(w.supported_tools).toEqual(new Set(["click", "drag"]));
  });

  it("leaves supported_tools undefined when absent", () => {
    expect(helloToWorker(base, 0).supported_tools).toBeUndefined();
  });

  it("still filters unknown capability strings", () => {
    expect(helloToWorker(base, 0).capabilities).toEqual(new Set(["read:dom"]));
  });
});
