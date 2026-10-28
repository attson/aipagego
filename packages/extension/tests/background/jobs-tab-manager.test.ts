import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireJobTab,
  registerJobTabBusyCheck,
  releaseJobTab,
} from "@/background/jobs/tab-manager";

afterEach(() => {
  vi.unstubAllGlobals();
  registerJobTabBusyCheck(() => false);
});

describe("Job tab manager", () => {
  it("reuses an exact existing URL ignoring fragment and never closes it", async () => {
    const remove = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn(async () => [
          { id: 7, url: "https://example.com/products#details", status: "complete" },
        ]),
        create: vi.fn(),
        remove,
      },
    });
    const tab = await acquireJobTab("https://example.com/products");
    expect(tab).toEqual({ tabId: 7, ownership: "existing" });
    await releaseJobTab(tab);
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not reuse a busy tab and closes only the inactive tab it creates", async () => {
    const create = vi.fn(async () => ({
      id: 9,
      url: "https://example.com/products",
      status: "complete",
    }));
    const remove = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn(async () => [
          { id: 7, url: "https://example.com/products", status: "complete" },
        ]),
        create,
        remove,
      },
    });
    registerJobTabBusyCheck((tabId) => tabId === 7);
    const tab = await acquireJobTab("https://example.com/products");
    expect(create).toHaveBeenCalledWith({
      url: "https://example.com/products",
      active: false,
    });
    expect(tab).toEqual({ tabId: 9, ownership: "created" });
    await releaseJobTab(tab);
    expect(remove).toHaveBeenCalledWith(9);
  });

  it("rechecks readiness after subscribing so a fast load event cannot be missed", async () => {
    let listener: ((tabId: number, change: chrome.tabs.TabChangeInfo) => void) | undefined;
    const removeListener = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: 12, status: "loading" })),
        get: vi.fn(async () => ({ id: 12, status: "complete" })),
        remove: vi.fn(async () => undefined),
        onUpdated: {
          addListener: vi.fn((next) => { listener = next; }),
          removeListener,
        },
      },
    });
    await expect(acquireJobTab("https://example.com/fast")).resolves.toEqual({
      tabId: 12,
      ownership: "created",
    });
    expect(listener).toBeDefined();
    expect(removeListener).toHaveBeenCalledWith(listener);
  });
});
