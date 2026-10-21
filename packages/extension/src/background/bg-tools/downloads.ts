import type { Json } from "@aipagego/shared/types";
import { XLSX_MIME, buildXlsxBytes, type SpreadsheetInput } from "@/sidepanel/lib/xlsx";

function asObj(raw: Json): Record<string, unknown> {
  return (raw ?? {}) as Record<string, unknown>;
}

export async function downloadImage(raw: Json): Promise<Json> {
  const { url, filename } = asObj(raw) as { url?: string; filename?: string };
  if (typeof url !== "string") throw new Error("downloadImage: url required");
  if (!chrome.downloads?.download) throw new Error("downloadImage: downloads API unavailable");
  const id = await chrome.downloads.download({
    url,
    filename: filename || undefined,
    saveAs: false
  });
  return { downloadId: id, filename: filename || null } as unknown as Json;
}

export async function downloadSpreadsheet(raw: Json): Promise<Json> {
  const input = asObj(raw) as { filename?: string; sheets?: unknown[] };
  if (!Array.isArray(input.sheets) || input.sheets.length === 0) {
    throw new Error("downloadSpreadsheet: sheets required");
  }
  if (!chrome.downloads?.download) {
    throw new Error("downloadSpreadsheet: downloads API unavailable");
  }

  const filename = normalizeXlsxFilename(input.filename);
  const bytes = buildXlsxBytes({ sheets: input.sheets } as SpreadsheetInput);
  // A service worker has no URL.createObjectURL, so the download is handed a
  // data: URL instead of a blob: URL.
  const url = `data:${XLSX_MIME};base64,${base64FromBytes(bytes)}`;
  const id = await chrome.downloads.download({ url, filename, saveAs: false });

  let rows = 0;
  for (const sheet of input.sheets) {
    const sheetRows = asObj(sheet as Json).rows;
    if (Array.isArray(sheetRows)) rows += sheetRows.length;
  }
  return {
    downloadId: id,
    filename,
    sheets: input.sheets.length,
    rows,
    bytes: bytes.byteLength
  } as unknown as Json;
}

function normalizeXlsxFilename(filename: unknown): string {
  const raw = typeof filename === "string" && filename.trim() ? filename.trim() : "export.xlsx";
  // eslint-disable-next-line no-control-regex
  const safe = raw.replace(/[<>:"|?*\x00-\x1f/\\]/g, "_");
  return /\.xlsx$/i.test(safe) ? safe : `${safe}.xlsx`;
}

/** Chunked so a large workbook cannot blow the argument limit of String.fromCharCode. */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
