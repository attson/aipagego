import type { RpcRequest } from "@aipagego/shared/messages";
import type { ExportBundle, Json, RunRecord, Step, Tool } from "@aipagego/shared/types";
import type { Preset } from "@aipagego/shared/preset";
import type { PermissionRequired } from "@aipagego/shared/optional-permissions";
import type {
  CollectionPreview,
  CollectionRecipeV1,
  CollectionResultPage,
  CollectionRunSnapshot,
} from "@aipagego/shared/collection";
import type { Job, JobDraft, JobRun } from "@aipagego/shared/jobs";
import type { Connector, ConnectorDelivery, ConnectorDraft, ConnectorSource } from "@aipagego/shared/connectors";
import type {
  ImportCommitResult,
  ImportConflictAction,
  ImportPreview,
  ToolSharePackageV1,
} from "@aipagego/shared/tool-package";

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
  exportToolSharePackage: (toolIds: string[], name: string, description?: string) =>
    call<ToolSharePackageV1>({
      type: "tools.share.export",
      toolIds,
      name,
      ...(description === undefined ? {} : { description }),
    }),
  previewToolImport: (bundle: unknown) =>
    call<ImportPreview>({ type: "tools.import.preview", bundle }),
  commitToolImport: (input: {
    bundle: unknown;
    digest: string;
    decisions: Array<{ index: number; action: ImportConflictAction }>;
    approveDangerous?: boolean;
  }) => call<ImportCommitResult>({ type: "tools.import.commit", ...input }),
  publishWorkflow: (input: Omit<Extract<RpcRequest, { type: "workflows.publish" }>, "type">) =>
    call<Tool>({ type: "workflows.publish", ...input }),
  activateWorkflow: (id: string, version: number) =>
    call<Tool>({ type: "workflows.activate", id, version }),

  // runs
  runDraft: (
    draft: Extract<RpcRequest, { type: "tools.save" }>["draft"],
    tabId: number,
    inputs?: Record<string, Json>
  ) => call<RunRecord>({
    type: "runs.start",
    target: { kind: "draft", draft },
    tabId,
    ...(inputs === undefined ? {} : { inputs })
  }),
  runTool: (id: string, tabId: number, inputs?: Record<string, Json>) =>
    call<RunRecord>({
      type: "runs.start",
      target: { kind: "tool", id },
      tabId,
      ...(inputs === undefined ? {} : { inputs })
    }),
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

  // local Jobs
  listJobs: () => call<Array<Job & { upgradeAvailable?: number }>>({ type: "jobs.list" }),
  getJob: (id: string) => call<Job | null>({ type: "jobs.get", id }),
  saveJob: (draft: JobDraft, options: { id?: string; acknowledgeCaution?: boolean } = {}) =>
    call<Job>({ type: "jobs.save", draft, ...options }),
  pauseJob: (id: string) => call<Job>({ type: "jobs.pause", id }),
  resumeJob: (id: string) => call<Job>({ type: "jobs.resume", id }),
  deleteJob: (id: string) => call<null>({ type: "jobs.delete", id }),
  runJobNow: (id: string, options: { inputs?: Record<string, Json>; approveDangerousOnce?: boolean } = {}) =>
    call<JobRun>({ type: "jobs.runNow", id, ...options }),
  upgradeJob: (id: string, toolVersion: number, acknowledgeCaution = false) =>
    call<Job>({ type: "jobs.upgrade", id, toolVersion, acknowledgeCaution }),
  listJobRuns: (jobId: string, cursor?: string, limit = 50) =>
    call<{ items: JobRun[]; nextCursor?: string }>({
      type: "jobRuns.list",
      jobId,
      limit,
      ...(cursor == null ? {} : { cursor }),
    }),
  getJobRun: (id: string) => call<JobRun | null>({ type: "jobRuns.get", id }),

  // connectors (credentials are write-only; responses contain redacted Connector data)
  listConnectors: () => call<Connector[]>({ type: "connectors.list" }),
  getConnector: (id: string) => call<Connector | null>({ type: "connectors.get", id }),
  saveConnector: (draft: ConnectorDraft, id?: string) =>
    call<Connector>({ type: "connectors.save", draft, ...(id == null ? {} : { id }) }),
  deleteConnector: (id: string) => call<null>({ type: "connectors.delete", id }),
  testConnector: (id: string) => call<{ ok: true; status: number }>({ type: "connectors.test", id }),
  createDelivery: (connectorId: string, source: ConnectorSource) =>
    call<ConnectorDelivery>({ type: "deliveries.create", connectorId, source }),
  listDeliveries: (connectorId?: string) =>
    call<ConnectorDelivery[]>({ type: "deliveries.list", ...(connectorId == null ? {} : { connectorId }) }),
  retryDelivery: (id: string, confirmUnknownCommit = false) =>
    call<ConnectorDelivery>({ type: "deliveries.retry", id, confirmUnknownCommit }),

  // tabs
  listTabs: (windowId?: number) =>
    call<{ tabs: Array<{ tabId: number; windowId: number; url: string; title: string }> }>({
      type: "tabs.list",
      ...(windowId == null ? {} : { windowId })
    }),
  openTab: (input: {
    url: string;
    active?: boolean;
    incognito?: boolean;
    windowId?: number;
  }) =>
    call<{ tabId: number; windowId: number; incognito: boolean; url: string; title: string }>({
      type: "tabs.open",
      ...input
    }),

  // presets
  listPresets: () => call<Preset[]>({ type: "presets.list" }),
  materializePreset: (presetId: string) => call<Tool>({ type: "presets.materialize", presetId }),

  // widget RPCs
  widgetOpenSidepanel: (input: {
    tabId: number;
    pendingApprovalId?: string;
    pendingPermission?: PermissionRequired & { toolUseId: string };
  }) =>
    call<null>({ type: "widget.openSidepanel", ...input }),
  widgetOpenSidepanelWithSave: (input: { tabId: number }) =>
    call<null>({ type: "widget.openSidepanelWithSave", tabId: input.tabId }),
  widgetMarkHostHidden: (host: string) =>
    call<null>({ type: "widget.markHostHidden", host }),

  // element capture
  startElementCapture: (tabId: number) =>
    call<null>({ type: "elementCapture.start", tabId }),

  // collection studio
  previewCollection: (input: { tabId: number; recipe: CollectionRecipeV1 }) =>
    call<CollectionPreview>({ type: "collections.preview", ...input }),
  startCollection: (input: { tabId: number; recipe: CollectionRecipeV1 }) =>
    call<{ runId: string }>({ type: "collections.start", ...input }),
  getCollectionRun: (runId: string) =>
    call<CollectionRunSnapshot | null>({ type: "collections.runs.get", runId }),
  cancelCollection: (runId: string) =>
    call<null>({ type: "collections.cancel", runId }),
  readCollectionResult: (input: { resultId: string; offset: number; limit: number }) =>
    call<CollectionResultPage>({ type: "collections.results.read", ...input }),

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
