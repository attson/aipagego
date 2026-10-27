import { afterEach, describe, expect, it, vi } from "vitest";
import { META_TOOLS, META_TOOL_NAMES, isMetaTool } from "@/background/meta-tool-router";

const realChrome = globalThis.chrome;

function fakeChrome(patch: Record<string, unknown>): void {
  globalThis.chrome = patch as unknown as typeof chrome;
}

afterEach(() => {
  globalThis.chrome = realChrome;
  vi.restoreAllMocks();
});

describe("meta tool router", () => {
  it("claims the tools the side panel used to own", () => {
    for (const n of [
      "screenshot", "listTabs", "openTab", "closeTab", "switchToTab",
      "searchBookmarks", "searchHistory", "downloadImage", "downloadSpreadsheet"
    ]) {
      expect(isMetaTool(n), n).toBe(true);
    }
  });

  it("claims the Plan 32 background tools", () => {
    for (const n of [
      "navigateBack", "navigateForward", "resize",
      "consoleMessages", "networkRequests", "networkRequestDetail",
      "handleDialog", "recorderConfig", "collectStructuredData"
    ]) {
      expect(isMetaTool(n), n).toBe(true);
    }
  });

  it("leaves content-script tools alone", () => {
    for (const n of ["click", "fillInput", "drag", "drop", "findElements", "snapshotDOM"]) {
      expect(isMetaTool(n), n).toBe(false);
    }
    expect(isMetaTool("attachTab")).toBe(false);
  });

  it("exports its names for HELLO negotiation", () => {
    expect(META_TOOL_NAMES).toContain("resize");
    expect(META_TOOL_NAMES.length).toBe(Object.keys(META_TOOLS).length);
  });
});

describe("tab plane", () => {
  it("lists open tabs", async () => {
    fakeChrome({
      tabs: {
        query: vi.fn(async () => [
          { id: 1, url: "https://a.test", title: "A", active: true, windowId: 9 },
          { id: undefined, url: "about:blank" }
        ])
      }
    });
    const out = (await META_TOOLS.listTabs({}, 1)) as unknown as Array<{ tabId: number }>;
    expect(out).toHaveLength(1);
    expect(out[0].tabId).toBe(1);
  });

  it("refuses to close a tab outside the allowed set", async () => {
    fakeChrome({ tabs: { remove: vi.fn() } });
    await expect(
      META_TOOLS.closeTab({ tabId: 77, allowedTabIds: [1] } as never, 1)
    ).rejects.toThrow("not in attachedTabs");
  });

  it("closes a tab inside the allowed set", async () => {
    const remove = vi.fn(async () => undefined);
    fakeChrome({ tabs: { remove } });
    await META_TOOLS.closeTab({ tabId: 1, allowedTabIds: [1] } as never, 1);
    expect(remove).toHaveBeenCalledWith(1);
  });

  it("refuses to switch to an unattached tab", async () => {
    fakeChrome({ tabs: { update: vi.fn() } });
    await expect(
      META_TOOLS.switchToTab({ tabId: 5, allowedTabIds: [1, 2] } as never, 1)
    ).rejects.toThrow("not attached");
  });
});

describe("downloads", () => {
  it("builds a data URL rather than a blob URL", async () => {
    const download = vi.fn(async () => 5);
    fakeChrome({
      downloads: { download },
      permissions: { contains: vi.fn(async () => true) },
    });
    const out = (await META_TOOLS.downloadSpreadsheet(
      { filename: "a", sheets: [{ name: "S", rows: [["x"]] }] } as never,
      1
    )) as unknown as { downloadId: number; filename: string; bytes: number };

    const url = (download.mock.calls[0] as unknown as [{ url: string }])[0].url;
    expect(url.startsWith("data:")).toBe(true);
    expect(url).toContain("spreadsheetml");
    expect(out.filename).toBe("a.xlsx");
    expect(out.bytes).toBeGreaterThan(0);
  });

  it("rejects an empty workbook", async () => {
    fakeChrome({ downloads: { download: vi.fn() } });
    await expect(META_TOOLS.downloadSpreadsheet({ sheets: [] } as never, 1)).rejects.toThrow(
      "sheets required"
    );
  });
});

describe("navigation", () => {
  it("reports the end of history without throwing", async () => {
    fakeChrome({
      tabs: {
        goBack: vi.fn(async () => {
          throw new Error("Cannot find a previous page in history.");
        })
      }
    });
    const out = (await META_TOOLS.navigateBack({}, 1)) as unknown as { ok: boolean };
    expect(out.ok).toBe(false);
  });

  it("surfaces a genuine navigation failure", async () => {
    fakeChrome({
      tabs: {
        goForward: vi.fn(async () => {
          throw new Error("No tab with id: 1");
        })
      }
    });
    await expect(META_TOOLS.navigateForward({}, 1)).rejects.toThrow("navigateForward");
  });

  it("compensates for browser chrome when resizing", async () => {
    const update = vi.fn(async () => undefined);
    const executeScript = vi.fn()
      .mockResolvedValueOnce([{ result: { iw: 1000, ih: 700, ow: 1016, oh: 790, dpr: 1 } }])
      .mockResolvedValue([{ result: { iw: 1280, ih: 800, ow: 1296, oh: 890, dpr: 2 } }]);
    fakeChrome({
      scripting: {
        executeScript
      },
      tabs: { get: vi.fn(async () => ({ windowId: 9 })) },
      windows: { update }
    });
    const out = (await META_TOOLS.resize({ width: 1280, height: 800 } as never, 1)) as unknown as {
      chromeInset: { w: number; h: number };
      actualViewport: { width: number; height: number };
      devicePixelRatio: number;
      verified: boolean;
    };
    expect(update).toHaveBeenCalledWith(9, { width: 1280 + 16, height: 800 + 90 });
    expect(out.chromeInset).toEqual({ w: 16, h: 90 });
    expect(out.actualViewport).toEqual({ width: 1280, height: 800 });
    expect(out.devicePixelRatio).toBe(2);
    expect(out.verified).toBe(true);
  });

  it("reports a viewport mismatch instead of pretending the requested size applied", async () => {
    vi.useFakeTimers();
    try {
      fakeChrome({
        scripting: {
          executeScript: vi.fn(async () => [{ result: { iw: 1920, ih: 887, ow: 1920, oh: 1008, dpr: 1 } }])
        },
        tabs: { get: vi.fn(async () => ({ windowId: 9 })) },
        windows: { update: vi.fn(async () => undefined) }
      });
      const pending = META_TOOLS.resize({ width: 390, height: 844 } as never, 1) as Promise<unknown>;
      await vi.runAllTimersAsync();
      const out = await pending as {
        actualViewport: { width: number; height: number };
        verified: boolean;
      };
      expect(out.actualViewport).toEqual({ width: 1920, height: 887 });
      expect(out.verified).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires both dimensions", async () => {
    fakeChrome({});
    await expect(META_TOOLS.resize({ width: 100 } as never, 1)).rejects.toThrow(
      "width and height required"
    );
  });
});
