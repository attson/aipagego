import { StepSchema } from "@aipagego/shared/messages";
import type { ChatMessage, Json, Step } from "@aipagego/shared/types";
import type { LlmClient } from "./types";

const MAX_NAME = 80;
const MAX_DESCRIPTION = 300;
const MAX_PROMPT = 8 * 1024;
const MAX_SOURCE = 32 * 1024;

export type ToolDraftGenerationInput = {
  client: LlmClient;
  apiKey: string;
  model: string;
  endpoint?: string;
  maxTokens?: number;
  currentUrl: string;
  messages: ChatMessage[];
  executedSteps: Step[];
  lastOutput: Json;
  abortSignal?: AbortSignal;
};

export type GeneratedPromptToolDraft = { name: string; description: string; prompt: string };
export type GeneratedStepsToolDraft = { name: string; description: string; steps: Step[] };

export function parseGeneratedJson(raw: string): unknown {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error(`AI returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function textFromMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (typeof m.content === "string") return `${m.role}: ${m.content}`;
      return `${m.role}: ${m.content
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n")}`;
    })
    .join("\n")
    .slice(0, 6000);
}

function stepsSummary(steps: Step[]): string {
  return steps
    .map((s, i) =>
      s.kind === "tool"
        ? `[${i}] tool ${s.tool} ${JSON.stringify(s.args).slice(0, 300)}`
        : `[${i}] js ${s.source.replace(/\s+/g, " ").slice(0, 300)}`
    )
    .join("\n");
}

function buildUserPrompt(input: ToolDraftGenerationInput, mode: "prompt" | "steps"): string {
  return [
    `# 当前 URL\n${input.currentUrl}`,
    `# 目标类型\n${mode === "prompt" ? "提示词工具" : "纯函数/固定步骤工具"}`,
    `# 多轮对话摘要\n${textFromMessages(input.messages)}`,
    `# 已执行步骤\n${stepsSummary(input.executedSteps)}`,
    `# 最后输出节选\n${JSON.stringify(input.lastOutput).slice(0, 2000)}`,
    "# 要求\n总结任务意图，不要机械复刻对话。只返回 JSON。"
  ].join("\n\n");
}

async function callJson(
  input: ToolDraftGenerationInput,
  system: string,
  mode: "prompt" | "steps"
): Promise<unknown> {
  const stream = input.client.stream({
    apiKey: input.apiKey,
    model: input.model,
    endpoint: input.endpoint,
    maxTokens: input.maxTokens,
    system,
    messages: [{ role: "user", content: buildUserPrompt(input, mode) }],
    tools: [],
    abortSignal: input.abortSignal
  });
  let text = "";
  for await (const ev of stream) {
    if (input.abortSignal?.aborted) throw new DOMException("aborted", "AbortError");
    if (ev.type === "text_delta") text += ev.text;
    if (ev.type === "error") throw new Error(ev.error);
  }
  return parseGeneratedJson(text);
}

function requireString(obj: Record<string, unknown>, key: string, max: number): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`AI JSON field ${key} must be a non-empty string`);
  }
  const s = v.trim();
  if (s.length > max) throw new Error(`AI JSON field ${key} is too long (${s.length} > ${max})`);
  return s;
}

function rejectSensitive(text: string): void {
  if (/\bBearer\s+[A-Za-z0-9._-]+/i.test(text) || /sk-[A-Za-z0-9_-]{12,}/.test(text) || /cookie\s*[:=]/i.test(text)) {
    throw new Error("AI prompt contains sensitive-looking content");
  }
}

export async function generatePromptToolDraft(
  input: ToolDraftGenerationInput
): Promise<GeneratedPromptToolDraft> {
  const raw = await callJson(
    input,
    [
      "你是 AIPageGo 的提示词工具生成器。",
      '输出 JSON: {"name": string, "description": string, "prompt": string}。',
      "prompt 面向未来运行，要求 AI 基于当前页面执行任务，不引用旧对话。",
      "不要包含 API key、cookie、账号密码或 token。"
    ].join("\n"),
    "prompt"
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("AI JSON must be an object");
  const obj = raw as Record<string, unknown>;
  const draft = {
    name: requireString(obj, "name", MAX_NAME),
    description: requireString(obj, "description", MAX_DESCRIPTION),
    prompt: requireString(obj, "prompt", MAX_PROMPT)
  };
  rejectSensitive(draft.prompt);
  return draft;
}

export async function generateStepsToolDraft(
  input: ToolDraftGenerationInput
): Promise<GeneratedStepsToolDraft> {
  const raw = await callJson(
    input,
    [
      "你是 AIPageGo 的纯函数/固定步骤工具生成器。",
      '输出 JSON: {"name": string, "description": string, "steps": Step[]}。',
      "优先生成单个 runJS 函数体；需要滚动、等待、点击时可以生成多 step。",
      "runJS 不调用 LLM、扩展 API，不输出敏感凭证。"
    ].join("\n"),
    "steps"
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("AI JSON must be an object");
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new Error("AI JSON steps must be a non-empty array");
  }
  const steps = obj.steps.map((s, i) => {
    const parsed = StepSchema.safeParse(s);
    if (!parsed.success) throw new Error(`AI step ${i} is invalid: ${parsed.error.message}`);
    if (parsed.data.kind === "js" && parsed.data.source.length > MAX_SOURCE) {
      throw new Error(`AI step ${i} source is too long`);
    }
    return parsed.data as Step;
  });
  return {
    name: requireString(obj, "name", MAX_NAME),
    description: requireString(obj, "description", MAX_DESCRIPTION),
    steps
  };
}
