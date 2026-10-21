import type { RpcRequest } from "@aipagego/shared/messages";
import type { ExportBundle, Json, RunRecord, Step, Tool } from "@aipagego/shared/types";
import type { Preset } from "@aipagego/shared/preset";

function isReceiverMissing(msg: string): boolean {
  return (
    msg.includes("Could not establish connection") ||
    msg.includes("Receiving end does not exist")
  );
}

async function call<T>(req: RpcRequest, retries = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = (await chrome.runtime.sendMessage(req)) as
        | { ok: true; data: T }
        | { ok: false; error: string }
        | undefined;
      // BG listener closed the channel without sendResponse — typically the
      // RpcRequest schema rejected the envelope. Surface a clear message
      // instead of the opaque "Cannot read .ok of undefined" TypeError.
      if (res == null) {
        throw new Error(
          `BG returned no response for ${req.type} — likely a schema mismatch on the request envelope. Reload the extension and re-open the side panel.`
        );
      }
      if (!res.ok) throw new Error(res.error);
      return res.data;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      // 仅对 SW 休眠/唤醒导致的 receiver-missing 重试；其他错立即抛
      if (!isReceiverMissing(msg) || attempt === retries) {
        throw e;
      }
      // 指数级 backoff：150 / 300 / 600 / 1200 ms
      await new Promise((r) => setTimeout(r, 150 * Math.pow(2, attempt)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export const rpc = {
  // tools
  listTools: () => call<Tool[]>({ type: "tools.list" }),
  getTool: (id: string) => call<Tool | null>({ type: "tools.get", id }),
  saveTool: (draft: Extract<RpcRequest, { type: "tools.save" }>["draft"]) =>
    call<Tool>({ type: "tools.save", draft }),
  deleteTool: (id: string) => call<null>({ type: "tools.delete", id }),
  matchingTools: (url: string) => call<Tool[]>({ type: "tools.matching", url }),
  exportAll: () => call<ExportBundle>({ type: "tools.export" }),
  importBundle: (bundle: unknown) =>
    call<{ imported: number; skipped: number }>({ type: "tools.import", bundle }),

  // runs
  runDraft: (
    draft: Extract<RpcRequest, { type: "tools.save" }>["draft"],
    tabId: number
  ) => call<RunRecord>({ type: "runs.start", target: { kind: "draft", draft }, tabId }),
  runTool: (id: string, tabId: number) =>
    call<RunRecord>({ type: "runs.start", target: { kind: "tool", id }, tabId }),
  runOneStep: (input: {
    step: Step;
    tabId: number;
    attachedTabIds?: number[];
    bindings?: Record<string, Json>;
  }) =>
    call<Json>({
      type: "runs.runOneStep",
      step: input.step,
      tabId: input.tabId,
      attachedTabIds: input.attachedTabIds ?? [],
      bindings: input.bindings ?? {}
    }),
  listRuns: (toolId?: string) => call<RunRecord[]>({ type: "runs.list", toolId }),
  getRun: (id: string) => call<RunRecord | null>({ type: "runs.get", id }),

  // tabs
  listTabs: (windowId?: number) =>
    call<{ tabs: Array<{ tabId: number; windowId: number; url: string; title: string }> }>({
      type: "tabs.list",
      ...(windowId == null ? {} : { windowId })
    }),
  openTab: (url: string, active?: boolean) =>
    call<{ tabId: number; url: string; title: string }>({
      type: "tabs.open",
      url,
      ...(active == null ? {} : { active })
    }),

  // presets
  listPresets: () => call<Preset[]>({ type: "presets.list" }),
  materializePreset: (presetId: string) => call<Tool>({ type: "presets.materialize", presetId }),

  // widget RPCs
  widgetOpenSidepanel: (input: { tabId: number; pendingApprovalId?: string }) =>
    call<null>({ type: "widget.openSidepanel", ...input }),
  widgetOpenSidepanelWithSave: (input: { tabId: number }) =>
    call<null>({ type: "widget.openSidepanelWithSave", tabId: input.tabId }),
  widgetMarkHostHidden: (host: string) =>
    call<null>({ type: "widget.markHostHidden", host }),

  // element capture
  startElementCapture: (tabId: number) =>
    call<null>({ type: "elementCapture.start", tabId }),

  // chat session
  startSession: (input: { url: string }) =>
    call<RunRecord>({ type: "chat.session.start", url: input.url }),
  appendStepLog: (
    runId: string,
    entry: { stepIndex: number; input: Json; output: Json; ms: number; error?: string }
  ) => call<null>({ type: "chat.session.appendLog", runId, entry }),
  finalizeSession: (
    runId: string,
    status: "ok" | "error" | "aborted",
    output?: Json
  ) => call<RunRecord>({ type: "chat.session.end", runId, status, output })
};

export async function currentTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active tab");
  return tab.id;
}

export async function currentTabInfo(): Promise<{ tabId: number; url: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active tab");
  return { tabId: tab.id, url: tab.url ?? "" };
}

export type TabRecommendationsMsg = {
  type: "tabs.recommendations";
  tabId: number;
  url: string;
  tools: Tool[];
  presets: Preset[];
};

export function onTabRecommendations(
  cb: (msg: TabRecommendationsMsg) => void
): () => void {
  const listener = (msg: unknown) => {
    if (
      typeof msg === "object" &&
      msg !== null &&
      (msg as { type?: string }).type === "tabs.recommendations"
    ) {
      const m = msg as TabRecommendationsMsg;
      cb({ ...m, presets: m.presets ?? [] });
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export type TabEvent =
  | { type: "tabs.spawned"; tabId: number; openerTabId: number | null; windowId: number; url: string; title: string }
  | { type: "tabs.urlChanged"; tabId: number; newUrl: string; newTitle: string }
  | { type: "tabs.removed"; tabId: number };

export function onTabEvents(cb: (ev: TabEvent) => void): () => void {
  const listener = (msg: unknown) => {
    if (typeof msg !== "object" || msg === null) return;
    const t = (msg as { type?: string }).type;
    if (t === "tabs.spawned" || t === "tabs.urlChanged" || t === "tabs.removed") {
      cb(msg as TabEvent);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
