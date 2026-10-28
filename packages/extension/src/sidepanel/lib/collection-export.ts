import type {
  CollectionField,
  CollectionResultPage,
  CollectionRow,
  CollectionRunSummary,
} from "@aipagego/shared/collection";
import { buildXlsxFile } from "./xlsx";

export type CollectionExportFormat = "xlsx" | "csv" | "json";

export type PreparedCollectionExport = {
  blob: Blob;
  filename: string;
  rowCount: number;
  format: CollectionExportFormat;
};

type ReadPage = (input: {
  resultId: string;
  offset: number;
  limit: number;
}) => Promise<CollectionResultPage>;

export async function readAllCollectionRows(
  resultId: string,
  readPage: ReadPage,
  chunkSize = 500
): Promise<CollectionRow[]> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 500) {
    throw new Error("collection export chunkSize must be between 1 and 500");
  }
  const rows: CollectionRow[] = [];
  let offset = 0;
  while (true) {
    const page = await readPage({ resultId, offset, limit: chunkSize });
    rows.push(...page.rows);
    if (!page.hasMore) return rows;
    if (page.nextOffset == null || page.nextOffset <= offset) {
      throw new Error("collection export received an invalid nextOffset");
    }
    offset = page.nextOffset;
  }
}

function csvCell(value: string | null): string {
  if (value == null) return "";
  const protectedValue = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(protectedValue)
    ? `"${protectedValue.replace(/"/g, '""')}"`
    : protectedValue;
}

export function buildCollectionCsv(
  fields: CollectionField[],
  rows: CollectionRow[]
): string {
  const lines = [
    fields.map((field) => csvCell(field.name)).join(","),
    ...rows.map((row) => fields.map((field) => csvCell(row[field.id] ?? null)).join(",")),
  ];
  return `\uFEFF${lines.join("\r\n")}`;
}

function exportBaseName(summary: CollectionRunSummary): string {
  const host = (() => {
    try {
      return new URL(summary.sourceUrl).hostname;
    } catch {
      return "collection";
    }
  })();
  return `aipagego-${host}-${summary.runId.slice(0, 8)}`
    .replace(/[<>:"|?*\x00-\x1f/\\]/g, "_");
}

function metadataRows(summary: CollectionRunSummary): Array<[string, string | number]> {
  return [
    ["runId", summary.runId],
    ["resultId", summary.resultId],
    ["sourceUrl", summary.sourceUrl],
    ["status", summary.status],
    ["stopReason", summary.stopReason],
    ["rowCount", summary.rowCount],
    ["byteSize", summary.byteSize],
    ["pageCount", summary.pageCount],
    ["duplicateCount", summary.duplicateCount],
    ["missingRequiredCount", summary.missingRequiredCount],
    ["startedAt", summary.startedAt],
    ["finishedAt", summary.finishedAt],
  ];
}

export async function prepareCollectionExport(input: {
  format: CollectionExportFormat;
  summary: CollectionRunSummary;
  fields: CollectionField[];
  readPage: ReadPage;
  chunkSize?: number;
}): Promise<PreparedCollectionExport> {
  const rows = await readAllCollectionRows(
    input.summary.resultId,
    input.readPage,
    input.chunkSize
  );
  if (rows.length !== input.summary.rowCount) {
    throw new Error(
      `collection export row count mismatch: expected ${input.summary.rowCount}, got ${rows.length}`
    );
  }

  const baseName = exportBaseName(input.summary);
  if (input.format === "csv") {
    return {
      blob: new Blob([buildCollectionCsv(input.fields, rows)], { type: "text/csv;charset=utf-8" }),
      filename: `${baseName}.csv`,
      rowCount: rows.length,
      format: input.format,
    };
  }
  if (input.format === "json") {
    return {
      blob: new Blob([
        JSON.stringify({ meta: input.summary, fields: input.fields, rows }, null, 2),
      ], { type: "application/json;charset=utf-8" }),
      filename: `${baseName}.json`,
      rowCount: rows.length,
      format: input.format,
    };
  }
  return {
    blob: buildXlsxFile({
      sheets: [
        {
          name: "数据",
          columns: input.fields.map((field) => ({ key: field.id, header: field.name })),
          rows,
        },
        {
          name: "元信息",
          rows: [["字段", "值"], ...metadataRows(input.summary)],
        },
      ],
    }),
    filename: `${baseName}.xlsx`,
    rowCount: rows.length,
    format: input.format,
  };
}

type DownloadDeps = {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  download: (options: {
    url: string;
    filename: string;
    saveAs: boolean;
  }) => Promise<number>;
};

export async function triggerCollectionDownload(
  prepared: PreparedCollectionExport,
  deps?: DownloadDeps
): Promise<{ downloadId: number; filename: string }> {
  if (!deps && !chrome.downloads?.download) {
    throw new Error("collection export: downloads API unavailable");
  }
  const resolved = deps ?? {
    createObjectURL: (blob: Blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url: string) => URL.revokeObjectURL(url),
    download: (options: { url: string; filename: string; saveAs: boolean }) =>
      chrome.downloads.download(options),
  };
  const url = resolved.createObjectURL(prepared.blob);
  try {
    const downloadId = await resolved.download({
      url,
      filename: prepared.filename,
      saveAs: false,
    });
    return { downloadId, filename: prepared.filename };
  } finally {
    resolved.revokeObjectURL(url);
  }
}
