import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CollectionOrchestrator,
  type CollectionAdvanceDynamicResult,
} from "@/background/collection-orchestrator";
import { _resetDBForTests } from "@/background/storage/db";
import { readCollectionResult } from "@/background/storage/collection-results";

const baseRecipe = {
  version: 1 as const,
  mode: "list" as const,
  itemSelector: ".item",
  fields: [{ id: "title", name: "标题", selector: ".title", valueMode: "text" as const, required: true }],
  pagination: { kind: "loadMore" as const, selector: ".more", maxPages: 5 },
  dedupeBy: ["title"],
  maxRows: 2_000,
  maxBytes: 5 * 1024 * 1024,
};

function page(index: number, titles: string[]) {
  return {
    rows: titles.map((title) => ({ values: { title }, missingRequired: [] })),
    pageUrl: "https://example.com/list",
    fingerprint: `page-${index}`,
    matchedCount: titles.length,
    duplicateCount: 0,
    truncatedBy: null,
  };
}

async function waitForDone(orchestrator: CollectionOrchestrator, runId: string) {
  let snapshot: Awaited<ReturnType<CollectionOrchestrator["get"]>> = null;
  await vi.waitFor(async () => {
    snapshot = await orchestrator.get(runId);
    expect(snapshot?.status).not.toBe("running");
  });
  return snapshot!;
}

describe("CollectionOrchestrator dynamic pagination", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
  });

  it("collects changed load-more pages and preserves rows when the control disappears", async () => {
    const advances: CollectionAdvanceDynamicResult[] = [
      { status: "changed", page: page(2, ["B"]) },
      { status: "missing" },
    ];
    const orchestrator = new CollectionOrchestrator({
      getTab: async () => ({ url: "https://example.com/list" }),
      extractPage: async () => page(1, ["A"]),
      advanceDynamic: async () => advances.shift()!,
      broadcast: vi.fn(),
    });

    const { runId } = await orchestrator.start({ tabId: 9, recipe: baseRecipe });
    const snapshot = await waitForDone(orchestrator, runId);

    expect(snapshot).toMatchObject({
      status: "partial",
      stopReason: "pagination_missing",
      pageCount: 2,
      rowCount: 2,
    });
    expect((await readCollectionResult(snapshot.resultId, 0, 10)).rows).toEqual([
      { title: "A" },
      { title: "B" },
    ]);
  });

  it("maps a disabled load-more control without losing the first checkpoint", async () => {
    const orchestrator = new CollectionOrchestrator({
      getTab: async () => ({ url: "https://example.com/list" }),
      extractPage: async () => page(1, ["A"]),
      advanceDynamic: async () => ({ status: "disabled" }),
      broadcast: vi.fn(),
    });
    const { runId } = await orchestrator.start({ tabId: 9, recipe: baseRecipe });

    expect(await waitForDone(orchestrator, runId)).toMatchObject({
      stopReason: "pagination_disabled",
      pageCount: 1,
      rowCount: 1,
    });
  });

  it("stops infinite scroll after two unchanged rounds and counts each round as a page", async () => {
    const advanceDynamic = vi.fn(async () => ({ status: "no_change" } as const));
    const orchestrator = new CollectionOrchestrator({
      getTab: async () => ({ url: "https://example.com/list" }),
      extractPage: async () => page(1, ["A"]),
      advanceDynamic,
      broadcast: vi.fn(),
    });
    const { runId } = await orchestrator.start({
      tabId: 9,
      recipe: { ...baseRecipe, pagination: { kind: "infiniteScroll", maxPages: 5 } },
    });

    expect(await waitForDone(orchestrator, runId)).toMatchObject({
      stopReason: "no_new_rows",
      pageCount: 3,
      rowCount: 1,
    });
    expect(advanceDynamic).toHaveBeenCalledTimes(2);
  });

  it("treats two changed pages containing only cross-page duplicates as no new rows", async () => {
    const advances: CollectionAdvanceDynamicResult[] = [
      { status: "changed", page: page(2, ["A"]) },
      { status: "changed", page: page(3, ["A"]) },
    ];
    const orchestrator = new CollectionOrchestrator({
      getTab: async () => ({ url: "https://example.com/list" }),
      extractPage: async () => page(1, ["A"]),
      advanceDynamic: async () => advances.shift()!,
      broadcast: vi.fn(),
    });
    const { runId } = await orchestrator.start({ tabId: 9, recipe: baseRecipe });

    expect(await waitForDone(orchestrator, runId)).toMatchObject({
      stopReason: "no_new_rows",
      pageCount: 3,
      rowCount: 1,
      duplicateCount: 2,
    });
  });

  it("enforces the 100-page hard limit even when called outside the RPC schema", async () => {
    const orchestrator = new CollectionOrchestrator({
      getTab: vi.fn(),
      extractPage: vi.fn(),
      broadcast: vi.fn(),
    });

    await expect(orchestrator.start({
      tabId: 9,
      recipe: {
        ...baseRecipe,
        pagination: { kind: "loadMore", selector: ".more", maxPages: 101 },
      },
    })).rejects.toThrow();
  });

  it("applies configured row and byte limits across dynamic pages", async () => {
    const advances: CollectionAdvanceDynamicResult[] = [
      { status: "changed", page: page(2, ["BB", "CCC"]) },
    ];
    const orchestrator = new CollectionOrchestrator({
      getTab: async () => ({ url: "https://example.com/list" }),
      extractPage: async () => page(1, ["A"]),
      advanceDynamic: async () => advances.shift()!,
      broadcast: vi.fn(),
    });
    const { runId } = await orchestrator.start({
      tabId: 9,
      recipe: { ...baseRecipe, maxRows: 2, maxBytes: 100 },
    });
    expect(await waitForDone(orchestrator, runId)).toMatchObject({
      stopReason: "max_rows",
      pageCount: 2,
      rowCount: 2,
    });

    const bytesForFirst = new TextEncoder().encode(JSON.stringify({ title: "A" })).byteLength;
    const bytesForSecond = new TextEncoder().encode(JSON.stringify({ title: "BB" })).byteLength;
    const byteLimited = new CollectionOrchestrator({
      getTab: async () => ({ url: "https://example.com/list" }),
      extractPage: async () => page(1, ["A"]),
      advanceDynamic: async () => ({ status: "changed", page: page(2, ["BB"]) }),
      broadcast: vi.fn(),
    });
    const second = await byteLimited.start({
      tabId: 10,
      recipe: { ...baseRecipe, maxBytes: bytesForFirst + bytesForSecond - 1 },
    });
    expect(await waitForDone(byteLimited, second.runId)).toMatchObject({
      stopReason: "max_bytes",
      pageCount: 2,
      rowCount: 1,
    });
  });
});
