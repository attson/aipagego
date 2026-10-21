import type { ChatMessage, Json, LlmSettings, Step } from "@aipagego/shared/types";
import type { LlmClient } from "./types";

export const SUMMARY_SYSTEM_PROMPT = [
  "你是 AIPageGo 的「汇总 step 生成器」。",
  "",
  "任务：基于刚刚一段成功的对话与已执行的 step 序列，写一段 runJS 代码作为",
  "该工具的「汇总最后一步」。重放该工具时，这段代码会作为最后 step 在",
  "MAIN world 跑，它的 return 值就是工具的最终 output。",
  "",
  "要求：",
  "1. 读取页面上下文（window.rawData / DOM / 之前 step 已采到的数据",
  "   通过 ctx[bindResultTo] 取——但只有有 bindResultTo 的步骤才在 ctx",
  "   里）。如果 ctx 为空，从页面 DOM/全局变量重新拉一次最关键字段。",
  "2. 不要重新发请求做大量数据抓取——只做整合。如果重放时数据不在",
  "   window.rawData，应回退到从 ctx 取。",
  "3. return 一个稳定结构的 JSON 对象，字段名见用户对话里 AI 给过的总结",
  "   报告。结构不存在则你自己设计简洁字段。",
  "4. 仅返回纯 JS 函数体（不带 ```js fence）。形如：",
  "     const init = window.rawData?.store?.initDataObj;",
  "     return { title: ..., main_image: ..., reviews: ... };",
  "5. 不调用 fetch / cookie / eval / 扩展 API。仅整合数据。"
].join("\n");

export type GenerateSummaryStepInput = {
  client: LlmClient;
  apiKey: string;
  model: string;
  endpoint?: string;
  maxTokens?: number;
  messages: ChatMessage[];
  executedSteps: Step[];
  lastOutput: Json;
  abortSignal?: AbortSignal;
  onTokenProgress?: (tokens: number) => void;
};

export type GenerateSummaryStepResult = {
  source: string;
  tokens: number;
};

const MAX_SOURCE_BYTES = 32 * 1024;

export function buildUserPrompt(input: {
  messages: ChatMessage[];
  executedSteps: Step[];
  lastOutput: Json;
}): string {
  const lines: string[] = [];

  lines.push("# 已执行的 step 序列与最近一次 outputs（节选）");
  for (let i = 0; i < input.executedSteps.length; i++) {
    const s = input.executedSteps[i];
    if (s.kind === "tool") {
      lines.push(
        `[step ${i}] tool: ${s.tool} args: ${JSON.stringify(s.args).slice(0, 300)}`
      );
    } else {
      const flat = s.source.replace(/\s+/g, " ").trim();
      const head = flat.slice(0, 200);
      lines.push(`[step ${i}] js: ${head}${flat.length > 200 ? "…" : ""}`);
    }
  }
  lines.push("");
  lines.push("# 最末步 output（截断）");
  lines.push(JSON.stringify(input.lastOutput).slice(0, 1500));
  lines.push("");

  const lastAssistant = [...input.messages]
    .reverse()
    .find((m) => m.role === "assistant");
  if (lastAssistant && Array.isArray(lastAssistant.content)) {
    const text = lastAssistant.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .slice(0, 2000);
    if (text.trim()) {
      lines.push("# 对话最后一段 assistant 总结报告");
      lines.push(text);
      lines.push("");
    }
  }

  lines.push("# 请生成汇总 step 的 runJS 源码（仅函数体，不带围栏）：");
  return lines.join("\n");
}

export function extractSource(raw: string): string {
  let s = raw.trim();

  const fence = s.match(/```(?:js|javascript|ts|typescript)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) s = fence[1].trim();

  if (s.length === 0) throw new Error("AI returned empty source");
  if (s.length > MAX_SOURCE_BYTES) {
    throw new Error(`AI source too large (${s.length} > ${MAX_SOURCE_BYTES})`);
  }
  if (!/\breturn\b/.test(s)) {
    throw new Error("AI source has no `return` statement");
  }
  return s;
}

export async function generateSummaryStep(
  input: GenerateSummaryStepInput
): Promise<GenerateSummaryStepResult> {
  const userPrompt = buildUserPrompt({
    messages: input.messages,
    executedSteps: input.executedSteps,
    lastOutput: input.lastOutput
  });

  const stream = input.client.stream({
    apiKey: input.apiKey,
    model: input.model,
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    tools: [],
    maxTokens: input.maxTokens,
    endpoint: input.endpoint,
    abortSignal: input.abortSignal
  });

  let textBuf = "";
  let tokens = 0;

  for await (const ev of stream) {
    if (input.abortSignal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    if (ev.type === "text_delta") {
      textBuf += ev.text;
    } else if (ev.type === "message_end") {
      if (ev.usage) {
        tokens = ev.usage.input_tokens + ev.usage.output_tokens;
        input.onTokenProgress?.(tokens);
      }
    } else if (ev.type === "error") {
      throw new Error(ev.error);
    }
  }

  return { source: extractSource(textBuf), tokens };
}

export type { LlmSettings };
