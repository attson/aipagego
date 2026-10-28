import { useCallback, useEffect, useMemo, useState } from "react";
import type { ImagePart, Json, ReplayableTool, Step, Tool, AttachedTab } from "@aipagego/shared/types";
import type { Preset } from "@aipagego/shared/preset";
import { CollectionRecipeSchema, type CollectionRecipeV1 } from "@aipagego/shared/collection";
import {
  PermissionRequiredSchema,
  type PermissionRequired,
} from "@aipagego/shared/optional-permissions";

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
import {
  createCollectionHandoff,
  isCollectionConversation,
  type CollectionStudioHandoff,
} from "@/sidepanel/chat/collection-handoff";
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
import { PermissionRequestCard } from "@/sidepanel/components/permission-request-card";
import { InputToolbar } from "@/sidepanel/input/input-toolbar";
import type {
  MentionTabOption,
  MentionToolOption,
  MentionBookmarkOption,
} from "@/sidepanel/input/mention-picker";
import { matchesAny } from "@aipagego/shared/url-pattern";
import { loadBookmarks } from "@/sidepanel/lib/bookmarks";
import {
  PENDING_PERMISSION_STORAGE_PREFIX,
  pendingPermissionStorageKey,
  requestOptionalPermission,
} from "@/permissions/optional-permissions";
import { broadcastPermissionDecision } from "@/sidepanel/chat/permission-request";
import { fileToImagePart, MAX_IMAGES_PER_TURN } from "@/sidepanel/lib/image-utils";
import { buildMetaTools } from "@/sidepanel/lib/meta-tools";
import {
  buildCurrentUserContent,
  buildInitialMessagesForNextTurn,
  resolveContextBuildOptions,
} from "@/sidepanel/chat/context-manager";

import { HistoryDrawer } from "@/sidepanel/drawers/history-drawer";
import { ToolsDrawer } from "@/sidepanel/drawers/tools-drawer";
import { JobsDrawer } from "@/sidepanel/drawers/jobs-drawer";
import { ConnectorsDrawer } from "@/sidepanel/drawers/connectors-drawer";
import { JOBS_OPEN_STORAGE_KEY } from "@/background/jobs/notifications";
import { SettingsDrawer } from "@/sidepanel/drawers/settings-drawer";
import { DebugDrawer } from "@/sidepanel/drawers/debug-drawer";
import { ScenariosDrawer } from "@/sidepanel/drawers/scenarios-drawer";
import { CollectStudioDrawer } from "@/sidepanel/drawers/collect-studio-drawer";
import { WorkflowStudioDrawer } from "@/sidepanel/drawers/workflow-studio-drawer";
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
import type { BookmarkPermissionState } from "@/sidepanel/input/mention-picker";
import { FirstRunOnboarding } from "@/sidepanel/onboarding/first-run-onboarding";
import {
  FIRST_RUN_RESTART_EVENT,
  decideFirstRun,
  saveFirstRunDisposition,
  type FirstRunDisposition,
} from "@/sidepanel/onboarding/first-run-state";

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

type PendingPermission = PermissionRequired & {
  tabId: number;
  toolUseId: string;
  busy: boolean;
  error?: string;
  resolve: (result: { granted: true } | { granted: false; reason: "user_denied" }) => void;
};

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
  const [bookmarkPermission, setBookmarkPermission] = useState<BookmarkPermissionState>({ state: "required" });
  const [pendingPermissions, setPendingPermissions] = useState<Record<number, PendingPermission>>({});
  const [stagedImages, setStagedImages] = useState<ImagePart[]>([]);
  const [stagedSelectors, setStagedSelectors] = useState<string[]>([]);
  const [recoverableUrl, setRecoverableUrl] = useState<string | null>(null);
  const [collectionHandoff, setCollectionHandoff] = useState<CollectionStudioHandoff | null>(null);
  const [workflowCollectionEdit, setWorkflowCollectionEdit] = useState<{
    toolId: string;
    recipe: CollectionRecipeV1;
    apply: (recipe: Json) => void;
  } | null>(null);
  const [firstRunResolved, setFirstRunResolved] = useState(false);
  const [showFirstRun, setShowFirstRun] = useState(false);
  const approver = getGlobalApprover();

  useHeartbeat();
  const externalReplay = useExternalReplay();

  useEffect(() => {
    void chrome.storage.local.get(JOBS_OPEN_STORAGE_KEY).then((stored) => {
      const pending = stored[JOBS_OPEN_STORAGE_KEY] as { jobId?: string } | undefined;
      if (!pending?.jobId) return;
      ui.open("jobs", pending.jobId);
      return chrome.storage.local.remove(JOBS_OPEN_STORAGE_KEY);
    }).catch(() => undefined);
  }, []);

  // Settings (or another extension context) can revoke optional permissions
  // while this AppShell stays mounted. Drop cached bookmark data immediately
  // so the next picker use returns to the explicit user-gesture grant flow.
  useEffect(() => {
    type PermissionRemovedListener = (removed: chrome.permissions.Permissions) => void;
    const event = chrome.permissions?.onRemoved as
      | (typeof chrome.permissions.onRemoved & {
          removeListener?: (listener: PermissionRemovedListener) => void;
        })
      | undefined;
    if (!event) return;
    const onRemoved: PermissionRemovedListener = (removed) => {
      if (!removed.permissions?.includes("bookmarks")) return;
      setBookmarks([]);
      setBookmarkPermission({ state: "required" });
    };
    event.addListener(onRemoved);
    return () => event.removeListener?.(onRemoved);
  }, []);

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

  // Widget permission handoff: the background stores the pending request
  // before opening the sidepanel. Read it on mount and also listen for the
  // signal used when the sidepanel was already open.
  useEffect(() => {
    let active = true;

    async function loadPendingPermissions(storageKey?: string): Promise<void> {
      const stored = await chrome.storage.session.get(storageKey ? [storageKey] : null);
      for (const [key, raw] of Object.entries(stored)) {
        if (!key.startsWith(PENDING_PERMISSION_STORAGE_PREFIX)) continue;
        if (!raw || typeof raw !== "object") continue;
        const candidate = raw as Record<string, unknown>;
        if (
          typeof candidate.ts !== "number" ||
          Date.now() - candidate.ts > 30_000 ||
          typeof candidate.tabId !== "number" ||
          typeof candidate.toolUseId !== "string"
        ) {
          await chrome.storage.session.remove([key]);
          continue;
        }
        const parsed = PermissionRequiredSchema.safeParse(candidate);
        if (!parsed.success) {
          await chrome.storage.session.remove([key]);
          continue;
        }
        if (!active) return;
        const tabId = candidate.tabId;
        const toolUseId = candidate.toolUseId;
        const resolve: PendingPermission["resolve"] = (result) => {
          setPendingPermissions((current) => {
            if (current[tabId]?.toolUseId !== toolUseId) return current;
            const next = { ...current };
            delete next[tabId];
            return next;
          });
          void chrome.storage.session.remove([key]);
          broadcastPermissionDecision(tabId, toolUseId, result);
        };
        setPendingPermissions((current) => ({
          ...current,
          [tabId]: {
            ...parsed.data,
            tabId,
            toolUseId,
            busy: false,
            resolve,
          },
        }));
      }
    }

    function onPendingPermission(message: unknown): void {
      if (!message || typeof message !== "object") return;
      const candidate = message as {
        type?: string;
        tabId?: number;
        toolUseId?: string;
        storageKey?: string;
      };
      if (candidate.type === "permission.pending.available") {
        void loadPendingPermissions(candidate.storageKey);
      } else if (
        candidate.type === "permission.decision" &&
        typeof candidate.tabId === "number" &&
        typeof candidate.toolUseId === "string"
      ) {
        setPendingPermissions((current) => {
          if (current[candidate.tabId!]?.toolUseId !== candidate.toolUseId) return current;
          const next = { ...current };
          delete next[candidate.tabId!];
          return next;
        });
        void chrome.storage.session.remove(
          pendingPermissionStorageKey(candidate.tabId, candidate.toolUseId)
        );
      }
    }

    void loadPendingPermissions();
    chrome.runtime.onMessage.addListener(onPendingPermission);
    return () => {
      active = false;
      chrome.runtime.onMessage.removeListener(onPendingPermission);
    };
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
        if (useUi.getState().openedDrawer === "collect") return;
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

  // Resolve once after settings load. Do not depend on settings.apiKey here:
  // entering a key inside onboarding must not be mistaken for an existing-user migration.
  useEffect(() => {
    if (!settings.loaded || firstRunResolved) return;
    let active = true;
    void decideFirstRun(settings.apiKey).then((decision) => {
      if (!active) return;
      setShowFirstRun(decision.show);
      setFirstRunResolved(true);
      if (decision.storageError) {
        console.warn("[aipagego] first-run state unavailable", decision.storageError);
      }
    });
    return () => {
      active = false;
    };
  }, [settings.loaded, firstRunResolved]);

  useEffect(() => {
    const restart = () => {
      useUi.getState().close();
      setFirstRunResolved(true);
      setShowFirstRun(true);
    };
    window.addEventListener(FIRST_RUN_RESTART_EVENT, restart);
    return () => window.removeEventListener(FIRST_RUN_RESTART_EVENT, restart);
  }, []);

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

  const handoffFixToChat = useCallback((opts: {
    initialPrompt: string;
    initialContext: string;
    tabId: number;
  }) => {
    const next = `${opts.initialPrompt}\n\n${opts.initialContext}`;
    getSessionActions(opts.tabId).setInputDraft(next);
    if (currentTabId === opts.tabId) setInput(next);
    ui.close();
  }, [currentTabId, ui]);

  const send = useCallback(
    async (prompt: string) => {
      if (!prompt.trim() && stagedImages.length === 0) return false;
      if (!settings.apiKey) {
        session.setError("请先在设置 → LLM 填入 API Key");
        return false;
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
          case "permission_required":
            runSession.setStatus("awaiting");
            log("info", `等待 ${e.permission} 权限: ${e.capability}`);
            break;
          case "permission_resolved":
            runSession.setStatus(e.granted ? "running" : "streaming");
            log(
              e.granted ? "info" : "warn",
              `${e.permission} 权限${e.granted ? "已授权" : "未授权"}`
            );
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
        const result = await runChatSession({
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
              version: t.kind === "steps" ? t.activeVersion : (t.versions.at(-1)?.version ?? 1),
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
          requestPermission: (required) =>
            new Promise((resolve) => {
              let settled = false;
              let onAbort = () => {};
              const finish = (
                result: { granted: true } | { granted: false; reason: "user_denied" }
              ) => {
                if (settled) return;
                settled = true;
                ac.signal.removeEventListener("abort", onAbort);
                setPendingPermissions((current) => {
                  if (current[tabId]?.toolUseId !== required.toolUseId) return current;
                  const next = { ...current };
                  delete next[tabId];
                  return next;
                });
                resolve(result);
              };
              onAbort = () => finish({ granted: false, reason: "user_denied" });
              if (ac.signal.aborted) {
                finish({ granted: false, reason: "user_denied" });
                return;
              }
              ac.signal.addEventListener("abort", onAbort, { once: true });
              setPendingPermissions((current) => ({
                ...current,
                [tabId]: { ...required, tabId, busy: false, resolve: finish },
              }));
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
        return result.status === "done";
      } catch (e) {
        runSession.setError(e instanceof Error ? e.message : String(e));
        runSession.setStatus("error");
        return false;
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

  async function requestBookmarkAccess(): Promise<void> {
    setBookmarkPermission({ state: "loading" });
    try {
      // This function is invoked directly from the permission-card click so
      // chrome.permissions.request remains inside the user gesture.
      const result = await requestOptionalPermission("bookmarks");
      if (!result.granted) {
        setBookmarkPermission({ state: "denied" });
        return;
      }
      const next = await loadBookmarks();
      setBookmarks(next);
      setBookmarkPermission({ state: "granted" });
    } catch (error) {
      setBookmarkPermission({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function grantPendingPermission(pending: PendingPermission): Promise<void> {
    setPendingPermissions((current) => {
      if (current[pending.tabId]?.toolUseId !== pending.toolUseId) return current;
      return {
        ...current,
        [pending.tabId]: { ...pending, busy: true, error: undefined },
      };
    });
    try {
      const result = await requestOptionalPermission(pending.permission);
      pending.resolve(result);
    } catch (error) {
      setPendingPermissions((current) => {
        if (current[pending.tabId]?.toolUseId !== pending.toolUseId) return current;
        return {
          ...current,
          [pending.tabId]: {
            ...pending,
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      });
    }
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
  const collectionConversation = isCollectionConversation(session);

  const inputStatus =
    session.status === "streaming" || session.status === "awaiting" || session.status === "running"
      ? "streaming"
      : session.errorMessage
        ? "error"
        : "idle";
  const pendingPermission = currentTabId == null ? undefined : pendingPermissions[currentTabId];

  async function finishFirstRun(
    disposition: Exclude<FirstRunDisposition, "existing_user">
  ): Promise<void> {
    try {
      await saveFirstRunDisposition(disposition);
    } catch (error) {
      session.setError(
        `首次设置状态未能保存，但你仍可继续使用：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setShowFirstRun(false);
      setFirstRunResolved(true);
    }
  }

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
        {pendingPermission ? (
          <PermissionRequestCard
            permission={pendingPermission.permission}
            capability={pendingPermission.capability}
            busy={pendingPermission.busy}
            error={pendingPermission.error}
            onGrant={() => void grantPendingPermission(pendingPermission)}
            onDeny={() =>
              pendingPermission.resolve({ granted: false, reason: "user_denied" })
            }
          />
        ) : null}
        {!firstRunResolved ? null : showFirstRun ? (
          <FirstRunOnboarding
            currentUrl={session.url}
            onRunExample={send}
            onFinish={finishFirstRun}
          />
        ) : emptyState && !settings.apiKey.trim() ? (
          <div className="m-auto max-w-[280px] rounded border border-amber-900/70 bg-amber-950/30 p-4 text-center">
            <h2 className="text-sm font-semibold text-zinc-100">重新连接模型</h2>
            <p className="mt-1 text-[11px] text-zinc-400">
              API Key 不在当前浏览器会话中。重新配置后即可继续聊天，已有会话和工具不会受影响。
            </p>
            <button
              type="button"
              onClick={() => ui.open("settings")}
              className="mt-3 rounded bg-amber-700 px-3 py-2 text-xs text-white hover:bg-amber-600"
            >
              打开 LLM 设置
            </button>
          </div>
        ) : emptyState ? (
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
                onContinueCollection={collectionConversation ? () => {
                  const handoff = createCollectionHandoff(session);
                  setCollectionHandoff(handoff);
                  ui.open("collect");
                } : undefined}
              />
            )}
          </>
        )}
      </div>

      {firstRunResolved && !showFirstRun ? <InputToolbar
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
        bookmarkPermission={bookmarkPermission}
        onRequestBookmarkPermission={() => void requestBookmarkAccess()}
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
      /> : null}

      <HistoryDrawer currentUrl={session.url} />
      <ToolsDrawer onFixWithAi={(opts) => {
        if (currentTabId == null) return;
        handoffFixToChat({ ...opts, tabId: currentTabId });
      }} />
      <JobsDrawer />
      <ConnectorsDrawer />
      <WorkflowStudioDrawer currentTabId={currentTabId} onFixWithAi={handoffFixToChat} onEditCollection={(input) => {
        const parsed = CollectionRecipeSchema.safeParse(input.recipe);
        if (!parsed.success) return;
        setWorkflowCollectionEdit({
          toolId: input.toolId,
          recipe: parsed.data,
          apply: input.apply,
        });
        ui.open("collect");
      }} />
      <SettingsDrawer />
      <DebugDrawer />
      <ScenariosDrawer />
      <CollectStudioDrawer
        currentTabId={currentTabId}
        currentUrl={session.url}
        handoff={collectionHandoff}
        onHandoffConsumed={(id) => setCollectionHandoff((current) =>
          current?.id === id ? null : current
        )}
        workflowEdit={workflowCollectionEdit ? {
          recipe: workflowCollectionEdit.recipe,
          onApply: (recipe) => {
            workflowCollectionEdit.apply(recipe as unknown as Json);
            const toolId = workflowCollectionEdit.toolId;
            setWorkflowCollectionEdit(null);
            ui.open("workflow", toolId);
          },
          onCancel: () => {
            const toolId = workflowCollectionEdit.toolId;
            setWorkflowCollectionEdit(null);
            ui.open("workflow", toolId);
          }
        } : null}
      />

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
