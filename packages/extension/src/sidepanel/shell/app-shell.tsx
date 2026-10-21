import { useCallback, useEffect, useMemo, useState } from "react";
import type { ImagePart, Json, ReplayableTool, Step, Tool, AttachedTab } from "@aipagego/shared/types";
import type { Preset } from "@aipagego/shared/preset";

import {
  getGlobalApprover,
  installApprovalListener,
  broadcastApprovalDecision,
  type Decision,
} from "@/sidepanel/chat/approval";
import { runChatSession, type SessionEvent } from "@/sidepanel/chat/run-session";
import {
  addLlmExchange,
  appendHealNote,
  appendUserMessageWithImages,
  attachTab,
  detachTab,
  ensureSession,
  getSessionActions,
  getSessionFor,
  installBroadcastSubscriber,
  popLastAssistantTurn,
  setCurrentTab,
  setPermissionMode,
  setChatMode,
  setDebugBadge,
  showSave,
  useCurrentTabId,
  useSession,
  useStore,
} from "@/sidepanel/chat/session-store";
import { getActiveByTabId } from "@/sidepanel/chat/persistence/sessions-storage";
import { handleTabEvent } from "@/sidepanel/chat/cross-tab-events";
import { useSettings, installSettingsSyncListener } from "@/sidepanel/chat/settings-store";
import { useUi } from "@/sidepanel/chat/ui-store";
import { RpcToolRunner } from "@/sidepanel/chat/tool-runner";
import { TOOL_DEFS } from "@/sidepanel/llm/tool-schema";
import { pickClient } from "@/sidepanel/llm/client";
import { createRecordingClient } from "@/sidepanel/llm/recording-client";
import { buildSystemPrompt } from "@/sidepanel/llm/system-prompt";
import { captureVisualEvidence } from "@/sidepanel/llm/visual-evidence";

import { Header } from "./header";
import { TabIdentityBar } from "./tab-identity-bar";
import { UpdateBanner } from "./update-banner";
import { ChatView } from "@/sidepanel/components/chat-view";
import { EmptySuggestions, type SuggestedTool } from "@/sidepanel/chat/empty-suggestions";
import { QuickActions } from "@/sidepanel/chat/quick-actions";
import { SaveAsToolCard } from "@/sidepanel/chat/save-as-tool-card";
import { SystemBubble } from "@/sidepanel/chat/system-bubble";
import { InputToolbar } from "@/sidepanel/input/input-toolbar";
import type {
  MentionTabOption,
  MentionToolOption,
  MentionBookmarkOption,
} from "@/sidepanel/input/mention-picker";
import { matchesAny } from "@aipagego/shared/url-pattern";
import { loadBookmarks } from "@/sidepanel/lib/bookmarks";
import { fileToImagePart, MAX_IMAGES_PER_TURN } from "@/sidepanel/lib/image-utils";
import { buildMetaTools } from "@/sidepanel/lib/meta-tools";
import {
  buildCurrentUserContent,
  buildInitialMessagesForNextTurn,
  resolveContextBuildOptions,
} from "@/sidepanel/chat/context-manager";

import { HistoryDrawer } from "@/sidepanel/drawers/history-drawer";
import { ToolsDrawer } from "@/sidepanel/drawers/tools-drawer";
import { SettingsDrawer } from "@/sidepanel/drawers/settings-drawer";
import { DebugDrawer } from "@/sidepanel/drawers/debug-drawer";
import { ScenariosDrawer } from "@/sidepanel/drawers/scenarios-drawer";
import { SaveAsToolDialog } from "@/sidepanel/components/save-as-tool-dialog";
import { TabPicker } from "@/sidepanel/components/tab-picker";
import { InterventionOverlay } from "@/sidepanel/components/intervention-overlay";
import {
  useIntervention,
  type AskUserKind,
  type AskUserOption,
  type AskUserResult,
} from "@/sidepanel/chat/intervention-store";

import { currentTabInfo, onTabEvents, onTabRecommendations, rpc } from "@/sidepanel/rpc";
import { usePendingPrompt } from "@/sidepanel/hooks/use-pending-prompt";
import { useExternalReplay } from "@/sidepanel/hooks/use-external-replay";
import { ExternalReplayModal } from "@/sidepanel/components/external-replay-modal";
import { useHeartbeat } from "@/sidepanel/chat/heartbeat";
import { installSelfHealHost } from "@/sidepanel/self-heal-host";
import { buildPromptWithSelectedElements } from "@/sidepanel/input/selected-elements";

function toSuggested(tools: Tool[]): SuggestedTool[] {
  return tools.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description ?? undefined,
    runCount: t.stats.runs,
  }));
}

function toMentionOptions(tabs: { tabId: number; title: string; url: string }[]): MentionTabOption[] {
  return tabs.map((t) => ({ tabId: t.tabId, title: t.title, url: t.url }));
}

export function AppShell() {
  const session = useSession();
  const settings = useSettings();
  const currentTabId = useCurrentTabId();
  const ui = useUi();

  const [input, setInput] = useState(session.inputDraft ?? "");
  const [recommendations, setRecommendations] = useState<Tool[]>([]);
  const [recommendedPresets, setRecommendedPresets] = useState<Preset[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickableTabs, setPickableTabs] = useState<MentionTabOption[]>([]);
  const [allTools, setAllTools] = useState<Tool[]>([]);
  const [bookmarks, setBookmarks] = useState<MentionBookmarkOption[]>([]);
  const [stagedImages, setStagedImages] = useState<ImagePart[]>([]);
  const [stagedSelectors, setStagedSelectors] = useState<string[]>([]);
  const [recoverableUrl, setRecoverableUrl] = useState<string | null>(null);
  const approver = getGlobalApprover();

  useHeartbeat();
  const externalReplay = useExternalReplay();

  // Self-heal host: listen for BG heal requests and run LLM in sidepanel context
  useEffect(() => {
    const dispose = installSelfHealHost();
    return dispose;
  }, []);

  // Broadcast subscriber: receive session.state.changed from widget and apply if newer
  useEffect(() => {
    const dispose = installBroadcastSubscriber();
    return dispose;
  }, []);

  // Cross-process approval relay: decisions resolved by the widget are
  // forwarded into the sidepanel's local approversByTab map so that
  // getGlobalApprover / getApproverForTab can unblock the awaiting promise.
  useEffect(() => {
    return installApprovalListener();
  }, []);

  // Auto-refresh LlmSettings when widget (or another sidepanel instance)
  // updates chrome.storage.local — keeps every context in lock-step.
  useEffect(() => {
    return installSettingsSyncListener();
  }, []);

  // Pending approval focus: when sidepanel opens after dangerous-tool handoff,
  // scroll to and briefly highlight the awaiting step card.
  useEffect(() => {
    const KEY = "aipagego.pendingApproval";
    void chrome.storage.session.get([KEY]).then(async (res) => {
      const p = (res as Record<string, unknown>)[KEY] as
        | { tabId: number; approvalId: string; ts: number }
        | undefined;
      if (!p) return;
      if (Date.now() - p.ts > 30_000) {
        await chrome.storage.session.remove([KEY]);
        return;
      }
      await chrome.storage.session.remove([KEY]);
      const el = document.querySelector(`[data-approval-id="${p.approvalId}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      (el as HTMLElement | null)?.classList?.add("ring-2", "ring-amber-400");
      setTimeout(
        () => (el as HTMLElement | null)?.classList?.remove("ring-2", "ring-amber-400"),
        2000
      );
    });
  }, []);

  // Widget 通过 widget.openSidepanelWithSave 唤起本面板时,BG 会在 chrome.storage.session
  // 存 aipagego.pendingSave;这里读到就调 showSave(tabId) 弹保存对话框。
  useEffect(() => {
    const KEY = "aipagego.pendingSave";
    void chrome.storage.session.get([KEY]).then(async (res) => {
      const p = (res as any)[KEY] as { tabId: number; ts: number } | undefined;
      if (!p) return;
      if (Date.now() - p.ts > 30_000) {
        await chrome.storage.session.remove([KEY]);
        return;
      }
      showSave(p.tabId);
      await chrome.storage.session.remove([KEY]);
    });
  }, []);

  // Self-heal event listener: surface heal status as inline system notes in the chat thread
  useEffect(() => {
    function onHealEvent(msg: unknown) {
      if (!msg || typeof msg !== "object") return;
      const m = msg as { type?: string; event?: Record<string, unknown> };
      if (m.type !== "session.event" || !m.event) return;
      const ev = m.event;
      const tabId = useStore.getState().currentTabId;
      if (tabId == null) return;
      if (ev.type === "self_heal_started") {
        appendHealNote(
          tabId,
          `正在自动修复失败步骤 (step ${ev.failedStepIndex})…`
        );
      } else if (ev.type === "self_heal_completed") {
        appendHealNote(
          tabId,
          `已自愈，升级到 v${ev.newVersion} (fixedStep=${ev.fixedStepIndex})`
        );
      } else if (ev.type === "self_heal_failed") {
        appendHealNote(
          tabId,
          `自愈失败: ${ev.reason ?? "unknown"}`
        );
      }
    }
    chrome.runtime.onMessage.addListener(onHealEvent);
    return () => chrome.runtime.onMessage.removeListener(onHealEvent);
  }, []);

  // Element-capture result handler: content script → runtime msg → sidepanel inserts selector
  useEffect(() => {
    function onMsg(msg: unknown) {
      if (!msg || typeof msg !== "object") return;
      const m = msg as { type?: string; selector?: string };
      if (m.type === "aipagego.captureResult" && typeof m.selector === "string") {
        const selector = m.selector;
        setStagedSelectors((prev) =>
          prev.includes(selector) ? prev : [...prev, selector]
        );
      }
    }
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, [session]);

  usePendingPrompt({
    onFill: (t) => {
      setInput(t);
      session.setInputDraft(t);
    },
    onAutoSend: (t) => {
      setInput(t);
      session.setInputDraft(t);
      void send(t);
    },
  });

  // Sync input when tab changes
  useEffect(() => {
    setInput(session.inputDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTabId]);

  // Load settings + initial recommendations
  useEffect(() => {
    if (!settings.loaded) void settings.load();
  }, [settings]);

  useEffect(() => {
    let active = true;
    (async () => {
      const { tabId, url } = await currentTabInfo();
      if (!active) return;
      const tools = await rpc.matchingTools(url);
      if (!active) return;
      setRecommendations(tools);
      ensureSession(tabId, url);
      setCurrentTab(tabId);
    })();
    const off = onTabRecommendations((m) => {
      currentTabInfo()
        .then((info) => {
          if (info.tabId === m.tabId) {
            setRecommendations(m.tools);
            setRecommendedPresets(m.presets ?? []);
          }
        })
        .catch(() => {});
    });
    const offEvents = onTabEvents(handleTabEvent);
    return () => {
      active = false;
      off();
      offEvents();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Permission mode: when session is fresh and settings load, seed it from defaultPermissionMode.
  useEffect(() => {
    if (!settings.loaded || currentTabId == null) return;
    if (session.messages.length === 0 && session.cards.length === 0) {
      // Idempotent — sets to the default mode the user picked in settings.
      if (session.permissionMode !== settings.defaultPermissionMode) {
        setPermissionMode(currentTabId, settings.defaultPermissionMode);
      }
    }
  }, [settings.loaded, settings.defaultPermissionMode, currentTabId, session]);

  // 新会话（无 message、无 card）时，chatMode 跟随 settings.defaultChatMode
  useEffect(() => {
    if (!settings.loaded || currentTabId == null) return;
    if (session.messages.length === 0 && session.cards.length === 0) {
      const target: "compact" | "full" = settings.defaultChatMode ?? "compact";
      if (session.chatMode !== target) {
        setChatMode(currentTabId, target);
      }
    }
  }, [settings.loaded, settings.defaultChatMode, currentTabId, session]);

  // Debug badge derivation: error in current session → red dot.
  useEffect(() => {
    if (currentTabId == null) return;
    if (session.errorMessage) {
      setDebugBadge(currentTabId, { kind: "error", count: 1 });
    }
  }, [session.errorMessage, currentTabId]);

  // Pickable tabs for the mention picker
  useEffect(() => {
    if (currentTabId == null) return;
    rpc
      .listTabs()
      .then((result) => {
        const filtered = result.tabs.filter(
          (t) =>
            t.tabId !== currentTabId &&
            !session.attachedTabs.some((a) => a.tabId === t.tabId)
        );
        setPickableTabs(toMentionOptions(filtered));
      })
      .catch(() => setPickableTabs([]));
  }, [currentTabId, session.attachedTabs]);

  // All tools for the @ picker — refresh when the drawer might have changed them.
  useEffect(() => {
    rpc.listTools().then(setAllTools).catch(() => setAllTools([]));
  }, [ui.openedDrawer]);

  // Bookmarks for the @ picker — refresh once on mount; could be hot-reloaded later.
  useEffect(() => {
    void loadBookmarks().then(setBookmarks);
  }, []);

  const pickableTools: MentionToolOption[] = useMemo(() => {
    return allTools.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description ?? undefined,
      matchesCurrentUrl: matchesAny(session.url, t.urlPatterns),
    }));
  }, [allTools, session.url]);

  // Recoverable session for current URL
  useEffect(() => {
    if (currentTabId == null) return;
    if (session.messages.length > 0) {
      setRecoverableUrl(null);
      return;
    }
    let active = true;
    void (async () => {
      const { url } = await currentTabInfo();
      const cur = await getActiveByTabId(currentTabId);
      if (!active) return;
      setRecoverableUrl(cur ? null : url);
    })();
    return () => {
      active = false;
    };
  }, [currentTabId, session.messages.length]);

  const handleApprove = useCallback(
    (
      id: string,
      decision: "run" | "run-and-always-allow" | "skip" | "deny",
      toolName?: string
    ) => {
      const resolvedDecision: Decision =
        decision === "run-and-always-allow" && toolName
          ? { kind: "run-and-always-allow", toolName }
          : ({ kind: decision } as Decision);

      if (decision === "run-and-always-allow" && toolName) {
        void settings.save({
          trustedDangerTools: Array.from(
            new Set([...(settings.trustedDangerTools ?? []), toolName])
          ),
        });
        approver.resolve(id, resolvedDecision);
        session.setCardStatus(id, { status: "running" });
      } else {
        approver.resolve(id, resolvedDecision);
        session.setCardStatus(id, {
          status: decision === "run" ? "running" : decision === "skip" ? "skipped" : "denied",
        });
      }

      // Broadcast so widget context (which holds the real pending promise when
      // a dangerous tool was handed off from widget to sidepanel) can unblock.
      if (currentTabId != null) {
        broadcastApprovalDecision(currentTabId, id, resolvedDecision);
      }
    },
    [session, approver, settings, currentTabId]
  );

  const send = useCallback(
    async (prompt: string) => {
      if (!prompt.trim() && stagedImages.length === 0) return;
      if (!settings.apiKey) {
        session.setError("请先在设置 → LLM 填入 API Key");
        return;
      }
      const { tabId, url } = await currentTabInfo();
      ensureSession(tabId, url);
      const session0 = getSessionFor(tabId);
      const runSession = getSessionActions(tabId);
      const attachedTabs = session0.attachedTabs;
      const contextOptions = resolveContextBuildOptions(settings);
      const context = buildInitialMessagesForNextTurn(session0.messages, contextOptions);
      const getAttachedTabIds = () =>
        useStore.getState().sessionsByTab[tabId]?.attachedTabs.map((a) => a.tabId) ?? [];
      runSession.setIdentity({ tabId, url, runRecordId: "" });
      runSession.setError(null);
      runSession.setDebugBadge(null);
      runSession.setStatus("streaming");
      const imgsToSend = stagedImages;
      const selectorsToSend = stagedSelectors;
      const promptForLlm = buildPromptWithSelectedElements(prompt, selectorsToSend);
      const userContentForLlm = buildCurrentUserContent(promptForLlm, imgsToSend);
      if (imgsToSend.length > 0) {
        appendUserMessageWithImages(tabId, prompt, imgsToSend);
        setStagedImages([]);
      } else {
        runSession.appendUserMessage(prompt);
      }
      if (selectorsToSend.length > 0) setStagedSelectors([]);
      if (context.compressed) {
        runSession.appendLog(
          "info",
          "[上下文] 已压缩早期对话",
          `policy=${settings.contextPolicy ?? "auto"} compressedMessages=${context.compressedMessageCount} estimatedChars=${context.estimatedChars} softCharBudget=${contextOptions.softCharBudget}`
        );
      }
      runSession.appendLog(
        "info",
        "提交 prompt",
        `provider=${settings.provider} model=${settings.model} endpoint=${settings.endpoint || "(默认)"} maxRounds=${settings.maxRounds}\n---\n${promptForLlm}`
      );
      runSession.setInputDraft("");
      setInput("");
      const ac = new AbortController();
      runSession.setAbortController(ac);
      const client = createRecordingClient(
        pickClient(settings.provider),
        (ex) => addLlmExchange(tabId, ex),
        { provider: settings.provider }
      );
      const runner = new RpcToolRunner((req) =>
        chrome.runtime.sendMessage(req) as Promise<{ ok: true; data: Json } | { ok: false; error: string }>
      );

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
        const log = runSession.appendLog;
        switch (e.type) {
          case "round_start":
            runSession.incrementRound();
            runSession.beginAssistantTurn();
            log("info", `round ${e.round + 1} 开始`);
            break;
          case "text_delta":
            runSession.appendAssistantText(e.text);
            break;
          case "tool_use_start":
            runSession.upsertCard({ toolUseId: e.id, name: e.name, status: "draft", inputReady: false });
            log("info", `tool_use_start: ${e.name} (${e.id})`);
            break;
          case "tool_use_input_delta": {
            const cards = useStore.getState().sessionsByTab[tabId]?.cards ?? [];
            const fresh = cards.find((c) => c.toolUseId === e.id);
            runSession.upsertCard({
              toolUseId: e.id,
              partialJson: (fresh?.partialJson ?? "") + e.partial_json,
            });
            break;
          }
          case "tool_use_end":
            runSession.upsertCard({ toolUseId: e.id, input: e.input, inputReady: true, status: "awaiting" });
            runSession.setStatus("awaiting");
            log("info", `tool_use_end: ${e.id}`, JSON.stringify(e.input, null, 2));
            break;
          case "assistant_turn_end":
            runSession.finalizeAssistantTurn(e.toolUses);
            break;
          case "tool_running":
            runSession.setCardStatus(e.id, { status: "running" });
            runSession.setStatus("running");
            log("info", `step running: ${e.id}`);
            break;
          case "tool_done":
            runSession.setCardStatus(e.id, { status: "ok", output: e.output, ms: e.ms });
            runSession.pushExecutedStep(stepFromCard(e.id));
            runSession.setLastOutput(e.output);
            runSession.setStatus("streaming");
            log("info", `step ok: ${e.id} (${e.ms}ms)`);
            break;
          case "tool_error":
            runSession.setCardStatus(e.id, { status: "error", error: e.error, ms: e.ms });
            runSession.setStatus("streaming");
            log("error", `step error: ${e.id}`, e.error);
            break;
          case "tool_skipped":
            runSession.setCardStatus(e.id, { status: "skipped" });
            log("warn", `step skipped: ${e.id}`);
            break;
          case "usage":
            runSession.addUsage({ input_tokens: e.input_tokens, output_tokens: e.output_tokens });
            break;
          case "continuation_nudge":
            log(
              "warn",
              `第 ${e.round + 1} 轮未调用工具，疑似提前收尾，已追问让其确认/继续（第 ${e.attempt} 次）`
            );
            runSession.setStatus("streaming");
            break;
          case "stream_error":
            log("error", "LLM stream error", e.error);
            runSession.setError(e.error);
            break;
          case "exception":
            log("error", "exception in run-session", e.error);
            runSession.setError(e.error);
            break;
          case "session_end":
            log(
              e.status === "done" ? "info" : "warn",
              `session_end: ${e.status}${e.reason ? " — " + e.reason : ""}`
            );
            if (e.status === "done") {
              runSession.setStatus("done");
            } else if (e.status === "max_rounds") {
              runSession.setStatus("error");
              runSession.setError("达到最大轮数");
            } else if (e.status === "aborted") {
              runSession.setStatus("aborted");
            } else {
              runSession.setStatus("error");
              if (e.reason) runSession.setError(e.reason);
            }
            break;
        }
      };

      try {
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
          input: { userPrompt: promptForLlm, userContent: userContentForLlm, tabId, url },
          settings: { ...settings, trustedDangerTools: settings.trustedDangerTools ?? [] },
          systemPrompt: buildSystemPrompt({
            url,
            savedTools: recommendations.map((t) => ({
              name: t.name,
              description: t.description ?? "",
              version: t.versions.at(-1)?.version ?? 1,
            })),
            attachedTabs,
            lastUserText: prompt,
          }),
          tools: TOOL_DEFS,
          permissionMode: session0.permissionMode,
          askUser: async (raw) => {
            const inp = (raw as { prompt?: string; kind?: AskUserKind; options?: AskUserOption[] }) ?? {};
            const result: AskUserResult = await useIntervention.getState().ask({
              id: `ask-${Date.now()}`,
              prompt: inp.prompt ?? "",
              kind: (inp.kind ?? "confirm") as AskUserKind,
              options: inp.options,
            });
            return result as unknown as Json;
          },
          metaTools: buildMetaTools({
            attachedTabIds: getAttachedTabIds,
            mainTabId: tabId,
          }),
          screenshot: async (raw) => {
            return captureVisualEvidence({
              raw,
              defaultTabId: tabId,
              getTab: (targetTabId) => chrome.tabs.get(targetTabId),
              captureVisibleTab: (windowId) => chrome.tabs.captureVisibleTab(windowId, { format: "png" }),
              runStep: rpc.runOneStep,
            });
          },
          abortSignal: ac.signal,
          onEvent,
          getAttachedTabIds,
          tabsRpc: { listTabs: rpc.listTabs, openTab: rpc.openTab },
          onCrossTabResult: (r) => {
            if (r.kind === "opened") {
              attachTab(tabId, {
                tabId: r.tabId,
                windowId: r.windowId ?? -1,
                source: "ai-open",
                lastSeenUrl: r.url ?? "",
                lastSeenTitle: r.title ?? "",
              });
            } else if (r.kind === "attached") {
              chrome.tabs
                .get(r.tabId)
                .then((t) =>
                  attachTab(tabId, {
                    tabId: r.tabId,
                    windowId: t.windowId,
                    source: "approval",
                    lastSeenUrl: t.url ?? "",
                    lastSeenTitle: t.title ?? "",
                  })
                )
                .catch(() => {});
            } else if (r.kind === "detached") {
              detachTab(tabId, r.tabId);
            }
          },
        });
      } catch (e) {
        runSession.setError(e instanceof Error ? e.message : String(e));
        runSession.setStatus("error");
      } finally {
        approver.resolveAllPending({ kind: "deny" });
        runSession.setAbortController(null);
      }
    },
    [session, settings, recommendations, approver, stagedImages, stagedSelectors]
  );

  async function onImageFiles(files: File[]) {
    for (const f of files) {
      if (stagedImages.length >= MAX_IMAGES_PER_TURN) {
        session.setError(`一次最多 ${MAX_IMAGES_PER_TURN} 张图片`);
        return;
      }
      try {
        const part = await fileToImagePart(f);
        setStagedImages((prev) => [...prev, part]);
      } catch (e) {
        session.setError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  function onRemoveImage(idx: number) {
    setStagedImages((prev) => prev.filter((_, i) => i !== idx));
  }

  function onRemoveSelector(idx: number) {
    setStagedSelectors((prev) => prev.filter((_, i) => i !== idx));
  }

  async function onNewChat() {
    const tabId = useStore.getState().currentTabId;
    if (tabId == null) return;
    const { newChatForTab } = await import("@/sidepanel/chat/new-chat");
    await newChatForTab(tabId);
    setInput("");
  }

  // Header onOpenTool: jump to Tools drawer with detail
  function openToolDetail(toolId: string) {
    ui.open("tools", toolId);
  }

  // For empty-state suggestions
  const emptyState = session.messages.length === 0 && session.cards.length === 0;
  const hasSteps = session.executedSteps.length > 0;
  const isIdle = session.status === "idle" || session.status === "done" || session.status === "aborted";

  const inputStatus =
    session.status === "streaming" || session.status === "awaiting" || session.status === "running"
      ? "streaming"
      : session.errorMessage
        ? "error"
        : "idle";

  return (
    <div className="h-full flex flex-col relative bg-zinc-950">
      <Header
        debugBadge={session.debugBadge}
        onNewChat={onNewChat}
        chatMode={session.chatMode}
        onToggleChatMode={() => {
          if (currentTabId != null) {
            setChatMode(currentTabId, session.chatMode === "compact" ? "full" : "compact");
          }
        }}
      />
      <UpdateBanner />
      {currentTabId != null && (
        <TabIdentityBar
          tabId={currentTabId}
          url={session.url}
          status={session.status}
          recoverable={!!recoverableUrl}
          onRecover={() => ui.open("history")}
        />
      )}

      <div className="flex-1 overflow-y-auto flex flex-col gap-3 px-3 py-3">
        {emptyState ? (
          <div className="m-auto max-w-[280px]">
            <QuickActions currentUrl={session.url || undefined} onPick={(prompt) => void send(prompt)} />
            <EmptySuggestions
              matchedTools={toSuggested(recommendations)}
              onRun={(id) => ui.open("tools", id)}
              onDetail={openToolDetail}
              presets={recommendedPresets}
              onPresetPick={async (preset) => {
                if (preset.kind === "tool") {
                  try {
                    const tool = await rpc.materializePreset(preset.id);
                    ui.open("tools", tool.id);
                  } catch {
                    // best-effort; silently ignore if materialize fails
                  }
                } else {
                  // prompt preset: fill input and let user send
                  setInput(preset.prompt);
                  session.setInputDraft(preset.prompt);
                }
              }}
            />
          </div>
        ) : (
          <>
            <ChatView
              onApprove={handleApprove}
              onRegenerate={() => {
                if (currentTabId == null) return;
                const last = popLastAssistantTurn(currentTabId);
                if (last) void send(last);
              }}
            />
            {session.errorMessage && (
              <SystemBubble kind="error" onClick={() => ui.open("debug")}>
                {session.errorMessage}
              </SystemBubble>
            )}
            {hasSteps && isIdle && !session.showSaveDialog && (
              <SaveAsToolCard
                stepCount={session.executedSteps.length}
                onSave={() => session.showSave()}
              />
            )}
          </>
        )}
      </div>

      <InputToolbar
        value={input}
        onChange={(v) => {
          setInput(v);
          session.setInputDraft(v);
        }}
        onSubmit={send}
        onStop={() => session.abortController?.abort()}
        currentTabUrl={session.url}
        attachedTabs={session.attachedTabs}
        pickableTabs={pickableTabs}
        pickableTools={pickableTools}
        pickableBookmarks={bookmarks}
        onMentionTool={(opt: MentionToolOption) => {
          const insertion = `@tool:${opt.name} `;
          const next = (input.endsWith("@") ? input.slice(0, -1) : input) + insertion;
          setInput(next);
          session.setInputDraft(next);
        }}
        onMentionBookmark={(opt: MentionBookmarkOption) => {
          const insertion = `@bookmark:${opt.title} (${opt.url}) `;
          const next = (input.endsWith("@") ? input.slice(0, -1) : input) + insertion;
          setInput(next);
          session.setInputDraft(next);
        }}
        onAttachTab={(opt: MentionTabOption) => {
          if (currentTabId == null) return;
          attachTab(currentTabId, {
            tabId: opt.tabId,
            windowId: -1,
            source: "mention",
            lastSeenUrl: opt.url,
            lastSeenTitle: opt.title,
          });
        }}
        onDetachTab={(tabId: number) => {
          if (currentTabId == null) return;
          detachTab(currentTabId, tabId);
        }}
        onOpenTabPicker={() => setPickerOpen(true)}
        permissionMode={session.permissionMode}
        onPermissionChange={(m) => {
          if (currentTabId != null) setPermissionMode(currentTabId, m);
        }}
        trustedDangerTools={settings.trustedDangerTools ?? []}
        onTrustedChange={(next) => void settings.save({ trustedDangerTools: next })}
        settings={settings}
        currentTabId={currentTabId}
        status={inputStatus}
        roundCount={session.roundCount}
        maxRounds={settings.maxRounds}
        tokensIn={session.tokenUsage.input}
        tokensOut={session.tokenUsage.output}
        stagedImages={stagedImages}
        stagedSelectors={stagedSelectors}
        onImageFiles={onImageFiles}
        onRemoveImage={onRemoveImage}
        onRemoveSelector={onRemoveSelector}
        onStartCapture={async () => {
          if (currentTabId == null) return;
          try {
            await rpc.startElementCapture(currentTabId);
          } catch (e) {
            session.setError(`无法在当前 tab 启动元素选择：${e instanceof Error ? e.message : String(e)}`);
          }
        }}
      />

      <HistoryDrawer currentUrl={session.url} />
      <ToolsDrawer />
      <SettingsDrawer />
      <DebugDrawer />
      <ScenariosDrawer />

      <InterventionOverlay />

      {externalReplay.replay && (
        <ExternalReplayModal
          replay={externalReplay.replay}
          onAccept={(r) => {
            externalReplay.clear();
            setInput(r.prompt);
            session.setInputDraft(r.prompt);
          }}
          onReject={externalReplay.clear}
        />
      )}

      {pickerOpen && currentTabId != null && (
        <TabPicker
          listTabs={(wid) => rpc.listTabs(wid)}
          attachedIds={session.attachedTabs.map((a) => a.tabId)}
          currentTabId={currentTabId}
          onSelect={(t: { tabId: number; windowId: number; url: string; title: string }) => {
            attachTab(currentTabId, {
              tabId: t.tabId,
              windowId: t.windowId,
              source: "mention",
              lastSeenUrl: t.url,
              lastSeenTitle: t.title,
            } satisfies Omit<AttachedTab, "addedAt" | "urlChanged">);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {session.showSaveDialog && currentTabId != null && (
        <SaveAsToolDialog
          tabId={currentTabId}
          initialName={
            recommendations[0]?.name ?? `AIPageGo 任务 ${new Date().toISOString().slice(0, 10)}`
          }
          initialDescription={
            (session.messages.find(
              (m): m is Extract<typeof m, { role: "user" }> & { content: string } =>
                m.role === "user" && typeof m.content === "string"
            )?.content ?? "")
              .replace(/^\[已恢复\][^\n]*\n?/, "")
              .replace(/^\[页面跳转\][^\n]*\n?/, "")
              .slice(0, 80)
          }
          initialUrl={session.url}
          steps={session.executedSteps}
          lastOutput={session.lastOutput}
          messages={session.messages}
          llmSettings={settings}
          onClose={() => session.hideSave()}
          onSaved={() => {
            session.hideSave();
          }}
        />
      )}
    </div>
  );
}
