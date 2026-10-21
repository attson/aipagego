import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRpc, setRecorderPolicy } from "@/background/rpc-handlers";
import { detachCdp } from "@/background/recorder/cdp";
import { _resetDBForTests } from "@/background/storage/db";
import { saveDraft } from "@/background/storage/tools";

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
});

describe("runs.runOneStep tabId gate", () => {
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
