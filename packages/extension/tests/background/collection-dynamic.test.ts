import { describe, expect, it, vi } from "vitest";
import { advanceCollectionDynamicPage } from "@/background/collection-dynamic";

const recipe = {
  version: 1 as const,
  mode: "list" as const,
  itemSelector: ".item",
  fields: [{ id: "title", name: "标题", selector: ".title", valueMode: "text" as const, required: true }],
  pagination: { kind: "loadMore" as const, selector: ".more", maxPages: 5 },
  dedupeBy: ["title"],
  maxRows: 2_000,
  maxBytes: 5 * 1024 * 1024,
};

function page(fingerprint: string, matchedCount: number) {
  return {
    rows: [],
    pageUrl: "https://example.com/list",
    fingerprint,
    matchedCount,
    duplicateCount: 0,
    truncatedBy: null,
  };
}

describe("advanceCollectionDynamicPage", () => {
  it.each([
    [page("same", 2), "item count"],
    [page("changed", 1), "fingerprint"],
  ] as const)("returns the changed extraction when %s changes", async (nextPage, _reason) => {
    const advance = vi.fn(async () => "clicked" as const);

    await expect(advanceCollectionDynamicPage({
      tabId: 7,
      recipe,
      previousFingerprint: "same",
      previousMatchedCount: 1,
      action: { kind: "loadMore", selector: ".more" },
      signal: new AbortController().signal,
    }, {
      advance,
      extractPage: async () => nextPage,
      sleep: async () => undefined,
      now: () => 0,
    })).resolves.toEqual({ status: "changed", page: nextPage });
    expect(advance).toHaveBeenCalledWith(7, { kind: "loadMore", selector: ".more" });
  });

  it.each(["missing", "disabled"] as const)("returns %s from the configured control", async (status) => {
    await expect(advanceCollectionDynamicPage({
      tabId: 7,
      recipe,
      previousFingerprint: "same",
      previousMatchedCount: 1,
      action: { kind: "loadMore", selector: ".more" },
      signal: new AbortController().signal,
    }, {
      advance: async () => status,
      extractPage: vi.fn(),
      sleep: vi.fn(),
      now: () => 0,
    })).resolves.toEqual({ status });
  });

  it("scrolls and returns no_change when the page stays unchanged for the wait window", async () => {
    let now = 0;
    const advance = vi.fn(async () => "scrolled" as const);

    await expect(advanceCollectionDynamicPage({
      tabId: 7,
      recipe: { ...recipe, pagination: { kind: "infiniteScroll", maxPages: 5 } },
      previousFingerprint: "same",
      previousMatchedCount: 1,
      action: { kind: "infiniteScroll" },
      signal: new AbortController().signal,
    }, {
      advance,
      extractPage: async () => page("same", 1),
      sleep: async (ms) => { now += ms; },
      now: () => now,
    }, 500)).resolves.toEqual({ status: "no_change" });
    expect(advance).toHaveBeenCalledWith(7, { kind: "infiniteScroll" });
  });

  it("returns aborted while waiting", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(advanceCollectionDynamicPage({
      tabId: 7,
      recipe,
      previousFingerprint: "same",
      previousMatchedCount: 1,
      action: { kind: "loadMore", selector: ".more" },
      signal: controller.signal,
    }, {
      advance: async () => "clicked",
      extractPage: vi.fn(),
      sleep: vi.fn(),
      now: () => 0,
    })).resolves.toEqual({ status: "aborted" });
  });

  it("surfaces a persistent extraction failure instead of reporting no new rows", async () => {
    let now = 0;
    await expect(advanceCollectionDynamicPage({
      tabId: 7,
      recipe,
      previousFingerprint: "same",
      previousMatchedCount: 1,
      action: { kind: "loadMore", selector: ".more" },
      signal: new AbortController().signal,
    }, {
      advance: async () => "clicked",
      extractPage: async () => { throw new Error("content receiver unavailable"); },
      sleep: async (ms) => { now += ms; },
      now: () => now,
    }, 500)).rejects.toThrow("content receiver unavailable");
  });
});
