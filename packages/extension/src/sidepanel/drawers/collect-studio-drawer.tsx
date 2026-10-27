import { useEffect, useRef, useState } from "react";
import {
  CollectionRecipeSchema,
  MAX_COLLECTION_BYTES,
  MAX_COLLECTION_FIELDS,
  MAX_COLLECTION_PAGES,
  MAX_COLLECTION_ROWS,
  type CollectionField,
  type CollectionPagination,
  type CollectionPreview,
  type CollectionRecipeV1,
  type CollectionRow,
  type CollectionRunSnapshot,
  type CollectionValueMode,
} from "@aipagego/shared/collection";
import type { Json } from "@aipagego/shared/types";
import type { Connector } from "@aipagego/shared/connectors";
import { useUi } from "@/sidepanel/chat/ui-store";
import { useSettings } from "@/sidepanel/chat/settings-store";
import type { CollectionStudioHandoff } from "@/sidepanel/chat/collection-handoff";
import { pickClient } from "@/sidepanel/llm/client";
import { recommendCollectionRecipe } from "@/sidepanel/llm/collection-recipe-generator";
import { rpc } from "@/sidepanel/rpc";
import { Drawer } from "@/sidepanel/shell/drawer";
import { requestOptionalPermission } from "@/permissions/optional-permissions";
import { PermissionRequestCard } from "@/sidepanel/components/permission-request-card";
import {
  prepareCollectionExport,
  triggerCollectionDownload,
  type CollectionExportFormat,
} from "@/sidepanel/lib/collection-export";

type EditableField = CollectionField & { dedupe: boolean };
type CaptureTarget =
  | { kind: "item" }
  | { kind: "field"; fieldId: string }
  | { kind: "next" };

export type WorkflowCollectionEdit = {
  recipe: CollectionRecipeV1;
  onApply: (recipe: CollectionRecipeV1) => void;
  onCancel: () => void;
};

const COLLECTION_TOOL_TIMEOUT_MS = 600_000;
const COLLECTION_RUN_SUMMARY_OUTPUT_SCHEMA: Json = {
  type: "object",
  properties: {
    runId: { type: "string" },
    resultId: { type: "string" },
    sourceUrl: { type: "string" },
    status: { type: "string", enum: ["completed", "partial"] },
    stopReason: { type: "string" },
    rowCount: { type: "integer" },
    byteSize: { type: "integer" },
    pageCount: { type: "integer" },
    duplicateCount: { type: "integer" },
    missingRequiredCount: { type: "integer" },
    preview: { type: "array", maxItems: 5 },
    startedAt: { type: "integer" },
    finishedAt: { type: "integer" },
  },
  required: [
    "runId", "resultId", "sourceUrl", "status", "stopReason", "rowCount",
    "byteSize", "pageCount", "duplicateCount", "missingRequiredCount",
    "preview", "startedAt", "finishedAt",
  ],
};

function defaultCollectionUrlPattern(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const origin = url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin;
    return `${origin}/**`;
  } catch {
    return "";
  }
}

function defaultCollectionToolName(rawUrl: string): string {
  try {
    return `采集 ${new URL(rawUrl).hostname}`;
  } catch {
    return "结构化采集";
  }
}

function initialField(index = 1): EditableField {
  return {
    id: `field_${index}`,
    name: `字段 ${index}`,
    selector: index === 1 ? "h1" : ".selector",
    valueMode: "text",
    required: index === 1,
    dedupe: false,
  };
}

function buildRecipe(
  mode: "single" | "list",
  itemSelector: string,
  fields: EditableField[],
  paginationKind: CollectionPagination["kind"],
  nextSelector: string,
  maxPages: number,
  maxRows: number
): CollectionRecipeV1 {
  return CollectionRecipeSchema.parse({
    version: 1,
    mode,
    ...(mode === "list" ? { itemSelector } : {}),
    fields: fields.map(({ dedupe: _dedupe, ...field }) => field),
    pagination: paginationKind === "single"
      ? { kind: "single" }
      : paginationKind === "infiniteScroll"
        ? { kind: "infiniteScroll", maxPages }
        : { kind: paginationKind, selector: nextSelector, maxPages },
    dedupeBy: fields.filter((field) => field.dedupe).map((field) => field.id),
    maxRows,
    maxBytes: MAX_COLLECTION_BYTES,
  });
}

function friendlyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isForbiddenError(message: string): boolean {
  return message.includes("站点注入策略") || message.includes("无法注入") || message.includes("受限页面");
}

function connectorTarget(connector: Connector): string {
  return connector.publicConfig.kind === "webhook"
    ? connector.publicConfig.endpointOrigin
    : `${connector.publicConfig.region === "feishu" ? "飞书" : "Lark"} · ${connector.publicConfig.appToken} / ${connector.publicConfig.tableId}`;
}

export function CollectStudioDrawer({
  currentTabId,
  currentUrl,
  handoff,
  onHandoffConsumed,
  workflowEdit,
}: {
  currentTabId: number | null;
  currentUrl: string;
  handoff?: CollectionStudioHandoff | null;
  onHandoffConsumed?: (id: string) => void;
  workflowEdit?: WorkflowCollectionEdit | null;
}) {
  const opened = useUi((state) => state.openedDrawer);
  const close = useUi((state) => state.close);
  const isOpen = opened === "collect";
  const wasOpen = useRef(false);
  const nextFieldIndex = useRef(2);
  const captureTarget = useRef<CaptureTarget | null>(null);
  const previewRevision = useRef(0);
  const recommendationRevision = useRef(0);
  const lastHandoffId = useRef<string | null>(null);
  const activeRunId = useRef<string | null>(null);
  const runRefreshRevision = useRef(0);
  const connectorLoadRevision = useRef(0);

  const [targetTabId, setTargetTabId] = useState<number | null>(null);
  const [targetUrl, setTargetUrl] = useState("");
  const [handoffSample, setHandoffSample] = useState<Json | null>(null);
  const [mode, setMode] = useState<"single" | "list">("single");
  const [itemSelector, setItemSelector] = useState(".item");
  const [paginationKind, setPaginationKind] = useState<CollectionPagination["kind"]>("single");
  const [nextSelector, setNextSelector] = useState(".next");
  const [maxPages, setMaxPages] = useState(20);
  const [maxRows, setMaxRows] = useState(MAX_COLLECTION_ROWS);
  const [fields, setFields] = useState<EditableField[]>([initialField()]);
  const [preview, setPreview] = useState<CollectionPreview | null>(null);
  const [state, setState] = useState<"default" | "loading" | "error" | "forbidden">("default");
  const [error, setError] = useState<string | null>(null);
  const [recommendationState, setRecommendationState] = useState<"idle" | "loading" | "error">("idle");
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runTargetTabId, setRunTargetTabId] = useState<number | null>(null);
  const [runSnapshot, setRunSnapshot] = useState<CollectionRunSnapshot | null>(null);
  const [resultRows, setResultRows] = useState<CollectionRow[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<
    | { status: "idle" }
    | { status: "loading"; format: CollectionExportFormat }
    | { status: "permission"; format: CollectionExportFormat; error?: string }
    | { status: "success"; format: CollectionExportFormat; rowCount: number }
    | { status: "error"; format: CollectionExportFormat; error: string }
  >({ status: "idle" });
  const [toolName, setToolName] = useState("");
  const [urlPattern, setUrlPattern] = useState("");
  const [saveState, setSaveState] = useState<
    | { status: "idle" }
    | { status: "saving" }
    | { status: "success"; toolId: string }
    | { status: "error"; error: string }
  >({ status: "idle" });
  const [readyConnectors, setReadyConnectors] = useState<Connector[]>([]);
  const [connectorLoadState, setConnectorLoadState] = useState<
    | { status: "idle" | "loading" | "ready" }
    | { status: "error"; error: string }
  >({ status: "idle" });
  const [sendConnectorId, setSendConnectorId] = useState("");
  const [sendConfirmationOpen, setSendConfirmationOpen] = useState(false);
  const [sendConfirmed, setSendConfirmed] = useState(false);
  const [sendState, setSendState] = useState<
    | { status: "idle" }
    | { status: "sending" }
    | { status: "success" }
    | { status: "error"; error: string }
  >({ status: "idle" });

  function invalidatePreview() {
    previewRevision.current += 1;
    recommendationRevision.current += 1;
    setPreview(null);
    setError(null);
    setState("default");
    setSaveState({ status: "idle" });
  }

  function loadRecipe(recipe: CollectionRecipeV1): void {
    setMode(recipe.mode);
    setItemSelector(recipe.itemSelector ?? ".item");
    setFields(recipe.fields.map((field) => ({
      ...field,
      dedupe: recipe.dedupeBy.includes(field.id)
    })));
    setPaginationKind(recipe.pagination.kind);
    setNextSelector(
      recipe.pagination.kind === "next" || recipe.pagination.kind === "loadMore"
        ? recipe.pagination.selector
        : ".next"
    );
    setMaxPages(recipe.pagination.kind === "single" ? 20 : recipe.pagination.maxPages);
    setMaxRows(recipe.maxRows);
    nextFieldIndex.current = recipe.fields.length + 1;
  }

  useEffect(() => {
    if (isOpen !== wasOpen.current) {
      previewRevision.current += 1;
      recommendationRevision.current += 1;
      captureTarget.current = null;
    }
    if (isOpen && !wasOpen.current) {
      const nextTabId = handoff?.tabId ?? currentTabId;
      const nextUrl = handoff?.url ?? currentUrl;
      setTargetTabId(nextTabId);
      setTargetUrl(nextUrl);
      setToolName(defaultCollectionToolName(nextUrl));
      setUrlPattern(defaultCollectionUrlPattern(nextUrl));
      setSaveState({ status: "idle" });
      setHandoffSample(handoff?.sample ?? null);
      setPreview(null);
      setError(null);
      setState("default");
      setRecommendationState("idle");
      setRecommendationError(null);
      if (workflowEdit) loadRecipe(workflowEdit.recipe);
      if (runTargetTabId != null && runTargetTabId !== nextTabId) {
        runRefreshRevision.current += 1;
        activeRunId.current = null;
        setRunId(null);
        setRunTargetTabId(null);
        setRunSnapshot(null);
        setResultRows([]);
        setRunError(null);
      }
    }
    wasOpen.current = isOpen;
  }, [currentTabId, currentUrl, handoff, isOpen, workflowEdit]);

  useEffect(() => {
    if (!isOpen || !handoff || handoff.id === lastHandoffId.current) return;
    lastHandoffId.current = handoff.id;
    previewRevision.current += 1;
    recommendationRevision.current += 1;
    captureTarget.current = null;
    setTargetTabId(handoff.tabId);
    setTargetUrl(handoff.url);
    setToolName(defaultCollectionToolName(handoff.url));
    setUrlPattern(defaultCollectionUrlPattern(handoff.url));
    setSaveState({ status: "idle" });
    setHandoffSample(handoff.sample);
    setPreview(null);
    setError(null);
    setState("default");
    setRecommendationState("idle");
    setRecommendationError(null);
    activeRunId.current = null;
    runRefreshRevision.current += 1;
    setRunId(null);
    setRunTargetTabId(null);
    setRunSnapshot(null);
    setResultRows([]);
    setExportState({ status: "idle" });
    setRunError(null);
    onHandoffConsumed?.(handoff.id);
  }, [handoff, isOpen, onHandoffConsumed]);

  useEffect(() => {
    if (!isOpen) return;
    const listener = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const capture = message as { type?: string; selector?: string };
      if (capture.type === "collection.progress") {
        const progress = message as { runId?: string };
        if (progress.runId && progress.runId === activeRunId.current) {
          void refreshRunSnapshot(progress.runId);
        }
        return;
      }
      if (capture.type !== "aipagego.captureResult" || !capture.selector) return;
      const target = captureTarget.current;
      captureTarget.current = null;
      if (target?.kind === "item") {
        setItemSelector(capture.selector);
      } else if (target?.kind === "next") {
        setNextSelector(capture.selector);
      } else if (target?.kind === "field") {
        setFields((current) => current.map((field) =>
          field.id === target.fieldId ? { ...field, selector: capture.selector! } : field
        ));
      }
      if (target) invalidatePreview();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !runId) return;
    activeRunId.current = runId;
    void refreshRunSnapshot(runId);
  }, [isOpen, runId]);

  async function loadReadyConnectors(): Promise<void> {
    const revision = ++connectorLoadRevision.current;
    setConnectorLoadState({ status: "loading" });
    try {
      const connectors = await rpc.listConnectors();
      if (revision !== connectorLoadRevision.current) return;
      const available = connectors.filter((connector) =>
        connector.status === "ready" && connector.credentialConfigured
      );
      setReadyConnectors(available);
      setSendConnectorId((current) =>
        available.some((connector) => connector.id === current) ? current : available[0]?.id ?? ""
      );
      setConnectorLoadState({ status: "ready" });
    } catch (connectorFailure) {
      if (revision !== connectorLoadRevision.current) return;
      setReadyConnectors([]);
      setConnectorLoadState({ status: "error", error: friendlyError(connectorFailure) });
    }
  }

  useEffect(() => {
    if (!isOpen) {
      connectorLoadRevision.current += 1;
      return;
    }
    void loadReadyConnectors();
  }, [isOpen]);

  function updateField(fieldId: string, patch: Partial<EditableField>) {
    setFields((current) => current.map((field) =>
      field.id === fieldId ? { ...field, ...patch } : field
    ));
    invalidatePreview();
  }

  function moveField(index: number, delta: -1 | 1) {
    const destination = index + delta;
    if (destination < 0 || destination >= fields.length) return;
    setFields((current) => {
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
    invalidatePreview();
  }

  function addField() {
    if (fields.length >= MAX_COLLECTION_FIELDS) return;
    setFields((current) => {
      if (current.length >= MAX_COLLECTION_FIELDS) return current;
      let index = nextFieldIndex.current;
      while (current.some((field) =>
        field.id === `field_${index}` || field.name === `字段 ${index}`
      )) {
        index += 1;
      }
      nextFieldIndex.current = index + 1;
      return [...current, initialField(index)];
    });
    invalidatePreview();
  }

  async function startCapture(target: CaptureTarget) {
    if (targetTabId == null) {
      setError("没有可用的目标标签页");
      setState("forbidden");
      return;
    }
    captureTarget.current = target;
    try {
      await rpc.startElementCapture(targetTabId);
    } catch (captureError) {
      captureTarget.current = null;
      const message = friendlyError(captureError);
      setError(message);
      setState(isForbiddenError(message) ? "forbidden" : "error");
    }
  }

  async function refreshPreview() {
    if (targetTabId == null) {
      setError("没有可用的目标标签页");
      setState("forbidden");
      return;
    }
    setState("loading");
    setError(null);
    const revision = ++previewRevision.current;
    try {
      const recipe = buildRecipe(mode, itemSelector, fields, paginationKind, nextSelector, maxPages, maxRows);
      const result = await rpc.previewCollection({ tabId: targetTabId, recipe });
      if (revision !== previewRevision.current) return;
      setPreview(result);
      setState("default");
    } catch (previewError) {
      if (revision !== previewRevision.current) return;
      const message = friendlyError(previewError);
      setError(message);
      setState(isForbiddenError(message) ? "forbidden" : "error");
    }
  }

  async function requestRecommendation() {
    if (targetTabId == null) {
      setRecommendationError("没有可用的目标标签页");
      setRecommendationState("error");
      return;
    }
    const revision = ++recommendationRevision.current;
    setRecommendationState("loading");
    setRecommendationError(null);
    try {
      const settings = useSettings.getState();
      const recipe = await recommendCollectionRecipe({
        client: pickClient(settings.provider),
        apiKey: settings.apiKey,
        model: settings.model,
        endpoint: settings.endpoint,
        maxTokens: settings.maxTokens,
        tabId: targetTabId,
        url: targetUrl,
        sample: handoffSample,
        runStep: (step, tabId) => rpc.runOneStep({
          step,
          tabId,
          attachedTabIds: [],
          bindings: {},
        }),
      });
      if (revision !== recommendationRevision.current) return;
      setMode(recipe.mode);
      setItemSelector(recipe.itemSelector ?? ".item");
      setFields(recipe.fields.map((field) => ({
        ...field,
        dedupe: recipe.dedupeBy.includes(field.id),
      })));
      setPaginationKind(recipe.pagination.kind);
      if (recipe.pagination.kind === "next" || recipe.pagination.kind === "loadMore") {
        setNextSelector(recipe.pagination.selector);
      }
      if (recipe.pagination.kind !== "single") {
        setMaxPages(recipe.pagination.maxPages);
      }
      setMaxRows(recipe.maxRows);
      previewRevision.current += 1;
      setPreview(null);
      setError(null);
      setState("default");
      setRecommendationState("idle");
    } catch (recommendationFailure) {
      if (revision !== recommendationRevision.current) return;
      setRecommendationError(friendlyError(recommendationFailure));
      setRecommendationState("error");
    }
  }

  async function refreshRunSnapshot(id: string) {
    const revision = ++runRefreshRevision.current;
    try {
      const snapshot = await rpc.getCollectionRun(id);
      if (revision !== runRefreshRevision.current || activeRunId.current !== id || !snapshot) return;
      setRunSnapshot(snapshot);
      setRunError(snapshot.error ?? null);
      if (snapshot.summary && !snapshot.resultExpired) {
        const page = await rpc.readCollectionResult({
          resultId: snapshot.resultId,
          offset: 0,
          limit: 50,
        });
        if (revision === runRefreshRevision.current && activeRunId.current === id) {
          setResultRows(page.rows);
        }
      }
    } catch (runFailure) {
      if (revision === runRefreshRevision.current && activeRunId.current === id) {
        setRunError(friendlyError(runFailure));
      }
    }
  }

  async function startCollection() {
    if (targetTabId == null) {
      setRunError("没有可用的目标标签页");
      return;
    }
    setRunError(null);
    setRunSnapshot(null);
    setResultRows([]);
    setExportState({ status: "idle" });
    setSendConfirmationOpen(false);
    setSendConfirmed(false);
    setSendState({ status: "idle" });
    runRefreshRevision.current += 1;
    try {
      const recipe = buildRecipe(mode, itemSelector, fields, paginationKind, nextSelector, maxPages, maxRows);
      const started = await rpc.startCollection({ tabId: targetTabId, recipe });
      activeRunId.current = started.runId;
      setRunId(started.runId);
      setRunTargetTabId(targetTabId);
      await refreshRunSnapshot(started.runId);
    } catch (runFailure) {
      setRunError(friendlyError(runFailure));
    }
  }

  async function cancelCollection() {
    const id = activeRunId.current;
    if (!id) return;
    try {
      await rpc.cancelCollection(id);
      await refreshRunSnapshot(id);
    } catch (cancelFailure) {
      setRunError(friendlyError(cancelFailure));
    }
  }

  async function exportCollection(format: CollectionExportFormat) {
    const snapshot = runSnapshot;
    if (!snapshot?.summary || snapshot.resultExpired) {
      setExportState({ status: "error", format, error: "当前没有可导出的本地结果" });
      return;
    }
    if (!snapshot.recipe) {
      setExportState({ status: "error", format, error: "结果缺少采集配方，无法确定字段顺序" });
      return;
    }
    setExportState({ status: "loading", format });
    try {
      // Called before any other await so Chrome sees the original button click
      // as the user gesture for optional permission prompting.
      const permission = await requestOptionalPermission("downloads");
      if (!permission.granted) {
        setExportState({ status: "permission", format });
        return;
      }
      const prepared = await prepareCollectionExport({
        format,
        summary: snapshot.summary,
        fields: snapshot.recipe.fields,
        readPage: rpc.readCollectionResult,
      });
      await triggerCollectionDownload(prepared);
      setExportState({ status: "success", format, rowCount: prepared.rowCount });
    } catch (exportFailure) {
      setExportState({ status: "error", format, error: friendlyError(exportFailure) });
    }
  }

  async function sendCollectionResult() {
    const snapshot = runSnapshot;
    if (!snapshot?.summary || snapshot.resultExpired || !sendConnectorId || !sendConfirmed) return;
    setSendState({ status: "sending" });
    try {
      await rpc.createDelivery(sendConnectorId, {
        kind: "collection_result",
        resultId: snapshot.resultId,
      });
      setSendState({ status: "success" });
      setSendConfirmationOpen(false);
      setSendConfirmed(false);
    } catch (sendFailure) {
      setSendState({ status: "error", error: friendlyError(sendFailure) });
    }
  }

  async function saveCollectionTool() {
    const name = toolName.trim();
    const pattern = urlPattern.trim();
    if (!name || !pattern) {
      setSaveState({ status: "error", error: "请填写工具名称和 URL 匹配规则" });
      return;
    }
    setSaveState({ status: "saving" });
    try {
      const recipe = buildRecipe(mode, itemSelector, fields, paginationKind, nextSelector, maxPages, maxRows);
      const saved = await rpc.saveTool({
        kind: "steps",
        name,
        urlPatterns: [pattern],
        description: "由采集工作台固化的结构化采集配方",
        steps: [{
          kind: "tool",
          tool: "collectStructuredData",
          args: { recipe },
          timeoutMs: COLLECTION_TOOL_TIMEOUT_MS,
        }],
        outputSchema: COLLECTION_RUN_SUMMARY_OUTPUT_SCHEMA,
      });
      setSaveState({ status: "success", toolId: saved.id });
    } catch (saveFailure) {
      setSaveState({ status: "error", error: friendlyError(saveFailure) });
    }
  }

  return (
    <Drawer
      open={isOpen}
      title={workflowEdit ? "采集工作台 · 编辑工作流 Recipe" : "采集工作台"}
      onClose={workflowEdit ? workflowEdit.onCancel : close}
    >
      <div className="p-3 space-y-3 text-xs text-zinc-200" data-testid="collect-studio">
        {workflowEdit ? (
          <section className="rounded-lg border border-sky-800 bg-sky-950/20 p-3 space-y-2">
            <div className="font-medium text-sky-100">应用到 Workflow 草稿</div>
            <div className="text-[10px] text-sky-300">这里只更新当前 collectStructuredData Step，不保存工具、不发布版本。</div>
            <div className="flex gap-2">
              <button
                type="button"
                aria-label="应用到工作流草稿"
                disabled={fields.length === 0}
                onClick={() => workflowEdit.onApply(buildRecipe(
                  mode,
                  itemSelector,
                  fields,
                  paginationKind,
                  nextSelector,
                  maxPages,
                  maxRows
                ))}
                className="rounded bg-sky-700 px-2 py-1 text-white disabled:opacity-40"
              >应用到工作流草稿</button>
              <button type="button" onClick={workflowEdit.onCancel} className="rounded bg-zinc-700 px-2 py-1">取消</button>
            </div>
          </section>
        ) : null}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="font-medium text-zinc-100">1. 选择采集模式和样本</div>
              <div className="text-[10px] text-zinc-500">目标 tab #{targetTabId ?? "不可用"} · 打开期间保持固定</div>
                {targetUrl && <div className="max-w-[220px] truncate text-[10px] text-zinc-600">{targetUrl}</div>}
            </div>
            <div className="flex rounded-md border border-zinc-700 p-0.5">
              <button
                type="button"
                aria-label="单条详情模式"
                onClick={() => { setMode("single"); invalidatePreview(); }}
                className={`rounded px-2 py-1 ${mode === "single" ? "bg-emerald-700 text-white" : "text-zinc-400"}`}
              >单条详情</button>
              <button
                type="button"
                aria-label="列表模式"
                onClick={() => { setMode("list"); invalidatePreview(); }}
                className={`rounded px-2 py-1 ${mode === "list" ? "bg-emerald-700 text-white" : "text-zinc-400"}`}
              >列表</button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="AI 识别当前页"
              disabled={targetTabId == null || recommendationState === "loading"}
              onClick={() => void requestRecommendation()}
              className="rounded bg-violet-800 px-2 py-1 text-white disabled:opacity-40"
            >{recommendationState === "loading" ? "AI 识别中…" : "AI 识别当前页"}</button>
            <span className="text-[10px] text-zinc-500">只填草稿，不自动运行</span>
          </div>
          {recommendationState === "error" && recommendationError && (
            <div className="rounded border border-red-900 bg-red-950/30 p-2 text-[11px] text-red-300">
              {recommendationError}
            </div>
          )}
          {handoffSample != null && (
            <details className="rounded border border-violet-900/70 bg-violet-950/20 p-2 text-[10px] text-violet-200">
              <summary className="cursor-pointer">来自已完成对话的结构化样例</summary>
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all text-zinc-400">
                {JSON.stringify(handoffSample, null, 2)}
              </pre>
            </details>
          )}
          {mode === "list" && (
            <label className="block space-y-1">
              <span className="text-zinc-400">列表项根节点</span>
              <span className="flex gap-1">
                <input
                  aria-label="列表项选择器"
                  value={itemSelector}
                  onChange={(event) => { setItemSelector(event.target.value); invalidatePreview(); }}
                  className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
                />
                <button
                  type="button"
                  aria-label="圈选列表项"
                  onClick={() => void startCapture({ kind: "item" })}
                  className="rounded bg-zinc-700 px-2 py-1"
                >圈选</button>
              </span>
            </label>
          )}
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 space-y-2">
          <div className="font-medium text-zinc-100">2. 配置分页</div>
          <label className="block space-y-1">
            <span className="text-zinc-400">分页方式</span>
            <select
              aria-label="分页方式"
              value={paginationKind}
              onChange={(event) => {
                setPaginationKind(event.target.value as CollectionPagination["kind"]);
                invalidatePreview();
              }}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
            >
              <option value="single">仅当前页</option>
              <option value="next">下一页按钮</option>
              <option value="loadMore">加载更多按钮</option>
              <option value="infiniteScroll">无限滚动</option>
            </select>
          </label>
          {paginationKind !== "single" && (
            <div className="grid grid-cols-[1fr_72px] gap-2">
              {paginationKind !== "infiniteScroll" ? (
                <label className="space-y-1">
                  <span className="text-zinc-400">{paginationKind === "next" ? "下一页 selector" : "加载更多 selector"}</span>
                  <span className="flex gap-1">
                    <input
                      aria-label={paginationKind === "next" ? "下一页选择器" : "翻页选择器"}
                      value={nextSelector}
                      onChange={(event) => { setNextSelector(event.target.value); invalidatePreview(); }}
                      className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono"
                    />
                    <button
                      type="button"
                      aria-label={paginationKind === "next" ? "圈选下一页" : "圈选加载更多"}
                      onClick={() => void startCapture({ kind: "next" })}
                      className="rounded bg-zinc-700 px-2 py-1"
                    >圈选</button>
                  </span>
                </label>
              ) : (
                <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-2 text-[10px] text-zinc-500">
                  每轮滚至页面底部；连续两轮没有新增行时停止。
                </div>
              )}
              <label className="space-y-1">
                <span className="text-zinc-400">最多页</span>
                <input
                  aria-label="最多页数"
                  type="number"
                  min={1}
                  max={MAX_COLLECTION_PAGES}
                  value={maxPages}
                  onChange={(event) => {
                    setMaxPages(Math.min(MAX_COLLECTION_PAGES, Math.max(1, Number(event.target.value) || 1)));
                    invalidatePreview();
                  }}
                  className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
                />
              </label>
            </div>
          )}
          <label className="block space-y-1">
            <span className="text-zinc-400">最多行数</span>
            <input
              aria-label="最多行数"
              type="number"
              min={1}
              max={MAX_COLLECTION_ROWS}
              value={maxRows}
              onChange={(event) => {
                setMaxRows(Math.min(MAX_COLLECTION_ROWS, Math.max(1, Number(event.target.value) || 1)));
                invalidatePreview();
              }}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
            />
            <span className="block text-[10px] text-zinc-600">硬上限 {MAX_COLLECTION_ROWS.toLocaleString()} 行 / {(MAX_COLLECTION_BYTES / 1024 / 1024).toFixed(0)} MiB</span>
          </label>
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="font-medium text-zinc-100">3. 定义字段</div>
            <button
              type="button"
              aria-label="添加字段"
              disabled={fields.length >= MAX_COLLECTION_FIELDS}
              onClick={addField}
              className="rounded bg-zinc-700 px-2 py-1 disabled:opacity-40"
            >＋ 添加字段</button>
          </div>

          {fields.length === 0 ? (
            <div className="rounded border border-dashed border-zinc-700 p-4 text-center text-zinc-500">
              还没有字段，请先添加字段再预览。
            </div>
          ) : fields.map((field, index) => (
            <div key={field.id} className="rounded-md border border-zinc-800 bg-zinc-950 p-2 space-y-2">
              <div className="grid grid-cols-[1fr_110px] gap-2">
                <input
                  aria-label={`字段名称 ${field.name}`}
                  value={field.name}
                  onChange={(event) => updateField(field.id, { name: event.target.value })}
                  className="min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 py-1"
                />
                <select
                  aria-label={`字段取值 ${field.name}`}
                  value={field.valueMode}
                  onChange={(event) => updateField(field.id, {
                    valueMode: event.target.value as CollectionValueMode,
                    ...(event.target.value === "attribute" ? { attribute: field.attribute ?? "data-value" } : {}),
                  })}
                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1"
                >
                  <option value="text">文本</option>
                  <option value="href">链接 href</option>
                  <option value="src">图片 src</option>
                  <option value="attribute">属性值</option>
                </select>
              </div>
              <div className="flex gap-1">
                <input
                  aria-label={`字段选择器 ${field.name}`}
                  value={field.selector}
                  onChange={(event) => updateField(field.id, { selector: event.target.value })}
                  className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono"
                />
                <button
                  type="button"
                  aria-label={`圈选字段 ${field.name}`}
                  onClick={() => void startCapture({ kind: "field", fieldId: field.id })}
                  className="rounded bg-zinc-700 px-2 py-1"
                >圈选</button>
              </div>
              {field.valueMode === "attribute" && (
                <input
                  aria-label={`属性名称 ${field.name}`}
                  value={field.attribute ?? ""}
                  onChange={(event) => updateField(field.id, { attribute: event.target.value })}
                  placeholder="data-sku"
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono"
                />
              )}
              <div className="flex items-center gap-3 text-zinc-400">
                <label className="flex items-center gap-1"><input type="checkbox" checked={field.required} onChange={(event) => updateField(field.id, { required: event.target.checked })} />必填</label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={field.dedupe} onChange={(event) => updateField(field.id, { dedupe: event.target.checked })} />去重键</label>
                <span className="ml-auto flex gap-1">
                  <button type="button" aria-label={`上移字段 ${field.name}`} disabled={index === 0} onClick={() => moveField(index, -1)} className="rounded bg-zinc-800 px-2 disabled:opacity-30">↑</button>
                  <button type="button" aria-label={`下移字段 ${field.name}`} disabled={index === fields.length - 1} onClick={() => moveField(index, 1)} className="rounded bg-zinc-800 px-2 disabled:opacity-30">↓</button>
                  <button type="button" aria-label={`删除字段 ${field.name}`} onClick={() => { setFields((current) => current.filter((candidate) => candidate.id !== field.id)); invalidatePreview(); }} className="rounded bg-red-950 px-2 text-red-300">×</button>
                </span>
              </div>
            </div>
          ))}
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="font-medium text-zinc-100">4. 当前页预览</div>
            <button
              type="button"
              aria-label="刷新预览"
              disabled={state === "loading" || fields.length === 0 || targetTabId == null}
              onClick={() => void refreshPreview()}
              className="rounded bg-emerald-700 px-2 py-1 text-white disabled:opacity-40"
            >{state === "loading" ? "预览中…" : "刷新预览"}</button>
          </div>

          {state === "loading" && <div className="animate-pulse rounded bg-zinc-800 p-4 text-zinc-500">正在读取当前页面样例…</div>}
          {(state === "error" || state === "forbidden") && (
            <div className={`rounded border p-3 ${state === "forbidden" ? "border-amber-800 bg-amber-950/30 text-amber-300" : "border-red-900 bg-red-950/30 text-red-300"}`}>
              <div className="font-medium">{state === "forbidden" ? "当前页面不允许采集" : "预览失败"}</div>
              <div className="mt-1 break-words text-[11px]">{error}</div>
            </div>
          )}
          {state === "default" && !preview && <div className="rounded border border-dashed border-zinc-700 p-4 text-center text-zinc-500">配置字段后刷新预览；当前页最多返回 20 条样例。</div>}
          {state === "default" && preview && (
            <>
              <div className="flex flex-wrap gap-2 text-[10px] text-zinc-400">
                <span>{preview.returnedCount} 条样例</span>
                <span>{preview.uniqueCount} 条去重后</span>
                <span>{preview.missingRequiredCount} 条缺失必填</span>
                <span>{preview.duplicateCount} 条重复</span>
                {preview.truncated && <span className="text-amber-400">还有更多样例未返回</span>}
              </div>
              <div className="overflow-x-auto rounded border border-zinc-800">
                <table className="min-w-full text-left text-[11px]">
                  <thead className="bg-zinc-800 text-zinc-400"><tr><th className="px-2 py-1">状态</th>{fields.map((field) => <th key={field.id} className="px-2 py-1">{field.name}</th>)}</tr></thead>
                  <tbody>{preview.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className={row.duplicate ? "bg-amber-950/20" : "border-t border-zinc-800"}>
                      <td className="px-2 py-1 whitespace-nowrap">{row.duplicate ? "重复" : row.missingRequired.length ? "缺失" : "正常"}</td>
                      {fields.map((field) => <td key={field.id} className={row.missingRequired.includes(field.id) ? "px-2 py-1 text-red-300" : "px-2 py-1"}>{row.values[field.id] ?? "—"}</td>)}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          )}
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="font-medium text-zinc-100">5. 运行与结果</div>
              {runId && <div className="text-[10px] text-zinc-500">runId: {runId}</div>}
            </div>
            <div className="flex gap-1">
              {runSnapshot?.status === "running" && (
                <button
                  type="button"
                  aria-label="停止采集"
                  onClick={() => void cancelCollection()}
                  className="rounded bg-amber-800 px-2 py-1 text-white"
                >停止</button>
              )}
              <button
                type="button"
                aria-label="运行采集"
                disabled={targetTabId == null || fields.length === 0 || runSnapshot?.status === "running"}
                onClick={() => void startCollection()}
                className="rounded bg-emerald-700 px-2 py-1 text-white disabled:opacity-40"
              >{runSnapshot?.status === "running" ? "采集中…" : "运行采集"}</button>
            </div>
          </div>

          {runError && (
            <div className="rounded border border-red-900 bg-red-950/30 p-2 text-red-300">
              <div>{runError}</div>
              <div className="mt-1 text-[10px] text-red-200">请检查页面和配方后重试；已完成页仍会保留。</div>
            </div>
          )}
          {!runSnapshot && !runError && (
            <div className="rounded border border-dashed border-zinc-700 p-4 text-center text-zinc-500">
              运行后完整结果保存在本地；此处按 resultId 恢复显示。
            </div>
          )}
          {runSnapshot && (
            <>
              {(runSnapshot.stopReason === "max_rows" || runSnapshot.stopReason === "max_bytes") && (
                <div className="rounded border border-amber-700 bg-amber-950/30 p-2 text-amber-200">
                  <div className="font-medium">已达到硬上限，部分结果已保留</div>
                  <div className="mt-1 text-[10px]">可以继续导出或调整配方后重试；硬上限不可提高。</div>
                </div>
              )}
              {runSnapshot.status === "running" && (
                <div className="rounded border border-emerald-900 bg-emerald-950/20 p-2 text-[10px] text-emerald-200">
                  正在采集第 {runSnapshot.pageCount + 1} 页；可停止并保留已完成页。
                </div>
              )}
              <div className="flex flex-wrap gap-2 text-[10px] text-zinc-400">
                <span>{runSnapshot.status === "running" ? "运行中" : runSnapshot.status === "completed" ? "已完成" : runSnapshot.status === "partial" ? "部分完成" : "失败"}</span>
                <span>{runSnapshot.pageCount} 页</span>
                <span>{runSnapshot.rowCount} 行</span>
                <span>{runSnapshot.byteSize} bytes</span>
                <span>{runSnapshot.duplicateCount} 条重复</span>
                {runSnapshot.stopReason && <span>stop: {runSnapshot.stopReason}</span>}
                {runSnapshot.resultExpired && <span className="text-amber-400">结果已过期</span>}
              </div>
              {resultRows.length > 0 && (
                <div className="overflow-x-auto rounded border border-zinc-800">
                  <table className="min-w-full text-left text-[11px]">
                    <thead className="bg-zinc-800 text-zinc-400"><tr>{fields.map((field) => <th key={field.id} className="px-2 py-1">{field.name}</th>)}</tr></thead>
                    <tbody>{resultRows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-t border-zinc-800">
                        {fields.map((field) => <td key={field.id} className="px-2 py-1">{row[field.id] ?? "—"}</td>)}
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              {runSnapshot.summary && !runSnapshot.resultExpired && (
                <div className="space-y-2 border-t border-zinc-800 pt-2">
                  <div className="flex flex-wrap gap-1">
                    {(["xlsx", "csv", "json"] as const).map((format) => (
                      <button
                        key={format}
                        type="button"
                        aria-label={`导出 ${format.toUpperCase()}`}
                        disabled={exportState.status === "loading"}
                        onClick={() => void exportCollection(format)}
                        className="rounded bg-zinc-700 px-2 py-1 text-zinc-100 disabled:opacity-40"
                      >导出 {format.toUpperCase()}</button>
                    ))}
                  </div>
                  {exportState.status === "loading" && (
                    <div className="text-[10px] text-zinc-400">正在分块读取本地结果并生成 {exportState.format.toUpperCase()}…</div>
                  )}
                  {exportState.status === "success" && (
                    <div className="text-[10px] text-emerald-300">{exportState.format.toUpperCase()} 已导出 {exportState.rowCount} 行</div>
                  )}
                  {exportState.status === "error" && (
                    <div role="alert" className="text-[10px] text-red-300">导出失败：{exportState.error}。结果仍保留，可直接重试。</div>
                  )}
                  {exportState.status === "permission" && (
                    <PermissionRequestCard
                      permission="downloads"
                      capability="downloadSpreadsheet"
                      busy={false}
                      error={exportState.error}
                      onGrant={() => void exportCollection(exportState.format)}
                      onDeny={() => setExportState({ status: "idle" })}
                    />
                  )}
                  {connectorLoadState.status === "loading" && (
                    <div className="border-t border-zinc-800 pt-2 text-[10px] text-zinc-500">正在加载可用连接器…</div>
                  )}
                  {connectorLoadState.status === "error" && (
                    <div className="space-y-1 border-t border-zinc-800 pt-2 text-[10px] text-red-300">
                      <div>连接器加载失败：{connectorLoadState.error}</div>
                      <button
                        type="button"
                        aria-label="重试加载连接器"
                        onClick={() => void loadReadyConnectors()}
                        className="text-blue-400"
                      >重试</button>
                    </div>
                  )}
                  {connectorLoadState.status === "ready" && readyConnectors.length === 0 && (
                    <div className="border-t border-zinc-800 pt-2 text-[10px] text-zinc-500">暂无可用连接器，请先在“连接与安全分享”中配置并测试。</div>
                  )}
                  {connectorLoadState.status === "ready" && readyConnectors.length > 0 && (
                    <div className="space-y-2 border-t border-zinc-800 pt-2">
                      <div className="flex gap-1">
                        <select
                          aria-label="采集结果发送连接器"
                          value={sendConnectorId}
                          onChange={(event) => {
                            setSendConnectorId(event.target.value);
                            setSendConfirmationOpen(false);
                            setSendConfirmed(false);
                            setSendState({ status: "idle" });
                          }}
                          className="min-w-0 flex-1 rounded bg-zinc-950 px-2 py-1"
                        >
                          {readyConnectors.map((connector) => (
                            <option key={connector.id} value={connector.id}>{connector.name}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          aria-label="发送采集结果"
                          onClick={() => {
                            setSendConfirmationOpen(true);
                            setSendConfirmed(false);
                            setSendState({ status: "idle" });
                          }}
                          className="rounded bg-blue-700 px-2 py-1 text-white"
                        >发送到连接器</button>
                      </div>
                      {sendConfirmationOpen && (() => {
                        const connector = readyConnectors.find((candidate) => candidate.id === sendConnectorId);
                        return connector ? (
                          <div className="space-y-2 rounded border border-amber-800 bg-amber-950/20 p-2 text-[10px] text-amber-100">
                            <div>{connector.name} · {connectorTarget(connector)}</div>
                            <div>{runSnapshot.rowCount} 行 · {runSnapshot.byteSize} bytes</div>
                            <div className="font-medium">数据将离开浏览器并发送到上述外部目标。</div>
                            <label className="flex gap-2">
                              <input
                                type="checkbox"
                                aria-label="确认外发采集结果"
                                checked={sendConfirmed}
                                onChange={(event) => setSendConfirmed(event.target.checked)}
                              />
                              我已核对目标并确认发送
                            </label>
                            <button
                              type="button"
                              aria-label="确认发送采集结果"
                              disabled={!sendConfirmed || sendState.status === "sending"}
                              onClick={() => void sendCollectionResult()}
                              className="rounded bg-blue-700 px-2 py-1 text-white disabled:opacity-40"
                            >{sendState.status === "sending" ? "发送中…" : "确认发送"}</button>
                          </div>
                        ) : null;
                      })()}
                      {sendState.status === "success" && (
                        <div className="text-[10px] text-emerald-300">发送完成；采集任务未重新运行。</div>
                      )}
                      {sendState.status === "error" && (
                        <div role="alert" className="text-[10px] text-red-300">发送失败：{sendState.error}</div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        {!workflowEdit ? <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 space-y-2">
          <div className="font-medium text-zinc-100">6. 固化为工具</div>
          <div className="text-[10px] text-zinc-500">保存当前配方后，相似页面可在工具库或 Coordinator/MCP 中直接重放，不需要 LLM。</div>
          <label className="block space-y-1">
            <span className="text-zinc-400">工具名称</span>
            <input
              aria-label="工具名称"
              value={toolName}
              onChange={(event) => { setToolName(event.target.value); setSaveState({ status: "idle" }); }}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-zinc-400">URL 匹配规则</span>
            <input
              aria-label="URL 匹配规则"
              value={urlPattern}
              onChange={(event) => { setUrlPattern(event.target.value); setSaveState({ status: "idle" }); }}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono"
            />
          </label>
          <button
            type="button"
            aria-label="保存为工具"
            disabled={saveState.status === "saving" || fields.length === 0}
            onClick={() => void saveCollectionTool()}
            className="rounded bg-violet-700 px-2 py-1 text-white disabled:opacity-40"
          >{saveState.status === "saving" ? "保存中…" : "保存为工具"}</button>
          {saveState.status === "success" && (
            <div className="text-[10px] text-emerald-300">已保存到工具库，可在相似 URL 上无 LLM 重放。</div>
          )}
          {saveState.status === "error" && (
            <div role="alert" className="text-[10px] text-red-300">保存失败：{saveState.error}</div>
          )}
        </section> : null}
      </div>
    </Drawer>
  );
}
