import type { ConnectorSource } from "@aipagego/shared/connectors";
import type { Json } from "@aipagego/shared/types";
import { getRun } from "../storage/runs";
import { getJobRun } from "../storage/jobs";
import { getDB } from "../storage/db";
import { readCollectionResult } from "../storage/collection-results";

export type ResolvedConnectorSource = {
  data: Json;
  rowCount?: number;
  byteSize: number;
};

function byteSize(value: Json): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function collection(resultId: string): Promise<ResolvedConnectorSource> {
  const record = await (await getDB()).get("collection_results", resultId);
  if (!record || (record.status !== "completed" && record.status !== "partial")) {
    throw new Error("connector_source_expired");
  }
  const rows: typeof record.rows = [];
  let offset = 0;
  while (true) {
    const page = await readCollectionResult(resultId, offset, 500);
    rows.push(...page.rows);
    if (!page.hasMore || page.nextOffset == null) break;
    offset = page.nextOffset;
  }
  return { data: rows, rowCount: rows.length, byteSize: record.byteSize };
}

async function run(runId: string): Promise<ResolvedConnectorSource> {
  const record = await getRun(runId);
  if (!record || record.status !== "ok") throw new Error("connector_source_expired");
  if (record.collection) return collection(record.collection.resultId);
  if (record.output === undefined) throw new Error("connector_source_expired");
  return { data: record.output, byteSize: byteSize(record.output) };
}

export async function resolveConnectorSource(source: ConnectorSource): Promise<ResolvedConnectorSource> {
  if (source.kind === "collection_result") return collection(source.resultId);
  if (source.kind === "run") return run(source.runId);
  const jobRun = await getJobRun(source.jobRunId);
  if (!jobRun || jobRun.status !== "ok") throw new Error("connector_source_expired");
  const successful = [...jobRun.attempts].reverse().find((attempt) => attempt.status === "ok" && attempt.runId);
  if (!successful?.runId) throw new Error("connector_source_expired");
  return run(successful.runId);
}
