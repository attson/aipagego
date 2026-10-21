import type { Json } from "@aipagego/shared/types";
import { extractFields, searchIndex } from "./page-index/search";
import { findBlock, getPageIndex } from "./page-index/store";
import {
  DEFAULT_MATCH_LIMIT,
  DEFAULT_READ_CHARS,
  DEFAULT_SUMMARY_LIMIT,
  MAX_INDEX_BLOCKS,
  MAX_MATCH_LIMIT,
  MAX_READ_CHARS,
  MAX_SUMMARY_LIMIT,
  type PageIndex,
  type TruncationInfo
} from "./page-index/types";
import { makePreview } from "./page-index/text";

type CreateArgs = {
  maxBlocks?: number;
  refresh?: boolean;
  summaryLimit?: number;
};

type SearchArgs = {
  query?: string;
  fields?: string[];
  limit?: number;
  maxBlocks?: number;
  refresh?: boolean;
};

type ReadArgs = {
  blockId?: string;
  indexId?: string;
  offset?: number;
  maxChars?: number;
  includeNeighbors?: boolean;
};

type ExtractArgs = {
  fields?: string[];
  maxCandidatesPerField?: number;
  maxBlocks?: number;
  refresh?: boolean;
};

function asRecord(args: Json): Record<string, Json> {
  return args && typeof args === "object" && !Array.isArray(args) ? args : {};
}

function numberArg(value: Json | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanArg(value: Json | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArg(value: Json | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArrayArg(value: Json | undefined): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function parseCreateArgs(args: Json): CreateArgs {
  const input = asRecord(args);
  return {
    maxBlocks: numberArg(input.maxBlocks),
    refresh: booleanArg(input.refresh),
    summaryLimit: numberArg(input.summaryLimit)
  };
}

function parseSearchArgs(args: Json): SearchArgs {
  const input = asRecord(args);
  return {
    query: stringArg(input.query),
    fields: stringArrayArg(input.fields),
    limit: numberArg(input.limit),
    maxBlocks: numberArg(input.maxBlocks),
    refresh: booleanArg(input.refresh)
  };
}

function parseReadArgs(args: Json): ReadArgs {
  const input = asRecord(args);
  return {
    blockId: stringArg(input.blockId),
    indexId: stringArg(input.indexId),
    offset: numberArg(input.offset),
    maxChars: numberArg(input.maxChars),
    includeNeighbors: booleanArg(input.includeNeighbors)
  };
}

function parseExtractArgs(args: Json): ExtractArgs {
  const input = asRecord(args);
  return {
    fields: stringArrayArg(input.fields),
    maxCandidatesPerField: numberArg(input.maxCandidatesPerField),
    maxBlocks: numberArg(input.maxBlocks),
    refresh: booleanArg(input.refresh)
  };
}

function noneTruncation(originalChars: number, ref: string): TruncationInfo {
  return {
    kind: "none",
    originalChars,
    returnedChars: originalChars,
    reason: "none",
    ref
  };
}

function textChars(index: PageIndex): number {
  return index.blocks.reduce((sum, block) => sum + block.text.length, 0);
}

function kindCounts(index: PageIndex): Record<string, number> {
  return index.blocks.reduce<Record<string, number>>((acc, block) => {
    acc[block.kind] = (acc[block.kind] ?? 0) + 1;
    return acc;
  }, {});
}

function nextRead(blockId: string, offset = 0, maxChars = DEFAULT_READ_CHARS, indexId?: string): Json {
  return {
    tool: "readPageBlock",
    args: { ...(indexId ? { indexId } : {}), blockId, offset, maxChars }
  };
}

export async function createPageIndex(args: Json): Promise<Json> {
  const input = parseCreateArgs(args);
  const index = getPageIndex({ maxBlocks: input.maxBlocks, refresh: input.refresh });
  const summaryLimit = Math.min(MAX_SUMMARY_LIMIT, Math.max(1, Math.floor(input.summaryLimit ?? DEFAULT_SUMMARY_LIMIT)));
  const summary = index.blocks.slice(0, summaryLimit).map((block) => {
    const preview = makePreview(block.text, 240, block.blockId, "summary");
    const result: Record<string, Json> = {
      blockId: block.blockId,
      kind: block.kind,
      text: preview.text,
      complete: preview.complete,
      availableChars: preview.availableChars,
      truncation: preview.truncation as Json
    };
    if (block.label) result.label = block.label;
    if (!preview.complete) result.recommendedNext = [nextRead(block.blockId, preview.offset, DEFAULT_READ_CHARS, index.indexId)];
    return result;
  });

  return {
    ok: true,
    indexId: index.indexId,
    url: index.url,
    title: index.title,
    blockCount: index.blocks.length,
    kinds: kindCounts(index),
    summary,
    truncated: index.truncated,
    truncation: (index.truncation ?? noneTruncation(textChars(index), "index")) as Json,
    ...(index.truncated && index.maxBlocks < MAX_INDEX_BLOCKS
      ? {
          recommendedNext: [
            {
              tool: "createPageIndex",
              args: { maxBlocks: Math.min(MAX_INDEX_BLOCKS, index.maxBlocks * 2), refresh: true }
            }
          ]
        }
      : {})
  };
}

export async function searchPageIndex(args: Json): Promise<Json> {
  const input = parseSearchArgs(args);
  const index = getPageIndex({ maxBlocks: input.maxBlocks, refresh: input.refresh });
  const result = searchIndex(index, {
    query: input.query,
    fields: input.fields,
    limit: Math.min(MAX_MATCH_LIMIT, input.limit ?? DEFAULT_MATCH_LIMIT)
  });

  return {
    ...result,
    matches: result.matches.map((match) => ({
      ...match,
      ...(!match.complete ? { recommendedNext: [nextRead(match.blockId, match.previewOffset ?? 0, DEFAULT_READ_CHARS, result.indexId)] } : {})
    }))
  } as Json;
}

export async function readPageBlock(args: Json): Promise<Json> {
  const input = parseReadArgs(args);
  if (!input.blockId) {
    const index = getPageIndex();
    return { error: "missing_blockId", indexId: index.indexId };
  }

  const { index, block, indexMissing } = findBlock(input.blockId, input.indexId);
  if (indexMissing || !index) {
    return { error: "index_not_found", indexId: input.indexId ?? "", blockId: input.blockId };
  }
  if (!block) {
    return { error: "block_not_found", indexId: index.indexId, blockId: input.blockId };
  }

  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const maxChars = Math.min(MAX_READ_CHARS, Math.max(1, Math.floor(input.maxChars ?? DEFAULT_READ_CHARS)));
  const text = block.text.slice(offset, offset + maxChars);
  const hasMore = offset + maxChars < block.text.length;
  const returnedChars = text.length;
  const result: Record<string, Json> = {
    indexId: index.indexId,
    blockId: block.blockId,
    kind: block.kind,
    text,
    offset,
    maxChars,
    nextOffset: hasMore ? offset + returnedChars : null,
    hasMore,
    truncation: {
      kind: hasMore ? "page" : "none",
      originalChars: block.text.length,
      returnedChars,
      reason: hasMore ? "readPageBlock.maxChars" : "none",
      ref: block.blockId
    }
  };
  if (block.label) result.label = block.label;
  if (block.selectorHint) result.selectorHint = block.selectorHint;
  if (hasMore) result.recommendedNext = [nextRead(block.blockId, offset + returnedChars, maxChars, index.indexId)];
  if (input.includeNeighbors) {
    result.neighbors = index.blocks
      .filter((candidate) => Math.abs(candidate.order - block.order) <= 1 && candidate.blockId !== block.blockId)
      .map((candidate) => {
        const preview = makePreview(candidate.text, 240, candidate.blockId, "neighbor");
        const neighbor: Record<string, Json> = {
          blockId: candidate.blockId,
          kind: candidate.kind,
          text: preview.text,
          complete: preview.complete,
          availableChars: preview.availableChars,
          truncation: preview.truncation as Json
        };
        if (candidate.label) neighbor.label = candidate.label;
        return neighbor;
      });
  }

  return result;
}

export async function extractPageFields(args: Json): Promise<Json> {
  const input = parseExtractArgs(args);
  const index = getPageIndex({ maxBlocks: input.maxBlocks, refresh: input.refresh });
  const result = extractFields(index, {
    fields: input.fields ?? [],
    maxCandidatesPerField: input.maxCandidatesPerField
  });

  return {
    ...result,
    fields: result.fields.map((field) => ({
      ...field,
      candidates: field.candidates.map((candidate) => ({
        ...candidate,
        ...(!candidate.complete
          ? { recommendedNext: [nextRead(candidate.blockId, candidate.previewOffset ?? 0, DEFAULT_READ_CHARS, result.indexId)] }
          : {})
      }))
    }))
  } as Json;
}
