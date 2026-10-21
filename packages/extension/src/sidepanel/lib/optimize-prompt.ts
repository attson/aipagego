import type { LlmSettings } from "@aipagego/shared/types";
import { TOOL_DEFS } from "@aipagego/shared/llm";
import { pickClient } from "@/sidepanel/llm/client";

const SYSTEM_PROMPT =
  "你是「浏览器自动化 agent 的提示词教练」。用户会给你一段自然语言草稿，你要改写成更具体、可执行的指令，让下游的 browser-agent 一次就能选对工具、找对信息源。\n\n" +
  "改写原则：\n" +
  "1. 明确目标产物（要什么、什么格式）\n" +
  "2. 说清楚信息在哪里能找到（当前页 / 搜索 / 特定 URL）\n" +
  "3. 必要时点名工具（如 takeSnapshot / clickByUid / httpRequest）\n" +
  "4. 保留用户原语气和语言（中文 / 英文）\n" +
  "5. 不要问回，不要解释，不要加「以下是优化后的：」之类的前缀\n\n" +
  "**只输出改写后的纯文本**。";

type Ctx = {
  draft: string;
  tabId: number;
  settings: LlmSettings;
  signal: AbortSignal;
};

export async function optimizePrompt(ctx: Ctx): Promise<string> {
  const client = pickClient(ctx.settings.provider);
  const model = (ctx.settings.optimizerModel ?? "").trim() || ctx.settings.model;

  const tab = await chrome.tabs.get(ctx.tabId);
  const title = tab.title || "(untitled)";
  const url = tab.url || "(no url)";

  const toolCatalog = TOOL_DEFS.map(
    (t) => `- ${t.name}: ${t.description.split("\n")[0].slice(0, 80)}`
  ).join("\n");

  const userMessage =
    `[当前页] ${title} — ${url}\n` +
    `[可用工具]\n${toolCatalog}\n\n` +
    `[用户草稿]\n${ctx.draft}`;

  let out = "";
  for await (const ev of client.stream({
    apiKey: ctx.settings.apiKey,
    endpoint: ctx.settings.endpoint,
    model,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    tools: [],
    maxTokens: 1024,
    abortSignal: ctx.signal,
  })) {
    if (ev.type === "text_delta") out += ev.text;
    if (ev.type === "error") throw new Error(ev.error);
  }
  const trimmed = out.trim();
  if (!trimmed) throw new Error("optimizer returned empty");
  return trimmed;
}
