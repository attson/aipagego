import type { LlmClient } from "@aipagego/shared/llm";
import type { LlmProvider } from "@aipagego/shared/types";

export type ConnectionErrorCategory =
  | "authentication"
  | "rate_limit"
  | "model"
  | "network"
  | "unknown";

export type ConnectionTestResult =
  | { ok: true }
  | { ok: false; category: ConnectionErrorCategory; message: string };

type ConnectionSettings = {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  endpoint?: string;
};

const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;

function classify(message: string): ConnectionErrorCategory {
  if (/\b(401|403)\b|invalid.{0,12}(api.?key|token)|unauthori[sz]ed|forbidden/i.test(message)) {
    return "authentication";
  }
  if (/\b429\b|rate.?limit|quota|too many requests/i.test(message)) return "rate_limit";
  if (/model.{0,24}(not.?found|invalid|unavailable|does not exist)|\b404\b/i.test(message)) {
    return "model";
  }
  if (/failed to fetch|network|ECONN|ENOTFOUND|timeout|timed out|abort|endpoint/i.test(message)) {
    return "network";
  }
  return "unknown";
}

function userMessage(category: ConnectionErrorCategory): string {
  switch (category) {
    case "authentication":
      return "认证失败：检查 API Key 是否完整、有效，并确认它属于当前 Provider。";
    case "rate_limit":
      return "请求受到限流或配额不足：稍后重试，或检查模型账户配额。";
    case "model":
      return "模型不可用：检查 Model 名称以及当前账号是否有访问权限。";
    case "network":
      return "无法连接模型服务：检查网络、Endpoint 和代理配置。";
    default:
      return "没有收到可用响应：请检查模型配置后重试。";
  }
}

function failed(message: string): ConnectionTestResult {
  const category = classify(message);
  return { ok: false, category, message: userMessage(category) };
}

export async function testLlmConnection(
  settings: ConnectionSettings,
  client: LlmClient,
  timeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS,
): Promise<ConnectionTestResult> {
  if (!settings.apiKey.trim()) return failed("401 missing api key");
  if (!settings.model.trim()) return failed("model invalid");

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    for await (const event of client.stream({
      apiKey: settings.apiKey,
      model: settings.model,
      endpoint: settings.endpoint,
      maxTokens: 16,
      system: "You are testing whether this LLM configuration can answer.",
      messages: [{ role: "user", content: "Reply with OK." }],
      tools: [],
      abortSignal: controller.signal,
    })) {
      if (event.type === "error") return failed(event.error);
      if (event.type === "text_delta" || event.type === "message_end") return { ok: true };
    }
    return failed("empty response");
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    window.clearTimeout(timeout);
  }
}

