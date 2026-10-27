import type {
  CollectionRecipeV1,
  CollectionResultPage,
  CollectionResultRecord,
  CollectionRow,
  CollectionRunSnapshot,
  CollectionRunSummary,
} from "@aipagego/shared/collection";
import { getDB } from "./db";

export const MAX_STORED_COLLECTION_RESULTS = 20;
export const MAX_STORED_COLLECTION_BYTES = 100 * 1024 * 1024;

export async function createCollectionResult(input: {
  resultId: string;
  runId: string;
  tabId: number;
  sourceUrl: string;
  recipe: CollectionRecipeV1;
  startedAt: number;
}): Promise<void> {
  const db = await getDB();
  const record: CollectionResultRecord = {
    ...input,
    rows: [],
    status: "running",
    phase: "starting",
    rowCount: 0,
    byteSize: 0,
    pageCount: 0,
    duplicateCount: 0,
    missingRequiredCount: 0,
    lastAccessedAt: input.startedAt,
  };
  await db.add("collection_results", record);
}

export async function checkpointCollectionResult(
  resultId: string,
  checkpoint: {
    rows: CollectionRow[];
    byteSize: number;
    pageCount: number;
    duplicateCount: number;
    missingRequiredCount: number;
  }
): Promise<void> {
  const db = await getDB();
  const current = await db.get("collection_results", resultId);
  if (!current) throw new Error(`collection result ${resultId} not found`);
  await db.put("collection_results", {
    ...current,
    ...checkpoint,
    rowCount: checkpoint.rows.length,
    phase: "persisting",
    lastAccessedAt: Date.now(),
  });
}

export async function updateCollectionProgress(
  resultId: string,
  progress: {
    phase: CollectionResultRecord["phase"];
    pageCount: number;
    rowCount: number;
    byteSize: number;
  }
): Promise<void> {
  const db = await getDB();
  const current = await db.get("collection_results", resultId);
  if (!current) throw new Error(`collection result ${resultId} not found`);
  await db.put("collection_results", {
    ...current,
    ...progress,
    lastAccessedAt: Date.now(),
  });
}

export async function finalizeCollectionResult(
  resultId: string,
  summary: CollectionRunSummary
): Promise<void> {
  const db = await getDB();
  const current = await db.get("collection_results", resultId);
  if (!current) throw new Error(`collection result ${resultId} not found`);
  await db.put("collection_results", {
    ...current,
    status: summary.status,
    phase: "completed",
    rowCount: summary.rowCount,
    byteSize: summary.byteSize,
    pageCount: summary.pageCount,
    duplicateCount: summary.duplicateCount,
    missingRequiredCount: summary.missingRequiredCount,
    stopReason: summary.stopReason,
    finishedAt: summary.finishedAt,
    summary,
    lastAccessedAt: Date.now(),
  });
}

export async function failCollectionResult(resultId: string, error: string): Promise<void> {
  const db = await getDB();
  const current = await db.get("collection_results", resultId);
  if (!current) return;
  await db.put("collection_results", {
    ...current,
    status: "error",
    phase: "completed",
    error,
    finishedAt: Date.now(),
    lastAccessedAt: Date.now(),
  });
}

function toSnapshot(record: CollectionResultRecord): CollectionRunSnapshot {
  return {
    runId: record.runId,
    resultId: record.resultId,
    tabId: record.tabId,
    sourceUrl: record.sourceUrl,
    recipe: record.recipe,
    status: record.status,
    phase: record.phase,
    rowCount: record.rowCount,
    byteSize: record.byteSize,
    pageCount: record.pageCount,
    duplicateCount: record.duplicateCount,
    missingRequiredCount: record.missingRequiredCount,
    startedAt: record.startedAt,
    ...(record.finishedAt == null ? {} : { finishedAt: record.finishedAt }),
    ...(record.stopReason == null ? {} : { stopReason: record.stopReason }),
    ...(record.summary == null ? {} : { summary: record.summary }),
    ...(record.error == null ? {} : { error: record.error }),
  };
}

export async function getCollectionRunSnapshot(
  runId: string
): Promise<CollectionRunSnapshot | undefined> {
  const db = await getDB();
  const record = await db.getFromIndex("collection_results", "by_runId", runId);
  return record ? toSnapshot(record) : undefined;
}

export async function readCollectionResult(
  resultId: string,
  offset: number,
  limit: number
): Promise<CollectionResultPage> {
  const db = await getDB();
  const record = await db.get("collection_results", resultId);
  if (!record) throw new Error(`result_expired: ${resultId}`);
  const rows = record.rows.slice(offset, offset + limit);
  const nextOffset = offset + rows.length;
  const hasMore = nextOffset < record.rows.length;
  record.lastAccessedAt = Date.now();
  await db.put("collection_results", record);
  return { rows, hasMore, nextOffset: hasMore ? nextOffset : null };
}

export async function pruneCollectionResults(options: {
  maxCount?: number;
  maxBytes?: number;
} = {}): Promise<string[]> {
  const maxCount = options.maxCount ?? MAX_STORED_COLLECTION_RESULTS;
  const maxBytes = options.maxBytes ?? MAX_STORED_COLLECTION_BYTES;
  const db = await getDB();
  const all = await db.getAll("collection_results");
  let remainingCount = all.length;
  let remainingBytes = all.reduce((sum, item) => sum + item.byteSize, 0);
  const candidates = all
    .filter((item) => item.status !== "running")
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  const evicted: string[] = [];
  for (const item of candidates) {
    if (remainingCount <= maxCount && remainingBytes <= maxBytes) break;
    await db.delete("collection_results", item.resultId);
    evicted.push(item.resultId);
    remainingCount -= 1;
    remainingBytes -= item.byteSize;
  }
  return evicted;
}
