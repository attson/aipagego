import { pickClient } from "@/sidepanel/llm/client";
import { useSettings } from "@/sidepanel/chat/settings-store";
import { buildSelfHealMessages } from "@/sidepanel/llm/self-heal-prompt";
import type { HealContext } from "@/background/self-heal";

const MSG_TYPE = "selfheal.request";
const RESP_TYPE = "selfheal.response";

type Req = {
  type: typeof MSG_TYPE;
  requestId: string;
  ctx: HealContext;
  maxOutputTokens: number;
};

type Resp =
  | {
      type: typeof RESP_TYPE;
      requestId: string;
      ok: true;
      patchedSteps: unknown;
      usage: { in: number; out: number };
    }
  | {
      type: typeof RESP_TYPE;
      requestId: string;
      ok: false;
      error: string;
    };

export function installSelfHealHost(): () => void {
  const listener = async (msg: unknown) => {
    if ((msg as any)?.type !== MSG_TYPE) return;
    const req = msg as Req;
    const settings = useSettings.getState();
    try {
      if (!settings.selfHealEnabled) throw new Error("self_heal_disabled");
      if (!settings.apiKey) throw new Error("no_api_key");
      const client = pickClient(settings.provider);
      const built = buildSelfHealMessages(
        req.ctx,
        Math.min(req.maxOutputTokens, settings.maxSelfHealOutputTokens)
      );

      // Non-streaming one-shot: drain stream events, collect text
      let text = "";
      let inTok = 0;
      let outTok = 0;
      for await (const ev of client.stream({
        apiKey: settings.apiKey,
        model: settings.model,
        endpoint: (settings as any).endpoint ?? undefined,
        system: built.system,
        messages: [{ role: "user", content: built.user }],
        maxTokens: built.maxTokens,
        tools: []
      })) {
        if ((ev as any).type === "text_delta") text += (ev as any).text;
        if ((ev as any).type === "message_end") {
          inTok = (ev as any).usage?.input_tokens ?? 0;
          outTok = (ev as any).usage?.output_tokens ?? 0;
        }
      }
      let patchedSteps: unknown;
      try {
        patchedSteps = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
      } catch {
        throw new Error("invalid_json");
      }
      const resp: Resp = {
        type: RESP_TYPE,
        requestId: req.requestId,
        ok: true,
        patchedSteps,
        usage: { in: inTok, out: outTok }
      };
      chrome.runtime.sendMessage(resp);
    } catch (e: any) {
      const resp: Resp = {
        type: RESP_TYPE,
        requestId: req.requestId,
        ok: false,
        error: String(e?.message ?? e)
      };
      chrome.runtime.sendMessage(resp);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
