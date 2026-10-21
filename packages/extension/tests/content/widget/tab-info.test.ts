import { describe, expect, it, vi, beforeEach } from "vitest";

(globalThis as any).chrome = {
  runtime: {
    sendMessage: vi.fn(),
    lastError: undefined as { message: string } | undefined,
  },
};

// Ensure location has a stable href for the test
Object.defineProperty(window, "location", {
  writable: true,
  value: { href: "https://example.com/page?x=1", host: "example.com" },
});

describe("getWidgetTabInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (chrome.runtime as any).lastError = undefined;
  });

  it("returns tabId from aipagego.getTabId side-channel + url from location", async () => {
    (chrome.runtime.sendMessage as any).mockImplementation((msg: any, cb: any) => {
      expect(msg).toEqual({ type: "aipagego.getTabId" });
      cb({ tabId: 42 });
    });
    const { getWidgetTabInfo } = await import("@/content/widget/tab-info");
    const info = await getWidgetTabInfo();
    expect(info).toEqual({ tabId: 42, url: "https://example.com/page?x=1" });
  });

  it("rejects when BG returns no tabId", async () => {
    (chrome.runtime.sendMessage as any).mockImplementation((_msg: any, cb: any) => {
      cb({ tabId: null });
    });
    const { getWidgetTabInfo } = await import("@/content/widget/tab-info");
    await expect(getWidgetTabInfo()).rejects.toThrow(/no tab id/);
  });

  it("rejects on chrome.runtime.lastError", async () => {
    (chrome.runtime as any).lastError = { message: "extension context invalidated" };
    (chrome.runtime.sendMessage as any).mockImplementation((_msg: any, cb: any) => {
      cb({ tabId: 42 });
    });
    const { getWidgetTabInfo } = await import("@/content/widget/tab-info");
    await expect(getWidgetTabInfo()).rejects.toThrow(/extension context invalidated/);
  });
});
