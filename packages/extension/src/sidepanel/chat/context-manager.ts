import type {
  ChatMessage,
  ContextPolicy,
  ImagePart,
  Json,
  LlmSettings,
  TextPart,
  ToolResultPart,
  ToolUsePart,
} from "@aipagego/shared/types";
import { truncateContent } from "@/sidepanel/llm/truncate";

export type UserMessageContent = Extract<ChatMessage, { role: "user" }>["content"];

export type ContextBuildOptions = {
  recentMessageLimit?: number;
  softCharBudget?: number;
  memoryCharLimit?: number;
};

export type ContextBuildResult = {
  initialMessages: ChatMessage[];
  compressed: boolean;
  compressedMessageCount: number;
  estimatedChars: number;
};

const POLICY_OPTIONS: Record<Exclude<ContextPolicy, "auto" | "custom">, Required<ContextBuildOptions>> = {
  conservative: { softCharBudget: 48_000, recentMessageLimit: 8, memoryCharLimit: 4_000 },
  large: { softCharBudget: 160_000, recentMessageLimit: 16, memoryCharLimit: 8_000 },
  huge: { softCharBudget: 500_000, recentMessageLimit: 24, memoryCharLimit: 16_000 },
};

const DEFAULT_RESOLVED_OPTIONS = POLICY_OPTIONS.conservative;
const MIN_SOFT_CHAR_BUDGET = 8_000;
const MAX_SOFT_CHAR_BUDGET = 900_000;
const MIN_RECENT_MESSAGE_LIMIT = 2;
const MAX_RECENT_MESSAGE_LIMIT = 80;
const MIN_MEMORY_CHAR_LIMIT = 1_000;
const MAX_MEMORY_CHAR_LIMIT = 80_000;
const PART_TEXT_CAP = 700;
const TOOL_RESULT_TEXT_CAP = 900;
const ASSISTANT_TOOL_INPUT_CAP = 500;

export function resolveContextBuildOptions(
  settings: Pick<
    Partial<LlmSettings>,
    "contextPolicy" | "contextSoftCharBudget" | "contextRecentMessageLimit" | "contextMemoryCharLimit" | "model"
  >
): Required<ContextBuildOptions> {
  const policy = settings.contextPolicy ?? "auto";
  if (policy === "custom") {
    return {
      softCharBudget: clampInt(settings.contextSoftCharBudget, MIN_SOFT_CHAR_BUDGET, MAX_SOFT_CHAR_BUDGET, DEFAULT_RESOLVED_OPTIONS.softCharBudget),
      recentMessageLimit: clampInt(settings.contextRecentMessageLimit, MIN_RECENT_MESSAGE_LIMIT, MAX_RECENT_MESSAGE_LIMIT, DEFAULT_RESOLVED_OPTIONS.recentMessageLimit),
      memoryCharLimit: clampInt(settings.contextMemoryCharLimit, MIN_MEMORY_CHAR_LIMIT, MAX_MEMORY_CHAR_LIMIT, DEFAULT_RESOLVED_OPTIONS.memoryCharLimit),
    };
  }
  if (policy === "auto") return inferContextOptionsFromModel(settings.model);
  return POLICY_OPTIONS[policy] ?? DEFAULT_RESOLVED_OPTIONS;
}

export function buildCurrentUserContent(
  text: string,
  images: ImagePart[]
): UserMessageContent {
  if (images.length === 0) return text;
  const content: Array<TextPart | ImagePart> = [...images];
  if (text) content.push({ type: "text", text });
  return content;
}

export function buildInitialMessagesForNextTurn(
  history: ChatMessage[],
  options: ContextBuildOptions = {}
): ContextBuildResult {
  const recentMessageLimit = options.recentMessageLimit ?? DEFAULT_RESOLVED_OPTIONS.recentMessageLimit;
  const softCharBudget = options.softCharBudget ?? DEFAULT_RESOLVED_OPTIONS.softCharBudget;
  const memoryCharLimit = options.memoryCharLimit ?? DEFAULT_RESOLVED_OPTIONS.memoryCharLimit;

  if (history.length === 0) {
    return { initialMessages: [], compressed: false, compressedMessageCount: 0, estimatedChars: 0 };
  }

  const sanitized = history.map(sanitizeMessageForHistory);
  const estimatedChars = JSON.stringify(sanitized).length;
  if (estimatedChars <= softCharBudget) {
    return {
      initialMessages: sanitized,
      compressed: false,
      compressedMessageCount: 0,
      estimatedChars,
    };
  }

  const recentCount = Math.max(1, Math.min(recentMessageLimit, sanitized.length));
  const old = sanitized.slice(0, -recentCount);
  const recent = sanitized.slice(-recentCount);
  const memory = buildMemoryMessage(old, memoryCharLimit);
  const initialMessages = memory ? [memory, ...recent] : recent;

  return {
    initialMessages,
    compressed: old.length > 0,
    compressedMessageCount: old.length,
    estimatedChars: JSON.stringify(initialMessages).length,
  };
}

function inferContextOptionsFromModel(model: string | undefined): Required<ContextBuildOptions> {
  const m = (model ?? "").toLowerCase();
  if (/(^|[-_])1m($|[-_])|1000k|million|gemini.*2\.5/.test(m)) return POLICY_OPTIONS.huge;
  if (/256k|gpt-5|200k|claude|sonnet|opus/.test(m)) return {
    softCharBudget: 180_000,
    recentMessageLimit: 18,
    memoryCharLimit: 10_000,
  };
  if (/128k|gpt-4o|o3|o4/.test(m)) return {
    softCharBudget: 120_000,
    recentMessageLimit: 14,
    memoryCharLimit: 8_000,
  };
  return DEFAULT_RESOLVED_OPTIONS;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function sanitizeMessageForHistory(message: ChatMessage): ChatMessage {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content.map(sanitizeAssistantPart),
    };
  }

  if (typeof message.content === "string") {
    return { role: "user", content: truncateContent(message.content, PART_TEXT_CAP) };
  }

  return {
    role: "user",
    content: message.content.map((part): TextPart | ToolResultPart => {
      if (part.type === "text") return { ...part, text: truncateContent(part.text, PART_TEXT_CAP) };
      if (part.type === "image") {
        return {
          type: "text",
          text: `[image omitted from prior context: ${part.media_type}, ${part.data.length} base64 chars]`,
        };
      }
      return sanitizeToolResultPart(part, TOOL_RESULT_TEXT_CAP);
    }),
  };
}

function sanitizeAssistantPart(part: TextPart | ToolUsePart): TextPart | ToolUsePart {
  if (part.type === "text") return { ...part, text: truncateContent(part.text, PART_TEXT_CAP) };
  return {
    ...part,
    input: compactJsonValue(part.input, ASSISTANT_TOOL_INPUT_CAP),
  };
}

function sanitizeToolResultPart(part: ToolResultPart, cap: number): ToolResultPart {
  if (typeof part.content === "string") {
    return { ...part, content: truncateContent(part.content, cap) };
  }

  let remaining = cap;
  return {
    ...part,
    content: part.content.map((inner): TextPart => {
      if (inner.type === "image") {
        return {
          type: "text",
          text: `[tool_result image omitted from prior context: ${inner.media_type}, ${inner.data.length} base64 chars]`,
        };
      }
      const text = truncateContent(inner.text, Math.max(0, remaining));
      remaining = Math.max(0, remaining - text.length);
      return { ...inner, text };
    }),
  };
}

function buildMemoryMessage(messages: ChatMessage[], memoryCharLimit: number): ChatMessage | null {
  if (messages.length === 0) return null;
  const lines = messages.map((message, index) => summarizeMessage(message, index + 1));
  const body = truncateContent(lines.join("\n"), memoryCharLimit);
  return {
    role: "user",
    content: [
      "[上下文记忆]",
      "以下是较早对话的压缩摘要。它用于保持同一会话的长期连续性；大段网页内容、历史图片和截图已用引用/占位符替代。",
      body,
    ].join("\n"),
  };
}

function summarizeMessage(message: ChatMessage, index: number): string {
  const prefix = message.role === "assistant" ? `A${index}` : `U${index}`;
  if (typeof message.content === "string") {
    return `${prefix}: ${message.content}`;
  }
  if (message.role === "assistant") {
    return `${prefix}: ${message.content.map(summarizeAssistantPart).filter(Boolean).join(" | ")}`;
  }
  return `${prefix}: ${message.content.map(summarizeUserPart).filter(Boolean).join(" | ")}`;
}

function summarizeAssistantPart(part: TextPart | ToolUsePart): string {
  if (part.type === "text") return part.text;
  return `tool_use ${part.name} input=${truncateJson(part.input, ASSISTANT_TOOL_INPUT_CAP)}`;
}

function summarizeUserPart(part: TextPart | ImagePart | ToolResultPart): string {
  if (part.type === "text") return part.text;
  if (part.type === "image") {
    return `[image omitted from prior context: ${part.media_type}, ${part.data.length} base64 chars]`;
  }
  const content = typeof part.content === "string"
    ? part.content
    : part.content.map((inner) =>
        inner.type === "image"
          ? `[tool_result image omitted from prior context: ${inner.media_type}, ${inner.data.length} base64 chars]`
          : inner.text
      ).join("\n");
  return `tool_result ${part.tool_use_id}: ${content}`;
}

function truncateJson(value: unknown, cap: number): string {
  return truncateContent(JSON.stringify(value), cap);
}

function compactJsonValue(value: Json, cap: number): Json {
  const encoded = JSON.stringify(value);
  if (encoded.length <= cap) return value;
  return { _omitted: truncateContent(encoded, cap) };
}
