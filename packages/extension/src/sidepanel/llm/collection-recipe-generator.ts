import {
  CollectionRecipeSchema,
  MAX_COLLECTION_BYTES,
  MAX_COLLECTION_ROWS,
  type CollectionRecipeV1,
} from "@aipagego/shared/collection";
import type { LlmClient } from "@aipagego/shared/llm";
import type { Json, Step } from "@aipagego/shared/types";
import { parseGeneratedJson } from "./tool-draft-generator";

const INDEX_SUMMARY_LIMIT = 12;
const DETAIL_BLOCK_LIMIT = 6;
const DETAIL_CHARS = 400;
const MAX_EVIDENCE_CHARS = 12_000;
const MAX_SAMPLE_CHARS = 2_000;

type RunStep = (step: Step, tabId: number) => Promise<Json>;

export type RecommendCollectionRecipeInput = {
  client: LlmClient;
  apiKey: string;
  model: string;
  endpoint?: string;
  maxTokens?: number;
  tabId: number;
  url: string;
  sample?: Json | null;
  runStep: RunStep;
  abortSignal?: AbortSignal;
};

function record(value: Json): Record<string, Json> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Json>
    : {};
}

function text(value: Json, max = 500): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function requireBoundedJson(value: Json, maxChars: number, label: string): string {
  const serialized = JSON.stringify(value);
  if (serialized.length > maxChars) {
    throw new Error(`${label} 超出 ${maxChars} 字符上限`);
  }
  return serialized;
}

function boundedSampleEvidence(value: Json, maxChars: number): Json {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxChars) return value;

  if (Array.isArray(value)) {
    const items: Json[] = [];
    for (const item of value) {
      const candidate = {
        items: [...items, item],
        truncation: { kind: "items", originalItems: value.length, returnedItems: items.length + 1 },
      } as Json;
      if (JSON.stringify(candidate).length > maxChars) break;
      items.push(item);
    }
    return {
      items,
      truncation: { kind: "items", originalItems: value.length, returnedItems: items.length },
    };
  }

  if (value != null && typeof value === "object") {
    const input = value as Record<string, Json>;
    if (Array.isArray(input.rows)) {
      const rows: Json[] = [];
      for (const row of input.rows) {
        const candidate = {
          rows: [...rows, row],
          truncation: {
            kind: "rows",
            originalRows: input.rows.length,
            returnedRows: rows.length + 1,
          },
        } as Json;
        if (JSON.stringify(candidate).length > maxChars) break;
        rows.push(row);
      }
      return {
        rows,
        truncation: {
          kind: "rows",
          originalRows: input.rows.length,
          returnedRows: rows.length,
        },
      };
    }
  }

  return {
    truncation: {
      kind: "sample_limit",
      originalChars: serialized.length,
      returned: false,
    },
  };
}

async function collectEvidence(input: RecommendCollectionRecipeInput): Promise<Json> {
  const index = await input.runStep({
    kind: "tool",
    tool: "createPageIndex",
    args: { maxBlocks: 200, refresh: true, summaryLimit: INDEX_SUMMARY_LIMIT },
  }, input.tabId);
  const indexRecord = record(index);
  if (indexRecord.ok !== true || typeof indexRecord.indexId !== "string") {
    throw new Error("页面索引创建失败，无法生成采集配方");
  }

  const summary = Array.isArray(indexRecord.summary)
    ? indexRecord.summary.slice(0, INDEX_SUMMARY_LIMIT).map((value) => {
        const item = record(value);
        return {
          blockId: text(item.blockId, 80) ?? "",
          kind: text(item.kind, 40) ?? "",
          ...(text(item.label, 80) ? { label: text(item.label, 80)! } : {}),
          text: text(item.text, 180) ?? "",
        };
      })
    : [];

  const detailIds = summary
    .map((item) => item.blockId)
    .filter(Boolean)
    .slice(0, DETAIL_BLOCK_LIMIT);
  const details = await Promise.all(detailIds.map(async (blockId) => {
    const value = await input.runStep({
      kind: "tool",
      tool: "readPageBlock",
      args: {
        indexId: indexRecord.indexId,
        blockId,
        offset: 0,
        maxChars: DETAIL_CHARS,
        includeNeighbors: false,
      },
    }, input.tabId);
    const detail = record(value);
    return {
      blockId,
      kind: text(detail.kind, 40) ?? "",
      ...(text(detail.label, 80) ? { label: text(detail.label, 80)! } : {}),
      ...(text(detail.selectorHint, 180) ? { selectorHint: text(detail.selectorHint, 180)! } : {}),
      text: text(detail.text, DETAIL_CHARS) ?? "",
      hasMore: detail.hasMore === true,
    };
  }));

  return {
    url: text(indexRecord.url, 2_000) ?? input.url,
    title: text(indexRecord.title, 500) ?? "",
    indexId: indexRecord.indexId,
    summary,
    details,
  } as Json;
}

export async function recommendCollectionRecipe(
  input: RecommendCollectionRecipeInput
): Promise<CollectionRecipeV1> {
  if (!input.apiKey.trim()) throw new Error("请先在设置中配置 LLM API Key");
  const evidence = await collectEvidence(input);
  const sample = input.sample == null
    ? "无"
    : JSON.stringify(boundedSampleEvidence(input.sample, MAX_SAMPLE_CHARS));
  const user = [
    `# 固定目标 URL\n${input.url}`,
    `# Page Context Index 有界证据\n${requireBoundedJson(evidence, MAX_EVIDENCE_CHARS, "页面索引证据")}`,
    `# 对话带入的结构化样例（仅供理解字段，不代表 selector）\n${sample}`,
    "# 输出\n只返回一个 CollectionRecipeV1 JSON 对象。",
  ].join("\n\n");

  const stream = input.client.stream({
    apiKey: input.apiKey,
    model: input.model,
    endpoint: input.endpoint,
    maxTokens: Math.min(input.maxTokens ?? 4096, 4096),
    abortSignal: input.abortSignal,
    tools: [],
    system: [
      "你是 AIPageGo 采集配方生成器。",
      "根据 Page Context Index 的 selectorHint、块类型、标签和文本，生成可编辑的当前页采集配方。",
      "selector 必须来自证据或由证据中的局部 selector 明确推导；不要把结构化样例里的值当 selector。",
      "本次只配置当前页，pagination 必须是 {\"kind\":\"single\"}。",
      "输出必须完整包含 version、mode、itemSelector(列表时)、fields、pagination、dedupeBy、maxRows、maxBytes。",
      "maxRows 固定 2000，maxBytes 固定 5242880；字段最多 20 个。不要自动运行，不要输出 markdown。",
    ].join("\n"),
    messages: [{ role: "user", content: user }],
  });

  let raw = "";
  for await (const event of stream) {
    if (input.abortSignal?.aborted) throw new DOMException("aborted", "AbortError");
    if (event.type === "text_delta") raw += event.text;
    if (event.type === "error") throw new Error(event.error);
  }

  const parsedJson = parseGeneratedJson(raw);
  const parsed = CollectionRecipeSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`AI 配方无效：${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  }
  if (parsed.data.pagination.kind !== "single") {
    throw new Error("AI 配方无效：当前页推荐只接受 single pagination");
  }
  if (
    parsed.data.maxRows !== MAX_COLLECTION_ROWS ||
    parsed.data.maxBytes !== MAX_COLLECTION_BYTES
  ) {
    throw new Error("AI 配方无效：maxRows / maxBytes 必须使用固定硬上限");
  }
  return parsed.data;
}
