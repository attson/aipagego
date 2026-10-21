import { z } from "zod";
import {
  ContentRequest as ContentRequestSchema,
  RpcRequest as RpcRequestSchema,
  StepSchema,
  type RpcRequest
} from "@aipagego/shared/messages";
import { runStaticScan } from "@aipagego/shared/static-scan";
import type { Json, RunRecord, Step, ToolDraft } from "@aipagego/shared/types";
import { fetchAsBase64, httpRequest } from "./http-proxy";
import { attemptHeal } from "./self-heal";
import { requestSidepanelLlm } from "./self-heal-bridge";
import { exportAll, importBundle } from "./storage/export-import";
import { appendStepLog, createRun, finalizeRun, getRun, listRuns, setRunHealed } from "./storage/runs";
import {
  appendVersion,
  deleteTool as deleteToolDb,
  getTool,
  listTools,
  matchingTools,
  materializePreset,
  recordRunStat,
  saveDraft
} from "./storage/tools";
import { classifyTool } from "@/sidepanel/chat/severity";
import { registerInjectMain } from "./recorder/host";
import { registerCaptureDeps } from "./bg-tools/capture";
import { META_TOOLS, isMetaTool } from "./meta-tool-router";
import { readPolicyForTab } from "@/injection-policy";
import { injectionModeRank } from "@aipagego/shared";
import type { InjectionMode } from "@aipagego/shared/types";
import { DRAIN_SOURCE } from "@/content/recorder/drain";
import { evaluateWithCdp } from "./recorder/cdp";

// Wired here rather than imported by the host to avoid a circular import.
registerInjectMain((tabId, source, args) => injectMainWorld(tabId, source, args));
registerCaptureDeps({
  runStep: ({ step, tabId, attachedTabIds, bindings }) =>
    runOneStep(step, tabId, attachedTabIds ?? [], bindings ?? {})
});

async function readLlmSettings(): Promise<{
  selfHealEnabled: boolean;
  maxSelfHealOutputTokens: number;
  apiKey: string;
}> {
  const KEY = "aipagego.llm";
  const raw = (await chrome.storage.local.get([KEY]))[KEY] ?? {};
  const session = (await chrome.storage.session?.get([KEY]))?.[KEY] ?? {};
  const apiKey = (raw as Record<string, string>).apiKey || (session as Record<string, string>).apiKey || "";
  return {
    selfHealEnabled: (raw as Record<string, unknown>).selfHealEnabled !== false, // default true
    maxSelfHealOutputTokens: ((raw as Record<string, unknown>).maxSelfHealOutputTokens as number | undefined) ?? 4096,
    apiKey
  };
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

export async function handleRpc(raw: unknown): Promise<{ ok: true; data: Json } | { ok: false; error: string }> {
  const parsed = RpcRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid request: " + parsed.error.message };
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
    case "tools.import": {
      const result = await importBundle(req.bundle as Parameters<typeof importBundle>[0], {
        onConflict: "skip"
      });
      return result as unknown as Json;
    }
    case "runs.start":
      return (await runTool(req)) as unknown as Json;
    case "runs.list":
      return (await listRuns({ toolId: req.toolId })) as unknown as Json;
    case "runs.get":
      return ((await getRun(req.id)) ?? null) as unknown as Json;
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
      return (await openTabRpc(req.url, req.active ?? false)) as unknown as Json;
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
    case "presets.list": {
      const { PRESETS } = await import("@aipagego/shared/presets");
      return PRESETS as unknown as Json;
    }
    case "presets.materialize": {
      return (await materializePreset(req.presetId)) as unknown as Json;
    }
    case "widget.openSidepanel": {
      await chrome.sidePanel.open({ tabId: req.tabId });
      if (req.pendingApprovalId) {
        await chrome.storage.session.set({
          "aipagego.pendingApproval": {
            tabId: req.tabId,
            approvalId: req.pendingApprovalId,
            ts: Date.now()
          }
        });
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
  bindings: Record<string, Json>
): Promise<Json> {
  let targetTabId = rpcTabId;
  if (step.kind === "tool") {
    const argsObj = (step.args ?? {}) as Record<string, Json>;
    const declared = argsObj.tabId;
    // 模型常把 tabId 误填为 0/null 表示"当前 tab"——视为未传，用会话 tab。
    if (typeof declared === "number" && declared > 0) targetTabId = declared;
  }
  if (targetTabId !== rpcTabId && !attachedTabIds.includes(targetTabId)) {
    throw new Error(`tab ${targetTabId} not attached; call attachTab first or omit tabId`);
  }

  const policy = await readPolicyForTab(targetTabId);
  const requiredMode = minimumModeForStep(step);
  if (injectionModeRank(policy.injectionMode) < injectionModeRank(requiredMode)) {
    throw new Error(
      `站点注入策略为「${modeLabel(policy.injectionMode)}」，${step.kind === "tool" ? step.tool : "runJS"} 需要「${modeLabel(requiredMode)}」或更高级别`
    );
  }

  if (requiredMode === "diagnostic") await setRecorderPolicy(targetTabId, true);

  // Meta tools run here in the service worker. Dispatching before the content
  // script hop is what lets the coordinator / MCP EXEC path reach them; the
  // side panel used to be the only caller that could.
  if (step.kind === "tool" && isMetaTool(step.tool)) {
    const metaArgs = {
      ...((step.args ?? {}) as Record<string, Json>),
      allowedTabIds: [rpcTabId, ...attachedTabIds]
    } as unknown as Json;
    return META_TOOLS[step.tool](metaArgs, targetTabId);
  }

  const stepReq = ContentRequestSchema.parse({
    type: "content.runStep",
    step,
    bindings
  });
  let res: { ok: true; data: Json } | { ok: false; error: string } | undefined;
  try {
    res = (await chrome.tabs.sendMessage(targetTabId, stepReq)) as typeof res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isReceiverMissing(msg)) throw e;
    // content script 还没在该 tab 上加载——尝试动态注入
    const injected = await injectContentScript(targetTabId);
    if (!injected) {
      throw new Error(
        "Content script 无法注入到此页面（可能是 chrome:// 或受限页面）。请在普通网页上重试。"
      );
    }
    // 注入完成后 listener 注册可能还需要几百 ms（@crxjs ESM loader 异步）
    res = await retryUntilReady(targetTabId, stepReq);
  }
  // Defensive: chrome.tabs.sendMessage resolves to undefined if the content
  // script's listener closes the channel without sending a response (e.g.
  // schema validation failure on an unknown tool name). Surface that as a
  // clear error rather than letting `res.ok` blow up.
  if (res == null) {
    throw new Error(
      `content script returned no response for ${step.kind === "tool" ? step.tool : "runJS"} — likely an unknown tool name or stale content script. Try reloading the tab.`
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

async function runTool(req: Extract<RpcRequest, { type: "runs.start" }>): Promise<RunRecord> {
  let steps: Step[];
  let toolId: string | null = null;
  let toolVersion: number | null = null;
  if (req.target.kind === "draft") {
    if (req.target.draft.kind !== "steps") throw new Error("draft runs require steps tools");
    steps = req.target.draft.steps as Step[];
  } else {
    const tool = await getTool(req.target.id);
    if (!tool) throw new Error("tool not found");
    if (tool.kind !== "steps") throw new Error("prompt tools run in chat, not background runner");
    steps = tool.steps;
    toolId = tool.id;
    toolVersion = tool.versions.at(-1)?.version ?? 1;
  }

  const tab = await chrome.tabs.get(req.tabId);
  const url = tab.url ?? "";
  const run = await createRun({ toolId, toolVersion, url });

  const bindings: Record<string, Json> = {};
  let lastOutput: Json = null;

  // Self-heal is only available for persisted tools (not drafts) with LLM configured.
  const settings = await readLlmSettings();
  const allowHeal =
    req.target.kind === "tool" &&
    settings.selfHealEnabled &&
    (settings.apiKey?.length ?? 0) > 0;
  let healApplied = false;

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const start = Date.now();
      const stepReq = ContentRequestSchema.parse({
        type: "content.runStep",
        step,
        bindings
      });
      const res = (await chrome.tabs.sendMessage(req.tabId, stepReq)) as
        | { ok: true; data: Json }
        | { ok: false; error: string };

      if (!res.ok) {
        // Decide whether to attempt self-heal.
        const canHeal =
          allowHeal &&
          !healApplied &&
          step.kind === "tool" &&
          classifyTool(step.tool, step.args as Json) !== "dangerous";

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
            input: step.kind === "tool" ? (step.args as Json) : step.source,
            output: null,
            ms: Date.now() - start,
            error: res.error
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

        const domSnapshot = await runOneStep(
          { kind: "tool", tool: "snapshotDOM", args: {} } as Step,
          req.tabId,
          [],
          {}
        ).catch(() => ({} as Json));

        const prevSteps = await collectPrevSteps(run.id);

        const heal = await attemptHeal(
          {
            tool: (await getTool(toolId!))! as Extract<Awaited<ReturnType<typeof getTool>>, { kind: "steps" }>,
            failedStepIndex: i,
            failedInput: step,
            errorText: res.error,
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
            parseSteps: (raw) => {
              const parsed = z.array(StepSchema).safeParse(raw);
              return parsed.success ? (parsed.data as Step[]) : null;
            },
            now: Date.now
          },
          { maxOutputTokens: settings.maxSelfHealOutputTokens }
        );

        if (!heal.ok) {
          broadcastSessionEvent({ type: "self_heal_failed", toolId: toolId!, reason: heal.reason });
          await appendStepLog(run.id, {
            stepIndex: i,
            // At this point step is always a tool step (canHeal check above requires step.kind === "tool")
            input: (step as Extract<Step, { kind: "tool" }>).args as Json,
            output: null,
            ms: Date.now() - start,
            error: `${res.error} · heal:${heal.reason}`
          });
          await finalizeRun(run.id, { status: "error" });
          if (toolId) await recordRunStat(toolId, false);
          return (await getRun(run.id)) as RunRecord;
        }

        // Splice in patched steps from position i onward.
        steps.splice(i, steps.length - i, ...heal.patchedSteps);
        const prevVer = toolVersion ?? 1;
        const newVer = prevVer + 1;
        const currentTool = (await getTool(toolId!))!;
        await appendVersion(toolId!, {
          steps,
          outputSchema: (currentTool.kind === "steps" ? currentTool.outputSchema : {}) as import("@aipagego/shared/types").JsonSchema,
          note: `自愈修复 step ${i}`
        });
        healApplied = true;
        await setRunHealed(run.id, {
          fromVersion: prevVer,
          toVersion: newVer,
          fixedStepIndex: i
        }).catch(() => {});

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
        input: step.kind === "tool" ? (step.args as Json) : step.source,
        output: res.data,
        ms: Date.now() - start
      });
      if (step.bindResultTo) bindings[step.bindResultTo] = res.data;
      lastOutput = res.data;
    }
    await finalizeRun(run.id, { status: "ok", output: lastOutput });
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

async function openTabRpc(url: string, active: boolean): Promise<{
  tabId: number; url: string; title: string;
}> {
  if (!isAccessibleUrl(url)) throw new Error("openTab: URL scheme not allowed");
  const tab = await chrome.tabs.create({ url, active });
  if (tab.id == null) throw new Error("openTab: chrome did not return a tab id");
  return { tabId: tab.id, url: tab.url ?? url, title: tab.title ?? "" };
}

function isAccessibleUrl(url: string): boolean {
  if (!url) return false;
  return /^https?:|^file:|^ftp:/.test(url);
}
