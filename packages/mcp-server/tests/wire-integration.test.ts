/**
 * Integration tests for wire.ts — verifies that installWire correctly bridges
 * LoopbackWSHub and Coordinator for worker lifecycle events.
 *
 * C1: A second HELLO from the same worker_id must NOT throw an uncaught exception.
 *     (Previously, coordinator.registerWorker threw "Worker already registered"
 *      because unregisterWorker was never called before re-registering.)
 */

import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, type Hello } from "@aipagego/shared/protocol";
import { Coordinator, DefaultClock, DefaultIdGen } from "@aipagego/coordinator";
import { LoopbackWSHub } from "../src/loopback-ws-hub";
import { installWire } from "../src/wire";

let hub: LoopbackWSHub | null = null;

afterEach(async () => {
  if (hub) await hub.close();
  hub = null;
});

function helloMsg(): Hello {
  return {
    type: "HELLO", nonce: "h1", ts: 1, protocol_version: PROTOCOL_VERSION,
    worker_id: "w1", fingerprint: { ext_hash: "x", os: "mac", chrome: "120" },
    capabilities: ["read:dom"], attended: true,
    available_tabs: [{ tab_id: "42", url: "https://example.org", title: "Ex" }],
    saved_tools: [], labels: []
  };
}

async function connectWorker(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, [`bearer.t`, `proto.${PROTOCOL_VERSION}`]);
  await new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); });
  return ws;
}

async function waitForWorkerCount(coordinator: Coordinator, count: number, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (coordinator.workers.list().length !== count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`expected ${count} workers, got ${coordinator.workers.list().length} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1000
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("wire.ts integration — C1: reconnect safety", () => {
  it("C1: second HELLO with same worker_id does not throw uncaught exception and re-registers cleanly", async () => {
    const clock = new DefaultClock();
    const idGen = new DefaultIdGen();

    hub = new LoopbackWSHub({ port: 0, token: "t", clock, idGen });
    const port = await hub.ready();

    const coordinator = new Coordinator({ hub, clock, idGen });
    installWire(hub, coordinator, clock);

    // Track any uncaught exceptions during the test
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);

    try {
      // First worker connects
      const ws1 = await connectWorker(port);
      ws1.send(JSON.stringify(helloMsg()));
      await waitForWorkerCount(coordinator, 1);
      expect(coordinator.workers.list().length).toBe(1);

      // Second worker connects with the same worker_id (reconnect scenario)
      const ws2 = await connectWorker(port);
      ws2.send(JSON.stringify(helloMsg()));

      // Wait for re-registration to complete
      // Poll until the old socket is terminated (ws1 in CLOSING/CLOSED state)
      const start = Date.now();
      while (ws1.readyState === WebSocket.OPEN) {
        if (Date.now() - start > 1000) throw new Error("old socket was not terminated in time");
        await new Promise((r) => setTimeout(r, 5));
      }

      // Give any pending microtasks / close-event callbacks a chance to run
      await new Promise((r) => setTimeout(r, 50));

      // No uncaught exception should have been thrown
      expect(uncaught).toHaveLength(0);

      // Exactly one registration should exist for worker w1
      expect(coordinator.workers.list().length).toBe(1);
      expect(coordinator.workers.list()[0].id).toBe("w1");
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});

describe("wire.ts integration — tab reconciliation", () => {
  it("promotes an attached tab and closes the session after the final tab disappears", async () => {
    const clock = new DefaultClock();
    const idGen = new DefaultIdGen();
    hub = new LoopbackWSHub({ port: 0, token: "t", clock, idGen });
    const port = await hub.ready();
    const coordinator = new Coordinator({ hub, clock, idGen });
    installWire(hub, coordinator, clock);
    const ws = await connectWorker(port);
    ws.send(JSON.stringify({
      ...helloMsg(),
      available_tabs: [
        { tab_id: "42", url: "https://example.org" },
        { tab_id: "43", url: "https://second.example.org" }
      ]
    }));
    await waitForWorkerCount(coordinator, 1);
    const session = coordinator.openSession({
      ai_client_fingerprint: "ai-1",
      worker_id: "w1",
      tab_id: "42",
      scope: new Set(["read:dom"])
    });
    coordinator.attachSessionTab(session.id, "w1", "43");

    ws.send(JSON.stringify({
      type: "TABS_UPDATE",
      nonce: "tabs-1",
      ts: 2,
      protocol_version: PROTOCOL_VERSION,
      tabs: [{ tab_id: "43", url: "https://second.example.org" }]
    }));
    await waitFor(
      () => coordinator.sessions.get(session.id)?.tab_id === "43",
      "primary tab was not promoted"
    );

    ws.send(JSON.stringify({
      type: "TABS_UPDATE",
      nonce: "tabs-2",
      ts: 3,
      protocol_version: PROTOCOL_VERSION,
      tabs: []
    }));
    await waitFor(
      () => coordinator.sessions.get(session.id)?.state === "closed",
      "session was not closed after its final tab disappeared"
    );
    expect(coordinator.sessions.get(session.id)?.tab_ids).toEqual([]);
    ws.close();
  });
});
