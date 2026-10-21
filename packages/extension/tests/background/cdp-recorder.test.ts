import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CdpRecorder,
  attachCdp,
  captureScreenshotWithCdp,
  detachCdp,
  evaluateWithCdp,
  getAttachedCdpRecorder,
  installCdpListeners
} from "@/background/recorder/cdp";
import { getRecorder, registerCdpLookup, registerInjectMain } from "@/background/recorder/host";

const realChrome = globalThis.chrome;

type Listener = (...a: unknown[]) => void;

function fakeChrome(opts: { attachFails?: string; enabled?: boolean } = {}) {
  const listeners: Record<string, Listener[]> = { onEvent: [], onDetach: [], onRemoved: [] };
  const sendCommand = vi.fn(async (
    _target: chrome.debugger.Debuggee,
    _method: string,
    _params?: object
  ): Promise<unknown> => ({}));
  const chromeStub = {
    debugger: {
      attach: vi.fn(async () => {
        if (opts.attachFails) throw new Error(opts.attachFails);
      }),
      detach: vi.fn(async () => undefined),
      sendCommand,
      onEvent: { addListener: (f: Listener) => listeners.onEvent.push(f) },
      onDetach: { addListener: (f: Listener) => listeners.onDetach.push(f) }
    },
    tabs: { onRemoved: { addListener: (f: Listener) => listeners.onRemoved.push(f) } },
    permissions: { contains: vi.fn(async () => opts.enabled !== false) },
    storage: {
      local: {
        get: vi.fn(async () => ({ "aipagego.recorder.cdpEnabled": opts.enabled !== false })),
        set: vi.fn(async () => undefined)
      }
    }
  };
  globalThis.chrome = chromeStub as unknown as typeof chrome;
  return { listeners, sendCommand, chromeStub };
}

beforeEach(() => {
  registerCdpLookup(() => null);
  registerInjectMain(async () => ({ missing: true }) as never);
});

afterEach(async () => {
  await detachCdp(1).catch(() => undefined);
  globalThis.chrome = realChrome;
  vi.restoreAllMocks();
});

describe("attachCdp", () => {
  it("returns null and records why when the tab is already claimed", async () => {
    fakeChrome({ attachFails: "Another debugger is already attached to the tab with id: 1" });
    installCdpListeners();
    expect(await attachCdp(1)).toBeNull();

    const rec = getRecorder(1);
    expect(rec.backend).toBe("main-world");
    const out = await rec.readConsole({});
    expect(out.degradedReason).toContain("attach failed");
  });

  it("returns null when the setting is off", async () => {
    fakeChrome({ enabled: false });
    expect(await attachCdp(1)).toBeNull();
  });

  it("enables the domains it needs on success", async () => {
    const { chromeStub } = fakeChrome();
    installCdpListeners();
    const rec = await attachCdp(1);
    expect(rec).not.toBeNull();
    const enabled = chromeStub.debugger.sendCommand.mock.calls.map(
      (c) => (c as unknown as [unknown, string])[1]
    );
    expect(enabled).toEqual(
      expect.arrayContaining(["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"])
    );
  });
});

describe("evaluateWithCdp", () => {
  it("explains how to enable CDP without requesting permission when it is off", async () => {
    const { chromeStub } = fakeChrome({ enabled: false });

    await expect(evaluateWithCdp(1, "return 2", {})).rejects.toMatchObject({
      code: "cdp_disabled"
    });
    await expect(evaluateWithCdp(1, "return 2", {})).rejects.toThrow(
      /Coordinator.*CDP.*inspectElement/i
    );
    expect(chromeStub.debugger.attach).not.toHaveBeenCalled();
    expect(chromeStub.permissions).not.toHaveProperty("request");
  });

  it("lazily attaches and evaluates the async function body by value", async () => {
    const { sendCommand, chromeStub } = fakeChrome();
    sendCommand.mockImplementation(async (_target, method) => {
      if (method === "Runtime.evaluate") return { result: { type: "number", value: 2 } };
      return {};
    });

    await expect(evaluateWithCdp(1, "return ctx.left + 1", { left: 1 })).resolves.toBe(2);
    await expect(evaluateWithCdp(1, "return ctx.left + 1", { left: 1 })).resolves.toBe(2);

    expect(chromeStub.debugger.attach).toHaveBeenCalledWith({ tabId: 1 }, "1.3");
    expect(chromeStub.debugger.attach).toHaveBeenCalledOnce();
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      "Runtime.evaluate",
      expect.objectContaining({
        expression: expect.stringContaining("return ctx.left + 1"),
        awaitPromise: true,
        returnByValue: true
      })
    );
    const evaluateCall = sendCommand.mock.calls.find((call) => call[1] === "Runtime.evaluate");
    expect(evaluateCall?.[2]).toMatchObject({ expression: expect.stringContaining('{"left":1}') });
  });

  it("surfaces page exceptions returned by Runtime.evaluate", async () => {
    const { sendCommand } = fakeChrome();
    sendCommand.mockImplementation(async (_target, method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: { type: "object", subtype: "error", description: "Error: boom\n    at test.js:1:1" },
          exceptionDetails: {
            text: "Uncaught (in promise) Error: boom",
            exception: { description: "Error: boom\n    at test.js:1:1" }
          }
        };
      }
      return {};
    });

    await expect(evaluateWithCdp(1, "throw new Error('boom')", {})).rejects.toMatchObject({
      code: "cdp_evaluation_failed",
      message: expect.stringContaining("Error: boom")
    });
  });

  it("maps undefined to null", async () => {
    const { sendCommand } = fakeChrome();
    sendCommand.mockImplementation(async (_target, method) =>
      method === "Runtime.evaluate" ? { result: { type: "undefined" } } : {}
    );

    await expect(evaluateWithCdp(1, "return undefined", {})).resolves.toBeNull();
  });

  it("rejects results that CDP cannot return by value", async () => {
    const { sendCommand } = fakeChrome();
    sendCommand.mockImplementation(async (_target, method) =>
      method === "Runtime.evaluate"
        ? { result: { type: "object", objectId: "remote-object-1" } }
        : {}
    );

    await expect(evaluateWithCdp(1, "return window", {})).rejects.toMatchObject({
      code: "cdp_evaluation_failed",
      message: expect.stringMatching(/JSON-compatible/i)
    });
  });

  it("preserves the Chrome attach failure reason", async () => {
    fakeChrome({ attachFails: "Another debugger is already attached to the tab with id: 1" });

    await expect(evaluateWithCdp(1, "return 2", {})).rejects.toMatchObject({
      code: "cdp_attach_failed",
      message: expect.stringMatching(/Another debugger.*DevTools/i)
    });
  });

  it("classifies Runtime.evaluate transport failures", async () => {
    const { sendCommand } = fakeChrome();
    sendCommand.mockImplementation(async (_target, method) => {
      if (method === "Runtime.evaluate") throw new Error("Cannot access a chrome:// URL");
      return {};
    });

    await expect(evaluateWithCdp(1, "return 2", {})).rejects.toMatchObject({
      code: "cdp_evaluation_failed",
      message: expect.stringContaining("Cannot access a chrome:// URL")
    });
  });
});

describe("CDP screenshots", () => {
  it("captures the CSS visual viewport with format and scale", async () => {
    const { sendCommand } = fakeChrome();
    sendCommand.mockImplementation(async (_target, method) => {
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: { pageX: 12, pageY: 34, clientWidth: 1000, clientHeight: 700 }
        };
      }
      if (method === "Page.captureScreenshot") return { data: "QUJD" };
      return {};
    });

    const out = await new CdpRecorder(1).captureScreenshot({ format: "jpeg", scale: 0.5 });

    expect(out).toMatchObject({ data: "QUJD", mediaType: "image/jpeg", width: 1000, height: 700 });
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      "Page.captureScreenshot",
      {
        format: "jpeg",
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { x: 12, y: 34, width: 1000, height: 700, scale: 0.5 }
      }
    );
  });

  it("captures the full CSS content without scrolling", async () => {
    const { sendCommand } = fakeChrome();
    sendCommand.mockImplementation(async (_target, method) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssContentSize: { x: 0, y: 0, width: 1440, height: 9000 } };
      }
      if (method === "Page.captureScreenshot") return { data: "QUJD" };
      return {};
    });

    const out = await new CdpRecorder(1).captureScreenshot({ fullPage: true, format: "png", scale: 1 });

    expect(out).toMatchObject({ fullPage: true, width: 1440, height: 9000 });
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      "Page.captureScreenshot",
      expect.objectContaining({
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 1440, height: 9000, scale: 1 }
      })
    );
    expect(sendCommand.mock.calls.map((call) => call[1])).not.toContain("Runtime.callFunctionOn");
  });

  it("clips a selector by page coordinates without scrolling or highlighting", async () => {
    const { sendCommand } = fakeChrome();
    sendCommand.mockImplementation(async (_target, method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            type: "object",
            value: {
              ok: true,
              rect: { x: 210, y: 430, width: 320, height: 180 },
              viewport: { width: 1280, height: 720 },
              visible: false
            }
          }
        };
      }
      if (method === "Page.captureScreenshot") return { data: "QUJD" };
      return {};
    });

    const out = await new CdpRecorder(1).captureScreenshot({ selector: ".chart" });

    expect(out.target).toEqual({
      selector: ".chart",
      rect: { x: 210, y: 430, width: 320, height: 180 },
      viewport: { width: 1280, height: 720 },
      visible: false
    });
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      "Page.captureScreenshot",
      expect.objectContaining({
        captureBeyondViewport: true,
        clip: { x: 210, y: 430, width: 320, height: 180, scale: 1 }
      })
    );
    const evaluateParams = sendCommand.mock.calls.find(
      (call) => call[1] === "Runtime.evaluate"
    )?.[2] as { expression?: string } | undefined;
    const expression = String(evaluateParams?.expression);
    expect(expression).toContain("getBoundingClientRect");
    expect(expression).not.toContain("scrollIntoView");
    expect(expression).not.toContain("outline");
  });

  it("does not request debugger permission when CDP is disabled", async () => {
    const { chromeStub } = fakeChrome({ enabled: false });
    await expect(captureScreenshotWithCdp(1, {})).resolves.toBeNull();
    expect(chromeStub.debugger.attach).not.toHaveBeenCalled();
    expect(chromeStub.permissions).not.toHaveProperty("request");
  });
});

describe("event ingestion", () => {
  it("routes console API calls into the ring with a cdp backend tag", async () => {
    fakeChrome();
    const rec = new CdpRecorder(1);
    rec.handleEvent("Runtime.consoleAPICalled", {
      type: "warning",
      args: [{ value: "careful" }, { description: "Object" }]
    });
    const out = await rec.readConsole({});
    expect(out.backend).toBe("cdp");
    expect(out.messages[0].level).toBe("warn");
    expect(out.messages[0].text).toBe("careful Object");
  });

  it("captures browser-level log entries the MAIN world cannot see", async () => {
    fakeChrome();
    const rec = new CdpRecorder(1);
    rec.handleEvent("Log.entryAdded", {
      entry: { level: "error", text: "CORS blocked", url: "https://a.test", lineNumber: 3 }
    });
    const out = await rec.readConsole({ level: "error" });
    expect(out.messages[0].text).toBe("CORS blocked");
    expect(out.messages[0].line).toBe(3);
  });

  it("correlates a request with its response", async () => {
    fakeChrome();
    const rec = new CdpRecorder(1);
    rec.handleEvent("Network.requestWillBeSent", {
      requestId: "r1",
      request: { method: "post", url: "https://a.test/api", headers: { a: "b" } },
      type: "XHR"
    });
    rec.handleEvent("Network.responseReceived", {
      requestId: "r1",
      response: { status: 500, statusText: "Server Error", headers: { "content-type": "text/plain" } }
    });
    const out = await rec.readNetwork({});
    expect(out.requests).toHaveLength(1);
    expect(out.requests[0].method).toBe("POST");
    expect(out.requests[0].status).toBe(500);
  });

  it("records a loading failure against the right entry", async () => {
    fakeChrome();
    const rec = new CdpRecorder(1);
    rec.handleEvent("Network.requestWillBeSent", {
      requestId: "r1",
      request: { method: "GET", url: "https://a.test/x" }
    });
    rec.handleEvent("Network.loadingFailed", { requestId: "r1", errorText: "net::ERR_FAILED" });
    const out = await rec.readNetwork({});
    expect(out.requests[0].error).toBe("net::ERR_FAILED");
  });

  it("fetches a response body lazily", async () => {
    const { sendCommand } = fakeChrome();
    sendCommand.mockResolvedValue({ body: "hello", base64Encoded: false } as never);
    const rec = new CdpRecorder(1);
    rec.handleEvent("Network.requestWillBeSent", {
      requestId: "r1",
      request: { method: "GET", url: "https://a.test/x" }
    });
    const d = await rec.readNetworkDetail({ id: 1 });
    expect(d.detail?.responseBody).toBe("hello");
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      "Network.getResponseBody",
      { requestId: "r1" }
    );
  });
});

describe("dialogs under CDP", () => {
  it("answers a pending dialog as soon as a policy arrives", async () => {
    const { sendCommand } = fakeChrome();
    const rec = new CdpRecorder(1);
    rec.handleEvent("Page.javascriptDialogOpening", { message: "sure?", type: "confirm" });
    // Nothing answered yet — the page is suspended.
    expect(sendCommand).not.toHaveBeenCalledWith(
      { tabId: 1 },
      "Page.handleJavaScriptDialog",
      expect.anything()
    );

    const out = await rec.setDialogPolicy({ accept: true, scope: "next" });
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      "Page.handleJavaScriptDialog",
      expect.objectContaining({ accept: true })
    );
    expect(out.dialogs.at(-1)!.handled).toBe("accepted");
  });

  it("applies a standing policy to a dialog that opens later", async () => {
    const { sendCommand } = fakeChrome();
    const rec = new CdpRecorder(1);
    await rec.setDialogPolicy({ accept: false, scope: "all" });
    rec.handleEvent("Page.javascriptDialogOpening", { message: "leave?", type: "confirm" });
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      "Page.handleJavaScriptDialog",
      expect.objectContaining({ accept: false })
    );
  });

  it("passes promptText through for a prompt", async () => {
    const { sendCommand } = fakeChrome();
    const rec = new CdpRecorder(1);
    await rec.setDialogPolicy({ accept: true, promptText: "typed", scope: "all" });
    rec.handleEvent("Page.javascriptDialogOpening", { message: "name?", type: "prompt" });
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      "Page.handleJavaScriptDialog",
      expect.objectContaining({ accept: true, promptText: "typed" })
    );
  });
});

describe("degradation", () => {
  it("falls back to main-world with a reason when the debugger detaches", async () => {
    const { listeners } = fakeChrome();
    installCdpListeners();
    await attachCdp(1);
    expect(getAttachedCdpRecorder(1)).not.toBeNull();

    for (const f of listeners.onDetach) f({ tabId: 1 }, "canceled_by_user");

    expect(getAttachedCdpRecorder(1)).toBeNull();
    const rec = getRecorder(1);
    expect(rec.backend).toBe("main-world");
    const out = await rec.readConsole({});
    expect(out.degradedReason).toContain("canceled_by_user");
  });

  it("drops recorder state when the tab closes", async () => {
    const { listeners } = fakeChrome();
    installCdpListeners();
    await attachCdp(1);
    for (const f of listeners.onRemoved) f(1);
    expect(getAttachedCdpRecorder(1)).toBeNull();
  });

  it("routes resize through Emulation while attached", async () => {
    const { sendCommand } = fakeChrome();
    installCdpListeners();
    const rec = await attachCdp(1);
    await rec!.setViewport(1280, 800);
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      "Emulation.setDeviceMetricsOverride",
      expect.objectContaining({ width: 1280, height: 800 })
    );
  });
});
