import type { Json } from "@aipagego/shared/types";

export type PageBlockKind = "heading" | "kv" | "table" | "list" | "form" | "text" | "media";

export type TruncationKind = "none" | "preview" | "page" | "index_budget" | "evidence_budget";

export type TruncationInfo = {
  kind: TruncationKind;
  originalChars: number;
  returnedChars: number;
  reason: string;
  ref?: string;
};

export type PageBlock = {
  blockId: string;
  kind: PageBlockKind;
  text: string;
  label?: string;
  value?: string;
  selectorHint?: string;
  headingPath: string[];
  order: number;
  keywords: string[];
};

export type PageIndex = {
  indexId: string;
  url: string;
  title: string;
  createdAt: number;
  maxBlocks: number;
  blocks: PageBlock[];
  truncated: boolean;
  truncation?: TruncationInfo;
};

export type Preview = {
  text: string;
  complete: boolean;
  availableChars: number;
  offset: number;
  truncation: TruncationInfo;
};

export type JsonRecord = Record<string, Json>;

export const DEFAULT_MAX_BLOCKS = 600;
export const MAX_INDEX_BLOCKS = 1200;
export const DEFAULT_SUMMARY_LIMIT = 40;
export const MAX_SUMMARY_LIMIT = 80;
export const DEFAULT_MATCH_LIMIT = 20;
export const MAX_MATCH_LIMIT = 50;
export const SEARCH_SNIPPET_CHARS = 800;
export const FIELD_EVIDENCE_CHARS = 600;
export const DEFAULT_READ_CHARS = 4000;
export const MAX_READ_CHARS = 12000;
