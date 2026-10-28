import { describe, expect, it, vi } from "vitest";
import type {
  CollectionField,
  CollectionResultPage,
  CollectionRunSummary,
} from "@aipagego/shared/collection";
import {
  buildCollectionCsv,
  prepareCollectionExport,
  triggerCollectionDownload,
} from "@/sidepanel/lib/collection-export";

const fields: CollectionField[] = [
  { id: "title", name: "标题", selector: ".title", valueMode: "text", required: true },
  { id: "price", name: "价格", selector: ".price", valueMode: "text", required: false },
  { id: "note", name: "备注", selector: ".note", valueMode: "text", required: false },
];

const summary: CollectionRunSummary = {
  runId: "run-123456789",
  resultId: "result-1",
  sourceUrl: "https://example.com/list",
  status: "partial",
  stopReason: "max_rows",
  rowCount: 3,
  byteSize: 120,
  pageCount: 2,
  duplicateCount: 1,
  missingRequiredCount: 0,
  preview: [],
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_001_000,
};

const rows = [
  { title: "A, One", price: "=1+1", note: null },
  { title: "B\"Two", price: "+2", note: "line\nbreak" },
  { title: "C", price: "-3", note: "@cmd" },
];

describe("collection result exports", () => {
  it("reads the result in bounded chunks before building a file", async () => {
    const readPage = vi.fn(async ({ offset, limit }: { offset: number; limit: number }): Promise<CollectionResultPage> => {
      const pageRows = rows.slice(offset, offset + limit);
      const nextOffset = offset + pageRows.length;
      return {
        rows: pageRows,
        hasMore: nextOffset < rows.length,
        nextOffset: nextOffset < rows.length ? nextOffset : null,
      };
    });

    const prepared = await prepareCollectionExport({
      format: "json",
      summary,
      fields,
      readPage,
      chunkSize: 2,
    });

    expect(readPage).toHaveBeenNthCalledWith(1, { resultId: "result-1", offset: 0, limit: 2 });
    expect(readPage).toHaveBeenNthCalledWith(2, { resultId: "result-1", offset: 2, limit: 2 });
    expect(prepared.rowCount).toBe(3);
  });

  it("writes CSV with a BOM, field order, null cells, escaping and formula protection", () => {
    const csv = buildCollectionCsv(fields, rows);

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toBe(
      '\uFEFF标题,价格,备注\r\n"A, One",\'=1+1,\r\n"B""Two",\'+2,"line\nbreak"\r\nC,\'-3,\'@cmd'
    );
  });

  it("writes JSON as meta, fields and rows without changing null", async () => {
    const prepared = await prepareCollectionExport({
      format: "json",
      summary,
      fields,
      readPage: async ({ offset, limit }) => ({
        rows: rows.slice(offset, offset + limit),
        hasMore: offset + limit < rows.length,
        nextOffset: offset + limit < rows.length ? offset + limit : null,
      }),
    });
    const parsed = JSON.parse(await prepared.blob.text());

    expect(parsed).toEqual({ meta: summary, fields, rows });
    expect(parsed.rows[0].note).toBeNull();
  });

  it("writes XLSX data and metadata sheets in declared field order", async () => {
    const prepared = await prepareCollectionExport({
      format: "xlsx",
      summary,
      fields,
      readPage: async () => ({ rows, hasMore: false, nextOffset: null }),
    });
    const bytes = new Uint8Array(await prepared.blob.arrayBuffer());
    const text = new TextDecoder().decode(bytes);

    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(text).toContain('sheet name="数据"');
    expect(text).toContain('sheet name="元信息"');
    expect(text.indexOf("标题")).toBeLessThan(text.indexOf("价格"));
    expect(text).toContain("max_rows");
    expect(text).toContain("https://example.com/list");
  });

  it("downloads the prepared blob and always revokes its object URL", async () => {
    const createObjectURL = vi.fn(() => "blob:collection");
    const revokeObjectURL = vi.fn();
    const download = vi.fn(async () => 42);

    await expect(triggerCollectionDownload({
      blob: new Blob(["ok"], { type: "text/plain" }),
      filename: "result.csv",
      rowCount: 1,
      format: "csv",
    }, { createObjectURL, revokeObjectURL, download })).resolves.toEqual({
      downloadId: 42,
      filename: "result.csv",
    });
    expect(download).toHaveBeenCalledWith({
      url: "blob:collection",
      filename: "result.csv",
      saveAs: false,
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:collection");
  });
});
