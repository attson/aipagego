import type { Json, Step } from "@aipagego/shared/types";

export type VisualEvidenceRunStep = (input: {
  step: Step;
  tabId: number;
  attachedTabIds?: number[];
  bindings?: Record<string, Json>;
}) => Promise<Json>;

type CaptureArgs = {
  raw: unknown;
  defaultTabId: number;
  getTab: (tabId: number) => Promise<{ windowId: number }>;
  captureVisibleTab: (windowId: number) => Promise<string>;
  runStep: VisualEvidenceRunStep;
  resolvedTarget?: ResolvedVisualEvidenceTarget;
};

export type VisualEvidenceResult = {
  media_type: "image/png";
  data: string;
  byteLen: number;
  target?: Json;
};

const PREPARE_VISUAL_EVIDENCE_SOURCE = `
const selector = ctx.selector;
const highlightMs = typeof ctx.highlightMs === "number" ? ctx.highlightMs : 1500;
if (typeof selector !== "string" || !selector) return { ok: false, error: "selector_required" };
const el = document.querySelector(selector);
if (!el) return { ok: false, error: "selector_not_found", selector };
el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
await new Promise((resolve) => setTimeout(resolve, 80));
const htmlEl = el;
const previousOutline = htmlEl.style.outline;
const previousOutlineOffset = htmlEl.style.outlineOffset;
htmlEl.style.outline = "3px solid #ef4444";
htmlEl.style.outlineOffset = "3px";
setTimeout(() => {
  htmlEl.style.outline = previousOutline;
  htmlEl.style.outlineOffset = previousOutlineOffset;
}, highlightMs);
const rect = el.getBoundingClientRect();
return {
  ok: true,
  selector,
  rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  viewport: { width: window.innerWidth, height: window.innerHeight },
  visible: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
};
`;

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function byteLenFromBase64(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

async function resolveBlockTarget(input: Record<string, unknown>, tabId: number, runStep: VisualEvidenceRunStep): Promise<{
  selector?: string;
  target?: Record<string, Json>;
}> {
  const blockId = optionalString(input.blockId);
  if (!blockId) return {};

  const indexId = optionalString(input.indexId);
  const block = asRecord(await runStep({
    tabId,
    step: {
      kind: "tool",
      tool: "readPageBlock",
      args: {
        ...(indexId ? { indexId } : {}),
        blockId,
        maxChars: 1
      }
    }
  }));
  if (typeof block.error === "string") {
    throw new Error(`screenshot: ${block.error}`);
  }

  const selector = optionalString(input.selector) ?? optionalString(block.selectorHint);
  return {
    selector,
    target: {
      kind: "pageBlock",
      indexId: (optionalString(block.indexId) ?? indexId ?? "") as Json,
      blockId,
      ...(selector ? { selector } : {}),
      ...(optionalString(block.label) ? { label: optionalString(block.label)! } : {})
    }
  };
}

async function prepareSelectorTarget(input: {
  selector: string;
  tabId: number;
  highlightMs: number;
  runStep: VisualEvidenceRunStep;
}): Promise<Record<string, Json>> {
  const result = asRecord(await input.runStep({
    tabId: input.tabId,
    step: { kind: "js", source: PREPARE_VISUAL_EVIDENCE_SOURCE },
    bindings: {
      selector: input.selector,
      highlightMs: input.highlightMs
    }
  }));
  if (result.ok === false) {
    throw new Error(`screenshot: ${String(result.error ?? "target_prepare_failed")}`);
  }
  return result as Record<string, Json>;
}

export type ResolvedVisualEvidenceTarget = {
  tabId: number;
  highlightMs: number;
  selector?: string;
  target?: Record<string, Json>;
};

export async function resolveVisualEvidenceTarget(args: {
  raw: unknown;
  defaultTabId: number;
  runStep: VisualEvidenceRunStep;
}): Promise<ResolvedVisualEvidenceTarget> {
  const input = asRecord(args.raw);
  const tabId = optionalNumber(input.tabId) ?? args.defaultTabId;
  const highlightMs = Math.max(250, Math.min(5000, Math.floor(optionalNumber(input.highlightMs) ?? 1500)));
  const blockTarget = await resolveBlockTarget(input, tabId, args.runStep);
  return {
    tabId,
    highlightMs,
    selector: blockTarget.selector ?? optionalString(input.selector),
    target: blockTarget.target
  };
}

export async function captureVisualEvidence(args: CaptureArgs): Promise<VisualEvidenceResult> {
  const resolved =
    args.resolvedTarget ??
    (await resolveVisualEvidenceTarget({
      raw: args.raw,
      defaultTabId: args.defaultTabId,
      runStep: args.runStep
    }));
  const { tabId, highlightMs, selector } = resolved;
  let target: Record<string, Json> | undefined = resolved.target;

  if (selector) {
    const prepared = await prepareSelectorTarget({ selector, tabId, highlightMs, runStep: args.runStep });
    target = {
      ...(target ?? { kind: "selector", selector }),
      selector,
      rect: prepared.rect as Json,
      viewport: prepared.viewport as Json,
      visible: prepared.visible === true
    };
  }

  const tab = await args.getTab(tabId);
  const dataUrl = await args.captureVisibleTab(tab.windowId);
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  return {
    media_type: "image/png",
    data: base64,
    byteLen: byteLenFromBase64(base64),
    ...(target ? { target: target as Json } : {})
  };
}
