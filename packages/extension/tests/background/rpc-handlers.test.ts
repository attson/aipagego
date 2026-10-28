import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRpc, setRecorderPolicy } from "@/background/rpc-handlers";
import { META_TOOLS } from "@/background/meta-tool-router";
import { detachCdp } from "@/background/recorder/cdp";
import { _resetDBForTests, getDB } from "@/background/storage/db";
import { appendVersion, getTool, saveDraft } from "@/background/storage/tools";

vi.stubGlobal("chrome", {
  tabs: {
    get: vi.fn(async () => ({ id: 1, url: "https://example.com/" })),
    sendMessage: vi.fn()
  }
});

describe("rpc handlers tool kinds", () => {
  beforeEach(() => {
    _resetDBForTests();
    indexedDB = new IDBFactory();
    vi.clearAllMocks();
  });

  it("saves prompt drafts", async () => {
    const res = await handleRpc({
      type: "tools.save",
      draft: {
        kind: "prompt",
        name: "Prompt",
        urlPatterns: ["https://example.com/**"],
        description: "",
        prompt: "请总结当前页"
      }
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ kind: "prompt", prompt: "请总结当前页" });
  });

  it("rejects running prompt tools in background runner", async () => {
    const tool = await saveDraft({
      kind: "prompt",
      name: "Prompt",
      urlPatterns: ["https://example.com/**"],
      description: "",
      prompt: "请总结当前页"
    });

    const res = await handleRpc({ type: "runs.start", target: { kind: "tool", id: tool.id }, tabId: 1 });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("prompt tools run in chat");
  });
});

describe("parameterized workflow runs", () => {
  beforeEach(() => {
    _resetDBForTests();
    indexedDB = new IDBFactory();
    vi.clearAllMocks();
  });

  function workflowChrome() {
    const sendMessage = vi.fn(async (
      _tabId: number,
      _request: unknown
    ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> => ({
      ok: true,
      data: null
    }));
    return {
      storage: {
        local: {
          get: vi.fn(async () => ({
            "aipagego.llm": {
              defaultInjectionMode: "operate",
              defaultAssistantEnabled: false,
              siteInjectionRules: [],
              selfHealEnabled: false
            }
          }))
        },
        session: { get: vi.fn(async () => ({})) }
      },
      tabs: {
        get: vi.fn(async () => ({ id: 1, url: "https://example.com/" })),
        sendMessage
      },
      runtime: { sendMessage: vi.fn() }
    };
  }

  it("rejects missing required inputs before the first page action", async () => {
    const fake = workflowChrome();
    vi.stubGlobal("chrome", fake);

    const res = await handleRpc({
      type: "runs.start",
      target: {
        kind: "draft",
        draft: {
          kind: "steps",
          name: "Search",
          description: "",
          urlPatterns: ["https://example.com/**"],
          parameters: [
            { key: "query", label: "Query", type: "string", required: true }
          ],
          steps: [
            { kind: "tool", tool: "fillInput", args: { selector: "#q", value: "${query}" } }
          ],
          outputSchema: null
        }
      },
      tabId: 1,
      inputs: {}
    });

    expect(res).toEqual({ ok: false, error: "missing_required_input: query" });
    expect(fake.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "unknown input",
      inputs: { query: "ok", extra: true },
      error: "unknown_input: extra"
    },
    {
      label: "wrong input type",
      inputs: { query: 42 },
      error: "input_type_mismatch: query"
    }
  ])("rejects $label before the first page action", async ({ inputs, error }) => {
    const fake = workflowChrome();
    vi.stubGlobal("chrome", fake);

    const res = await handleRpc({
      type: "runs.start",
      target: {
        kind: "draft",
        draft: {
          kind: "steps",
          name: "Validated Search",
          description: "",
          urlPatterns: ["https://example.com/**"],
          parameters: [
            { key: "query", label: "Query", type: "string", required: true }
          ],
          steps: [
            { kind: "tool", tool: "fillInput", args: { selector: "#q", value: "${query}" } }
          ],
          outputSchema: null
        }
      },
      tabId: 1,
      inputs
    });

    expect(res).toEqual({ ok: false, error });
    expect(fake.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects an unknown binding before the first page action", async () => {
    const fake = workflowChrome();
    vi.stubGlobal("chrome", fake);

    const res = await handleRpc({
      type: "runs.start",
      target: {
        kind: "draft",
        draft: {
          kind: "steps",
          name: "Invalid Workflow",
          description: "",
          urlPatterns: ["https://example.com/**"],
          steps: [
            { kind: "tool", tool: "fillInput", args: { selector: "#q", value: "${future}" } }
          ],
          outputSchema: null
        }
      },
      tabId: 1
    });

    expect(res).toMatchObject({
      ok: false,
      error: expect.stringContaining('"code":"unknown_binding"')
    });
    expect(fake.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("runs the active snapshot with its defaults and records its real version", async () => {
    const fake = workflowChrome();
    fake.tabs.sendMessage.mockResolvedValue({ ok: true, data: "done" });
    vi.stubGlobal("chrome", fake);
    const tool = await saveDraft({
      kind: "steps",
      name: "Versioned Search",
      description: "",
      urlPatterns: ["https://example.com/**"],
      parameters: [
        {
          key: "query",
          label: "Query",
          type: "string",
          required: false,
          defaultValue: "from-v1"
        }
      ],
      steps: [
        { kind: "tool", tool: "fillInput", args: { selector: "#q", value: "${query}" } }
      ],
      outputSchema: null
    });
    const v2 = await appendVersion(tool.id, {
      steps: [
        { kind: "tool", tool: "fillInput", args: { selector: "#q", value: "from-v2" } }
      ],
      outputSchema: null
    });
    if (v2.kind !== "steps") throw new Error("expected steps tool");
    const db = await getDB();
    await db.put("tools", { ...v2, activeVersion: 1 });

    const res = await handleRpc({
      type: "runs.start",
      target: { kind: "tool", id: tool.id },
      tabId: 1
    });

    expect(res).toMatchObject({
      ok: true,
      data: { status: "ok", toolVersion: 1, output: "done" }
    });
    expect(fake.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        type: "content.runStep",
        step: expect.objectContaining({
          args: { selector: "#q", value: "from-v1" }
        })
      })
    );
  });

  it("runs an activated historical version and switches back without appending history", async () => {
    const fake = workflowChrome();
    fake.tabs.sendMessage.mockResolvedValue({ ok: true, data: "done" });
    vi.stubGlobal("chrome", fake);
    const tool = await saveDraft({
      kind: "steps",
      name: "Switchable",
      description: "",
      urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h1" } }],
      outputSchema: null,
    });
    await appendVersion(tool.id, {
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h2" } }],
      outputSchema: null,
    });

    await handleRpc({ type: "workflows.activate", id: tool.id, version: 1 });
    const oldRun = await handleRpc({
      type: "runs.start",
      target: { kind: "tool", id: tool.id },
      tabId: 1,
    });
    await handleRpc({ type: "workflows.activate", id: tool.id, version: 2 });
    const latestRun = await handleRpc({
      type: "runs.start",
      target: { kind: "tool", id: tool.id },
      tabId: 1,
    });

    expect(oldRun).toMatchObject({ ok: true, data: { toolVersion: 1 } });
    expect(latestRun).toMatchObject({ ok: true, data: { toolVersion: 2 } });
    expect((await getTool(tool.id))?.versions).toHaveLength(2);
  });

  it("returns the configured output binding instead of the last step output", async () => {
    const fake = workflowChrome();
    fake.tabs.sendMessage.mockImplementation(async (_tabId, request) => {
      const selector = (request as { step: { args: { selector: string } } }).step.args.selector;
      return selector === "#first"
        ? { ok: true, data: { rows: [{ title: "chosen" }] } }
        : { ok: true, data: "last-step" };
    });
    vi.stubGlobal("chrome", fake);

    const res = await handleRpc({
      type: "runs.start",
      target: {
        kind: "draft",
        draft: {
          kind: "steps",
          name: "Selected Output",
          description: "",
          urlPatterns: ["https://example.com/**"],
          steps: [
            {
              kind: "tool",
              tool: "extractText",
              args: { selector: "#first" },
              bindResultTo: "selected"
            },
            {
              kind: "tool",
              tool: "extractText",
              args: { selector: "${selected.rows.0.title}" }
            }
          ],
          outputBinding: "selected",
          outputSchema: null
        }
      },
      tabId: 1
    });

    expect(res).toMatchObject({
      ok: true,
      data: {
        status: "ok",
        output: { rows: [{ title: "chosen" }] }
      }
    });
    expect(fake.tabs.sendMessage).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({
        step: expect.objectContaining({ args: { selector: "chosen" } })
      })
    );
  });

  it("executes with sensitive values in memory but redacts tainted persisted results", async () => {
    const fake = workflowChrome();
    const executedValues: unknown[] = [];
    fake.tabs.sendMessage.mockImplementation(async (_tabId, request) => {
      const value = (request as { step: { args: { value: unknown } } }).step.args.value;
      executedValues.push(value);
      return { ok: true, data: value };
    });
    vi.stubGlobal("chrome", fake);

    const res = await handleRpc({
      type: "runs.start",
      target: {
        kind: "draft",
        draft: {
          kind: "steps",
          name: "Sensitive Flow",
          description: "",
          urlPatterns: ["https://example.com/**"],
          parameters: [
            {
              key: "secret",
              label: "Secret",
              type: "string",
              required: true,
              sensitive: true
            }
          ],
          steps: [
            {
              kind: "tool",
              tool: "fillInput",
              args: { selector: "#token", value: "${secret}" },
              bindResultTo: "echo"
            },
            {
              kind: "tool",
              tool: "fillInput",
              args: { selector: "#confirm", value: "${echo}" },
              bindResultTo: "final"
            }
          ],
          outputBinding: "final",
          outputSchema: null
        }
      },
      tabId: 1,
      inputs: { secret: "sk-private" }
    });

    expect(executedValues).toEqual(["sk-private", "sk-private"]);
    expect(res).toMatchObject({
      ok: true,
      data: {
        status: "ok",
        stepLog: [
          { input: { __redacted: true }, output: { __redacted: true } },
          { input: { __redacted: true }, output: { __redacted: true } }
        ],
        output: { __redacted: true }
      }
    });
    expect(JSON.stringify(res)).not.toContain("sk-private");
  });

  it("redacts error details emitted by a tainted step", async () => {
    const fake = workflowChrome();
    fake.tabs.sendMessage.mockResolvedValue({
      ok: false,
      error: "page rejected sk-private"
    });
    vi.stubGlobal("chrome", fake);

    const res = await handleRpc({
      type: "runs.start",
      target: {
        kind: "draft",
        draft: {
          kind: "steps",
          name: "Sensitive Failure",
          description: "",
          urlPatterns: ["https://example.com/**"],
          parameters: [
            {
              key: "secret",
              label: "Secret",
              type: "string",
              required: true,
              sensitive: true
            }
          ],
          steps: [
            {
              kind: "tool",
              tool: "fillInput",
              args: { selector: "#token", value: "${secret}" }
            }
          ],
          outputSchema: null
        }
      },
      tabId: 1,
      inputs: { secret: "sk-private" }
    });

    expect(res).toMatchObject({
      ok: true,
      data: {
        status: "error",
        stepLog: [{
          input: { __redacted: true },
          output: { __redacted: true },
          error: { __redacted: true }
        }]
      }
    });
    expect(JSON.stringify(res)).not.toContain("sk-private");
  });
});

describe("workflow publishing RPC", () => {
  beforeEach(() => {
    _resetDBForTests();
    indexedDB = new IDBFactory();
    vi.clearAllMocks();
  });

  it("publishes and activates a validated workflow snapshot", async () => {
    const tool = await saveDraft({
      kind: "steps",
      name: "Studio RPC",
      description: "",
      urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
      outputSchema: null
    });

    const res = await handleRpc({
      type: "workflows.publish",
      id: tool.id,
      basedOnVersion: 1,
      parameters: [
        { key: "selector", label: "Selector", type: "string", required: true }
      ],
      steps: [
        {
          kind: "tool",
          tool: "extractText",
          args: { selector: "${selector}" },
          bindResultTo: "result"
        }
      ],
      outputBinding: "result",
      outputSchema: { type: "string" },
      note: "edited in studio"
    });

    expect(res).toMatchObject({
      ok: true,
      data: {
        kind: "steps",
        activeVersion: 2,
        versions: [
          { version: 1 },
          { version: 2, basedOnVersion: 1, note: "edited in studio" }
        ]
      }
    });
  });

  it("activates a historical workflow snapshot without appending a version", async () => {
    const tool = await saveDraft({
      kind: "steps",
      name: "Activation RPC",
      description: "",
      urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
      outputSchema: null,
    });
    await appendVersion(tool.id, {
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h1" } }],
      outputSchema: { type: "string" },
    });

    const res = await handleRpc({
      type: "workflows.activate",
      id: tool.id,
      version: 1,
    });

    expect(res).toMatchObject({
      ok: true,
      data: { activeVersion: 1, versions: [{ version: 1 }, { version: 2 }] },
    });
  });
});

describe("recorder policy", () => {
  it("injects the recorder build entry in the MAIN world", async () => {
    const executeScript = vi.fn().mockResolvedValue([]);
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: vi.fn(() => ({
          content_scripts: [
            { js: ["assets/bootstrap.js"] },
            { js: ["assets/recorder.js"] }
          ]
        }))
      },
      scripting: { executeScript }
    });

    await setRecorderPolicy(7, true);

    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["assets/recorder.js"],
      world: "MAIN"
    });
  });

  it("uninstalls recorder patches when diagnostic mode is disabled", async () => {
    const executeScript = vi.fn().mockImplementation(async (details: {
      func?: (source: string, args: unknown) => Promise<unknown>;
      args?: unknown[];
      world?: string;
    }) => {
      const func = details.func as ((source: string, args: unknown) => Promise<unknown>) | undefined;
      expect(details.world).toBe("MAIN");
      expect(details.args?.[1]).toEqual({ op: "uninstall" });
      expect(String(details.args?.[0])).toContain("rec.uninstall()");
      expect(func).toBeTypeOf("function");
      return [{ result: { ok: true } }];
    });
    vi.stubGlobal("chrome", { scripting: { executeScript } });

    await setRecorderPolicy(8, false);

    expect(executeScript).toHaveBeenCalledOnce();
  });
});

describe("scripting.injectMain CSP fallback", () => {
  const tabId = 91;

  function runJsChrome(mainResult: unknown, options: { executeInjected?: boolean; cdpEnabled?: boolean } = {}) {
    const sendCommand = vi.fn(async (_target: chrome.debugger.Debuggee, method: string, _params?: object) =>
      method === "Runtime.evaluate" ? { result: { type: "number", value: 2 } } : {}
    );
    const chromeStub = {
      storage: {
        local: {
          get: vi.fn(async () => ({
            "aipagego.llm": {
              defaultInjectionMode: "operate",
              defaultAssistantEnabled: false,
              siteInjectionRules: []
            },
            "aipagego.recorder.cdpEnabled": options.cdpEnabled !== false
          }))
        }
      },
      permissions: { contains: vi.fn(async () => options.cdpEnabled !== false) },
      tabs: { get: vi.fn(async () => ({ id: tabId, url: "https://github.com/" })) },
      scripting: {
        executeScript: vi.fn(async (details: {
          func?: (source: string, args: unknown) => unknown;
          args?: [string, unknown];
        }) => [{
          result: options.executeInjected
            ? await details.func!(...details.args!)
            : mainResult
        }])
      },
      debugger: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand
      }
    };
    vi.stubGlobal("chrome", chromeStub);
    return chromeStub;
  }

  afterEach(async () => {
    await detachCdp(tabId);
  });

  it("uses CDP after a compile-stage CSP EvalError", async () => {
    const chromeStub = runJsChrome({
      __ok: false,
      phase: "compile",
      errorName: "EvalError",
      error: "EvalError: Refused to evaluate a string because 'unsafe-eval' is not an allowed source"
    });

    const result = await handleRpc({
      type: "scripting.injectMain",
      tabId,
      source: "return 1 + 1",
      args: {}
    });

    expect(result).toEqual({ ok: true, data: 2 });
    expect(chromeStub.debugger.attach).toHaveBeenCalledOnce();
    expect(chromeStub.scripting.executeScript).toHaveBeenCalledOnce();
  });

  it("does not retry a runtime error even when its message mentions unsafe-eval", async () => {
    const chromeStub = runJsChrome(null, { executeInjected: true });

    const result = await handleRpc({
      type: "scripting.injectMain",
      tabId,
      source: "throw new EvalError('user code reports unsafe-eval')",
      args: {}
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("user code") });
    expect(chromeStub.debugger.attach).not.toHaveBeenCalled();
  });

  it("keeps successful scripts on the MAIN-world path", async () => {
    const chromeStub = runJsChrome(null, { executeInjected: true });

    const result = await handleRpc({
      type: "scripting.injectMain",
      tabId,
      source: "return 1 + 1",
      args: {}
    });

    expect(result).toEqual({ ok: true, data: 2 });
    expect(chromeStub.debugger.attach).not.toHaveBeenCalled();
  });

  it("does not retry ordinary syntax errors", async () => {
    const chromeStub = runJsChrome(null, { executeInjected: true });

    const result = await handleRpc({
      type: "scripting.injectMain",
      tabId,
      source: "return (",
      args: {}
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/SyntaxError/i) });
    expect(chromeStub.debugger.attach).not.toHaveBeenCalled();
  });

  it("returns setup guidance when CSP blocks MAIN world and CDP is off", async () => {
    const chromeStub = runJsChrome({
      __ok: false,
      phase: "compile",
      errorName: "EvalError",
      error: "EvalError: 'unsafe-eval' is not an allowed source"
    }, { cdpEnabled: false });

    const result = await handleRpc({
      type: "scripting.injectMain",
      tabId,
      source: "return 1 + 1",
      args: {}
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Coordinator.*CDP.*debugger.*inspectElement/i)
    });
    expect(chromeStub.debugger.attach).not.toHaveBeenCalled();
  });
});

describe("tabs.list", () => {
  it("returns tabs across windows, excluding chrome:// and incognito", async () => {
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn(),
        sendMessage: vi.fn(),
        query: vi.fn(async () => [
          { id: 1, windowId: 10, url: "https://a.com/x", title: "A", incognito: false },
          { id: 2, windowId: 10, url: "chrome://flags", title: "F", incognito: false },
          { id: 3, windowId: 11, url: "https://b.com",  title: "B", incognito: true },
          { id: 4, windowId: 11, url: "about:blank",    title: "",  incognito: false },
          { id: 5, windowId: 11, url: "https://c.com",  title: "C", incognito: false }
        ])
      }
    });
    const res = await handleRpc({ type: "tabs.list" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const ids = (res.data as { tabs: Array<{ tabId: number }> }).tabs.map((t) => t.tabId);
      expect(ids.sort()).toEqual([1, 5]);
    }
  });

  it("filters by windowId when provided", async () => {
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: "https://example.com/" })),
        sendMessage: vi.fn(),
        query: vi.fn(async (q: chrome.tabs.QueryInfo) => {
          const all = [
            { id: 1, windowId: 10, url: "https://a.com", title: "A", incognito: false },
            { id: 2, windowId: 11, url: "https://b.com", title: "B", incognito: false }
          ];
          return q.windowId == null ? all : all.filter((t) => t.windowId === q.windowId);
        })
      }
    });
    const res = await handleRpc({ type: "tabs.list", windowId: 11 });
    if (res.ok) {
      expect((res.data as { tabs: Array<{ tabId: number }> }).tabs.map((t) => t.tabId)).toEqual([2]);
    }
  });
});

describe("tabs.open", () => {
  it("creates a tab via chrome.tabs.create and returns {tabId, url, title}", async () => {
    const created: unknown[] = [];
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: "https://example.com/" })),
        sendMessage: vi.fn(),
        create: vi.fn(async (info: chrome.tabs.CreateProperties) => {
          created.push(info);
          return { id: 42, windowId: 1, url: info.url ?? "", title: "" };
        })
      }
    });
    const res = await handleRpc({ type: "tabs.open", url: "https://x.com" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { tabId: number; url: string };
      expect(d.tabId).toBe(42);
      expect(d.url).toBe("https://x.com");
    }
    expect(created).toHaveLength(1);
  });

  it("rejects chrome:// URLs", async () => {
    // Note: zod's z.string().url() accepts "chrome://flags" as a valid URL,
    // so this passes parse and reaches the handler. The handler then
    // rejects via isAccessibleUrl.
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn(), sendMessage: vi.fn(), create: vi.fn() }
    });
    const res = await handleRpc({ type: "tabs.open", url: "chrome://flags" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/scheme/i);
  });

  it("forwards incognito and windowId to the tab opener", async () => {
    const create = vi.fn(async (info: chrome.tabs.CreateProperties) => ({
      id: 43,
      windowId: info.windowId,
      url: info.url ?? "",
      title: "",
      incognito: true
    }));
    vi.stubGlobal("chrome", {
      extension: {
        isAllowedIncognitoAccess: vi.fn((callback: (allowed: boolean) => void) => callback(true))
      },
      runtime: {},
      tabs: {
        get: vi.fn(),
        sendMessage: vi.fn(),
        create
      },
      windows: {
        getAll: vi.fn(async () => [{ id: 22, type: "normal", incognito: true }]),
        create: vi.fn()
      }
    });

    const res = await handleRpc({
      type: "tabs.open",
      url: "https://x.com",
      incognito: true,
      windowId: 22
    });

    expect(res.ok).toBe(true);
    expect(create).toHaveBeenCalledWith({ url: "https://x.com", active: false, windowId: 22 });
  });
});

describe("runs.runOneStep tabId gate", () => {
  it("resolves nested bindings before dispatching a background meta tool", async () => {
    const original = META_TOOLS.collectStructuredData;
    META_TOOLS.collectStructuredData = vi.fn(async (args) => args);
    vi.stubGlobal("chrome", {
      storage: { local: { get: vi.fn(async () => ({
        "aipagego.llm": {
          defaultInjectionMode: "operate",
          defaultAssistantEnabled: false,
          siteInjectionRules: []
        }
      })) } },
      tabs: {
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: "https://example.com/" })),
        sendMessage: vi.fn()
      }
    });

    try {
      const res = await handleRpc({
        type: "runs.runOneStep",
        step: {
          kind: "tool",
          tool: "collectStructuredData",
          args: { recipe: "${workflow.recipe}" }
        },
        tabId: 1,
        attachedTabIds: [],
        bindings: {
          workflow: {
            recipe: {
              version: 1,
              name: "Products",
              fields: [{ key: "title", label: "Title", selector: "h2", value: "text" }],
              pagination: { kind: "single" }
            }
          }
        }
      });

      expect(res).toMatchObject({
        ok: true,
        data: {
          recipe: {
            name: "Products",
            pagination: { kind: "single" }
          }
        }
      });
    } finally {
      META_TOOLS.collectStructuredData = original;
    }
  });

  it("rejects tabId not in attachedTabIds and not equal to RPC.tabId", async () => {
    const res = await handleRpc({
      type: "runs.runOneStep",
      step: { kind: "tool", tool: "snapshotDOM", args: { tabId: 999 } },
      tabId: 1,
      attachedTabIds: [2, 3]
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/tab 999 not attached/);
  });

  it("accepts args.tabId in attachedTabIds (dispatches to that tab)", async () => {
    const sends: Array<{ tabId: number }> = [];
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: "https://example.com/" })),
        sendMessage: vi.fn(async (tabId: number) => {
          sends.push({ tabId });
          return { ok: true, data: null };
        })
      }
    });
    const res = await handleRpc({
      type: "runs.runOneStep",
      step: { kind: "tool", tool: "snapshotDOM", args: { tabId: 2 } },
      tabId: 1,
      attachedTabIds: [2, 3]
    });
    expect(res.ok).toBe(true);
    expect(sends[0].tabId).toBe(2);
  });

  it("tolerates args.tabId === 0 by treating as 'omitted' and using session tab", async () => {
    const sends: Array<{ tabId: number }> = [];
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: "https://example.com/" })),
        sendMessage: vi.fn(async (tabId: number) => {
          sends.push({ tabId });
          return { ok: true, data: null };
        })
      }
    });
    const res = await handleRpc({
      type: "runs.runOneStep",
      step: { kind: "tool", tool: "snapshotDOM", args: { tabId: 0 } },
      tabId: 1,
      attachedTabIds: []
    });
    expect(res.ok).toBe(true);
    expect(sends[0].tabId).toBe(1);
  });

  it("tolerates negative args.tabId by treating as 'omitted' and using session tab", async () => {
    const sends: Array<{ tabId: number }> = [];
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: "https://example.com/" })),
        sendMessage: vi.fn(async (tabId: number) => {
          sends.push({ tabId });
          return { ok: true, data: null };
        })
      }
    });
    const res = await handleRpc({
      type: "runs.runOneStep",
      step: { kind: "tool", tool: "snapshotDOM", args: { tabId: -1 } },
      tabId: 1,
      attachedTabIds: []
    });
    expect(res.ok).toBe(true);
    expect(sends[0].tabId).toBe(1);
  });

  it("kind=js never uses args.tabId; always RPC.tabId", async () => {
    const sends: Array<{ tabId: number }> = [];
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: "https://example.com/" })),
        sendMessage: vi.fn(async (tabId: number) => {
          sends.push({ tabId });
          return { ok: true, data: null };
        })
      }
    });
    await handleRpc({
      type: "runs.runOneStep",
      step: { kind: "js", source: "return 1" },
      tabId: 1,
      attachedTabIds: [2]
    });
    expect(sends[0].tabId).toBe(1);
  });
});

describe("runs.runOneStep injection policy gate", () => {
  function policyChrome(mode: string) {
    return {
      storage: { local: { get: vi.fn(async () => ({
        "aipagego.llm": {
          defaultInjectionMode: mode,
          defaultAssistantEnabled: false,
          siteInjectionRules: []
        }
      })) } },
      tabs: {
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: "https://example.com/" })),
        sendMessage: vi.fn(async () => ({ ok: true, data: null }))
      }
    };
  }

  it("allows DOM reads in read mode", async () => {
    vi.stubGlobal("chrome", policyChrome("read"));
    const res = await handleRpc({
      type: "runs.runOneStep",
      step: { kind: "tool", tool: "snapshotDOM", args: {} },
      tabId: 1,
      attachedTabIds: []
    });
    expect(res.ok).toBe(true);
  });

  it("rejects page actions in read mode", async () => {
    const fake = policyChrome("read");
    vi.stubGlobal("chrome", fake);
    const res = await handleRpc({
      type: "runs.runOneStep",
      step: { kind: "tool", tool: "click", args: { selector: "button" } },
      tabId: 1,
      attachedTabIds: []
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("需要「操作」");
    expect(fake.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects recorder reads below diagnostic mode", async () => {
    vi.stubGlobal("chrome", policyChrome("operate"));
    const res = await handleRpc({
      type: "runs.runOneStep",
      step: { kind: "tool", tool: "consoleMessages", args: {} },
      tabId: 1,
      attachedTabIds: []
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("需要「诊断」");
  });
});
