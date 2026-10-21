import {
  DEFAULT_RECORDER_CONFIG,
  RING_SIZES,
  Ring,
  filterConsole,
  filterNetwork,
  type BackendTag,
  type ConsoleEntry,
  type ConsoleLevel,
  type ConsoleQuery,
  type ConsoleReadResult,
  type DialogEntry,
  type DialogPolicy,
  type DialogReadResult,
  type NetworkDetail,
  type NetworkDetailResult,
  type NetworkEntry,
  type NetworkPart,
  type NetworkQuery,
  type NetworkReadResult,
  type PageRecorder,
  type RecorderConfig,
  type RecorderConfigPatch
} from "@aipagego/shared/recorder";
import type { Json } from "@aipagego/shared/types";
import { cdpRecorderEnabled } from "./cdp-permission";
import { registerCdpLookup, registerCdpResizer, setDegradedReason } from "./host";

const PROTOCOL = "1.3";

export type CdpScreenshotOptions = {
  format?: "png" | "jpeg";
  scale?: number;
  fullPage?: boolean;
  selector?: string;
};

type ScreenshotRect = { x: number; y: number; width: number; height: number };

export type CdpScreenshotResult = {
  data: string;
  mediaType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  fullPage?: true;
  target?: {
    selector: string;
    rect: ScreenshotRect;
    viewport: { width: number; height: number };
    visible: boolean;
  };
};

const MEASURE_SELECTOR_SOURCE = `
const selector = ctx.selector;
if (typeof selector !== "string" || !selector) return { ok: false, error: "selector_required" };
const el = document.querySelector(selector);
if (!el) return { ok: false, error: "selector_not_found", selector };
const rect = el.getBoundingClientRect();
return {
  ok: true,
  rect: {
    x: rect.left + window.scrollX,
    y: rect.top + window.scrollY,
    width: rect.width,
    height: rect.height
  },
  viewport: { width: window.innerWidth, height: window.innerHeight },
  visible: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
};
`;

export class CdpEvaluationError extends Error {
  constructor(
    readonly code: "cdp_disabled" | "cdp_attach_failed" | "cdp_evaluation_failed",
    message: string
  ) {
    super(message);
    this.name = "CdpEvaluationError";
  }
}

/**
 * Full-fidelity backend. Sees what the MAIN-world patches cannot: response
 * bodies, messages emitted before any script ran, browser-level CORS/CSP
 * errors, and genuinely suspended dialogs.
 *
 * Attaching is best-effort. DevTools or another extension (playwright-ext, for
 * instance) may already hold the target, and the user can detach at any time.
 * Every failure path degrades to the MAIN-world backend and records why, so an
 * agent can tell reduced fidelity from an empty page.
 */
export class CdpRecorder implements PageRecorder {
  readonly backend = "cdp" as const;

  config: RecorderConfig = { ...DEFAULT_RECORDER_CONFIG, bodies: true };
  readonly console = new Ring<ConsoleEntry>(RING_SIZES.console);
  readonly network = new Ring<NetworkEntry>(RING_SIZES.network);
  readonly dialog = new Ring<DialogEntry>(RING_SIZES.dialog);

  /** CDP requestId → our entry id, for correlating the response event. */
  private readonly requestIds = new Map<string, number>();
  private readonly details = new Map<number, NetworkDetail>();
  /** CDP requestId kept so getResponseBody can be called lazily. */
  private readonly cdpIdFor = new Map<number, string>();

  private dialogPolicy: DialogPolicy | null = null;
  private pendingDialog: { message: string; type: string; defaultPrompt?: string } | null = null;
  private seq = 0;

  constructor(readonly tabId: number) {}

  private nextId(): number {
    return (this.seq += 1);
  }

  private tag(): BackendTag {
    return { backend: this.backend };
  }

  private send<T = unknown>(method: string, params?: object): Promise<T> {
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params) as Promise<T>;
  }

  // ── event ingestion ──────────────────────────────────────────────────────

  handleEvent(method: string, params: Record<string, unknown>): void {
    if (method === "Runtime.consoleAPICalled") this.onConsoleApi(params);
    else if (method === "Log.entryAdded") this.onLogEntry(params);
    else if (method === "Network.requestWillBeSent") this.onRequest(params);
    else if (method === "Network.responseReceived") this.onResponse(params);
    else if (method === "Network.loadingFailed") this.onLoadingFailed(params);
    else if (method === "Page.javascriptDialogOpening") this.onDialogOpening(params);
  }

  private onConsoleApi(p: Record<string, unknown>): void {
    if (!this.config.console) return;
    const type = String(p.type ?? "log");
    const args = Array.isArray(p.args) ? (p.args as Array<Record<string, unknown>>) : [];
    this.console.push({
      id: this.nextId(),
      ts: Date.now(),
      level: normaliseLevel(type),
      text: args.map(renderRemoteObject).join(" ")
    });
  }

  private onLogEntry(p: Record<string, unknown>): void {
    if (!this.config.console) return;
    const entry = (p.entry ?? {}) as Record<string, unknown>;
    this.console.push({
      id: this.nextId(),
      ts: Date.now(),
      level: normaliseLevel(String(entry.level ?? "info")),
      text: String(entry.text ?? ""),
      url: entry.url ? String(entry.url) : undefined,
      line: typeof entry.lineNumber === "number" ? entry.lineNumber : undefined
    });
  }

  private onRequest(p: Record<string, unknown>): void {
    if (!this.config.network) return;
    const cdpId = String(p.requestId ?? "");
    const req = (p.request ?? {}) as Record<string, unknown>;
    const id = this.nextId();
    this.requestIds.set(cdpId, id);
    this.cdpIdFor.set(id, cdpId);
    const entry: NetworkEntry = {
      id,
      ts: Date.now(),
      method: String(req.method ?? "GET").toUpperCase(),
      url: String(req.url ?? ""),
      resourceType: p.type ? String(p.type) : undefined
    };
    this.network.push(entry);
    this.details.set(id, {
      ...entry,
      requestHeaders: (req.headers as Record<string, string>) ?? undefined,
      requestBody: typeof req.postData === "string" ? req.postData : undefined
    });
  }

  private onResponse(p: Record<string, unknown>): void {
    const id = this.requestIds.get(String(p.requestId ?? ""));
    if (id == null) return;
    const res = (p.response ?? {}) as Record<string, unknown>;
    const detail = this.details.get(id);
    const patch = {
      status: typeof res.status === "number" ? res.status : undefined,
      statusText: res.statusText ? String(res.statusText) : undefined,
      ms: detail ? Date.now() - detail.ts : undefined
    };
    if (detail) {
      this.details.set(id, {
        ...detail,
        ...patch,
        responseHeaders: (res.headers as Record<string, string>) ?? undefined
      });
    }
    patchRing(this.network, id, patch);
  }

  private onLoadingFailed(p: Record<string, unknown>): void {
    const id = this.requestIds.get(String(p.requestId ?? ""));
    if (id == null) return;
    const error = String(p.errorText ?? "loading failed");
    patchRing(this.network, id, { error });
    const detail = this.details.get(id);
    if (detail) this.details.set(id, { ...detail, error });
  }

  /**
   * Under CDP the page is genuinely suspended here, so a standing policy can
   * be applied immediately. This is the one place where `handleDialog` behaves
   * like playwright's rather than as a pre-set policy.
   */
  private onDialogOpening(p: Record<string, unknown>): void {
    const message = String(p.message ?? "");
    const type = String(p.type ?? "alert");
    const defaultPrompt = p.defaultPrompt ? String(p.defaultPrompt) : undefined;
    const policy = this.takePolicy();

    if (!policy) {
      this.pendingDialog = { message, type, defaultPrompt };
      return;
    }
    this.answer(policy, { message, type, defaultPrompt });
  }

  private takePolicy(): DialogPolicy | null {
    const p = this.dialogPolicy;
    if (p && p.scope === "next") this.dialogPolicy = null;
    return p;
  }

  private answer(
    policy: DialogPolicy,
    d: { message: string; type: string; defaultPrompt?: string }
  ): void {
    const promptText = policy.accept ? policy.promptText ?? d.defaultPrompt : undefined;
    void this.send("Page.handleJavaScriptDialog", {
      accept: policy.accept,
      ...(promptText != null ? { promptText } : {})
    }).catch(() => undefined);
    this.dialog.push({
      id: this.nextId(),
      ts: Date.now(),
      kind: dialogKind(d.type),
      message: d.message,
      defaultValue: d.defaultPrompt,
      handled: policy.accept ? "accepted" : "dismissed",
      promptText
    });
    this.pendingDialog = null;
  }

  // ── PageRecorder ─────────────────────────────────────────────────────────

  async readConsole(q: ConsoleQuery): Promise<ConsoleReadResult> {
    return {
      ...this.tag(),
      dropped: this.console.dropped,
      messages: filterConsole(this.console.toArray(), q)
    };
  }

  async readNetwork(q: NetworkQuery): Promise<NetworkReadResult> {
    return {
      ...this.tag(),
      dropped: this.network.dropped,
      requests: filterNetwork(this.network.toArray(), q)
    };
  }

  async readDialogs(q: { limit?: number }): Promise<DialogReadResult> {
    const all = this.dialog.toArray();
    const limit = q.limit;
    const dialogs = limit && limit > 0 && all.length > limit ? all.slice(all.length - limit) : all;
    return { ...this.tag(), dropped: this.dialog.dropped, dialogs };
  }

  /** Bodies are fetched on demand rather than buffered for every request. */
  async readNetworkDetail(q: { id: number; part?: NetworkPart }): Promise<NetworkDetailResult> {
    const base = this.details.get(q.id);
    if (!base) return { ...this.tag(), detail: null };

    let responseBody: string | undefined;
    const cdpId = this.cdpIdFor.get(q.id);
    if (cdpId) {
      try {
        const r = await this.send<{ body: string; base64Encoded: boolean }>(
          "Network.getResponseBody",
          { requestId: cdpId }
        );
        responseBody = r?.base64Encoded ? "(binary body omitted)" : r?.body;
      } catch {
        responseBody = undefined;
      }
    }
    const detail: NetworkDetail = { ...base, responseBody };
    return { ...this.tag(), detail: q.part ? project(detail, q.part) : detail };
  }

  async setDialogPolicy(p: DialogPolicy): Promise<DialogReadResult> {
    this.dialogPolicy = p;
    if (this.pendingDialog) {
      const pending = this.pendingDialog;
      const policy = this.takePolicy();
      if (policy) this.answer(policy, pending);
    }
    return this.readDialogs({});
  }

  async configure(patch: RecorderConfigPatch): Promise<BackendTag & { config: RecorderConfig }> {
    const { clear, ...rest } = patch;
    this.config = { ...this.config, ...rest };
    for (const kind of clear ?? []) {
      if (kind === "console") this.console.clear();
      if (kind === "network") {
        this.network.clear();
        this.details.clear();
        this.requestIds.clear();
        this.cdpIdFor.clear();
      }
      if (kind === "dialog") this.dialog.clear();
    }
    return { ...this.tag(), config: this.config };
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: false
    });
  }

  async captureScreenshot(options: CdpScreenshotOptions): Promise<CdpScreenshotResult> {
    const format = options.format === "jpeg" ? "jpeg" : "png";
    const scale = clampScale(options.scale);
    let clip: ScreenshotRect & { scale: number };
    let target: CdpScreenshotResult["target"];

    if (options.selector) {
      const measured = await this.evaluate(MEASURE_SELECTOR_SOURCE, {
        selector: options.selector
      }) as unknown as {
        ok?: boolean;
        error?: string;
        rect?: ScreenshotRect;
        viewport?: { width: number; height: number };
        visible?: boolean;
      };
      if (!measured.ok || !measured.rect || !measured.viewport) {
        throw new Error(`screenshot: ${measured.error ?? "selector_measure_failed"}`);
      }
      assertCaptureRect(measured.rect);
      clip = { ...measured.rect, scale };
      target = {
        selector: options.selector,
        rect: measured.rect,
        viewport: measured.viewport,
        visible: measured.visible === true
      };
    } else {
      type LayoutMetrics = {
        cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
        visualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
        cssContentSize?: ScreenshotRect;
        contentSize?: ScreenshotRect;
      };
      const metrics = await this.send<LayoutMetrics>("Page.getLayoutMetrics");
      if (options.fullPage) {
        const content = metrics.cssContentSize ?? metrics.contentSize;
        if (!content) throw new Error("screenshot: CDP content metrics unavailable");
        assertCaptureRect(content);
        clip = { x: content.x, y: content.y, width: content.width, height: content.height, scale };
      } else {
        const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
        if (!viewport) throw new Error("screenshot: CDP viewport metrics unavailable");
        const rect = {
          x: viewport.pageX,
          y: viewport.pageY,
          width: viewport.clientWidth,
          height: viewport.clientHeight
        };
        assertCaptureRect(rect);
        clip = { ...rect, scale };
      }
    }

    const captured = await this.send<{ data?: string }>("Page.captureScreenshot", {
      format,
      fromSurface: true,
      captureBeyondViewport: options.fullPage === true || target != null,
      clip
    });
    if (!captured.data) throw new Error("screenshot: CDP returned no image data");
    return {
      data: captured.data,
      mediaType: format === "jpeg" ? "image/jpeg" : "image/png",
      width: clip.width,
      height: clip.height,
      ...(options.fullPage ? { fullPage: true as const } : {}),
      ...(target ? { target } : {})
    };
  }

  async evaluate(source: string, args: Json): Promise<Json> {
    type EvaluateResponse = {
      result?: { type?: string; value?: unknown; description?: string };
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string };
      };
    };
    let response: EvaluateResponse;
    try {
      response = await this.send<EvaluateResponse>("Runtime.evaluate", {
        expression: `(async (ctx) => {\n"use strict";\n${source}\n})(${JSON.stringify(args)})`,
        awaitPromise: true,
        returnByValue: true
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new CdpEvaluationError("cdp_evaluation_failed", `CDP Runtime.evaluate failed: ${message}`);
    }
    if (response.exceptionDetails) {
      const detail =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        response.result?.description ??
        "unknown page exception";
      throw new CdpEvaluationError("cdp_evaluation_failed", `runJS error: ${detail}`);
    }
    if (response.result?.type === "undefined") return null;
    if (!response.result || !Object.prototype.hasOwnProperty.call(response.result, "value")) {
      throw new CdpEvaluationError(
        "cdp_evaluation_failed",
        "runJS result is not JSON-compatible; return a JSON-compatible value instead of a page object."
      );
    }
    try {
      const json = JSON.stringify(response.result.value);
      if (json == null) throw new Error("value cannot be serialized");
      return JSON.parse(json) as Json;
    } catch {
      throw new CdpEvaluationError(
        "cdp_evaluation_failed",
        "runJS result is not JSON-compatible; return only null, booleans, finite numbers, strings, arrays, or plain objects."
      );
    }
  }
}

// ── registry and lifecycle ────────────────────────────────────────────────

const attached = new Map<number, CdpRecorder>();
const attachFailures = new Map<number, string>();

export function getAttachedCdpRecorder(tabId: number): CdpRecorder | null {
  return attached.get(tabId) ?? null;
}

export async function evaluateWithCdp(tabId: number, source: string, args: Json): Promise<Json> {
  if (!(await cdpRecorderEnabled())) {
    throw new CdpEvaluationError(
      "cdp_disabled",
      "页面 CSP 禁止 unsafe-eval。请在 Coordinator 设置中开启 CDP/debugger 后重试；只需读取样式、位置或父链时请改用 inspectElement。"
    );
  }
  const recorder = getAttachedCdpRecorder(tabId) ?? (await attachCdp(tabId));
  if (!recorder) {
    const reason = attachFailures.get(tabId) ?? "unknown debugger attach failure";
    throw new CdpEvaluationError(
      "cdp_attach_failed",
      `无法连接 CDP: ${reason}。请关闭该 tab 的 DevTools 或其他 debugger 扩展后重试。`
    );
  }
  return recorder.evaluate(source, args);
}

/** Uses the existing opt-in CDP setting and never prompts for permission. */
export async function captureScreenshotWithCdp(
  tabId: number,
  options: CdpScreenshotOptions
): Promise<CdpScreenshotResult | null> {
  if (!(await cdpRecorderEnabled())) return null;
  const recorder = getAttachedCdpRecorder(tabId) ?? (await attachCdp(tabId));
  return recorder ? recorder.captureScreenshot(options) : null;
}

/** Returns null rather than throwing — a failed attach must degrade, not fail. */
export async function attachCdp(tabId: number): Promise<CdpRecorder | null> {
  if (attached.has(tabId)) return attached.get(tabId)!;
  if (!chrome.debugger?.attach) {
    const reason = "chrome.debugger unavailable";
    attachFailures.set(tabId, reason);
    setDegradedReason(tabId, reason);
    return null;
  }
  if (!(await cdpRecorderEnabled())) {
    const reason = "CDP recorder is off in settings";
    attachFailures.set(tabId, reason);
    setDegradedReason(tabId, reason);
    return null;
  }

  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // The usual cause is DevTools or another extension already holding the tab.
    attachFailures.set(tabId, reason);
    setDegradedReason(tabId, `debugger attach failed: ${reason}`);
    return null;
  }

  const rec = new CdpRecorder(tabId);
  attachFailures.delete(tabId);
  attached.set(tabId, rec);
  for (const domain of ["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"]) {
    try {
      await chrome.debugger.sendCommand({ tabId }, domain);
    } catch {
      // A domain that will not enable costs fidelity, not correctness.
    }
  }
  return rec;
}

export async function detachCdp(tabId: number): Promise<void> {
  attached.delete(tabId);
  attachFailures.delete(tabId);
  try {
    await chrome.debugger?.detach?.({ tabId });
  } catch {
    // Already gone.
  }
}

/** Idempotent; safe to call from both service-worker start and tests. */
export function installCdpListeners(): void {
  registerCdpLookup((tabId) => getAttachedCdpRecorder(tabId));
  registerCdpResizer((tabId) => {
    const rec = getAttachedCdpRecorder(tabId);
    return rec ? (w, h) => rec.setViewport(w, h) : null;
  });

  chrome.debugger?.onEvent?.addListener((source, method, params) => {
    if (source.tabId == null) return;
    attached.get(source.tabId)?.handleEvent(method, (params ?? {}) as Record<string, unknown>);
  });

  chrome.debugger?.onDetach?.addListener((source, reason) => {
    if (source.tabId == null) return;
    attached.delete(source.tabId);
    // The next getRecorder() call now returns a MainWorldRecorder, and this
    // reason rides along on its results so the drop in fidelity is visible.
    setDegradedReason(source.tabId, `debugger detached: ${reason}`);
  });

  chrome.tabs?.onRemoved?.addListener((tabId) => {
    attached.delete(tabId);
    attachFailures.delete(tabId);
  });
}

// ── helpers ───────────────────────────────────────────────────────────────

function normaliseLevel(type: string): ConsoleLevel {
  if (type === "warning" || type === "warn") return "warn";
  if (type === "error") return "error";
  if (type === "debug" || type === "verbose") return "debug";
  if (type === "trace") return "trace";
  if (type === "info") return "info";
  return "log";
}

function dialogKind(type: string): DialogEntry["kind"] {
  if (type === "confirm") return "confirm";
  if (type === "prompt") return "prompt";
  return "alert";
}

function clampScale(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(0.1, Math.min(1, value));
}

function assertCaptureRect(rect: ScreenshotRect): void {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    throw new Error("screenshot: target has no capturable area");
  }
}

function renderRemoteObject(o: Record<string, unknown>): string {
  if (o == null) return "undefined";
  if ("value" in o) return String(o.value);
  if (typeof o.description === "string") return o.description;
  if (typeof o.unserializableValue === "string") return o.unserializableValue;
  return String(o.type ?? "");
}

/** Ring has no random access, so a patched entry is rewritten in place. */
function patchRing(ring: Ring<NetworkEntry>, id: number, patch: Partial<NetworkEntry>): void {
  const items = ring.toArray();
  const i = items.findIndex((e) => e.id === id);
  if (i === -1) return;
  items[i] = { ...items[i], ...patch };
  ring.clear();
  for (const e of items) ring.push(e);
}

function project(d: NetworkDetail, part: NetworkPart): NetworkDetail {
  const base: NetworkDetail = { id: d.id, ts: d.ts, method: d.method, url: d.url, status: d.status };
  if (part === "request-headers") return { ...base, requestHeaders: d.requestHeaders };
  if (part === "request-body") return { ...base, requestBody: d.requestBody };
  if (part === "response-headers") return { ...base, responseHeaders: d.responseHeaders };
  return { ...base, responseBody: d.responseBody };
}
