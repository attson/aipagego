/**
 * MAIN-world page-event recorder (Plan 32).
 *
 * Runs in the page's own realm so it can observe `console`, `fetch`,
 * `XMLHttpRequest`, and `window.alert` — none of which are reachable from an
 * isolated content script. State lives on `window.__AIPAGEGO_REC__`; the
 * background host drains it through the existing one-shot `injectMainWorld`
 * channel, which executes in this same realm.
 *
 * Defaults are deliberately inert. This script loads on every page the user
 * visits, so body capture stays off and dialogs pass straight through to the
 * native implementations until an agent explicitly arms them. Until then the
 * page behaves exactly as it would without the extension.
 *
 * The page shares this realm and can overwrite the patches. That is accepted:
 * the CDP backend is the answer for adversarial pages.
 */
import {
  BODY_CAP_BYTES,
  DEFAULT_RECORDER_CONFIG,
  RING_SIZES,
  Ring,
  TEXTY_CONTENT_TYPE,
  serializeArg,
  type ConsoleEntry,
  type ConsoleLevel,
  type DialogEntry,
  type DialogPolicy,
  type NetworkDetail,
  type NetworkEntry,
  type RecorderConfig,
  type RecorderConfigPatch
} from "@aipagego/shared/recorder";

export type RecorderGlobal = {
  version: 1;
  config: RecorderConfig;
  console: Ring<ConsoleEntry>;
  network: Ring<NetworkEntry>;
  dialog: Ring<DialogEntry>;
  details: Map<number, NetworkDetail>;
  dialogPolicy: DialogPolicy | null;
  nextId(): number;
  configure(patch: RecorderConfigPatch): RecorderConfig;
  setDialogPolicy(p: DialogPolicy | null): void;
  uninstall(): void;
};

declare global {
  interface Window {
    __AIPAGEGO_REC__?: RecorderGlobal;
  }
}

const CONSOLE_LEVELS: ConsoleLevel[] = ["log", "info", "warn", "error", "debug", "trace"];

export function install(): RecorderGlobal {
  let seq = 0;
  const restorers: Array<() => void> = [];

  const rec: RecorderGlobal = {
    version: 1,
    config: { ...DEFAULT_RECORDER_CONFIG },
    console: new Ring<ConsoleEntry>(RING_SIZES.console),
    network: new Ring<NetworkEntry>(RING_SIZES.network),
    dialog: new Ring<DialogEntry>(RING_SIZES.dialog),
    details: new Map<number, NetworkDetail>(),
    dialogPolicy: null,
    nextId: () => (seq += 1),
    configure(patch) {
      const { clear, ...rest } = patch;
      rec.config = { ...rec.config, ...rest };
      for (const kind of clear ?? []) {
        if (kind === "console") rec.console.clear();
        if (kind === "network") {
          rec.network.clear();
          rec.details.clear();
        }
        if (kind === "dialog") rec.dialog.clear();
      }
      return rec.config;
    },
    setDialogPolicy(p) {
      rec.dialogPolicy = p;
    },
    uninstall() {
      while (restorers.length) restorers.pop()!();
      rec.console.clear();
      rec.network.clear();
      rec.dialog.clear();
      rec.details.clear();
      rec.dialogPolicy = null;
      delete window.__AIPAGEGO_REC__;
    }
  };

  installConsole(rec, restorers);
  installNetwork(rec, restorers);
  installDialog(rec, restorers);

  window.__AIPAGEGO_REC__ = rec;
  return rec;
}

// ── console ────────────────────────────────────────────────────────────────

function installConsole(rec: RecorderGlobal, restorers: Array<() => void>): void {
  for (const level of CONSOLE_LEVELS) {
    const original = console[level] as ((...a: unknown[]) => void) | undefined;
    if (typeof original !== "function") continue;
    const patched = (...a: unknown[]) => {
      if (rec.config.console) {
        rec.console.push({
          id: rec.nextId(),
          ts: Date.now(),
          level,
          text: a.map((v) => serializeArg(v)).join(" ")
        });
      }
      original.apply(console, a);
    };
    (console as unknown as Record<string, unknown>)[level] = patched;
    restorers.push(() => {
      (console as unknown as Record<string, unknown>)[level] = original;
    });
  }

  const onError = (e: ErrorEvent) => {
    if (!rec.config.console) return;
    rec.console.push({
      id: rec.nextId(),
      ts: Date.now(),
      level: "error",
      text: e.message,
      stack: e.error instanceof Error ? e.error.stack : undefined,
      url: e.filename || undefined,
      line: e.lineno || undefined
    });
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    if (!rec.config.console) return;
    rec.console.push({
      id: rec.nextId(),
      ts: Date.now(),
      level: "error",
      text: `Unhandled rejection: ${serializeArg(e.reason)}`
    });
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  restorers.push(() => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  });
}

// ── network ────────────────────────────────────────────────────────────────

function headersOf(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function cap(text: string): string {
  return text.length > BODY_CAP_BYTES ? text.slice(0, BODY_CAP_BYTES) : text;
}

function installNetwork(rec: RecorderGlobal, restorers: Array<() => void>): void {
  const captureBody = async (res: Response): Promise<string | undefined> => {
    if (!rec.config.bodies) return undefined;
    const ct = res.headers.get("content-type") ?? "";
    if (!TEXTY_CONTENT_TYPE.test(ct)) return undefined;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > BODY_CAP_BYTES) return undefined;
    try {
      return cap(await res.clone().text());
    } catch {
      return undefined;
    }
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function patchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> {
      if (!rec.config.network) return originalFetch.call(window, input, init);
      const id = rec.nextId();
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (
        init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")
      ).toUpperCase();
      const started = Date.now();
      try {
        const res = await originalFetch.call(window, input, init);
        const entry: NetworkEntry = {
          id,
          ts: started,
          method,
          url,
          status: res.status,
          statusText: res.statusText,
          ms: Date.now() - started
        };
        rec.network.push(entry);
        const responseBody = await captureBody(res);
        rec.details.set(id, {
          ...entry,
          requestHeaders: init?.headers ? headersOf(new Headers(init.headers)) : undefined,
          requestBody:
            rec.config.bodies && typeof init?.body === "string" ? cap(init.body) : undefined,
          responseHeaders: headersOf(res.headers),
          responseBody
        });
        return res;
      } catch (e) {
        const entry: NetworkEntry = {
          id,
          ts: started,
          method,
          url,
          ms: Date.now() - started,
          error: e instanceof Error ? e.message : String(e)
        };
        rec.network.push(entry);
        rec.details.set(id, entry);
        throw e;
      }
    } as typeof fetch;
    restorers.push(() => {
      window.fetch = originalFetch;
    });
  }

  installXhr(rec, restorers);
  installResourceObserver(rec, restorers);
}

type TrackedXhr = XMLHttpRequest & {
  __aipagego?: { id: number; method: string; url: string; started: number; body?: string };
};

function installXhr(rec: RecorderGlobal, restorers: Array<() => void>): void {
  const XHR = window.XMLHttpRequest;
  if (typeof XHR !== "function") return;
  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;

  XHR.prototype.open = function patchedOpen(
    this: TrackedXhr,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.__aipagego = {
      id: rec.nextId(),
      method: String(method).toUpperCase(),
      url: typeof url === "string" ? url : url.href,
      started: 0
    };
    return (originalOpen as unknown as (...a: unknown[]) => void).call(
      this,
      method,
      url,
      ...rest
    );
  } as typeof XHR.prototype.open;

  XHR.prototype.send = function patchedSend(this: TrackedXhr, body?: unknown) {
    const meta = this.__aipagego;
    if (meta && rec.config.network) {
      meta.started = Date.now();
      if (rec.config.bodies && typeof body === "string") meta.body = cap(body);
      this.addEventListener("loadend", () => {
        const entry: NetworkEntry = {
          id: meta.id,
          ts: meta.started,
          method: meta.method,
          url: meta.url,
          status: this.status || undefined,
          statusText: this.statusText || undefined,
          ms: Date.now() - meta.started,
          error: this.status === 0 ? "network error or aborted" : undefined
        };
        rec.network.push(entry);
        let responseBody: string | undefined;
        if (rec.config.bodies) {
          const ct = this.getResponseHeader("content-type") ?? "";
          if (TEXTY_CONTENT_TYPE.test(ct)) {
            try {
              const t = this.responseText;
              if (typeof t === "string") responseBody = cap(t);
            } catch {
              // responseType made responseText unreadable — metadata only
            }
          }
        }
        rec.details.set(meta.id, { ...entry, requestBody: meta.body, responseBody });
      });
    }
    return (originalSend as unknown as (...a: unknown[]) => void).call(this, body);
  } as typeof XHR.prototype.send;

  restorers.push(() => {
    XHR.prototype.open = originalOpen;
    XHR.prototype.send = originalSend;
  });
}

function installResourceObserver(rec: RecorderGlobal, restorers: Array<() => void>): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const obs = new PerformanceObserver((list) => {
      if (!rec.config.network) return;
      for (const e of list.getEntries() as PerformanceResourceTiming[]) {
        rec.network.push({
          id: rec.nextId(),
          ts: Date.now(),
          method: "GET",
          url: e.name,
          ms: Math.round(e.duration),
          observed: true,
          resourceType: e.initiatorType,
          transferSize: e.transferSize
        });
      }
    });
    obs.observe({ type: "resource", buffered: true });
    restorers.push(() => obs.disconnect());
  } catch {
    // Observer unavailable — metadata-only degradation is acceptable.
  }
}

// ── dialogs ────────────────────────────────────────────────────────────────

function installDialog(rec: RecorderGlobal, restorers: Array<() => void>): void {
  const takePolicy = (): DialogPolicy | null => {
    if (!rec.config.dialog) return null;
    const p = rec.dialogPolicy;
    if (p && p.scope === "next") rec.dialogPolicy = null;
    return p;
  };

  const record = (
    kind: DialogEntry["kind"],
    message: string,
    handled: DialogEntry["handled"],
    extra?: { defaultValue?: string; promptText?: string }
  ) => {
    rec.dialog.push({
      id: rec.nextId(),
      ts: Date.now(),
      kind,
      message,
      handled,
      defaultValue: extra?.defaultValue,
      promptText: extra?.promptText
    });
  };

  const nativeAlert = window.alert;
  const nativeConfirm = window.confirm;
  const nativePrompt = window.prompt;

  window.alert = function patchedAlert(message?: unknown): void {
    const text = String(message ?? "");
    const policy = takePolicy();
    if (!policy) {
      record("alert", text, "passthrough");
      nativeAlert.call(window, text);
      return;
    }
    record("alert", text, policy.accept ? "accepted" : "dismissed");
  } as typeof window.alert;

  window.confirm = function patchedConfirm(message?: unknown): boolean {
    const text = String(message ?? "");
    const policy = takePolicy();
    if (!policy) {
      record("confirm", text, "passthrough");
      return nativeConfirm.call(window, text);
    }
    record("confirm", text, policy.accept ? "accepted" : "dismissed");
    return policy.accept;
  } as typeof window.confirm;

  window.prompt = function patchedPrompt(
    message?: unknown,
    defaultValue?: unknown
  ): string | null {
    const text = String(message ?? "");
    const dflt = defaultValue == null ? undefined : String(defaultValue);
    const policy = takePolicy();
    if (!policy) {
      record("prompt", text, "passthrough", { defaultValue: dflt });
      return nativePrompt.call(window, text, dflt as string);
    }
    const answer = policy.accept ? policy.promptText ?? dflt ?? "" : null;
    record("prompt", text, policy.accept ? "accepted" : "dismissed", {
      defaultValue: dflt,
      promptText: answer ?? undefined
    });
    return answer;
  } as typeof window.prompt;

  restorers.push(() => {
    window.alert = nativeAlert;
    window.confirm = nativeConfirm;
    window.prompt = nativePrompt;
  });
}

if (typeof window !== "undefined" && !window.__AIPAGEGO_REC__) install();
