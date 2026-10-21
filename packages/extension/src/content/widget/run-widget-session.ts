/**
 * Widget-side chat session runner.
 *
 * Reuses the same runChatSession / LlmClient pipeline as the sidepanel,
 * but invoked from the content-script / widget context.
 */
import { runChatSession, type SessionEvent } from "@/sidepanel/chat/run-session";
import { pickClient } from "@/sidepanel/llm/client";
import { createRecordingClient } from "@/sidepanel/llm/recording-client";
import { useSettings } from "@/sidepanel/chat/settings-store";
import {
  Approver,
  registerApproverForTab,
  broadcastApprovalDecision,
} from "@/sidepanel/chat/approval";
import {
  useStore,
  addLlmExchange,
  appendAssistantText,
  beginAssistantTurn,
  finalizeAssistantTurn,
  incrementRound,
  upsertCard,
  setCardStatus,
  setStatus,
  setError,
  pushExecutedStep,
  setLastOutput,
} from "@/sidepanel/chat/session-store";
import { rpc } from "@/sidepanel/rpc";
import { RpcToolRunner } from "@/sidepanel/chat/tool-runner";
import { TOOL_DEFS } from "@/sidepanel/llm/tool-schema";
import { buildSystemPrompt } from "@/sidepanel/llm/system-prompt";
import { classifyTool } from "@/sidepanel/chat/severity";
import { handOffToSidepanel } from "./handoff";
import type { Decision } from "@/sidepanel/chat/approval";
import type { ChatMessage, ImagePart, Json, Step, ReplayableTool } from "@aipagego/shared/types";
import {
  buildCurrentUserContent,
  buildInitialMessagesForNextTurn,
  resolveContextBuildOptions,
} from "@/sidepanel/chat/context-manager";

/**
 * Widget-specific approver: intercepts dangerous tools and hands off to
 * the sidepanel before delegating the decision to the user via super.request().
 *
 * Also broadcasts any resolved decision so the sidepanel context (which may
 * have shown a confirm modal) can close out its own awaiting promise — and
 * vice-versa: the installApprovalListener relay in react-root.tsx delivers
 * sidepanel decisions back into this instance's pending map.
 */
class WidgetApprover extends Approver {
  constructor(private readonly tabId: number) {
    super();
  }

  override async request(toolUseId: string): Promise<Decision> {
    // Look up the card to determine severity — card is in "awaiting" state
    // by the time run-session calls approver.request()
    const cards = useStore.getState().sessionsByTab[this.tabId]?.cards ?? [];
    const card = cards.find((c) => c.toolUseId === toolUseId);
    if (card) {
      const sev = classifyTool(card.name, card.input);
      if (sev === "dangerous") {
        await handOffToSidepanel(this.tabId, toolUseId);
      }
    }
    return super.request(toolUseId);
  }

  override resolve(toolUseId: string, decision: Decision): void {
    if (!this.has(toolUseId)) return;
    super.resolve(toolUseId, decision);
    // Relay decision to sidepanel context so it can unblock any parallel waiter
    broadcastApprovalDecision(this.tabId, toolUseId, decision);
  }
}

export async function runFromInput(
  tabId: number,
  text: string,
  inputContext: { images?: ImagePart[]; historyMessages?: ChatMessage[] } = {}
): Promise<void> {
  // Defensive: if bootstrap's load() is still in-flight (widget mounted then
  // user hit Enter within the same frame), await it here.
  if (!useSettings.getState().loaded) {
    await useSettings.getState().load();
  }
  const settings = useSettings.getState();
  if (!settings.apiKey) {
    setError(tabId, "未配置 API Key。请在扩展面板设置。");
    return;
  }

  const sessionState = useStore.getState().sessionsByTab[tabId];
  if (!sessionState) return;

  const url = sessionState.url;
  const permissionMode = sessionState.permissionMode ?? "default";
  const context = buildInitialMessagesForNextTurn(
    inputContext.historyMessages ?? sessionState.messages,
    resolveContextBuildOptions(settings)
  );
  const userContent = buildCurrentUserContent(text, inputContext.images ?? []);

  const client = createRecordingClient(
    pickClient(settings.provider),
    (ex) => addLlmExchange(tabId, ex),
    { provider: settings.provider }
  );

  const runner = new RpcToolRunner(
    (req) =>
      chrome.runtime.sendMessage(req) as Promise<
        { ok: true; data: Json } | { ok: false; error: string }
      >
  );

  const approver = new WidgetApprover(tabId);
  // Register in the module map so that Panel.handleApprove (via getApproverForTab)
  // and the broadcast relay can reach this instance.
  registerApproverForTab(tabId, approver);

  const systemPrompt = buildSystemPrompt({
    url,
    savedTools: [],
    attachedTabs: [],
    lastUserText: text,
  });

  function stepFromCard(id: string): Step {
    const cards = useStore.getState().sessionsByTab[tabId]?.cards ?? [];
    const card = cards.find((c) => c.toolUseId === id);
    if (!card) throw new Error(`card not found: ${id}`);
    if (card.name === "runJS") {
      return { kind: "js", source: (card.input as { source: string }).source };
    }
    return { kind: "tool", tool: card.name as ReplayableTool, args: card.input };
  }

  const onEvent = (e: SessionEvent) => {
    switch (e.type) {
      case "round_start":
        incrementRound(tabId);
        beginAssistantTurn(tabId);
        break;
      case "text_delta":
        appendAssistantText(tabId, e.text);
        break;
      case "tool_use_start":
        upsertCard(tabId, { toolUseId: e.id, name: e.name, status: "draft", inputReady: false });
        break;
      case "tool_use_input_delta": {
        const cards = useStore.getState().sessionsByTab[tabId]?.cards ?? [];
        const fresh = cards.find((c) => c.toolUseId === e.id);
        upsertCard(tabId, {
          toolUseId: e.id,
          partialJson: (fresh?.partialJson ?? "") + e.partial_json,
        });
        break;
      }
      case "tool_use_end":
        upsertCard(tabId, { toolUseId: e.id, input: e.input, inputReady: true, status: "awaiting" });
        setStatus(tabId, "awaiting");
        break;
      case "assistant_turn_end":
        finalizeAssistantTurn(tabId, e.toolUses);
        break;
      case "tool_running":
        setCardStatus(tabId, e.id, { status: "running" });
        setStatus(tabId, "running");
        break;
      case "tool_done":
        setCardStatus(tabId, e.id, { status: "ok", output: e.output, ms: e.ms });
        pushExecutedStep(tabId, stepFromCard(e.id));
        setLastOutput(tabId, e.output);
        setStatus(tabId, "streaming");
        break;
      case "tool_error":
        setCardStatus(tabId, e.id, { status: "error", error: e.error, ms: e.ms });
        setStatus(tabId, "streaming");
        break;
      case "tool_skipped":
        setCardStatus(tabId, e.id, { status: "skipped" });
        break;
      case "usage":
        // Handled by createRecordingClient via the onExchange callback
        break;
      case "continuation_nudge":
        setStatus(tabId, "streaming");
        break;
      case "stream_error":
        setError(tabId, e.error);
        break;
      case "exception":
        setError(tabId, e.error);
        break;
      case "session_end":
        if (e.status === "done") {
          setStatus(tabId, "done");
        } else if (e.status === "max_rounds") {
          setStatus(tabId, "error");
          setError(tabId, "达到最大轮数");
        } else if (e.status === "aborted") {
          setStatus(tabId, "aborted");
        } else {
          setStatus(tabId, "error");
          if (e.reason) setError(tabId, e.reason);
        }
        break;
    }
  };

  await runChatSession({
    client,
    runner,
    approver,
    rpc: {
      startSession: (i) => rpc.startSession(i).then((r) => ({ id: r.id })),
      appendStepLog: (runId, entry) => rpc.appendStepLog(runId, entry),
      finalizeSession: (runId, status, output) => rpc.finalizeSession(runId, status, output),
    },
    initialMessages: context.initialMessages,
    input: { userPrompt: text, userContent, tabId, url },
    settings: { ...settings, trustedDangerTools: settings.trustedDangerTools ?? [] },
    systemPrompt,
    tools: TOOL_DEFS,
    permissionMode,
    onEvent,
    tabsRpc: { listTabs: rpc.listTabs, openTab: rpc.openTab },
  });
}
