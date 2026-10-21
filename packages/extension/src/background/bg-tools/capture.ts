import type { Json, Step } from "@aipagego/shared/types";
import {
  captureVisualEvidence,
  resolveVisualEvidenceTarget
} from "@/sidepanel/llm/visual-evidence";
import { captureScreenshotWithCdp } from "@/background/recorder/cdp";
import {
  PAGE_METRICS_SOURCE,
  SCROLL_TO_SOURCE,
  STITCH_SOURCE
} from "@/content/tools/page-metrics";

/**
 * `screenshot` in the service worker so the coordinator/MCP EXEC path can
 * reach it. Targeting logic (page-index blockId, selector scroll and
 * highlight) is reused from `visual-evidence.ts`, which is already
 * dependency-injected — only the chrome.* bindings differ here.
 */

export type RunStepFn = (input: {
  step: Step;
  tabId: number;
  attachedTabIds?: number[];
  bindings?: Record<string, Json>;
}) => Promise<Json>;

export type CaptureDeps = { runStep: RunStepFn };

let deps: CaptureDeps | null = null;

/** Wired from rpc-handlers at module init to avoid a circular import. */
export function registerCaptureDeps(d: CaptureDeps): void {
  deps = d;
}

/**
 * chrome.tabs.captureVisibleTab is quota-limited per second. A long page would
 * start throwing partway through the band loop without this spacing.
 */
const BAND_DELAY_MS = 120;

/** Bounds the loop so an infinite-scroll page cannot hang the tool call. */
const MAX_BANDS = 20;

export async function screenshot(raw: Json, tabId: number): Promise<Json> {
  const d = deps;
  if (!d) throw new Error("screenshot: capture deps not initialised");
  if (!chrome.tabs?.captureVisibleTab) {
    throw new Error("screenshot: captureVisibleTab unavailable");
  }
  const a = (raw ?? {}) as {
    fullPage?: boolean;
    format?: "png" | "jpeg";
    scale?: number;
  };

  const resolved = a.fullPage
    ? undefined
    : await resolveVisualEvidenceTarget({ raw, defaultTabId: tabId, runStep: d.runStep });
  const cdp = await captureScreenshotWithCdp(tabId, {
    fullPage: a.fullPage,
    format: a.format,
    scale: a.scale,
    selector: resolved?.selector
  });
  if (cdp) {
    const target = resolved?.target
      ? { ...resolved.target, ...(cdp.target ?? {}) }
      : cdp.target;
    return {
      media_type: cdp.mediaType,
      data: cdp.data,
      byteLen: byteLenFromBase64(cdp.data),
      backend: "cdp",
      width: cdp.width,
      height: cdp.height,
      ...(cdp.fullPage ? { fullPage: true } : {}),
      ...(target ? { target } : {})
    } as unknown as Json;
  }

  return withActiveTab(tabId, async () => {
    if (a.fullPage) {
      const shot = await captureFullPage(raw, tabId, d) as Record<string, Json>;
      return { ...shot, backend: "visible-tab" } as unknown as Json;
    }

    const shot = await captureVisualEvidence({
      raw,
      defaultTabId: tabId,
      getTab: async (id) => {
        const tab = await chrome.tabs.get(id);
        if (tab.windowId == null) throw new Error(`screenshot: tab ${id} has no window`);
        return { windowId: tab.windowId };
      },
      captureVisibleTab: (windowId) => chrome.tabs.captureVisibleTab(windowId, { format: "png" }),
      runStep: d.runStep,
      resolvedTarget: resolved
    });
    return { ...shot, backend: "visible-tab" } as unknown as Json;
  });
}

async function withActiveTab<T>(tabId: number, capture: () => Promise<T>): Promise<T> {
  const target = await chrome.tabs.get(tabId);
  if (target.windowId == null) throw new Error(`screenshot: tab ${tabId} has no window`);
  const [previous] = await chrome.tabs.query({ windowId: target.windowId, active: true });
  const previousTabId = previous?.id;
  const switched = previousTabId !== tabId;

  if (switched) await chrome.tabs.update(tabId, { active: true });
  try {
    return await capture();
  } finally {
    if (switched && previousTabId != null) {
      const [current] = await chrome.tabs.query({ windowId: target.windowId, active: true }).catch(() => []);
      if (current?.id === tabId) {
        await chrome.tabs.update(previousTabId, { active: true }).catch(() => undefined);
      }
    }
  }
}

async function captureFullPage(raw: Json, tabId: number, d: CaptureDeps): Promise<Json> {
  const a = (raw ?? {}) as { format?: "png" | "jpeg"; scale?: number };
  const js = (source: string, bindings: Record<string, Json> = {}) =>
    d.runStep({ step: { kind: "js", source }, tabId, bindings });

  const metrics = (await js(PAGE_METRICS_SOURCE)) as unknown as {
    scrollHeight: number;
    clientHeight: number;
    clientWidth: number;
    scrollY: number;
  };
  if (!metrics?.clientHeight) throw new Error("screenshot: could not measure the page");

  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId == null) throw new Error(`screenshot: tab ${tabId} has no window`);

  const originalScrollY = metrics.scrollY;
  const bandHeight = metrics.clientHeight;
  const wanted = Math.ceil(metrics.scrollHeight / bandHeight);
  const bandCount = Math.min(wanted, MAX_BANDS);
  const truncated = wanted > MAX_BANDS;

  const bands: Array<{ y: number; dataUrl: string }> = [];
  try {
    for (let i = 0; i < bandCount; i++) {
      const y = i * bandHeight;
      const landed = (await js(SCROLL_TO_SOURCE, { y, settleMs: 120 })) as unknown as {
        scrollY: number;
      };
      if (i > 0) await sleep(BAND_DELAY_MS);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      bands.push({ y: landed?.scrollY ?? y, dataUrl });
    }
  } finally {
    // Always put the user's scroll position back, including on failure.
    await js(SCROLL_TO_SOURCE, { y: originalScrollY, settleMs: 0 }).catch(() => undefined);
  }

  const stitched = (await js(STITCH_SOURCE, {
    bands: bands as unknown as Json,
    width: metrics.clientWidth,
    height: Math.min(metrics.scrollHeight, bandCount * bandHeight),
    format: a.format ?? "png",
    scale: a.scale ?? 1
  })) as unknown as { ok: boolean; dataUrl?: string; error?: string };

  if (!stitched?.ok || !stitched.dataUrl) {
    throw new Error(`screenshot: stitching failed — ${stitched?.error ?? "unknown"}`);
  }

  const media_type = (a.format ?? "png") === "jpeg" ? "image/jpeg" : "image/png";
  const base64 = stitched.dataUrl.replace(/^data:image\/(png|jpeg);base64,/, "");
  return {
    media_type,
    data: base64,
    byteLen: byteLenFromBase64(base64),
    fullPage: true,
    bands: bands.length,
    ...(truncated ? { truncated: true, wantedBands: wanted } : {})
  } as unknown as Json;
}

function byteLenFromBase64(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
