import { describe, expect, it, vi } from "vitest";
import {
  createCollectStructuredDataHandler,
  type CollectionRunner,
} from "@/background/bg-tools/collection";

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

const partialSummary = {
  runId: "collection-run",
  resultId: "collection-result",
  sourceUrl: "https://example.com/list/2",
  status: "partial" as const,
  stopReason: "aborted" as const,
  rowCount: 2,
  byteSize: 42,
  pageCount: 1,
  duplicateCount: 1,
  missingRequiredCount: 0,
  preview: [{ title: "A" }, { title: "B" }],
  startedAt: 10,
  finishedAt: 20,
};

describe("collectStructuredData meta tool", () => {
  it("validates the recipe, waits for the shared runner and returns only its bounded summary", async () => {
    const runAndWait = vi.fn<CollectionRunner["runAndWait"]>().mockResolvedValue(partialSummary);
    const handler = createCollectStructuredDataHandler({ runAndWait });

    const result = await handler(
      { recipe },
      73,
      { timeoutMs: 123_000, source: "coordinator" },
    );

    expect(runAndWait).toHaveBeenCalledWith({
      tabId: 73,
      recipe,
      timeoutMs: 123_000,
      source: "coordinator",
    });
    expect(result).toEqual(partialSummary);
    expect(result).not.toHaveProperty("rows");
  });

  it("rejects an invalid recipe before starting a run", async () => {
    const runAndWait = vi.fn<CollectionRunner["runAndWait"]>();
    const handler = createCollectStructuredDataHandler({ runAndWait });

    await expect(handler({ recipe: { ...recipe, maxRows: 2_001 } }, 73)).rejects.toThrow();
    expect(runAndWait).not.toHaveBeenCalled();
  });

  it("surfaces a failed collection instead of fabricating a partial summary", async () => {
    const runAndWait = vi.fn<CollectionRunner["runAndWait"]>()
      .mockRejectedValue(new Error("collection extraction failed"));
    const handler = createCollectStructuredDataHandler({ runAndWait });

    await expect(handler({ recipe }, 73)).rejects.toThrow("collection extraction failed");
  });
});
