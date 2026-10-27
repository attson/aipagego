import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CollectionRunSummary } from "@aipagego/shared/collection";
import { _resetDBForTests } from "@/background/storage/db";
import {
  checkpointCollectionResult,
  createCollectionResult,
  finalizeCollectionResult,
  getCollectionRunSnapshot,
  pruneCollectionResults,
  readCollectionResult,
} from "@/background/storage/collection-results";

const recipe = {
  version: 1 as const,
  mode: "single" as const,
  fields: [
    { id: "title", name: "标题", selector: "h1", valueMode: "text" as const, required: true },
  ],
  pagination: { kind: "single" as const },
  dedupeBy: [],
  maxRows: 2_000,
  maxBytes: 5 * 1024 * 1024,
};

function summary(resultId: string, runId: string, startedAt: number): CollectionRunSummary {
  return {
    runId,
    resultId,
    sourceUrl: "https://example.com",
    status: "completed",
    stopReason: "completed",
    rowCount: 2,
    byteSize: 30,
    pageCount: 1,
    duplicateCount: 0,
    missingRequiredCount: 0,
    preview: [{ title: "A" }, { title: "B" }],
    startedAt,
    finishedAt: startedAt + 1,
  };
}

describe("collection result storage", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
  });
  afterEach(() => _resetDBForTests());

  it("checkpoints full rows but returns only paged reads and a bounded summary snapshot", async () => {
    await createCollectionResult({
      resultId: "result-1",
      runId: "run-1",
      tabId: 8,
      sourceUrl: "https://example.com",
      recipe,
      startedAt: 1,
    });
    await checkpointCollectionResult("result-1", {
      rows: [{ title: "A" }, { title: "B" }],
      byteSize: 30,
      pageCount: 1,
      duplicateCount: 0,
      missingRequiredCount: 0,
    });
    await finalizeCollectionResult("result-1", summary("result-1", "run-1", 1));

    expect(await readCollectionResult("result-1", 0, 1)).toEqual({
      rows: [{ title: "A" }],
      hasMore: true,
      nextOffset: 1,
    });
    const snapshot = await getCollectionRunSnapshot("run-1");
    expect(snapshot?.summary?.preview).toEqual([{ title: "A" }, { title: "B" }]);
    expect(snapshot).not.toHaveProperty("rows");
  });

  it("prunes oldest completed results by count and reports missing ids as expired", async () => {
    for (let index = 0; index < 3; index++) {
      const resultId = `result-${index}`;
      const runId = `run-${index}`;
      await createCollectionResult({
        resultId,
        runId,
        tabId: index + 1,
        sourceUrl: "https://example.com",
        recipe,
        startedAt: index + 1,
      });
      await checkpointCollectionResult(resultId, {
        rows: [{ title: `P${index}` }],
        byteSize: 10,
        pageCount: 1,
        duplicateCount: 0,
        missingRequiredCount: 0,
      });
      await finalizeCollectionResult(resultId, {
        ...summary(resultId, runId, index + 1),
        rowCount: 1,
        byteSize: 10,
        preview: [{ title: `P${index}` }],
      });
    }

    expect(await pruneCollectionResults({ maxCount: 2, maxBytes: 100 })).toEqual(["result-0"]);
    await expect(readCollectionResult("result-0", 0, 10)).rejects.toThrow("result_expired");
    expect((await readCollectionResult("result-2", 0, 10)).rows).toEqual([{ title: "P2" }]);
  });

  it("prunes by aggregate byte size without evicting running results", async () => {
    await createCollectionResult({
      resultId: "running",
      runId: "run-running",
      tabId: 1,
      sourceUrl: "https://example.com",
      recipe,
      startedAt: 1,
    });
    await createCollectionResult({
      resultId: "done",
      runId: "run-done",
      tabId: 2,
      sourceUrl: "https://example.com",
      recipe,
      startedAt: 2,
    });
    await checkpointCollectionResult("done", {
      rows: [{ title: "large" }],
      byteSize: 80,
      pageCount: 1,
      duplicateCount: 0,
      missingRequiredCount: 0,
    });
    await finalizeCollectionResult("done", {
      ...summary("done", "run-done", 2),
      rowCount: 1,
      byteSize: 80,
      preview: [{ title: "large" }],
    });

    expect(await pruneCollectionResults({ maxCount: 20, maxBytes: 50 })).toEqual(["done"]);
    expect((await getCollectionRunSnapshot("run-running"))?.status).toBe("running");
  });
});
