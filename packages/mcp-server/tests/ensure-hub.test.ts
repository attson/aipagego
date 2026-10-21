import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeClock, FakeIdGen } from "@aipagego/coordinator";
import { PROTOCOL_VERSION, type Hello } from "@aipagego/shared/protocol";
import { WebSocket } from "ws";
import { createHubEnsurer } from "../src/ensure-hub";
import { loadLastPort, loadOrCreateIdentity, saveLastPort } from "../src/identity";
import { PairingWaitTimeoutError } from "../src/pairing-errors";
import pkg from "../package.json" with { type: "json" };

const dirs: string[] = [];
const made: Array<ReturnType<typeof createHubEnsurer>> = [];

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "aipagego-hub-"));
  dirs.push(d);
  return d;
};

function helloMsg(): Hello {
  return {
    type: "HELLO",
    nonce: "h1",
    ts: 1,
    protocol_version: PROTOCOL_VERSION,
    worker_id: "w1",
    fingerprint: { ext_hash: "x", os: "linux", chrome: "120" },
    capabilities: ["read:dom"],
    attended: true,
    available_tabs: [{ tab_id: "42", url: "https://example.org", title: "Ex" }],
    saved_tools: [],
    labels: []
  };
}

function makeEnsurer(opts: {
  openUrl?: (u: string) => void | Promise<void>;
  dir?: string;
  explicitPort?: number;
}) {
  const e = createHubEnsurer({
    clock: new FakeClock(0),
    idGen: new FakeIdGen(),
    identityDir: opts.dir ?? tmp(),
    explicitPort: opts.explicitPort,
    openUrl: opts.openUrl,
    processInfo: { sessionId: "sess_test", label: "~/code/x", pid: 1 }
  });
  made.push(e);
  return e;
}

afterEach(async () => {
  for (const e of made.splice(0)) await e.peek()?.hub.close?.();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("createHubEnsurer", () => {
  it("binds nothing until a browser-needing tool runs", async () => {
    const e = makeEnsurer({});
    expect(e.bound()).toBe(false);
    expect(e.peek()).toBeNull();
    expect(e.pairUrl()).toBeNull();

    await e.ensure();
    expect(e.bound()).toBe(true);
    expect(e.peek()).not.toBeNull();
  });

  it("is idempotent", async () => {
    const e = makeEnsurer({});
    const a = await e.ensure();
    const b = await e.ensure();
    expect(a.port).toBe(b.port);
    expect(a.coordinator).toBe(b.coordinator);
  });

  it("shares one bind between concurrent first calls", async () => {
    const e = makeEnsurer({});
    const [a, b] = await Promise.all([e.ensure(), e.ensure()]);
    expect(a.port).toBe(b.port);
  });

  it("opens the pairing page at most once", async () => {
    const opened: string[] = [];
    const e = makeEnsurer({ openUrl: (u) => { opened.push(u); } });
    await e.ensure();
    await e.ensure();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pair$/);
  });

  it("retries opening the pairing page after a launch failure", async () => {
    let attempts = 0;
    const e = makeEnsurer({
      openUrl: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("no browser opener");
      }
    });

    await e.ensure();
    await e.ensure();

    expect(attempts).toBe(2);
  });

  it("announces the pairing URL before waiting for HELLO", async () => {
    const e = makeEnsurer({});
    const announced: string[] = [];
    const waiting = e.waitForWorker(1_000, (url) => {
      announced.push(url);
      throw new Error("stop after announcement");
    });

    await expect(waiting).rejects.toThrow("stop after announcement");
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pair$/);
  });

  it("keeps the first browser call pending until HELLO registers a worker", async () => {
    const e = makeEnsurer({});
    const { port } = await e.ensure();
    const waiting = e.waitForWorker(1_000);
    let settled = false;
    void waiting.finally(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.send(JSON.stringify(helloMsg()));

    await expect(waiting).resolves.toBe("w1");
    ws.close();
  });

  it("observes HELLO completed while the pairing presenter is still pending", async () => {
    const e = makeEnsurer({});
    const { port } = await e.ensure();

    const waiting = e.waitForWorker(1_000, async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });
      ws.send(JSON.stringify(helloMsg()));
      await new Promise<void>((resolve, reject) => {
        ws.once("message", () => resolve());
        ws.once("error", reject);
      });
      ws.close();
    });

    await expect(waiting).resolves.toBe("w1");
  });

  it("ends the pending browser call when the trusted pairing UI reports denial", async () => {
    const dir = tmp();
    const e = makeEnsurer({ dir });
    const { port } = await e.ensure();
    const identity = loadOrCreateIdentity(dir);
    const waiting = e.waitForWorker(1_000);
    const denied = expect(waiting).rejects.toThrow(/拒绝/);

    const response = await fetch(`http://127.0.0.1:${port}/pair/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        v: 1,
        decision: "denied",
        sessionId: "sess_test",
        installId: identity.installId,
        secret: identity.secret
      })
    });

    expect(response.status).toBe(204);
    await denied;
  });

  it("shares one pending wait between concurrent browser calls", async () => {
    const e = makeEnsurer({});
    const { port } = await e.ensure();
    const first = e.waitForWorker(1_000);
    const second = e.waitForWorker(1_000);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.send(JSON.stringify(helloMsg()));

    await expect(Promise.all([first, second])).resolves.toEqual(["w1", "w1"]);
    ws.close();
  });

  it("times out with the pairing URL and allows a later wait to succeed", async () => {
    const e = makeEnsurer({});
    const { port } = await e.ensure();

    const timeout = await e.waitForWorker(5).catch((error: unknown) => error);
    expect(timeout).toBeInstanceOf(PairingWaitTimeoutError);
    expect((timeout as Error).message).toMatch(
      new RegExp(`等待浏览器授权超时.*127\\.0\\.0\\.1:${port}/pair`)
    );

    const retry = e.waitForWorker(1_000);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.send(JSON.stringify(helloMsg()));
    await expect(retry).resolves.toBe("w1");
    ws.close();
  });

  it("does not let an HTTP page result forge pairing success", async () => {
    const dir = tmp();
    const e = makeEnsurer({ dir });
    const { port } = await e.ensure();
    const identity = loadOrCreateIdentity(dir);
    const waiting = e.waitForWorker(1_000);

    const response = await fetch(`http://127.0.0.1:${port}/pair/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        v: 1,
        decision: "approved",
        sessionId: "sess_test",
        installId: identity.installId,
        secret: identity.secret
      })
    });
    expect(response.status).toBe(403);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.send(JSON.stringify(helloMsg()));
    await expect(waiting).resolves.toBe("w1");
    ws.close();
  });

  it("cancels the pending wait when the hub closes", async () => {
    const e = makeEnsurer({});
    const { hub } = await e.ensure();
    const waiting = e.waitForWorker(10_000).then(
      () => "resolved",
      (error: Error) => error.message
    );

    await hub.close?.();
    const outcome = await Promise.race([
      waiting,
      new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 30))
    ]);

    expect(outcome).toMatch(/关闭/);
  });

  it("records the port it actually bound", async () => {
    const dir = tmp();
    const e = makeEnsurer({ dir });
    const { port } = await e.ensure();
    expect(loadLastPort(dir)).toBe(port);
  });

  it("prefers the remembered port when it is free", async () => {
    const dir = tmp();
    // Learn a free port, release it, then check the next ensurer reuses it.
    const probe = makeEnsurer({ dir });
    const { port } = await probe.ensure();
    await probe.peek()!.hub.close?.();

    saveLastPort(port, dir);
    const again = createHubEnsurer({
      clock: new FakeClock(0),
      idGen: new FakeIdGen(),
      identityDir: dir,
      processInfo: { sessionId: "s2", label: "~/code/x", pid: 2 }
    });
    made.push(again);
    expect((await again.ensure()).port).toBe(port);
  });

  it("falls back to an ephemeral port when the remembered one is taken", async () => {
    const dir = tmp();
    const first = makeEnsurer({ dir });
    const { port } = await first.ensure();
    // first is still holding it; a second ensurer must not fail.
    const second = createHubEnsurer({
      clock: new FakeClock(0),
      idGen: new FakeIdGen(),
      identityDir: dir,
      processInfo: { sessionId: "s2", label: "~/code/x", pid: 2 }
    });
    made.push(second);
    const got = await second.ensure();
    expect(got.port).not.toBe(port);
    expect(got.port).toBeGreaterThan(0);
  });

  it("surfaces a clash on an explicitly configured port", async () => {
    const dir = tmp();
    const first = makeEnsurer({ dir });
    const { port } = await first.ensure();
    const pinned = createHubEnsurer({
      clock: new FakeClock(0),
      idGen: new FakeIdGen(),
      identityDir: dir,
      explicitPort: port,
      processInfo: { sessionId: "s3", label: "~/code/x", pid: 3 }
    });
    await expect(pinned.ensure()).rejects.toThrow(/AIPAGEGO_WS_PORT/);
  });

  it("serves the pairing page from the bound port", async () => {
    const e = makeEnsurer({});
    const { port } = await e.ensure();
    const res = await fetch(`http://127.0.0.1:${port}/pair`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("sess_test");
    expect(html).toContain(`\"mcpVersion\":\"${pkg.version}\"`);
  });
});
