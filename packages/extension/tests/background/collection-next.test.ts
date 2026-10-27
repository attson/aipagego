import { describe, expect, it, vi } from "vitest";
import { advanceCollectionNextPage } from "@/background/collection-next";

const recipe = {
  version: 1 as const,
  mode: "single" as const,
  fields: [{ id: "title", name: "标题", selector: "h1", valueMode: "text" as const, required: true }],
  pagination: { kind: "next" as const, selector: ".next", maxPages: 3 },
  dedupeBy: [],
  maxRows: 2_000,
  maxBytes: 5 * 1024 * 1024,
};

function page(fingerprint: string) {
  return {
    rows: [{ values: { title: fingerprint }, missingRequired: [] }],
    pageUrl: "https://example.com/2",
    fingerprint,
    matchedCount: 1,
    duplicateCount: 0,
    truncatedBy: null,
  };
}

describe("advanceCollectionNextPage", () => {
  it("returns missing and disabled without polling", async () => {
    for (const status of ["missing", "disabled"] as const) {
      const extractPage = vi.fn();
      expect(await advanceCollectionNextPage({
        tabId: 7,
        selector: ".next",
        recipe,
        previousUrl: "https://example.com/1",
        previousFingerprint: "p1",
        signal: new AbortController().signal,
      }, {
        clickNext: async () => status,
        readTab: vi.fn(),
        extractPage,
        sleep: vi.fn(),
        now: () => 0,
      })).toEqual({ status });
      expect(extractPage).not.toHaveBeenCalled();
    }
  });

  it("returns the changed page after navigation completes", async () => {
    expect(await advanceCollectionNextPage({
      tabId: 7,
      selector: ".next",
      recipe,
      previousUrl: "https://example.com/1",
      previousFingerprint: "p1",
      signal: new AbortController().signal,
    }, {
      clickNext: async () => "clicked",
      readTab: async () => ({ url: "https://example.com/2", status: "complete" }),
      extractPage: async () => page("p2"),
      sleep: vi.fn(),
      now: () => 0,
    })).toMatchObject({ status: "changed", page: { fingerprint: "p2" } });
  });

  it("does not commit a transient fingerprint while a changed URL is still loading", async () => {
    let now = 0;
    let attempt = 0;
    const result = await advanceCollectionNextPage({
      tabId: 7,
      selector: ".next",
      recipe,
      previousUrl: "https://example.com/1",
      previousFingerprint: "p1",
      signal: new AbortController().signal,
    }, {
      clickNext: async () => "clicked",
      readTab: async () => ({
        url: "https://example.com/2",
        status: attempt++ === 0 ? "loading" : "complete",
      }),
      extractPage: async () => attempt === 1 ? page("transient") : page("p2"),
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });

    expect(result).toMatchObject({ status: "changed", page: { fingerprint: "p2" } });
    expect(attempt).toBe(2);
  });

  it("returns navigation_timeout after 15 seconds without URL or fingerprint change", async () => {
    let now = 0;
    const result = await advanceCollectionNextPage({
      tabId: 7,
      selector: ".next",
      recipe,
      previousUrl: "https://example.com/1",
      previousFingerprint: "p1",
      signal: new AbortController().signal,
    }, {
      clickNext: async () => "clicked",
      readTab: async () => ({ url: "https://example.com/1", status: "complete" }),
      extractPage: async () => ({ ...page("p1"), pageUrl: "https://example.com/1" }),
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });
    expect(result).toEqual({ status: "timeout" });
    expect(now).toBe(15_000);
  });

  it("stops an in-flight wait when cancelled", async () => {
    let now = 0;
    const controller = new AbortController();
    const result = await advanceCollectionNextPage({
      tabId: 7,
      selector: ".next",
      recipe,
      previousUrl: "https://example.com/1",
      previousFingerprint: "p1",
      signal: controller.signal,
    }, {
      clickNext: async () => "clicked",
      readTab: async () => ({ url: "https://example.com/1", status: "complete" }),
      extractPage: async () => page("p1"),
      sleep: async (ms) => { now += ms; controller.abort(); },
      now: () => now,
    });
    expect(result).toEqual({ status: "aborted" });
  });
});
