import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ElicitRequestSchema,
  ToolListChangedNotificationSchema
} from "@modelcontextprotocol/sdk/types.js";
import { Coordinator, FakeClock, FakeIdGen, type Worker } from "@atwebpilot/coordinator";
import type { Result } from "@atwebpilot/shared/protocol";
import { buildToolList, createMcpServer, createToolState, dispatchCall } from "../src/mcp-server";
import { staticDeps, type Deps } from "../src/handlers";

function fakeWorker(): Worker {
  return {
    id: "w1", fingerprint: { ext_hash: "x", os: "mac", chrome: "120" },
    capabilities: new Set(["read:dom"]), attended: true, labels: new Set(),
    available_tabs: [{ tab_id: "42", url: "https://example.org" }],
    saved_tools: [], protocol_version: 1, connected_at: 0, last_heartbeat_at: 0
  };
}
const okResult: Result = { type: "RESULT", nonce: "n", ts: 1, protocol_version: 1, req_id: "req_1", ok: true, return: { ok: 1 } };
function deps() {
  const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
  coordinator.registerWorker(fakeWorker());
  return staticDeps(coordinator, { exec: async () => okResult } as any);
}

describe("buildToolList", () => {
  it("lists only skill, 5 controls, discovery and the call bridge before pairing", () => {
    const tools = buildToolList();
    const names = tools.map((t) => t.name);
    expect(names).toContain("atwebpilot_skill_read");
    expect(names).toContain("list_tabs");
    expect(names).toContain("open_session");
    expect(names).toContain("pairing_status");
    expect(names).toContain("browser_call");
    expect(names).not.toContain("browser_click");
    expect(names).not.toContain("browser_snapshotDOM");
    expect(tools.length).toBe(1 + 5 + 1 + 1);
    for (const t of tools) expect(t.inputSchema).toBeTruthy();
  });

  it("describes the first-use pairing behavior", () => {
    const listTabs = buildToolList().find((tool) => tool.name === "list_tabs");
    expect(listTabs?.description).toContain("pairing_required");
    expect(listTabs?.description).toContain("immediately");
  });
});

describe("pairing surface", () => {
  it("returns pairing_required immediately without progress polling", async () => {
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
    const d: Deps = {
      ensure: async () => ({ coordinator, hub: {} as any, port: 43443 }),
      peek: () => null,
      pairUrl: () => "http://127.0.0.1:43443/pair",
      waitForWorker: async () => { throw new Error("must not wait"); }
    };
    const server = createMcpServer(d);
    const client = new Client({ name: "test-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "list_tabs", arguments: {} });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body).toEqual({
      status: "pairing_required",
      pair_url: "http://127.0.0.1:43443/pair",
      tabs: []
    });
    await Promise.all([client.close(), server.close()]);
  });

  it("asks a capable MCP host to open the pairing URL without blocking list_tabs", async () => {
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
    const d: Deps = {
      ensure: async () => ({ coordinator, hub: {} as any, port: 43443 }),
      peek: () => null,
      pairUrl: () => "http://127.0.0.1:43443/pair",
      waitForWorker: async () => { throw new Error("must not wait"); }
    };
    const fallbackOpenUrl = vi.fn();
    const server = createMcpServer(d, undefined, { fallbackOpenUrl });
    const client = new Client(
      { name: "elicitation-client", version: "1" },
      { capabilities: { elicitation: { url: {} } } }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let finishElicitation!: (result: { action: "accept" }) => void;
    const elicitation = new Promise<{ action: "accept" }>((resolve) => {
      finishElicitation = resolve;
    });
    const requests: Array<{ mode?: string; url?: string; elicitationId?: string }> = [];
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      requests.push(request.params);
      return elicitation;
    });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: "list_tabs", arguments: {} });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text).status).toBe("pairing_required");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      mode: "url",
      url: "http://127.0.0.1:43443/pair"
    });
    expect(requests[0].elicitationId).toMatch(/^atwebpilot-pairing-/);
    expect(fallbackOpenUrl).not.toHaveBeenCalled();

    await client.callTool({ name: "list_tabs", arguments: {} });
    expect(requests).toHaveLength(1);
    finishElicitation({ action: "accept" });
    await Promise.all([client.close(), server.close()]);
  });

  it("falls back to the system opener when the MCP host lacks URL elicitation", async () => {
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
    const d: Deps = {
      ensure: async () => ({ coordinator, hub: {} as any, port: 43443 }),
      peek: () => null,
      pairUrl: () => "http://127.0.0.1:43443/pair",
      waitForWorker: async () => { throw new Error("must not wait"); }
    };
    const fallbackOpenUrl = vi.fn();
    const server = createMcpServer(d, undefined, { fallbackOpenUrl });
    const client = new Client({ name: "legacy-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.callTool({ name: "pairing_status", arguments: {} });
    await vi.waitFor(() => {
      expect(fallbackOpenUrl).toHaveBeenCalledWith("http://127.0.0.1:43443/pair");
    });

    await Promise.all([client.close(), server.close()]);
  });

  it("falls back when a capable MCP host cannot handle URL elicitation", async () => {
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
    const d: Deps = {
      ensure: async () => ({ coordinator, hub: {} as any, port: 43443 }),
      peek: () => null,
      pairUrl: () => "http://127.0.0.1:43443/pair",
      waitForWorker: async () => { throw new Error("must not wait"); }
    };
    const fallbackOpenUrl = vi.fn();
    const server = createMcpServer(d, undefined, { fallbackOpenUrl });
    const client = new Client(
      { name: "broken-elicitation-client", version: "1" },
      { capabilities: { elicitation: { url: {} } } }
    );
    client.setRequestHandler(ElicitRequestSchema, async () => {
      throw new Error("cannot present URL");
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await client.callTool({ name: "list_tabs", arguments: {} });
    await vi.waitFor(() => {
      expect(fallbackOpenUrl).toHaveBeenCalledWith("http://127.0.0.1:43443/pair");
    });

    consoleError.mockRestore();
    await Promise.all([client.close(), server.close()]);
  });

  it("presents the pairing URL when open_session is called before pairing", async () => {
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
    const bundle = { coordinator, hub: {} as any, port: 43443 };
    const d: Deps = {
      ensure: async () => bundle,
      peek: () => bundle,
      pairUrl: () => "http://127.0.0.1:43443/pair",
      waitForWorker: async () => { throw new Error("must not wait"); }
    };
    const presented: string[] = [];

    const result = await dispatchCall(
      d,
      "open_session",
      { tab_id: "42" },
      createToolState("core"),
      undefined,
      (url) => { presented.push(url); }
    );

    expect(result.isError).toBe(true);
    expect(presented).toEqual(["http://127.0.0.1:43443/pair"]);
  });

  it("reveals browser tools and emits list_changed once connection is observed", async () => {
    const state = createToolState("core");
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
    coordinator.registerWorker(fakeWorker());
    const server = createMcpServer(staticDeps(coordinator, { exec: async () => okResult } as any), state);
    const client = new Client({ name: "test-client", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const changes: number[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changes.push(1); });
    await Promise.all([server.connect(st), client.connect(ct)]);

    state.browserSurfaceVisible = false;
    await client.callTool({ name: "pairing_status", arguments: {} });
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("browser_click");
    await client.callTool({ name: "list_tabs", arguments: {} });
    expect(changes).toHaveLength(1);
    await Promise.all([client.close(), server.close()]);
  });
});

/** Narrows a CallResult's first block to text; image blocks have no `text`. */
function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  const b = r.content[0];
  if (b?.type !== "text" || typeof b.text !== "string") {
    throw new Error(`expected a text block, got ${b?.type}`);
  }
  return b.text;
}

describe("dispatchCall", () => {
  it("returns a concise quickstart by default and full guidance only on request", async () => {
    const quick = await dispatchCall(deps(), "atwebpilot_skill_read", {});
    const full = await dispatchCall(deps(), "atwebpilot_skill_read", { topic: "full" });
    expect(textOf(quick)).toContain("pairing_status");
    expect(textOf(quick)).toContain("browser_getPageInfo");
    expect(textOf(quick)).not.toMatch(/\buse getPageInfo\b/);
    expect(textOf(full)).toContain("## Capabilities you have");
    expect(textOf(quick).length).toBeLessThan(textOf(full).length / 3);
  });

  it("routes list_tabs and returns content", async () => {
    const r = await dispatchCall(deps(), "list_tabs", {});
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("42");
  });
  it("returns isError for unknown tool", async () => {
    const r = await dispatchCall(deps(), "no_such_tool", {});
    expect(r.isError).toBe(true);
  });
  it("routes a generated browser_* tool", async () => {
    const d = deps();
    const open = await dispatchCall(d, "open_session", { tab_id: "42" });
    const session_id = JSON.parse(textOf(open)).session_id;
    const r = await dispatchCall(d, "browser_getPageInfo", { session_id });
    expect(r.isError).toBeFalsy();
  });

  it("binds switchToTab and closeTab to the session tab", async () => {
    const coordinator = new Coordinator({
      hub: { send: async () => undefined } as any,
      clock: new FakeClock(0),
      idGen: new FakeIdGen()
    });
    coordinator.registerWorker(fakeWorker());
    const calls: Array<{ step: unknown }> = [];
    const d = staticDeps(coordinator, {
      exec: async (_workerId: string, params: { step: unknown }) => {
        calls.push(params);
        return okResult;
      }
    } as any);
    const open = await dispatchCall(d, "open_session", { tab_id: "42" });
    const session_id = JSON.parse(textOf(open)).session_id;

    await dispatchCall(d, "browser_switchToTab", { session_id });
    await dispatchCall(d, "browser_closeTab", { session_id });

    expect(calls.map((call) => call.step)).toEqual([
      { kind: "tool", tool: "switchToTab", args: { tabId: 42 } },
      { kind: "tool", tool: "closeTab", args: { tabId: 42 } }
    ]);
  });

  it("classifies read-only runJS as scanned and cookie access as unsafe", async () => {
    const coordinator = new Coordinator({
      hub: { send: async () => undefined } as any,
      clock: new FakeClock(0),
      idGen: new FakeIdGen()
    });
    coordinator.registerWorker(fakeWorker());
    const d = staticDeps(coordinator, { exec: async () => okResult } as any);
    const open = await dispatchCall(d, "open_session", { tab_id: "42" });
    const session_id = JSON.parse(textOf(open)).session_id;

    await dispatchCall(d, "browser_runJS", { session_id, source: "return getComputedStyle(document.body).display" });
    expect(coordinator.quotaFor(session_id)?.dangerous_used).toBe(0);

    await dispatchCall(d, "browser_runJS", { session_id, source: "return document.cookie" });
    expect(coordinator.quotaFor(session_id)?.dangerous_used).toBe(1);
  });

  it("forwards browser_storage to readStorage/writeStorage and charges dangerous on both", async () => {
    const coordinator = new Coordinator({
      hub: { send: async () => undefined } as any,
      clock: new FakeClock(0),
      idGen: new FakeIdGen()
    });
    coordinator.registerWorker(fakeWorker());
    const calls: Array<{ step: unknown }> = [];
    const d = staticDeps(coordinator, {
      exec: async (_workerId: string, params: { step: unknown }) => { calls.push(params); return okResult; }
    } as any);
    const open = await dispatchCall(d, "open_session", { tab_id: "42" });
    const session_id = JSON.parse(textOf(open)).session_id;

    const r1 = await dispatchCall(d, "browser_storage", { session_id, op: "get", store: "local", key: "k" });
    expect(r1.isError).toBeFalsy();
    const r2 = await dispatchCall(d, "browser_storage", { session_id, op: "set", store: "local", key: "k", value: "v" });
    expect(r2.isError).toBeFalsy();
    expect(calls.map((c) => c.step)).toEqual([
      { kind: "tool", tool: "readStorage", args: { store: "local", key: "k" } },
      { kind: "tool", tool: "writeStorage", args: { store: "local", key: "k", value: "v" } }
    ]);
    expect(coordinator.quotaFor(session_id)?.dangerous_used).toBe(2);
  });

  it("returns isError on an invalid merged-tool argument set", async () => {
    const d = deps();
    const open = await dispatchCall(d, "open_session", { tab_id: "42" });
    const session_id = JSON.parse(textOf(open)).session_id;
    const r = await dispatchCall(d, "browser_highlight", { session_id });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/InvalidArgs/);
  });
});

describe("image results", () => {
  function imageDeps() {
    const coordinator = new Coordinator({
      hub: { send: async () => undefined } as any,
      clock: new FakeClock(0),
      idGen: new FakeIdGen()
    });
    coordinator.registerWorker(fakeWorker());
    const shot: Result = {
      type: "RESULT", nonce: "n", ts: 1, protocol_version: 1, req_id: "req_1", ok: true,
      return: {
        data: "QUJD",
        media_type: "image/png",
        byteLen: 3,
        backend: "cdp",
        width: 390,
        height: 844
      }
    };
    return staticDeps(coordinator, { exec: async () => shot } as any);
  }

  it("returns a screenshot as an image content block", async () => {
    const d = imageDeps();
    const open = await dispatchCall(d, "open_session", { tab_id: "42" });
    const session_id = JSON.parse(textOf(open)).session_id;
    const r = await dispatchCall(d, "browser_screenshot", { session_id });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]).toEqual({ type: "image", data: "QUJD", mimeType: "image/png" });
  });

  it("keeps compact screenshot metadata without duplicating image data", async () => {
    const d = imageDeps();
    const open = await dispatchCall(d, "open_session", { tab_id: "42" });
    const session_id = JSON.parse(textOf(open)).session_id;
    const r = await dispatchCall(d, "browser_screenshot", { session_id });

    expect(r.content).toHaveLength(2);
    expect(r.content[1].type).toBe("text");
    const metadata = JSON.parse((r.content[1] as { type: "text"; text: string }).text);
    expect(metadata).toEqual({ byteLen: 3, backend: "cdp", width: 390, height: 844 });
    expect((r.content[1] as { type: "text"; text: string }).text).not.toContain("QUJD");
  });

  it("falls back to text when the payload is not an image", async () => {
    const d = deps();
    const open = await dispatchCall(d, "open_session", { tab_id: "42" });
    const session_id = JSON.parse(textOf(open)).session_id;
    const r = await dispatchCall(d, "browser_screenshot", { session_id });
    expect(r.content[0].type).toBe("text");
  });

  it("keeps json tools on text blocks", async () => {
    const d = deps();
    const open = await dispatchCall(d, "open_session", { tab_id: "42" });
    const session_id = JSON.parse(textOf(open)).session_id;
    const r = await dispatchCall(d, "browser_click", { session_id, selector: ".x" });
    expect(r.content[0].type).toBe("text");
  });
});

describe("discovery over MCP", () => {
  it("advertises browser_discoverTools in core mode and full mode alike", () => {
    const names = buildToolList(undefined, createToolState("core")).map((t) => t.name);
    expect(names).toContain("browser_discoverTools");
    const fullState = createToolState("full");
    fullState.browserSurfaceVisible = true;
    const fullNames = buildToolList(undefined, fullState).map((t) => t.name);
    expect(fullNames).toContain("browser_discoverTools");
    expect(fullNames).toContain("browser_downloadSpreadsheet");
  });

  it("enable adds the tool to tools/list and emits list_changed", async () => {
    const state = createToolState("core");
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
    coordinator.registerWorker({ ...fakeWorker(), supported_tools: new Set(["downloadSpreadsheet"]) });
    const d = staticDeps(coordinator, { exec: async () => okResult } as any);
    const server = createMcpServer(d, state);
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const changes: number[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changes.push(1); });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const before = (await client.listTools()).tools.map((t) => t.name);
    expect(before).not.toContain("browser_downloadSpreadsheet");

    const r = await client.callTool({ name: "browser_discoverTools", arguments: { enable: ["browser_downloadSpreadsheet"] } });
    const body = JSON.parse((r.content as Array<{ text: string }>)[0].text);
    expect(body.enabled[0].name).toBe("browser_downloadSpreadsheet");
    await vi.waitFor(() => expect(changes).toHaveLength(1));

    const after = (await client.listTools()).tools.map((t) => t.name);
    expect(after).toContain("browser_downloadSpreadsheet");
    await Promise.all([client.close(), server.close()]);
  });

  it("enableGroups adds a known group in one call and emits list_changed once", async () => {
    const state = createToolState("core");
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
    coordinator.registerWorker({ ...fakeWorker(), supported_tools: new Set(["searchBookmarks", "searchHistory"]) });
    const d = staticDeps(coordinator, { exec: async () => okResult } as any);
    const server = createMcpServer(d, state);
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const changes: number[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changes.push(1); });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const r = await client.callTool({ name: "browser_discoverTools", arguments: { enableGroups: ["browser-data"] } });
    const body = JSON.parse((r.content as Array<{ text: string }>)[0].text);
    expect(body.enabled.map((t: { name: string }) => t.name)).toEqual([
      "browser_searchBookmarks",
      "browser_searchHistory"
    ]);
    await vi.waitFor(() => expect(changes).toHaveLength(1));

    const after = (await client.listTools()).tools.map((t) => t.name);
    expect(after).toContain("browser_searchBookmarks");
    expect(after).toContain("browser_searchHistory");
    await Promise.all([client.close(), server.close()]);
  });

  it("enables and calls a discoverable tool through the bridge in the same client turn", async () => {
    const state = createToolState("core");
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
    coordinator.registerWorker({ ...fakeWorker(), supported_tools: new Set(["snapshotDOM"]) });
    const calls: Array<{ session_id: string; tab_id: string; step: unknown }> = [];
    const d = staticDeps(coordinator, {
      exec: async (_workerId: string, params: { session_id: string; tab_id: string; step: unknown }) => {
        calls.push(params);
        return okResult;
      }
    } as any);
    const server = createMcpServer(d, state);
    const client = new Client({ name: "same-turn-client", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const initial = (await client.listTools()).tools.map((tool) => tool.name);
    expect(initial).toContain("browser_call");
    expect(initial).not.toContain("browser_snapshotDOM");

    const opened = await client.callTool({ name: "open_session", arguments: { tab_id: "42" } });
    const session_id = JSON.parse((opened.content as Array<{ text: string }>)[0].text).session_id;
    const discovered = await client.callTool({
      name: "browser_discoverTools",
      arguments: { enable: ["browser_snapshotDOM"] }
    });
    const discoveryBody = JSON.parse((discovered.content as Array<{ text: string }>)[0].text);
    expect(discoveryBody.changed).toBeUndefined();
    expect(discoveryBody.enabled[0].name).toBe("browser_snapshotDOM");
    expect(discoveryBody.enabled[0].inputSchema).toBeTruthy();

    const called = await client.callTool({
      name: "browser_call",
      arguments: {
        session_id,
        tool: "browser_snapshotDOM",
        args: { root: "main", maxDepth: 4, session_id: "nested-session-must-not-win" }
      }
    });
    expect(called.isError).toBeFalsy();
    expect(calls).toEqual([{
      session_id,
      tab_id: "42",
      step: { kind: "tool", tool: "snapshotDOM", args: { root: "main", maxDepth: 4 } }
    }]);

    await Promise.all([client.close(), server.close()]);
  });

  it("rejects unknown tools through the bridge", async () => {
    const result = await dispatchCall(deps(), "browser_call", {
      session_id: "s1",
      tool: "browser_notReal",
      args: {}
    }, createToolState("full"));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/unknown browser tool/i);
  });

  it("rejects bridge calls for tools that were not enabled", async () => {
    const state = createToolState("core");
    const d = deps();
    const opened = await dispatchCall(d, "open_session", { tab_id: "42" }, state);
    const session_id = JSON.parse(textOf(opened)).session_id;

    const result = await dispatchCall(d, "browser_call", {
      session_id,
      tool: "browser_snapshotDOM",
      args: {}
    }, state);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not enabled/i);
  });

  it("rejects bridge calls that the connected worker cannot run", async () => {
    const state = createToolState("full");
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
    coordinator.registerWorker({ ...fakeWorker(), supported_tools: new Set(["click"]) });
    const d = staticDeps(coordinator, { exec: async () => okResult } as any);
    const opened = await dispatchCall(d, "open_session", { tab_id: "42" }, state);
    const session_id = JSON.parse(textOf(opened)).session_id;

    const result = await dispatchCall(d, "browser_call", {
      session_id,
      tool: "browser_snapshotDOM",
      args: {}
    }, state);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not supported/i);
  });

  it("keeps screenshot image blocks and dangerous accounting through the bridge", async () => {
    const state = createToolState("full");
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
    coordinator.registerWorker({
      ...fakeWorker(),
      supported_tools: new Set(["screenshot", "readStorage", "writeStorage"])
    });
    const d = staticDeps(coordinator, {
      exec: async (_workerId: string, params: { step: { tool: string } }) => ({
        ...okResult,
        return: params.step.tool === "screenshot"
          ? { data: "aW1n", media_type: "image/png", width: 10 }
          : { ok: true }
      })
    } as any);
    const opened = await dispatchCall(d, "open_session", { tab_id: "42" }, state);
    const session_id = JSON.parse(textOf(opened)).session_id;

    const screenshot = await dispatchCall(d, "browser_call", {
      session_id,
      tool: "browser_screenshot",
      args: {}
    }, state);
    expect(screenshot.content[0]).toEqual({ type: "image", data: "aW1n", mimeType: "image/png" });
    expect(screenshot.content[1]).toEqual({ type: "text", text: JSON.stringify({ width: 10 }) });

    const storage = await dispatchCall(d, "browser_call", {
      session_id,
      tool: "browser_storage",
      args: { op: "get", store: "local", key: "k" }
    }, state);
    expect(storage.isError).toBeFalsy();
    expect(coordinator.quotaFor(session_id)?.dangerous_used).toBe(1);
  });

  it("a non-advertised tool is still callable by name (client cache may lag)", async () => {
    const d = deps();
    const state = createToolState("core");
    const open = await dispatchCall(d, "open_session", { tab_id: "42" }, state);
    const session_id = JSON.parse(textOf(open)).session_id;
    const r = await dispatchCall(d, "browser_snapshotDOM", { session_id }, state);
    expect(r.isError).toBeFalsy();
  });

  it("worker support filter applies to merged tools via every underlying builtin", () => {
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
    coordinator.registerWorker({ ...fakeWorker(), supported_tools: new Set(["click", "readStorage"]) });
    const d = staticDeps(coordinator, { exec: async () => okResult } as any);
    const names = buildToolList(d, createToolState("full")).map((t) => t.name);
    expect(names).toContain("browser_click");
    expect(names).not.toContain("browser_storage"); // writeStorage missing
  });

  it("enable on an unsupported tool reports unsupported and never advertises it", async () => {
    const state = createToolState("core");
    const coordinator = new Coordinator({ hub: { send: async () => undefined } as any, clock: new FakeClock(0), idGen: new FakeIdGen() });
    coordinator.registerWorker({ ...fakeWorker(), supported_tools: new Set(["downloadImage"]) });
    const d = staticDeps(coordinator, { exec: async () => okResult } as any);

    const r = await dispatchCall(d, "browser_discoverTools", { enable: ["browser_storage"] }, state);
    const body = JSON.parse(textOf(r));
    expect(body.unsupported).toEqual(["browser_storage"]);
    expect(body.enabled ?? []).toEqual([]);

    const names = buildToolList(d, state).map((t) => t.name);
    expect(names).not.toContain("browser_storage");
  });
});
