import type { Json } from "@aipagego/shared/types";
import type { PageRecorder } from "@aipagego/shared/recorder";
import { DRAIN_SOURCE } from "@/content/recorder/drain";
import { MainWorldRecorder } from "./main-world-host";

/**
 * Per-tab reason the CDP backend is unavailable. Set when an attach fails or
 * the debugger detaches, and surfaced once on the next read so an agent can
 * tell degraded output from complete output.
 */
const degraded = new Map<number, string>();

export function setDegradedReason(tabId: number, reason: string): void {
  degraded.set(tabId, reason);
}

export function clearDegradedReason(tabId: number): void {
  degraded.delete(tabId);
}

/** Replaced by the CDP backend in Phase 6. */
let cdpLookup: (tabId: number) => PageRecorder | null = () => null;

export function registerCdpLookup(fn: (tabId: number) => PageRecorder | null): void {
  cdpLookup = fn;
}

/**
 * When a CDP session owns the tab, `resize` prefers Emulation over resizing
 * the user's actual window. Null when no CDP session is attached.
 */
export type CdpResizer = (width: number, height: number) => Promise<void>;

let cdpResizerLookup: (tabId: number) => CdpResizer | null = () => null;

export function registerCdpResizer(fn: (tabId: number) => CdpResizer | null): void {
  cdpResizerLookup = fn;
}

export function getCdpResizer(tabId: number): CdpResizer | null {
  return cdpResizerLookup(tabId);
}

export type InjectMainFn = (tabId: number, source: string, args: Json) => Promise<Json>;

let injectMain: InjectMainFn | null = null;

/** Wired from rpc-handlers at module init to avoid a circular import. */
export function registerInjectMain(fn: InjectMainFn): void {
  injectMain = fn;
}

export function getRecorder(tabId: number): PageRecorder {
  const cdp = cdpLookup(tabId);
  if (cdp) return cdp;
  const inject = injectMain;
  if (!inject) throw new Error("recorder host not initialised: injectMain is unset");
  return new MainWorldRecorder(
    tabId,
    (ctx) => inject(tabId, DRAIN_SOURCE, ctx as Json),
    degraded.get(tabId)
  );
}

/** Tears down per-tab recorder state when a tab goes away. */
export function forgetTab(tabId: number): void {
  degraded.delete(tabId);
}
