import { create } from "zustand";
import type { AttachedTab, ChatMessage, ImagePart, Json, LlmExchange, PersistedSessionData, Step, ToolUsePart } from "@atwebpilot/shared/types";
import type { PermissionMode } from "./severity";

export const SELF_INSTANCE_ID: string =
  (globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2));

function broadcastMutation(tabId: number): void {
  const snap = useStore.getState().sessionsByTab[tabId];
  if (!snap) return;
  try {
    void chrome.runtime.sendMessage({
      type: "session.state.changed",
      tabId,
      snapshot: snap,
      senderId: SELF_INSTANCE_ID
    });
  } catch { /* swallow */ }
}

function mutateSession(tabId: number, updater: (s: SessionData) => SessionData): void {
  useStore.setState((state) => {
    const cur = state.sessionsByTab[tabId];
    if (!cur) return state;
    const next = updater(cur);
    const bumped = { ...next, _rev: (cur._rev ?? 0) + 1 };
    return { sessionsByTab: { ...state.sessionsByTab, [tabId]: bumped } };
  });
  broadcastMutation(tabId);
}

export const MAX_EXCHANGES = 60;

export type DebugBadge = { kind: "error" | "exchange" | "log"; count: number } | null;

export type StepCardState = {
  toolUseId: string;
  name: string;
  input: Json;
  partialJson: string;
  inputReady: boolean;
  status: "draft" | "awaiting" | "running" | "ok" | "error" | "skipped" | "denied";
  output?: Json;
  error?: string;
  ms?: number;
  /** Widget round 2:tool 进入 running 时的时间戳 (Date.now())。widget 状态条计时器用。 */
  _runningStartAt?: number;
};

export type LogEntry = {
  ts: number;
  level: "info" | "warn" | "error";
  message: string;
  details?: string;
};

export type SessionStatus =
  | "idle"
  | "streaming"
  | "awaiting"
  | "running"
  | "done"
  | "error"
  | "aborted";

export type SessionData = {
  tabId: number;
  url: string;
  runRecordId: string | null;
  /** Logical local conversation id shared by sidepanel and widget snapshots. */
  _sessionId?: string;

  messages: ChatMessage[];
  streamingAssistantText: string;
  cards: StepCardState[];

  status: SessionStatus;
  errorMessage: string | null;
  roundCount: number;
  tokenUsage: { input: number; output: number };

  executedSteps: Step[];
  lastOutput: Json;
  showSaveDialog: boolean;

  abortController: AbortController | null;

  logs: LogEntry[];
  logsOpen: boolean;

  inputDraft: string;
  attachedTabs: AttachedTab[];

  llmExchanges: LlmExchange[];

  /** Per-session permission mode (controls tool auto-approval). Persists across runs. */
  permissionMode: PermissionMode;
  /** Header `💭` badge state — set by the chat/run plumbing when something needs attention. */
  debugBadge: DebugBadge;
  /** 聊天视图模式（session-scoped；不持久化）。默认 "compact"。 */
  chatMode: "compact" | "full";
  /** 广播冲突仲裁字段；每次 mutation 后自增（Task 7）。初始 0。 */
  _rev: number;
  /**
   * 最近一次 tool_running 事件的时间戳（Date.now()）。cross-tab-events
   * 用来判定新 spawn 的 tab 是否 AI 打开的:只有窗口 <1500ms 内有过
   * tool_running 才归 AI,否则一律视为用户 Ctrl+click。
   */
  _lastToolRunningAt?: number;
};

export function makeEmptySession(tabId: number, url = ""): SessionData {
  return {
    tabId,
    url,
    runRecordId: null,
    _sessionId: globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random()}`,
    messages: [],
    streamingAssistantText: "",
    cards: [],
    status: "idle",
    errorMessage: null,
    roundCount: 0,
    tokenUsage: { input: 0, output: 0 },
    executedSteps: [],
    lastOutput: null,
    showSaveDialog: false,
    abortController: null,
    logs: [],
    logsOpen: false,
    inputDraft: "",
    attachedTabs: [],
    llmExchanges: [],
    permissionMode: "default",
    debugBadge: null,
    chatMode: "compact",
    _rev: 0
  };
}

export const EMPTY_SESSION: SessionData = Object.freeze(makeEmptySession(-1)) as SessionData;

/** @deprecated 兼容 Plan 1-3 命名；新代码用 SessionData */
export type ChatSessionState = SessionData;

type StoreShape = {
  sessionsByTab: Record<number, SessionData>;
  currentTabId: number | null;
};

export const useStore = create<StoreShape>(() => ({
  sessionsByTab: {},
  currentTabId: null
}));

function patchSession(tabId: number, fn: (s: SessionData) => SessionData): void {
  useStore.setState((state) => {
    const cur = state.sessionsByTab[tabId];
    if (!cur) return state;
    const next = fn(cur);
    if (next === cur) return state;
    return {
      ...state,
      sessionsByTab: { ...state.sessionsByTab, [tabId]: next }
    };
  });
}

// === per-tab actions ===

export function ensureSession(tabId: number, url: string): void {
  const existing = useStore.getState().sessionsByTab[tabId];
  if (existing) {
    if (url && existing.url !== url) {
      mutateSession(tabId, (s) => ({ ...s, url }));
    }
    return;
  }
  // New session: initialize with _rev 0, then broadcast
  useStore.setState((state) => ({
    sessionsByTab: { ...state.sessionsByTab, [tabId]: makeEmptySession(tabId, url) }
  }));
  broadcastMutation(tabId);
}

export function setCurrentTab(tabId: number): void {
  useStore.setState({ currentTabId: tabId });
}

export function setUrl(tabId: number, url: string): void {
  mutateSession(tabId, (s) => ({ ...s, url }));
}

export function appendSystemNote(tabId: number, text: string): void {
  mutateSession(tabId, (s) =>
    s.messages.length === 0
      ? s
      : { ...s, messages: [...s.messages, { role: "user", content: text }] }
  );
}

/**
 * Append a [自愈] system note to the message thread unconditionally.
 * Used by the self-heal event listener to surface heal status in the chat UI.
 */
export function appendHealNote(tabId: number, text: string): void {
  mutateSession(tabId, (s) => ({
    ...s,
    messages: [...s.messages, { role: "user" as const, content: `[自愈] ${text}` }]
  }));
}

export function appendUserMessage(tabId: number, text: string): void {
  mutateSession(tabId, (s) => ({
    ...s,
    messages: [...s.messages, { role: "user", content: text }]
  }));
}

/** Like appendUserMessage but attaches images as a content array. */
export function appendUserMessageWithImages(tabId: number, text: string, images: ImagePart[]): void {
  if (images.length === 0) return appendUserMessage(tabId, text);
  mutateSession(tabId, (s) => {
    const content: Array<{ type: "text"; text: string } | ImagePart> = [];
    for (const img of images) content.push(img);
    if (text) content.push({ type: "text", text });
    return { ...s, messages: [...s.messages, { role: "user", content }] };
  });
}

export function beginAssistantTurn(tabId: number): void {
  mutateSession(tabId, (s) => ({ ...s, streamingAssistantText: "" }));
}

export function appendAssistantText(tabId: number, delta: string): void {
  mutateSession(tabId, (s) => ({
    ...s,
    streamingAssistantText: s.streamingAssistantText + delta
  }));
}

export function finalizeAssistantTurn(tabId: number, toolUses: ToolUsePart[]): void {
  mutateSession(tabId, (s) => {
    const arr: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: Json }
    > = [];
    if (s.streamingAssistantText) arr.push({ type: "text", text: s.streamingAssistantText });
    for (const tu of toolUses) arr.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    return {
      ...s,
      messages: [...s.messages, { role: "assistant", content: arr }],
      streamingAssistantText: ""
    };
  });
}

export function upsertCard(
  tabId: number,
  card: Partial<StepCardState> & { toolUseId: string }
): void {
  mutateSession(tabId, (s) => {
    const idx = s.cards.findIndex((c) => c.toolUseId === card.toolUseId);
    if (idx === -1) {
      const next: StepCardState = {
        toolUseId: card.toolUseId,
        name: card.name ?? "",
        input: card.input ?? {},
        partialJson: card.partialJson ?? "",
        inputReady: card.inputReady ?? false,
        status: card.status ?? "draft",
        output: card.output,
        error: card.error,
        ms: card.ms
      };
      return { ...s, cards: [...s.cards, next] };
    }
    const merged = { ...s.cards[idx], ...card };
    const cards = s.cards.slice();
    cards[idx] = merged;
    return { ...s, cards };
  });
}

export function setCardStatus(
  tabId: number,
  toolUseId: string,
  patch: Partial<Omit<StepCardState, "toolUseId">>
): void {
  mutateSession(tabId, (s) => ({
    ...s,
    cards: s.cards.map((c) =>
      c.toolUseId === toolUseId
        ? {
            ...c,
            ...patch,
            ...(patch.status === "running" && c.status !== "running"
              ? { _runningStartAt: Date.now() }
              : {}),
          }
        : c
    ),
  }));
}

export function appendToolResults(
  tabId: number,
  results: Array<{ tool_use_id: string; content: string; is_error?: boolean }>
): void {
  mutateSession(tabId, (s) => ({
    ...s,
    messages: [
      ...s.messages,
      {
        role: "user",
        content: results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.tool_use_id,
          content: r.content,
          is_error: r.is_error
        }))
      }
    ]
  }));
}

export function pushExecutedStep(tabId: number, step: Step): void {
  mutateSession(tabId, (s) => ({ ...s, executedSteps: [...s.executedSteps, step] }));
}

export function setLastOutput(tabId: number, v: Json): void {
  mutateSession(tabId, (s) => ({ ...s, lastOutput: v }));
}

export function incrementRound(tabId: number): void {
  mutateSession(tabId, (s) => ({ ...s, roundCount: s.roundCount + 1 }));
}

export function addUsage(
  tabId: number,
  u: { input_tokens: number; output_tokens: number }
): void {
  mutateSession(tabId, (s) => ({
    ...s,
    tokenUsage: {
      input: s.tokenUsage.input + (u.input_tokens ?? 0),
      output: s.tokenUsage.output + (u.output_tokens ?? 0)
    }
  }));
}

export function addLlmExchange(tabId: number, ex: LlmExchange): void {
  mutateSession(tabId, (s) => ({
    ...s,
    llmExchanges: [...s.llmExchanges, ex].slice(-MAX_EXCHANGES)
  }));
}

export function setStatus(tabId: number, status: SessionStatus): void {
  mutateSession(tabId, (s) => ({
    ...s,
    status,
    // Stamp AI-activity time when a tool starts running. cross-tab-events
    // uses this to distinguish AI-opened tabs from user Ctrl+click (both
    // arrive with `openerTabId` set;only recent AI activity attributes AI).
    ...(status === "running" ? { _lastToolRunningAt: Date.now() } : {}),
  }));
}

export function setError(tabId: number, errorMessage: string | null): void {
  mutateSession(tabId, (s) => ({ ...s, errorMessage }));
}

export function setPermissionMode(tabId: number, mode: PermissionMode): void {
  mutateSession(tabId, (s) => ({ ...s, permissionMode: mode }));
}

export function setDebugBadge(tabId: number, badge: DebugBadge): void {
  mutateSession(tabId, (s) => ({ ...s, debugBadge: badge }));
}

export function setChatMode(tabId: number, mode: "compact" | "full"): void {
  mutateSession(tabId, (s) => (s.chatMode === mode ? s : { ...s, chatMode: mode }));
}

export function setIdentity(
  tabId: number,
  p: { url: string; runRecordId: string }
): void {
  mutateSession(tabId, (s) => ({ ...s, url: p.url, runRecordId: p.runRecordId }));
}

export function setAbortController(tabId: number, ac: AbortController | null): void {
  mutateSession(tabId, (s) => ({ ...s, abortController: ac }));
}

export function showSave(tabId: number): void {
  mutateSession(tabId, (s) => ({ ...s, showSaveDialog: true }));
}

export function hideSave(tabId: number): void {
  mutateSession(tabId, (s) => ({ ...s, showSaveDialog: false }));
}

export function appendLog(
  tabId: number,
  level: LogEntry["level"],
  message: string,
  details?: string
): void {
  patchSession(tabId, (s) => ({
    ...s,
    logs: [...s.logs, { ts: Date.now(), level, message, details }]
  }));
}

export function clearLogs(tabId: number): void {
  patchSession(tabId, (s) => ({ ...s, logs: [] }));
}

export function setLogsOpen(tabId: number, open: boolean): void {
  patchSession(tabId, (s) => ({ ...s, logsOpen: open }));
}

export function setInputDraft(tabId: number, text: string): void {
  mutateSession(tabId, (s) => ({ ...s, inputDraft: text }));
}

export function resetSession(tabId: number): void {
  mutateSession(tabId, (s) => ({ ...makeEmptySession(tabId, s.url) }));
}

/**
 * Strip the last assistant turn (assistant message + its cards + any trailing
 * tool_result user messages) and return the user prompt that triggered it.
 * The caller is responsible for re-sending the returned prompt.
 */
export function popLastAssistantTurn(tabId: number): string | null {
  let lastUserPrompt: string | null = null;
  useStore.setState((state) => {
    const cur = state.sessionsByTab[tabId];
    if (!cur) return state;
    const msgs = cur.messages.slice();
    // Drop trailing tool_result user-role messages
    while (msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      if (last.role === "user" && Array.isArray(last.content)) {
        msgs.pop();
        continue;
      }
      break;
    }
    // Drop the trailing assistant message
    while (msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      if (last.role === "assistant") {
        const toolUseIds = new Set<string>();
        for (const c of last.content) if (c.type === "tool_use") toolUseIds.add(c.id);
        msgs.pop();
        // Strip the cards from that turn
        cur.cards = cur.cards.filter((c) => !toolUseIds.has(c.toolUseId));
        continue;
      }
      break;
    }
    // Find the last user text prompt (now at the tail) and pluck it
    while (msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      if (last.role === "user" && typeof last.content === "string") {
        lastUserPrompt = last.content;
        msgs.pop();
        break;
      }
      // Skip non-text user entries (defensive)
      msgs.pop();
    }
    return {
      ...state,
      sessionsByTab: {
        ...state.sessionsByTab,
        [tabId]: { ...cur, messages: msgs }
      }
    };
  });
  return lastUserPrompt;
}

// === persistence-aware session ops ===

/**
 * Snapshot the current SessionData for archiving, then reset sessionsByTab[tabId] to empty
 * (preserving url). Returns the snapshot or null if no session exists.
 *
 * Caller (chat-page.tsx) handles the IDB archive.
 */
export function startNewSession(tabId: number): SessionData | null {
  let archived: SessionData | null = null;
  useStore.setState((state) => {
    const cur = state.sessionsByTab[tabId];
    if (!cur) return state;
    archived = cur;
    cur.abortController?.abort();
    return {
      ...state,
      sessionsByTab: { ...state.sessionsByTab, [tabId]: makeEmptySession(tabId, cur.url) }
    };
  });
  return archived;
}

/**
 * Overwrite sessionsByTab[tabId] with persisted data. Forces transient fields
 * (status / abortController / streamingAssistantText) to fresh values via
 * makeEmptySession; any stale streaming/running status is dropped.
 */
export function rehydrateFromPersisted(tabId: number, data: PersistedSessionData): void {
  useStore.setState((state) => {
    state.sessionsByTab[tabId]?.abortController?.abort();
    const rehydrated: SessionData = {
      ...makeEmptySession(tabId, data.url),
      messages: data.messages,
      cards: data.cards,
      executedSteps: data.executedSteps,
      tokenUsage: data.tokenUsage,
      roundCount: data.roundCount,
      attachedTabs: data.attachedTabs,
      runRecordId: data.runRecordId,
      errorMessage: data.errorMessage,
      llmExchanges: data.llmExchanges ?? []
    };
    return {
      ...state,
      sessionsByTab: { ...state.sessionsByTab, [tabId]: rehydrated }
    };
  });
}

// === attachedTabs actions ===

export function attachTab(
  tabId: number,
  attached: Omit<AttachedTab, "addedAt" | "urlChanged">
): void {
  patchSession(tabId, (s) => {
    if (s.attachedTabs.some((a) => a.tabId === attached.tabId)) return s;
    return {
      ...s,
      attachedTabs: [
        ...s.attachedTabs,
        { ...attached, addedAt: Date.now() }
      ]
    };
  });
}

export function detachTab(tabId: number, attachedTabId: number): void {
  patchSession(tabId, (s) => {
    const next = s.attachedTabs.filter((a) => a.tabId !== attachedTabId);
    if (next.length === s.attachedTabs.length) return s;
    return { ...s, attachedTabs: next };
  });
}

export function markAttachedUrlChanged(
  sessionTabId: number,
  attachedTabId: number,
  newUrl: string,
  newTitle: string
): void {
  patchSession(sessionTabId, (s) => {
    const idx = s.attachedTabs.findIndex((a) => a.tabId === attachedTabId);
    if (idx === -1) return s;
    const next = s.attachedTabs.slice();
    next[idx] = { ...next[idx], lastSeenUrl: newUrl, lastSeenTitle: newTitle, urlChanged: true };
    return { ...s, attachedTabs: next };
  });
}

export function removeAttachedTab(attachedTabId: number): void {
  useStore.setState((state) => {
    let mutated = false;
    const sessionsByTab: Record<number, SessionData> = { ...state.sessionsByTab };
    for (const [k, s] of Object.entries(state.sessionsByTab)) {
      const next = s.attachedTabs.filter((a) => a.tabId !== attachedTabId);
      if (next.length !== s.attachedTabs.length) {
        sessionsByTab[Number(k)] = { ...s, attachedTabs: next };
        mutated = true;
      }
    }
    return mutated ? { ...state, sessionsByTab } : state;
  });
}

export function validateAttachedTabs(knownTabIds: Set<number>): void {
  useStore.setState((state) => {
    let mutated = false;
    const sessionsByTab: Record<number, SessionData> = { ...state.sessionsByTab };
    for (const [k, s] of Object.entries(state.sessionsByTab)) {
      const next = s.attachedTabs.filter((a) => knownTabIds.has(a.tabId));
      if (next.length !== s.attachedTabs.length) {
        sessionsByTab[Number(k)] = { ...s, attachedTabs: next };
        mutated = true;
      }
    }
    return mutated ? { ...state, sessionsByTab } : state;
  });
}

// === selectors ===

export function getSessionFor(tabId: number): SessionData {
  return useStore.getState().sessionsByTab[tabId] ?? EMPTY_SESSION;
}

// === legacy hook (transitional) ===

export type SessionActions = {
  reset: () => void;
  setStatus: (s: SessionStatus) => void;
  setError: (msg: string | null) => void;
  setIdentity: (p: { tabId?: number; url: string; runRecordId: string }) => void;
  appendUserMessage: (text: string) => void;
  beginAssistantTurn: () => void;
  appendAssistantText: (delta: string) => void;
  finalizeAssistantTurn: (toolUses: ToolUsePart[]) => void;
  upsertCard: (card: Partial<StepCardState> & { toolUseId: string }) => void;
  setCardStatus: (
    toolUseId: string,
    patch: Partial<Pick<StepCardState, "status" | "output" | "error" | "ms" | "input" | "inputReady">>
  ) => void;
  appendToolResults: (
    results: Array<{ tool_use_id: string; content: string; is_error?: boolean }>
  ) => void;
  pushExecutedStep: (step: Step) => void;
  setLastOutput: (v: Json) => void;
  incrementRound: () => void;
  addUsage: (u: { input_tokens: number; output_tokens: number }) => void;
  addLlmExchange: (ex: LlmExchange) => void;
  setAbortController: (c: AbortController | null) => void;
  showSave: () => void;
  hideSave: () => void;
  appendLog: (level: LogEntry["level"], message: string, details?: string) => void;
  clearLogs: () => void;
  setLogsOpen: (open: boolean) => void;
  setInputDraft: (text: string) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setDebugBadge: (badge: DebugBadge) => void;
  setChatMode: (m: "compact" | "full") => void;
};

export function getSessionActions(tabId: number): SessionActions {
  return {
    reset: () => resetSession(tabId),
    setStatus: (s) => setStatus(tabId, s),
    setError: (m) => setError(tabId, m),
    setIdentity: (p) => setIdentity(tabId, { url: p.url, runRecordId: p.runRecordId }),
    appendUserMessage: (t) => appendUserMessage(tabId, t),
    beginAssistantTurn: () => beginAssistantTurn(tabId),
    appendAssistantText: (d) => appendAssistantText(tabId, d),
    finalizeAssistantTurn: (tu) => finalizeAssistantTurn(tabId, tu),
    upsertCard: (c) => upsertCard(tabId, c),
    setCardStatus: (id, p) => setCardStatus(tabId, id, p),
    appendToolResults: (r) => appendToolResults(tabId, r),
    pushExecutedStep: (s) => pushExecutedStep(tabId, s),
    setLastOutput: (v) => setLastOutput(tabId, v),
    incrementRound: () => incrementRound(tabId),
    addUsage: (u) => addUsage(tabId, u),
    addLlmExchange: (ex) => addLlmExchange(tabId, ex),
    setAbortController: (ac) => setAbortController(tabId, ac),
    showSave: () => showSave(tabId),
    hideSave: () => hideSave(tabId),
    appendLog: (l, m, d) => appendLog(tabId, l, m, d),
    clearLogs: () => clearLogs(tabId),
    setLogsOpen: (o) => setLogsOpen(tabId, o),
    setInputDraft: (t) => setInputDraft(tabId, t),
    setPermissionMode: (m) => setPermissionMode(tabId, m),
    setDebugBadge: (b) => setDebugBadge(tabId, b),
    setChatMode: (m: "compact" | "full") => setChatMode(tabId, m)
  };
}

type LegacySession = SessionData & SessionActions;

export function useSession(): LegacySession {
  const data = useStore((s) => {
    const id = s.currentTabId;
    return id == null ? EMPTY_SESSION : (s.sessionsByTab[id] ?? EMPTY_SESSION);
  });
  const tabId = useStore.getState().currentTabId ?? -1;

  return { ...data, ...getSessionActions(tabId) };
}

export function useCurrentTabId(): number | null {
  return useStore((s) => s.currentTabId);
}

export function installBroadcastSubscriber(): () => void {
  const listener = (msg: unknown) => {
    const m = msg as {
      type?: string; tabId?: number; snapshot?: SessionData; senderId?: string;
    } | null;
    if (!m || m.type !== "session.state.changed") return;
    if (m.senderId === SELF_INSTANCE_ID) return;   // self — skip
    if (typeof m.tabId !== "number" || !m.snapshot) return;
    const current = useStore.getState().sessionsByTab[m.tabId];
    if ((current?._rev ?? 0) >= (m.snapshot._rev ?? 0)) return;  // stale — skip
    useStore.setState((state) => ({
      sessionsByTab: { ...state.sessionsByTab, [m.tabId!]: m.snapshot! }
    }));
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
