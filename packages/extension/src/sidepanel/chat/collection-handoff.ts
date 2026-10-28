import type { ChatMessage, Json, Step } from "@aipagego/shared/types";

export type CollectionConversation = {
  tabId: number;
  url: string;
  status: string;
  messages: ChatMessage[];
  executedSteps: Step[];
  lastOutput: Json;
};

export type CollectionStudioHandoff = {
  id: string;
  source: "chat";
  tabId: number;
  url: string;
  sample: Json | null;
};

const COLLECTION_TOOLS = new Set([
  "createPageIndex",
  "searchPageIndex",
  "readPageBlock",
  "extractPageFields",
  "extractText",
  "extractImages",
  "querySelectorAll",
]);

const COLLECTION_INTENT = /(采集|收集|抓取|提取|导出|列表|字段|评论|商品|collect|extract|scrape)/i;

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function isCollectionConversation(session: CollectionConversation): boolean {
  if (session.status !== "done") return false;
  const hasIntent = session.messages
    .filter((message) => message.role === "user")
    .some((message) => COLLECTION_INTENT.test(messageText(message)));
  if (!hasIntent) return false;
  return session.executedSteps.some((step) =>
    step.kind === "tool" && COLLECTION_TOOLS.has(step.tool)
  );
}

function boundedValue(value: Json, depth: number): Json {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 500);
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 5).map((item) => boundedValue(item, depth + 1));
  const out: Record<string, Json> = {};
  for (const [key, child] of Object.entries(value).slice(0, 20)) {
    if (/selector|xpath/i.test(key)) continue;
    out[key] = boundedValue(child, depth + 1);
  }
  return out;
}

function structuredSample(value: Json): Json | null {
  if (value == null || typeof value !== "object") return null;
  return boundedValue(value, 0);
}

export function createCollectionHandoff(
  session: CollectionConversation
): CollectionStudioHandoff {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `collection-${Date.now()}`,
    source: "chat",
    tabId: session.tabId,
    url: session.url,
    sample: structuredSample(session.lastOutput),
  };
}
