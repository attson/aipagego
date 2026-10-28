import { z } from "zod";
import {
  ContentRequest as ContentRequestSchema,
  RpcRequest as RpcRequestSchema,
  StepSchema,
  type RpcRequest
} from "@aipagego/shared/messages";
import { connectorService } from "./connectors/service";
import { deliveryService } from "./connectors/delivery-service";
import { runStaticScan } from "@aipagego/shared/static-scan";
import type {
  Json,
  RedactedValue,
  RunRecord,
  RunSource,
  Step,
  StepsTool,
  ToolDraft,
  ToolParameter,
} from "@aipagego/shared/types";
import { fetchAsBase64, httpRequest } from "./http-proxy";
import { attemptHeal } from "./self-heal";
import { requestSidepanelLlm } from "./self-heal-bridge";
import { exportAll } from "./storage/export-import";
import { exportToolSharePackage } from "./tool-share-export";
import { commitToolImport, previewToolImport } from "./tool-import-review";
import { appendStepLog, createRun, finalizeRun, getRun, listRuns, setRunHealed } from "./storage/runs";
import {
  activateWorkflowVersion,
  appendVersion,
  deleteTool as deleteToolDb,
  getTool,
  listTools,
  matchingTools,
  materializePreset,
  publishWorkflow,
  recordRunStat,
  saveDraft
} from "./storage/tools";
import { classifyTool } from "@/sidepanel/chat/severity";
import { registerInjectMain } from "./recorder/host";
import { registerCaptureDeps } from "./bg-tools/capture";
import { META_TOOLS, isMetaTool } from "./meta-tool-router";
import { openTabInBrowser } from "./bg-tools/tabs";
import { readPolicyForTab } from "@/injection-policy";
import { injectionModeRank } from "@aipagego/shared";
import type { InjectionMode } from "@aipagego/shared/types";
import { DRAIN_SOURCE } from "@/content/recorder/drain";
import { evaluateWithCdp } from "./recorder/cdp";
import { pendingPermissionStorageKey } from "@/permissions/optional-permissions";
import { CollectionOrchestrator } from "./collection-orchestrator";
import { readCollectionResult } from "./storage/collection-results";
import { advanceCollectionNextPage } from "./collection-next";
import { advanceCollectionDynamicPage } from "./collection-dynamic";
import { registerCollectionRunner } from "./bg-tools/collection";
import { CollectionRecipeSchema, type CollectionRecipeV1 } from "@aipagego/shared/collection";
import {
  analyzeWorkflow,
  getActiveStepsVersion,
  prepareWorkflowInputs,
  resolveWorkflowValue,
} from "@aipagego/shared/workflow";
import { JobService } from "./jobs/service";
import { requestJobReconcile } from "./jobs/runtime";
import { notifyJobTerminal } from "./jobs/notifications";

// Wired here rather than imported by the host to avoid a circular import.
registerInjectMain((tabId, source, args) => injectMainWorld(tabId, source, args));
registerCaptureDeps({
  runStep: ({ step, tabId, attachedTabIds, bindings }) =>
    runOneStep(step, tabId, attachedTabIds ?? [], bindings ?? {})
});

const collectionOrchestrator = new CollectionOrchestrator({
  getTab: (tabId) => chrome.tabs.get(tabId),
  extractPage: extractCollectionPageFromTab,
  advanceNext: (input) => advanceCollectionNextPage(input, {
    clickNext: async (tabId, selector) => {
      const request = ContentRequestSchema.parse({
        type: "content.collectionAdvanceNext",
        selector,
      });
      return z.object({
        status: z.enum(["clicked", "missing", "disabled"]),
      }).parse(await sendContentRequest(tabId, request, "collection next control")).status;
    },
    readTab: (tabId) => chrome.tabs.get(tabId),
    extractPage: extractCollectionPageFromTab,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  }),
  advanceDynamic: (input) => advanceCollectionDynamicPage(input, {
    advance: async (tabId, action) => {
      const request = ContentRequestSchema.parse({
        type: "content.collectionAdvanceDynamic",
        action,
      });
      return z.object({
        status: z.enum(["clicked", "scrolled", "missing", "disabled"]),
      }).parse(await sendContentRequest(tabId, request, "collection dynamic pagination")).status;
    },
    extractPage: extractCollectionPageFromTab,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  }),
  broadcast: (progress) => {
    void Promise.resolve(chrome.runtime.sendMessage(progress)).catch(() => undefined);
  },
});

export const jobService = new JobService(({ toolId, toolVersion, tabId, inputs }) =>
  runTool(
    {
      type: "runs.start",
      target: { kind: "tool", id: toolId, version: toolVersion },
      tabId,
      inputs,
    },
    { source: "job", allowSelfHeal: false },
  ),
  {
    readWatchText: async (tabId, selector) => {
      const result = await runOneStep(
        { kind: "tool", tool: "extractText", args: { selector } },
        tabId,
        [],
        {},
        { source: "job" },
      );
      if (!Array.isArray(result) || !result.every((value) => typeof value === "string")) {
        throw new Error("watch_reader_invalid_response");
      }
      return result;
    },
    notifyTerminal: notifyJobTerminal,
  },
);
registerCollectionRunner(collectionOrchestrator);

const REDACTED_WORKFLOW_VALUE: RedactedValue = { __redacted: true };

async function extractCollectionPageFromTab(tabId: number, recipe: CollectionRecipeV1) {
  const request = ContentRequestSchema.parse({
    type: "content.collectionExtractPage",
    recipe,
  });
  return sendContentRequest(tabId, request, "collection page extraction");
}

function broadcastSessionEvent(ev: unknown): void {
  try {
    void chrome.runtime.sendMessage({ type: "session.event", event: ev });
  } catch {
    // swallow — sidepanel may not be open
  }
}

async function collectPrevSteps(runId: string): Promise<{ input: Json | string; output: Json }[]> {
  const run = await getRun(runId);
  if (!run) return [];
  return run.stepLog
    .filter((e) => !e.error)
    .map((e) => ({ input: e.input, output: e.output as Json }));
}

export async function handleRpc(
  raw: unknown,
  context: { source?: "extension" | "content" } = {},
): Promise<{ ok: true; data: Json } | { ok: false; error: string }> {
  const parsed = RpcRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid request: " + parsed.error.message };
  if (
    (parsed.data.type.startsWith("connectors.") || parsed.data.type.startsWith("deliveries."))
    && context.source === "content"
  ) {
    return { ok: false, error: "connector_sidepanel_required" };
  }
  try {
    const data = await dispatch(parsed.data);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function dispatch(req: RpcRequest): Promise<Json> {
  switch (req.type) {
    case "tools.list":
      return (await listTools()) as unknown as Json;
    case "tools.get":
      return ((await getTool(req.id)) ?? null) as unknown as Json;
    case "tools.save":
      return (await saveDraft(req.draft as ToolDraft)) as unknown as Json;
    case "tools.delete":
      await deleteToolDb(req.id);
      return null;
    case "tools.matching":
      return (await matchingTools(req.url)) as unknown as Json;
    case "tools.export":
      return (await exportAll()) as unknown as Json;
    case "tools.share.export":
      return (await exportToolSharePackage({
        toolIds: req.toolIds,
        name: req.name,
        ...(req.description === undefined ? {} : { description: req.description }),
      })) as unknown as Json;
    case "tools.import":
      throw new Error("import_preview_required");
    case "tools.import.preview":
      return (await previewToolImport(req.bundle)) as unknown as Json;
    case "tools.import.commit":
      return (await commitToolImport({
        bundle: req.bundle,
        digest: req.digest,
        decisions: req.decisions,
        approveDangerous: req.approveDangerous,
      })) as unknown as Json;
    case "workflows.publish":
      return (await publishWorkflow(req.id, {
        basedOnVersion: req.basedOnVersion,
        parameters: req.parameters as ToolParameter[],
        steps: req.steps as Step[],
        outputBinding: req.outputBinding,
        outputSchema: req.outputSchema as Json,
        note: req.note
      })) as unknown as Json;
    case "workflows.activate":
      return (await activateWorkflowVersion(req.id, req.version)) as unknown as Json;
    case "runs.start":
      return (await runTool(req)) as unknown as Json;
    case "runs.list":
      return (await listRuns({ toolId: req.toolId })) as unknown as Json;
    case "runs.get":
      return ((await getRun(req.id)) ?? null) as unknown as Json;
    case "jobs.list":
      return (await jobService.list()) as unknown as Json;
    case "jobs.get":
      return ((await jobService.get(req.id)) ?? null) as unknown as Json;
    case "jobs.save": {
      const job = await jobService.save(
        req.draft,
        req.id,
        req.acknowledgeCaution ?? false,
      );
      requestJobReconcile();
      return job as unknown as Json;
    }
    case "jobs.delete":
      await jobService.delete(req.id);
      requestJobReconcile();
      return null;
    case "jobs.runNow": {
      const run = await jobService.runNow(
        req.id,
        (req.inputs ?? {}) as Record<string, Json>,
        req.approveDangerousOnce ?? false,
      );
      requestJobReconcile();
      return run as unknown as Json;
    }
    case "jobRuns.list":
      return (await jobService.listRuns(req.jobId, req.cursor, req.limit)) as unknown as Json;
    case "jobRuns.get":
      return ((await jobService.getRun(req.id)) ?? null) as unknown as Json;
    case "jobs.pause": {
      const job = await jobService.pause(req.id);
      requestJobReconcile();
      return job as unknown as Json;
    }
    case "jobs.resume": {
      const job = await jobService.resume(req.id);
      requestJobReconcile();
      return job as unknown as Json;
    }
    case "jobs.upgrade": {
      const job = await jobService.upgrade(
        req.id,
        req.toolVersion,
        req.acknowledgeCaution ?? false,
      );
      requestJobReconcile();
      return job as unknown as Json;
    }
    case "connectors.list":
      return (await connectorService.list()) as unknown as Json;
    case "connectors.get":
      return ((await connectorService.get(req.id)) ?? null) as unknown as Json;
    case "connectors.save":
      return (await connectorService.save(req.draft, req.id)) as unknown as Json;
    case "connectors.delete":
      await connectorService.delete(req.id);
      return null;
    case "connectors.test":
      return (await connectorService.test(req.id)) as unknown as Json;
    case "deliveries.create":
      return (await deliveryService.create(req.connectorId, req.source)) as unknown as Json;
    case "deliveries.list":
      return (await deliveryService.list(req.connectorId)) as unknown as Json;
    case "deliveries.retry":
      return (await deliveryService.retry(req.id, req.confirmUnknownCommit ?? false)) as unknown as Json;
    case "http.request":
      return (await httpRequest({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        withCredentials: req.withCredentials
      })) as unknown as Json;
    case "scripting.injectMain": {
      if (req.tabId == null) throw new Error("scripting.injectMain: tabId missing");
      const policy = await readPolicyForTab(req.tabId);
      if (injectionModeRank(policy.injectionMode) < injectionModeRank("operate")) {
        throw new Error(`站点注入策略为「${modeLabel(policy.injectionMode)}」，MAIN-world 执行需要「操作」或更高级别`);
      }
      return (await injectMainWorld(req.tabId, req.source, req.args as Json)) as unknown as Json;
    }
    case "chat.session.start": {
      const run = await createRun({ toolId: null, toolVersion: null, url: req.url });
      return run as unknown as Json;
    }
    case "chat.session.appendLog": {
      await appendStepLog(req.runId, {
        stepIndex: req.entry.stepIndex,
        input: req.entry.input as Json,
        output: req.entry.output as Json,
        ms: req.entry.ms,
        error: req.entry.error
      });
      return null;
    }
    case "chat.session.end": {
      const r = await finalizeRun(req.runId, {
        status: req.status,
        output: req.output as Json | undefined
      });
      return r as unknown as Json;
    }
    case "runs.runOneStep": {
      return (await runOneStep(
        req.step as Step,
        req.tabId,
        req.attachedTabIds,
        req.bindings as Record<string, Json>
      )) as unknown as Json;
    }
    case "tabs.list":
      return (await listTabsRpc(req.windowId)) as unknown as Json;
    case "tabs.open":
      return (await openTabRpc({
        url: req.url,
        active: req.active,
        incognito: req.incognito,
        windowId: req.windowId
      })) as unknown as Json;
    case "http.fetchBinary": {
      return (await fetchAsBase64(req.url)) as unknown as Json;
    }
    case "elementCapture.start": {
      const policy = await readPolicyForTab(req.tabId);
      if (injectionModeRank(policy.injectionMode) < injectionModeRank("operate")) {
        throw new Error(`站点注入策略为「${modeLabel(policy.injectionMode)}」，元素选择需要「操作」或更高级别`);
      }
      await startElementCapture(req.tabId);
      return null;
    }
    case "collections.preview": {
      const policy = await readPolicyForTab(req.tabId);
      if (injectionModeRank(policy.injectionMode) < injectionModeRank("read")) {
        throw new Error(
          `站点注入策略为「${modeLabel(policy.injectionMode)}」，采集预览需要「只读」或更高级别`
        );
      }
      const contentReq = ContentRequestSchema.parse({
        type: "content.collectionPreview",
        recipe: req.recipe
      });
      return await sendContentRequest(req.tabId, contentReq, "collection preview");
    }
    case "collections.start": {
      const policy = await readPolicyForTab(req.tabId);
      const requiredMode = req.recipe.pagination.kind === "single" ? "read" : "operate";
      if (injectionModeRank(policy.injectionMode) < injectionModeRank(requiredMode)) {
        throw new Error(
          `站点注入策略为「${modeLabel(policy.injectionMode)}」，采集运行需要「${modeLabel(requiredMode)}」或更高级别`
        );
      }
      return (await collectionOrchestrator.start({
        tabId: req.tabId,
        recipe: req.recipe,
      })) as unknown as Json;
    }
    case "collections.runs.get":
      return ((await collectionOrchestrator.get(req.runId)) ?? null) as unknown as Json;
    case "collections.cancel":
      collectionOrchestrator.cancel(req.runId);
      return null;
    case "collections.results.read":
      return (await readCollectionResult(req.resultId, req.offset, req.limit)) as unknown as Json;
    case "presets.list": {
      const { PRESETS } = await import("@aipagego/shared/presets");
      return PRESETS as unknown as Json;
    }
    case "presets.materialize": {
      return (await materializePreset(req.presetId)) as unknown as Json;
    }
    case "widget.openSidepanel": {
      if (req.pendingApprovalId) {
        await chrome.storage.session.set({
          "aipagego.pendingApproval": {
            tabId: req.tabId,
            approvalId: req.pendingApprovalId,
            ts: Date.now()
          }
        });
      }
      if (req.pendingPermission) {
        const storageKey = pendingPermissionStorageKey(
          req.tabId,
          req.pendingPermission.toolUseId,
        );
        await chrome.storage.session.set({
          [storageKey]: {
            tabId: req.tabId,
            ...req.pendingPermission,
            ts: Date.now(),
          }
        });
      }
      await chrome.sidePanel.open({ tabId: req.tabId });
      if (req.pendingPermission) {
        await Promise.resolve(chrome.runtime.sendMessage({
          type: "permission.pending.available",
          tabId: req.tabId,
          storageKey: pendingPermissionStorageKey(
            req.tabId,
            req.pendingPermission.toolUseId,
          ),
        })).catch(() => undefined);
      }
      return null;
    }
    case "widget.openSidepanelWithSave": {
      await chrome.sidePanel.open({ tabId: req.tabId });
      await chrome.storage.session.set({
        "aipagego.pendingSave": { tabId: req.tabId, ts: Date.now() }
      });
      return null;
    }
    case "widget.markHostHidden": {
      const KEY = "aipagego.llm";
      const raw = (await chrome.storage.local.get([KEY]))[KEY];
      const settings = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const rules = Array.isArray(settings.siteInjectionRules) ? [...settings.siteInjectionRules] : [];
      rules.push({ pattern: req.host, injectionMode: "inherit", assistant: "disabled" });
      await chrome.storage.local.set({ [KEY]: { ...settings, siteInjectionRules: rules } });
      return null;
    }
  }
}

export async function runOneStep(
  step: Step,
  rpcTabId: number,
  attachedTabIds: number[],
  bindings: Record<string, Json>,
  execution: { source?: RunSource } = {},
): Promise<Json> {
  const resolvedStep: Step = step.kind === "tool"
    ? { ...step, args: resolveWorkflowValue(step.args, bindings) }
    : step;
  let targetTabId = rpcTabId;
  if (resolvedStep.kind === "tool") {
    const argsObj = (resolvedStep.args ?? {}) as Record<string, Json>;
    const declared = argsObj.tabId;
    // 模型常把 tabId 误填为 0/null 表示"当前 tab"——视为未传，用会话 tab。
    if (typeof declared === "number" && declared > 0) targetTabId = declared;
  }
  if (targetTabId !== rpcTabId && !attachedTabIds.includes(targetTabId)) {
    throw new Error(`tab ${targetTabId} not attached; call attachTab first or omit tabId`);
  }

  const policy = await readPolicyForTab(targetTabId);
  const requiredMode = minimumModeForStep(resolvedStep);
  if (injectionModeRank(policy.injectionMode) < injectionModeRank(requiredMode)) {
    throw new Error(
      `站点注入策略为「${modeLabel(policy.injectionMode)}」，${resolvedStep.kind === "tool" ? resolvedStep.tool : "runJS"} 需要「${modeLabel(requiredMode)}」或更高级别`
    );
  }

  if (requiredMode === "diagnostic") await setRecorderPolicy(targetTabId, true);

  // Meta tools run here in the service worker. Dispatching before the content
  // script hop is what lets the coordinator / MCP EXEC path reach them; the
  // side panel used to be the only caller that could.
  if (resolvedStep.kind === "tool" && isMetaTool(resolvedStep.tool)) {
    const metaArgs = {
      ...((resolvedStep.args ?? {}) as Record<string, Json>),
      allowedTabIds: [rpcTabId, ...attachedTabIds]
    } as unknown as Json;
    return META_TOOLS[resolvedStep.tool](metaArgs, targetTabId, {
      ...(resolvedStep.timeoutMs == null ? {} : { timeoutMs: resolvedStep.timeoutMs }),
      source: execution.source ?? "user",
    });
  }

  const stepReq = ContentRequestSchema.parse({
    type: "content.runStep",
    step: resolvedStep,
    bindings
  });
  return sendContentRequest(
    targetTabId,
    stepReq,
    resolvedStep.kind === "tool" ? resolvedStep.tool : "runJS"
  );
}

async function sendContentRequest(
  tabId: number,
  request: unknown,
  label: string
): Promise<Json> {
  let res: { ok: true; data: Json } | { ok: false; error: string } | undefined;
  try {
    res = (await chrome.tabs.sendMessage(tabId, request)) as typeof res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isReceiverMissing(msg)) throw e;
    // content script 还没在该 tab 上加载——尝试动态注入
    const injected = await injectContentScript(tabId);
    if (!injected) {
      throw new Error(
        "Content script 无法注入到此页面（可能是 chrome:// 或受限页面）。请在普通网页上重试。"
      );
    }
    // 注入完成后 listener 注册可能还需要几百 ms（@crxjs ESM loader 异步）
    res = await retryUntilReady(tabId, request);
  }
  // Defensive: chrome.tabs.sendMessage resolves to undefined if the content
  // script's listener closes the channel without sending a response (e.g.
  // schema validation failure on an unknown tool name). Surface that as a
  // clear error rather than letting `res.ok` blow up.
  if (res == null) {
    throw new Error(
      `content script returned no response for ${label} — likely an unknown request or stale content script. Try reloading the tab.`
    );
  }
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

export async function setRecorderPolicy(tabId: number, enabled: boolean): Promise<void> {
  if (!enabled) {
    await injectMainWorld(tabId, DRAIN_SOURCE, { op: "uninstall" }).catch(() => undefined);
    return;
  }
  const recorderEntry = chrome.runtime.getManifest().content_scripts?.[1];
  const files = recorderEntry?.js;
  if (!files?.length) throw new Error("recorder build entry missing from manifest");
  await chrome.scripting.executeScript({ target: { tabId }, files, world: "MAIN" });
}

const READ_TOOLS = new Set([
  "snapshotDOM", "querySelector", "querySelectorAll", "extractText", "extractImages",
  "getValue", "extractFormState", "takeSnapshot", "getPageInfo", "findElements",
  "inspectElement", "createPageIndex", "searchPageIndex", "readPageBlock", "extractPageFields", "waitFor"
]);
const NO_INJECTION_TOOLS = new Set(["listTabs", "searchBookmarks", "searchHistory", "screenshot"]);
const DIAGNOSTIC_TOOLS = new Set([
  "consoleMessages", "networkRequests", "networkRequestDetail", "recorderConfig", "handleDialog"
]);

function minimumModeForStep(step: Step): InjectionMode {
  if (step.kind === "js") return "operate";
  if (step.tool === "collectStructuredData") {
    const input = z.object({ recipe: CollectionRecipeSchema }).safeParse(step.args);
    return input.success && input.data.recipe.pagination.kind === "single" ? "read" : "operate";
  }
  if (NO_INJECTION_TOOLS.has(step.tool)) return "disabled";
  if (DIAGNOSTIC_TOOLS.has(step.tool)) return "diagnostic";
  if (READ_TOOLS.has(step.tool)) return "read";
  return "operate";
}

function modeLabel(mode: InjectionMode): string {
  return { disabled: "禁用", read: "只读", operate: "操作", diagnostic: "诊断" }[mode];
}

function isReceiverMissing(msg: string): boolean {
  return (
    msg.includes("Could not establish connection") ||
    msg.includes("Receiving end does not exist")
  );
}

async function injectContentScript(tabId: number): Promise<boolean> {
  const manifest = chrome.runtime.getManifest();
  const cs = manifest.content_scripts?.[0];
  const files = cs?.js;
  if (!files?.length) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
    return true;
  } catch (e) {
    console.warn("[aipagego] content script inject failed", e);
    return false;
  }
}

async function startElementCapture(tabId: number): Promise<void> {
  const msg = { type: "aipagego.startCapture" };
  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return;
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (!isReceiverMissing(text)) throw e;
  }

  const injected = await injectContentScript(tabId);
  if (!injected) {
    throw new Error("Content script 无法注入到此页面（可能是 chrome:// 或受限页面）。请在普通网页上重试。");
  }

  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < 2000) {
    try {
      await chrome.tabs.sendMessage(tabId, msg);
      return;
    } catch (e) {
      lastErr = e;
      const text = e instanceof Error ? e.message : String(e);
      if (!isReceiverMissing(text)) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const tail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Content script 注入后 2000ms 内仍无法启动元素选择。请刷新页面再试。底层错误: ${tail}`);
}

async function retryUntilReady(
  tabId: number,
  stepReq: unknown,
  deadlineMs = 2000,
  intervalMs = 100
): Promise<{ ok: true; data: Json } | { ok: false; error: string }> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < deadlineMs) {
    try {
      return (await chrome.tabs.sendMessage(tabId, stepReq)) as
        | { ok: true; data: Json }
        | { ok: false; error: string };
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!isReceiverMissing(msg)) throw e;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  const tail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `Content script 注入后 ${deadlineMs}ms 内仍无响应。请刷新页面（Cmd/Ctrl+R）再试。底层错误: ${tail}`
  );
}

export async function runTool(
  req: Extract<RpcRequest, { type: "runs.start" }>,
  execution: { source?: RunSource; allowSelfHeal?: boolean } = {},
): Promise<RunRecord> {
  let steps: Step[];
  let parameters: ToolParameter[];
  let outputBinding: string | undefined;
  let versionOutputSchema: Json = null;
  let persistedTool: StepsTool | null = null;
  let toolId: string | null = null;
  let toolVersion: number | null = null;
  if (req.target.kind === "draft") {
    if (req.target.draft.kind !== "steps") throw new Error("draft runs require steps tools");
    steps = req.target.draft.steps as Step[];
    parameters = (req.target.draft.parameters ?? []) as ToolParameter[];
    outputBinding = req.target.draft.outputBinding;
    versionOutputSchema = req.target.draft.outputSchema as Json;
  } else {
    const tool = await getTool(req.target.id);
    if (!tool) throw new Error("tool not found");
    if (tool.kind !== "steps") throw new Error("prompt tools run in chat, not background runner");
    const requestedVersion = req.target.version;
    const selectedSnapshot = requestedVersion == null
      ? getActiveStepsVersion(tool)
      : tool.versions.find((snapshot) => snapshot.version === requestedVersion);
    if (!selectedSnapshot) throw new Error("workflow_version_not_found");
    steps = [...selectedSnapshot.steps];
    parameters = selectedSnapshot.parameters;
    outputBinding = selectedSnapshot.outputBinding;
    versionOutputSchema = selectedSnapshot.outputSchema;
    persistedTool = tool;
    toolId = tool.id;
    toolVersion = selectedSnapshot.version;
  }

  let analysis = analyzeWorkflow({ parameters, steps, outputBinding });
  if (analysis.issues.length > 0) {
    throw new Error(`invalid_workflow: ${JSON.stringify(analysis.issues)}`);
  }
  const preparedInputs = prepareWorkflowInputs(parameters, req.inputs ?? {});
  let taintedStepIndexes = new Set(analysis.taintedStepIndexes);

  const tab = await chrome.tabs.get(req.tabId);
  const url = tab.url ?? "";
  const run = await createRun({
    toolId,
    toolVersion,
    url,
    source: execution.source ?? "user",
  });

  const bindings: Record<string, Json> = { ...preparedInputs.bindings };
  let lastOutput: Json = null;

  // The background never reads LLM settings or the API key. Persisted tools
  // may ask the sidepanel host to heal; that host owns enablement, key, and
  // token-budget checks and returns a stable rejection reason when unavailable.
  const allowHeal = req.target.kind === "tool" && execution.allowSelfHeal !== false;
  let healApplied = false;

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const isTainted = taintedStepIndexes.has(i);
      const resolvedInput = step.kind === "tool"
        ? resolveWorkflowValue(step.args, bindings)
        : step.source;
      const persistedInput = isTainted ? REDACTED_WORKFLOW_VALUE : resolvedInput;
      const start = Date.now();
      let res:
        | { ok: true; data: Json }
        | { ok: false; error: string };
      try {
        res = {
          ok: true,
          data: await runOneStep(step, req.tabId, [], bindings, {
            source: execution.source ?? "user",
          }),
        };
      } catch (error) {
        res = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }

      if (!res.ok) {
        // Decide whether to attempt self-heal.
        const canHeal =
          allowHeal &&
          !healApplied &&
          step.kind === "tool" &&
          step.tool !== "collectStructuredData" &&
          classifyTool(step.tool, resolvedInput) !== "dangerous";

        if (!canHeal) {
          // If we already applied a heal and the re-run step also failed,
          // surface the specific reason so callers can distinguish it.
          if (healApplied && toolId) {
            broadcastSessionEvent({
              type: "self_heal_failed",
              toolId,
              reason: "step_still_fails"
            });
          }
          await appendStepLog(run.id, {
            stepIndex: i,
            input: persistedInput,
            output: isTainted ? REDACTED_WORKFLOW_VALUE : null,
            ms: Date.now() - start,
            error: isTainted ? REDACTED_WORKFLOW_VALUE : res.error
          });
          await finalizeRun(run.id, { status: "error" });
          if (toolId) await recordRunStat(toolId, false);
          return (await getRun(run.id)) as RunRecord;
        }

        // --- Self-heal path ---
        broadcastSessionEvent({
          type: "self_heal_started",
          toolId: toolId!,
          toolName: (await getTool(toolId!))?.name ?? "",
          failedStepIndex: i
        });

        const domSnapshot = isTainted
          ? REDACTED_WORKFLOW_VALUE
          : await runOneStep(
              { kind: "tool", tool: "snapshotDOM", args: {} } as Step,
              req.tabId,
              [],
              {}
            ).catch(() => ({} as Json));

        const prevSteps = await collectPrevSteps(run.id);

        const heal = await attemptHeal(
          {
            tool: {
              id: persistedTool!.id,
              kind: "steps",
              name: persistedTool!.name,
              description: persistedTool!.description,
              urlPatterns: persistedTool!.urlPatterns,
              version: toolVersion!,
              parameters,
              steps: [...steps],
              outputBinding,
              outputSchema: versionOutputSchema,
              createdAt: getActiveStepsVersion(persistedTool!).createdAt,
            },
            failedStepIndex: i,
            failedInput: step,
            errorText: isTainted ? JSON.stringify(REDACTED_WORKFLOW_VALUE) : res.error,
            prevSteps,
            domSnapshot,
            url
          },
          {
            requestSidepanelLlm,
            snapshot: async () => domSnapshot,
            staticScan: (steps: Step[]) =>
              steps.flatMap((s) =>
                s.kind === "js" ? runStaticScan(s.source).map((f) => f.severity as "safe" | "caution" | "dangerous") : []
              ),
            classifyStep: (patchedStep) => {
              if (patchedStep.kind !== "tool") return "dangerous";
              try {
                return classifyTool(
                  patchedStep.tool,
                  resolveWorkflowValue(patchedStep.args, bindings),
                );
              } catch {
                // Autonomous patches must be provably non-dangerous with the
                // bindings available at the failed step. A future/dynamic
                // value cannot pass the strict gate by looking harmless as a
                // raw `${binding}` string.
                return "dangerous";
              }
            },
            parseSteps: (raw) => {
              const parsed = z.array(StepSchema).safeParse(raw);
              return parsed.success ? (parsed.data as Step[]) : null;
            },
            validatePatch: (patchedSteps) => analyzeWorkflow({
              parameters,
              steps: [...steps.slice(0, i), ...patchedSteps],
              outputBinding,
            }).issues.length === 0,
            now: Date.now
          },
          { maxOutputTokens: 8192 }
        );

        if (!heal.ok) {
          broadcastSessionEvent({ type: "self_heal_failed", toolId: toolId!, reason: heal.reason });
          await appendStepLog(run.id, {
            stepIndex: i,
            input: persistedInput,
            output: isTainted ? REDACTED_WORKFLOW_VALUE : null,
            ms: Date.now() - start,
            error: isTainted
              ? REDACTED_WORKFLOW_VALUE
              : `${res.error} · heal:${heal.reason}`
          });
          await finalizeRun(run.id, { status: "error" });
          if (toolId) await recordRunStat(toolId, false);
          return (await getRun(run.id)) as RunRecord;
        }

        // Splice in patched steps from position i onward.
        steps.splice(i, steps.length - i, ...heal.patchedSteps);
        analysis = analyzeWorkflow({ parameters, steps, outputBinding });
        taintedStepIndexes = new Set(analysis.taintedStepIndexes);
        const prevVer = toolVersion ?? 1;
        const appended = await appendVersion(toolId!, {
          basedOnVersion: prevVer,
          parameters,
          steps,
          outputBinding,
          outputSchema: versionOutputSchema,
          note: `自愈修复 step ${i}`
        });
        if (appended.kind !== "steps" || appended.activeVersion == null) {
          throw new Error("self_heal_version_append_failed");
        }
        const newVer = appended.activeVersion;
        toolVersion = newVer;
        persistedTool = appended;
        healApplied = true;
        await setRunHealed(run.id, {
          fromVersion: prevVer,
          toVersion: newVer,
          fixedStepIndex: i
        });

        broadcastSessionEvent({
          type: "self_heal_completed",
          toolId: toolId!,
          newVersion: newVer,
          fixedStepIndex: i
        });

        i--; // re-run current step index with patched step
        continue;
      }

      await appendStepLog(run.id, {
        stepIndex: i,
        input: persistedInput,
        output: isTainted ? REDACTED_WORKFLOW_VALUE : res.data,
        ms: Date.now() - start
      });
      if (step.bindResultTo) bindings[step.bindResultTo] = res.data;
      lastOutput = res.data;
    }
    const finalOutputIsTainted = outputBinding === undefined
      ? taintedStepIndexes.has(steps.length - 1)
      : analysis.taintedBindings.includes(outputBinding);
    const finalOutput = finalOutputIsTainted
      ? REDACTED_WORKFLOW_VALUE
      : outputBinding === undefined
        ? lastOutput
        : bindings[outputBinding];
    await finalizeRun(run.id, { status: "ok", output: finalOutput });
    if (toolId) await recordRunStat(toolId, true);
    return (await getRun(run.id)) as RunRecord;
  } catch (e) {
    await finalizeRun(run.id, { status: "error" });
    if (toolId) await recordRunStat(toolId, false);
    throw e;
  }
}

async function injectMainWorld(tabId: number, source: string, args: Json): Promise<Json> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [source, args],
    func: (src: string, a: unknown) => {
      let fn: (ctx: unknown) => Promise<unknown>;
      try {
        // eslint-disable-next-line no-new-func
        fn = new Function(
          "ctx",
          `"use strict"; return (async (ctx) => { ${src} })(ctx);`
        ) as (ctx: unknown) => Promise<unknown>;
      } catch (e) {
        return {
          __ok: false as const,
          phase: "compile" as const,
          errorName: e instanceof Error ? e.name : undefined,
          error: e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        };
      }
      return Promise.resolve(fn(a)).then(
        (v) => ({ __ok: true as const, value: v }),
        (e: unknown) => ({
          __ok: false as const,
          phase: "runtime" as const,
          errorName: e instanceof Error ? e.name : undefined,
          error:
            e instanceof Error
              ? `${e.name}: ${e.message}\n${e.stack ?? ""}`.trim()
              : String(e)
        })
      );
    }
  });
  const result = res?.result;
  if (
    result &&
    typeof result === "object" &&
    "__ok" in (result as Record<string, unknown>)
  ) {
    const wrapped = result as {
      __ok: boolean;
      value?: unknown;
      phase?: "compile" | "runtime";
      errorName?: string;
      error?: string;
    };
    if (wrapped.__ok) return ((wrapped.value ?? null) as Json);
    if (isCspCompileFailure(wrapped)) return evaluateWithCdp(tabId, source, args);
    throw new Error(`runJS error: ${wrapped.error ?? "(unknown)"}`);
  }
  return (result ?? null) as Json;
}

function isCspCompileFailure(result: {
  phase?: "compile" | "runtime";
  errorName?: string;
  error?: string;
}): boolean {
  return result.phase === "compile" &&
    result.errorName === "EvalError" &&
    /unsafe-eval|content security policy|refused to evaluate a string|evaluating a string as javascript/i.test(
      result.error ?? ""
    );
}

async function listTabsRpc(windowId?: number): Promise<{
  tabs: Array<{ tabId: number; windowId: number; url: string; title: string }>;
}> {
  const query: chrome.tabs.QueryInfo = windowId == null ? {} : { windowId };
  const all = await chrome.tabs.query(query);
  const tabs = all
    .filter((t) => t.id != null && !t.incognito && isAccessibleUrl(t.url ?? ""))
    .map((t) => ({
      tabId: t.id as number,
      windowId: t.windowId,
      url: t.url ?? "",
      title: t.title ?? ""
    }));
  return { tabs };
}

async function openTabRpc(input: {
  url: string;
  active?: boolean;
  incognito?: boolean;
  windowId?: number;
}): Promise<{
  tabId: number;
  windowId: number;
  incognito: boolean;
  url: string;
  title: string;
}> {
  if (!isAccessibleUrl(input.url)) throw new Error("openTab: URL scheme not allowed");
  return openTabInBrowser(input);
}

function isAccessibleUrl(url: string): boolean {
  if (!url) return false;
  return /^https?:|^file:|^ftp:/.test(url);
}
