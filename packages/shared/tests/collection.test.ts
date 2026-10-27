import { describe, expect, it } from "vitest";
import {
  CollectionProgressSchema,
  CollectionRecipeSchema,
  CollectionRunSummarySchema,
  CollectionRunSnapshotSchema,
  CollectionStopReasonSchema,
  MAX_COLLECTION_BYTES,
  MAX_COLLECTION_ROWS,
} from "../src/collection";

function validRecipe() {
  return {
    version: 1 as const,
    mode: "list" as const,
    itemSelector: ".item",
    fields: [
      {
        id: "title",
        name: "标题",
        selector: ".title",
        valueMode: "text" as const,
        required: true,
      },
      {
        id: "sku",
        name: "SKU",
        selector: "[data-sku]",
        valueMode: "attribute" as const,
        attribute: "data-sku",
        required: false,
      },
    ],
    pagination: { kind: "next" as const, selector: "a.next", maxPages: 20 },
    dedupeBy: ["title", "sku"],
    maxRows: MAX_COLLECTION_ROWS,
    maxBytes: MAX_COLLECTION_BYTES,
  };
}

describe("CollectionRecipeSchema", () => {
  it("accepts a bounded v1 list recipe with multi-field dedupe", () => {
    expect(CollectionRecipeSchema.parse(validRecipe())).toMatchObject({
      version: 1,
      mode: "list",
      dedupeBy: ["title", "sku"],
    });
  });

  it("requires list roots and attribute names", () => {
    const noRoot = { ...validRecipe(), itemSelector: undefined };
    const noAttribute = {
      ...validRecipe(),
      fields: validRecipe().fields.map((field) =>
        field.id === "sku" ? { ...field, attribute: undefined } : field
      ),
    };

    expect(CollectionRecipeSchema.safeParse(noRoot).success).toBe(false);
    expect(CollectionRecipeSchema.safeParse(noAttribute).success).toBe(false);
  });

  it("rejects duplicate field ids and unknown dedupe fields", () => {
    const duplicate = {
      ...validRecipe(),
      fields: [validRecipe().fields[0], { ...validRecipe().fields[1], id: "title" }],
    };
    const unknown = { ...validRecipe(), dedupeBy: ["missing"] };

    expect(CollectionRecipeSchema.safeParse(duplicate).success).toBe(false);
    expect(CollectionRecipeSchema.safeParse(unknown).success).toBe(false);
  });

  it("enforces collection and pagination hard limits", () => {
    expect(CollectionRecipeSchema.safeParse({ ...validRecipe(), maxRows: 2_001 }).success).toBe(false);
    expect(CollectionRecipeSchema.safeParse({ ...validRecipe(), maxBytes: MAX_COLLECTION_BYTES + 1 }).success).toBe(false);
    expect(CollectionRecipeSchema.safeParse({
      ...validRecipe(),
      pagination: { kind: "next", selector: "a.next", maxPages: 101 },
    }).success).toBe(false);
  });
});

describe("collection run contracts", () => {
  it("round-trips every machine-readable stop reason", () => {
    const reasons = [
      "completed", "max_rows", "max_bytes", "max_pages", "pagination_missing",
      "pagination_disabled", "no_new_rows", "repeated_page", "navigation_timeout", "aborted",
    ];
    expect(reasons.map((reason) => CollectionStopReasonSchema.parse(reason))).toEqual(reasons);
  });

  it("keeps completed summaries bounded to five preview rows", () => {
    const summary = {
      runId: "run-1",
      resultId: "result-1",
      sourceUrl: "https://example.com",
      status: "completed",
      stopReason: "completed",
      rowCount: 7,
      byteSize: 100,
      pageCount: 1,
      duplicateCount: 1,
      missingRequiredCount: 2,
      preview: Array.from({ length: 5 }, (_, index) => ({ title: `P${index}` })),
      startedAt: 1,
      finishedAt: 2,
    };
    expect(CollectionRunSummarySchema.parse(summary)).toEqual(summary);
    expect(CollectionRunSummarySchema.safeParse({
      ...summary,
      preview: [...summary.preview, { title: "P5" }],
    }).success).toBe(false);
  });

  it("validates running snapshots and progress events", () => {
    const snapshot = CollectionRunSnapshotSchema.parse({
      runId: "run-1",
      resultId: "result-1",
      tabId: 9,
      sourceUrl: "https://example.com",
      status: "running",
      phase: "extracting",
      rowCount: 0,
      byteSize: 0,
      pageCount: 0,
      duplicateCount: 0,
      missingRequiredCount: 0,
      startedAt: 1,
    });
    expect(snapshot.status).toBe("running");
    expect(CollectionProgressSchema.parse({
      type: "collection.progress",
      runId: "run-1",
      phase: "completed",
      pageCount: 1,
      rowCount: 3,
      byteSize: 42,
      stopReason: "completed",
    }).stopReason).toBe("completed");
  });
});
