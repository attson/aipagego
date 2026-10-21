import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCaptureDeps, screenshot } from "@/background/bg-tools/capture";
import { detachCdp } from "@/background/recorder/cdp";
import { PAGE_METRICS_SOURCE, SCROLL_TO_SOURCE, STITCH_SOURCE } from "@/content/tools/page-metrics";

const realChrome = globalThis.chrome;

type Metrics = { scrollHeight: number; clientHeight: number; clientWidth: number; scrollY: number };

/** Simulates the page side of the band loop. */
function harness(metrics: Metrics) {
  const scrolls: number[] = [];
  let stitchBands: Array<{ y: number }> = [];
  const runStep = vi.fn(async ({ step, bindings }: { step: { source?: string }; bindings?: Record<string, unknown> }) => {
    const src = step.source ?? "";
    if (src === PAGE_METRICS_SOURCE) return metrics as never;
    if (src === SCROLL_TO_SOURCE) {
      const y = bindings?.y as number;
      scrolls.push(y);
      return { scrollY: y } as never;
    }
    if (src === STITCH_SOURCE) {
      stitchBands = bindings?.bands as Array<{ y: number }>;
      return { ok: true, dataUrl: "data:image/png;base64,QUJD" } as never;
    }
    throw new Error(`unexpected step source`);
  });
  registerCaptureDeps({ runStep: runStep as never });
  return { runStep, scrolls, bands: () => stitchBands };
}

let captureVisibleTab: ReturnType<typeof vi.fn>;
let updateTab: ReturnType<typeof vi.fn>;

beforeEach(() => {
  let activeTabId = 2;
  captureVisibleTab = vi.fn(async () => "data:image/png;base64,QUJD");
  updateTab = vi.fn(async (tabId: number) => {
    activeTabId = tabId;
    return { id: tabId, windowId: 9 };
  });
  globalThis.chrome = {
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 9, active: tabId === activeTabId })),
      query: vi.fn(async () => [{ id: activeTabId, windowId: 9, active: true }]),
      update: updateTab,
      captureVisibleTab
    }
  } as unknown as typeof chrome;
});

afterEach(async () => {
  await detachCdp(1).catch(() => undefined);
  globalThis.chrome = realChrome;
  vi.restoreAllMocks();
});

describe("screenshot backend selection", () => {
  it("uses CDP without activating the target tab when the opt-in setting is enabled", async () => {
    const h = harness({ scrollHeight: 2400, clientHeight: 800, clientWidth: 1000, scrollY: 0 });
    const sendCommand = vi.fn(async (_target: chrome.debugger.Debuggee, method: string) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssContentSize: { x: 0, y: 0, width: 1000, height: 2400 } };
      }
      if (method === "Page.captureScreenshot") return { data: "QUJD" };
      return {};
    });
    Object.assign(globalThis.chrome, {
      debugger: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand
      },
      permissions: { contains: vi.fn(async () => true) },
      storage: {
        local: { get: vi.fn(async () => ({ "aipagego.recorder.cdpEnabled": true })) }
      }
    });

    const out = (await screenshot({ fullPage: true, scale: 0.5 } as never, 1)) as unknown as {
      backend: string;
      fullPage: boolean;
      data: string;
    };

    expect(out).toMatchObject({ backend: "cdp", fullPage: true, data: "QUJD" });
    expect(updateTab).not.toHaveBeenCalled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(h.runStep).not.toHaveBeenCalled();
  });

  it("resolves a page-index target and clips it through CDP without activating the tab", async () => {
    const runStep = vi.fn(async ({ step }: { step: { kind: string; tool?: string } }) => {
      if (step.kind === "tool" && step.tool === "readPageBlock") {
        return {
          indexId: "pi_1",
          blockId: "b2",
          label: "Revenue chart",
          selectorHint: ".chart"
        } as never;
      }
      throw new Error("unexpected visible-tab step");
    });
    registerCaptureDeps({ runStep: runStep as never });
    const sendCommand = vi.fn(async (_target: chrome.debugger.Debuggee, method: string) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            type: "object",
            value: {
              ok: true,
              rect: { x: 40, y: 1200, width: 800, height: 450 },
              viewport: { width: 1280, height: 720 },
              visible: false
            }
          }
        };
      }
      if (method === "Page.captureScreenshot") return { data: "QUJD" };
      return {};
    });
    Object.assign(globalThis.chrome, {
      debugger: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand
      },
      permissions: { contains: vi.fn(async () => true) },
      storage: {
        local: { get: vi.fn(async () => ({ "aipagego.recorder.cdpEnabled": true })) }
      }
    });

    const out = (await screenshot({ blockId: "b2", indexId: "pi_1" } as never, 1)) as unknown as {
      backend: string;
      target: Record<string, unknown>;
    };

    expect(out.backend).toBe("cdp");
    expect(out.target).toMatchObject({
      kind: "pageBlock",
      indexId: "pi_1",
      blockId: "b2",
      selector: ".chart",
      label: "Revenue chart",
      rect: { x: 40, y: 1200, width: 800, height: 450 }
    });
    expect(updateTab).not.toHaveBeenCalled();
    expect(runStep).toHaveBeenCalledTimes(1);
  });

  it("marks the compatibility backend when CDP is disabled", async () => {
    harness({ scrollHeight: 800, clientHeight: 800, clientWidth: 1000, scrollY: 0 });
    const out = (await screenshot({} as never, 1)) as unknown as { backend: string };
    expect(out.backend).toBe("visible-tab");
  });

  it("does not restore the old tab over a tab the user selected during capture", async () => {
    harness({ scrollHeight: 800, clientHeight: 800, clientWidth: 1000, scrollY: 0 });
    const query = vi.mocked(chrome.tabs.query);
    query
      .mockResolvedValueOnce([{ id: 2, windowId: 9, active: true }] as chrome.tabs.Tab[])
      .mockResolvedValueOnce([{ id: 3, windowId: 9, active: true }] as chrome.tabs.Tab[]);

    await screenshot({} as never, 1);

    expect(updateTab.mock.calls).toEqual([[1, { active: true }]]);
  });
});

describe("screenshot — fullPage", () => {
  it("activates the session tab for capture and restores the previous tab", async () => {
    harness({ scrollHeight: 800, clientHeight: 800, clientWidth: 1000, scrollY: 0 });
    await screenshot({ fullPage: true } as never, 1);
    expect(updateTab.mock.calls).toEqual([
      [1, { active: true }],
      [2, { active: true }]
    ]);
  });

  it("captures one band per viewport height", async () => {
    const h = harness({ scrollHeight: 2400, clientHeight: 800, clientWidth: 1000, scrollY: 0 });
    const out = (await screenshot({ fullPage: true } as never, 1)) as unknown as {
      fullPage: boolean;
      bands: number;
      media_type: string;
    };
    expect(out.fullPage).toBe(true);
    expect(out.bands).toBe(3);
    expect(captureVisibleTab).toHaveBeenCalledTimes(3);
    expect(h.scrolls.slice(0, 3)).toEqual([0, 800, 1600]);
  });

  it("restores the original scroll position afterwards", async () => {
    const h = harness({ scrollHeight: 1600, clientHeight: 800, clientWidth: 1000, scrollY: 450 });
    await screenshot({ fullPage: true } as never, 1);
    expect(h.scrolls.at(-1)).toBe(450);
  });

  it("restores the scroll position even when a capture fails", async () => {
    const h = harness({ scrollHeight: 1600, clientHeight: 800, clientWidth: 1000, scrollY: 120 });
    captureVisibleTab.mockRejectedValueOnce(new Error("quota exceeded"));
    await expect(screenshot({ fullPage: true } as never, 1)).rejects.toThrow("quota");
    expect(h.scrolls.at(-1)).toBe(120);
    expect(updateTab).toHaveBeenLastCalledWith(2, { active: true });
  });

  it("caps the band count and flags truncation", async () => {
    harness({ scrollHeight: 800 * 50, clientHeight: 800, clientWidth: 1000, scrollY: 0 });
    const out = (await screenshot({ fullPage: true } as never, 1)) as unknown as {
      bands: number;
      truncated: boolean;
      wantedBands: number;
    };
    expect(out.bands).toBe(20);
    expect(out.truncated).toBe(true);
    expect(out.wantedBands).toBe(50);
  });

  it("does not flag truncation for a short page", async () => {
    harness({ scrollHeight: 800, clientHeight: 800, clientWidth: 1000, scrollY: 0 });
    const out = (await screenshot({ fullPage: true } as never, 1)) as unknown as {
      truncated?: boolean;
    };
    expect(out.truncated).toBeUndefined();
  });

  it("passes format and scale through to stitching", async () => {
    const h = harness({ scrollHeight: 800, clientHeight: 800, clientWidth: 1000, scrollY: 0 });
    const out = (await screenshot({ fullPage: true, format: "jpeg", scale: 0.5 } as never, 1)) as unknown as {
      media_type: string;
    };
    const stitchCall = h.runStep.mock.calls.find(
      (c) => (c[0] as { step: { source?: string } }).step.source === STITCH_SOURCE
    )!;
    const bindings = (stitchCall[0] as { bindings: Record<string, unknown> }).bindings;
    expect(bindings.format).toBe("jpeg");
    expect(bindings.scale).toBe(0.5);
    expect(out.media_type).toBe("image/jpeg");
  });

  it("surfaces a stitching failure", async () => {
    registerCaptureDeps({
      runStep: (async ({ step }: { step: { source?: string } }) => {
        if (step.source === PAGE_METRICS_SOURCE) {
          return { scrollHeight: 800, clientHeight: 800, clientWidth: 1000, scrollY: 0 };
        }
        if (step.source === SCROLL_TO_SOURCE) return { scrollY: 0 };
        return { ok: false, error: "canvas 2d context unavailable" };
      }) as never
    });
    await expect(screenshot({ fullPage: true } as never, 1)).rejects.toThrow(
      "canvas 2d context unavailable"
    );
  });
});
