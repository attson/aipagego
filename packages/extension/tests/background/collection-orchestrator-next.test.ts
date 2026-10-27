import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CollectionOrchestrator,
  type CollectionAdvanceNextResult,
} from "@/background/collection-orchestrator";
import { _resetDBForTests } from "@/background/storage/db";
import { readCollectionResult } from "@/background/storage/collection-results";
import { getRun } from "@/background/storage/runs";

const recipe = {
  version: 1 as const,
  mode: "list" as const,
  itemSelector: ".item",
  fields: [{ id: "title", name: "标题", selector: ".title", valueMode: "text" as const, required: true }],
  pagination: { kind: "next" as const, selector: ".next", maxPages: 5 },
  dedupeBy: ["title"],
  maxRows: 2_000,
  maxBytes: 5 * 1024 * 1024,
};

function page(index: number, titles: Array<string | null>) {
  return {
    rows: titles.map((title) => ({
      values: { title },
      missingRequired: title == null ? ["title"] : [],
    })),
    pageUrl: `https://example.com/${index}`,
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

describe("CollectionOrchestrator next pagination", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
  });

  it("checkpoints each changed page, deduplicates across pages, then stops when next is missing", async () => {
    const advances: CollectionAdvanceNextResult[] = [
      { status: "changed", page: page(2, ["B", "C", null]) },
      { status: "missing" },
    ];
    const progress: unknown[] = [];
    const orchestrator = new CollectionOrchestrator({
      getTab: async () => ({ url: "https://example.com/1" }),
      extractPage: async () => page(1, ["A", "B"]),
      advanceNext: async () => advances.shift()!,
      broadcast: (event) => progress.push(event),
    });

    const { runId } = await orchestrator.start({ tabId: 8, recipe });
    const snapshot = await waitForDone(orchestrator, runId);

    expect(snapshot).toMatchObject({
      status: "partial",
      stopReason: "pagination_missing",
      pageCount: 2,
      rowCount: 4,
      duplicateCount: 1,
      missingRequiredCount: 1,
    });
    expect((await readCollectionResult(snapshot.resultId, 0, 20)).rows).toEqual([
      { title: "A" },
      { title: "B" },
      { title: "C" },
      { title: null },
    ]);
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "persisting", pageCount: 1, rowCount: 2 }),
      expect.objectContaining({ phase: "persisting", pageCount: 2, rowCount: 4 }),
    ]));
  });

  it.each([
    ["disabled", "pagination_disabled"],
    ["timeout", "navigation_timeout"],
  ] as const)("maps %s to %s while preserving the committed first page", async (status, stopReason) => {
    const orchestrator = new CollectionOrchestrator({
      getTab: async () => ({ url: "https://example.com/1" }),
      extractPage: async () => page(1, ["A"]),
      advanceNext: async () => ({ status }),
      broadcast: vi.fn(),
    });
    const { runId } = await orchestrator.start({ tabId: 8, recipe });

    expect(await waitForDone(orchestrator, runId)).toMatchObject({
      status: "partial",
      stopReason,
      pageCount: 1,
      rowCount: 1,
    });
  });

  it("detects a repeated page before committing it twice", async () => {
    const orchestrator = new CollectionOrchestrator({
      getTab: async () => ({ url: "https://example.com/1" }),
      extractPage: async () => page(1, ["A"]),
      advanceNext: async () => ({ status: "changed", page: page(1, ["A"]) }),
      broadcast: vi.fn(),
    });
    const { runId } = await orchestrator.start({ tabId: 8, recipe });

    expect(await waitForDone(orchestrator, runId)).toMatchObject({
      status: "partial",
      stopReason: "repeated_page",
      pageCount: 1,
      rowCount: 1,
    });
  });

  it("cancels an in-flight next wait and preserves the committed page", async () => {
    let waiting = false;
    const orchestrator = new CollectionOrchestrator({
      getTab: async () => ({ url: "https://example.com/1" }),
      extractPage: async () => page(1, ["A"]),
      advanceNext: ({ signal }) => new Promise((resolve) => {
        waiting = true;
        signal.addEventListener("abort", () => resolve({ status: "aborted" }), { once: true });
      }),
      broadcast: vi.fn(),
    });
    const { runId } = await orchestrator.start({ tabId: 8, recipe });
    await vi.waitFor(() => expect(waiting).toBe(true));
    orchestrator.cancel(runId);

    expect(await waitForDone(orchestrator, runId)).toMatchObject({
      status: "partial",
      stopReason: "aborted",
      pageCount: 1,
      rowCount: 1,
    });
  });

  it("stops replay at its timeout and records coordinator provenance", async () => {
    const orchestrator = new CollectionOrchestrator({
      getTab: async () => ({ url: "https://example.com/1" }),
      extractPage: async () => page(1, ["A"]),
      advanceNext: ({ signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ status: "aborted" }), { once: true });
      }),
      broadcast: vi.fn(),
    });

    const summary = await orchestrator.runAndWait({
      tabId: 8,
      recipe,
      timeoutMs: 20,
      source: "coordinator",
    });

    expect(summary).toMatchObject({
      status: "partial",
      stopReason: "aborted",
      pageCount: 1,
      rowCount: 1,
    });
    expect(await getRun(summary.runId)).toMatchObject({ source: "coordinator" });
  });

  it("stops replay at its timeout when the initial read never settles", async () => {
    const orchestrator = new CollectionOrchestrator({
      getTab: async () => ({ url: "https://example.com/1" }),
      extractPage: () => new Promise(() => undefined),
      advanceNext: vi.fn(),
      broadcast: vi.fn(),
    });

    const summary = await orchestrator.runAndWait({
      tabId: 8,
      recipe,
      timeoutMs: 20,
      source: "coordinator",
    });

    expect(summary).toMatchObject({
      status: "partial",
      stopReason: "aborted",
      pageCount: 0,
      rowCount: 0,
    });
  });
});
