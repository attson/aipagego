import { z } from "zod";

export const MAX_COLLECTION_FIELDS = 20;
export const MAX_COLLECTION_PAGES = 100;
export const MAX_COLLECTION_ROWS = 2_000;
export const MAX_COLLECTION_BYTES = 5 * 1024 * 1024;

export const CollectionValueModeSchema = z.enum(["text", "href", "src", "attribute"]);

export const CollectionFieldSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  selector: z.string().trim().min(1),
  valueMode: CollectionValueModeSchema,
  attribute: z.string().trim().min(1).optional(),
  required: z.boolean(),
}).superRefine((field, ctx) => {
  if (field.valueMode === "attribute" && !field.attribute) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attribute"],
      message: "attribute value mode requires an attribute name",
    });
  }
});

export const CollectionPaginationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("single") }),
  z.object({
    kind: z.enum(["next", "loadMore"]),
    selector: z.string().trim().min(1),
    maxPages: z.number().int().min(1).max(MAX_COLLECTION_PAGES),
  }),
  z.object({
    kind: z.literal("infiniteScroll"),
    maxPages: z.number().int().min(1).max(MAX_COLLECTION_PAGES),
  }),
]);

export const CollectionRecipeSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["single", "list"]),
  itemSelector: z.string().trim().min(1).optional(),
  fields: z.array(CollectionFieldSchema).min(1).max(MAX_COLLECTION_FIELDS),
  pagination: CollectionPaginationSchema,
  dedupeBy: z.array(z.string().trim().min(1)).max(MAX_COLLECTION_FIELDS),
  maxRows: z.number().int().min(1).max(MAX_COLLECTION_ROWS),
  maxBytes: z.number().int().min(1).max(MAX_COLLECTION_BYTES),
}).superRefine((recipe, ctx) => {
  if (recipe.mode === "list" && !recipe.itemSelector) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["itemSelector"],
      message: "list mode requires an item selector",
    });
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  for (let index = 0; index < recipe.fields.length; index++) {
    const field = recipe.fields[index];
    if (ids.has(field.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fields", index, "id"],
        message: `duplicate field id: ${field.id}`,
      });
    }
    if (names.has(field.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fields", index, "name"],
        message: `duplicate field name: ${field.name}`,
      });
    }
    ids.add(field.id);
    names.add(field.name);
  }

  const dedupeIds = new Set<string>();
  for (let index = 0; index < recipe.dedupeBy.length; index++) {
    const fieldId = recipe.dedupeBy[index];
    if (!ids.has(fieldId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dedupeBy", index],
        message: `unknown dedupe field: ${fieldId}`,
      });
    }
    if (dedupeIds.has(fieldId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dedupeBy", index],
        message: `duplicate dedupe field: ${fieldId}`,
      });
    }
    dedupeIds.add(fieldId);
  }
});

export const CollectionStopReasonSchema = z.enum([
  "completed",
  "max_rows",
  "max_bytes",
  "max_pages",
  "pagination_missing",
  "pagination_disabled",
  "no_new_rows",
  "repeated_page",
  "navigation_timeout",
  "aborted",
]);

export const CollectionRowSchema = z.record(z.string().nullable());

export const CollectionRunSummarySchema = z.object({
  runId: z.string().min(1),
  resultId: z.string().min(1),
  sourceUrl: z.string().min(1),
  status: z.enum(["completed", "partial"]),
  stopReason: CollectionStopReasonSchema,
  rowCount: z.number().int().nonnegative(),
  byteSize: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  missingRequiredCount: z.number().int().nonnegative(),
  preview: z.array(CollectionRowSchema).max(5),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
});

export const CollectionRunSnapshotSchema = z.object({
  runId: z.string().min(1),
  resultId: z.string().min(1),
  tabId: z.number().int().positive(),
  sourceUrl: z.string().min(1),
  recipe: CollectionRecipeSchema.optional(),
  status: z.enum(["running", "completed", "partial", "error"]),
  phase: z.enum(["starting", "extracting", "persisting", "completed"]),
  rowCount: z.number().int().nonnegative(),
  byteSize: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  missingRequiredCount: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
  stopReason: CollectionStopReasonSchema.optional(),
  summary: CollectionRunSummarySchema.optional(),
  error: z.string().optional(),
  resultExpired: z.boolean().optional(),
});

export const CollectionProgressSchema = z.object({
  type: z.literal("collection.progress"),
  runId: z.string().min(1),
  phase: z.enum(["starting", "extracting", "persisting", "completed"]),
  pageCount: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  byteSize: z.number().int().nonnegative(),
  stopReason: CollectionStopReasonSchema.optional(),
});

export const CollectionResultPageSchema = z.object({
  rows: z.array(CollectionRowSchema),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export const CollectionExtractedRowSchema = z.object({
  values: CollectionRowSchema,
  missingRequired: z.array(z.string()),
});

export const CollectionPageExtractionSchema = z.object({
  rows: z.array(CollectionExtractedRowSchema),
  pageUrl: z.string(),
  fingerprint: z.string().min(1),
  matchedCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative().default(0),
  truncatedBy: z.enum(["max_rows", "max_bytes"]).nullable().default(null),
});

export type CollectionValueMode = z.infer<typeof CollectionValueModeSchema>;
export type CollectionField = z.infer<typeof CollectionFieldSchema>;
export type CollectionPagination = z.infer<typeof CollectionPaginationSchema>;
export type CollectionRecipeV1 = z.infer<typeof CollectionRecipeSchema>;
export type CollectionStopReason = z.infer<typeof CollectionStopReasonSchema>;
export type CollectionRow = z.infer<typeof CollectionRowSchema>;
export type CollectionRunSummary = z.infer<typeof CollectionRunSummarySchema>;
export type CollectionRunSnapshot = z.infer<typeof CollectionRunSnapshotSchema>;
export type CollectionProgress = z.infer<typeof CollectionProgressSchema>;
export type CollectionResultPage = z.infer<typeof CollectionResultPageSchema>;
export type CollectionExtractedRow = z.infer<typeof CollectionExtractedRowSchema>;
export type CollectionPageExtraction = z.infer<typeof CollectionPageExtractionSchema>;

export type CollectionResultRecord = {
  resultId: string;
  runId: string;
  tabId: number;
  sourceUrl: string;
  recipe: CollectionRecipeV1;
  rows: CollectionRow[];
  status: "running" | "completed" | "partial" | "error";
  phase: "starting" | "extracting" | "persisting" | "completed";
  rowCount: number;
  byteSize: number;
  pageCount: number;
  duplicateCount: number;
  missingRequiredCount: number;
  startedAt: number;
  finishedAt?: number;
  stopReason?: CollectionStopReason;
  summary?: CollectionRunSummary;
  error?: string;
  lastAccessedAt: number;
};

export type CollectionPreviewRow = {
  values: Record<string, string | null>;
  missingRequired: string[];
  duplicate: boolean;
};

export type CollectionPreview = {
  rows: CollectionPreviewRow[];
  matchedCount: number;
  returnedCount: number;
  uniqueCount: number;
  duplicateCount: number;
  missingRequiredCount: number;
  truncated: boolean;
};
