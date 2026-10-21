/**
 * Stands in for the extension runtime so the real side panel can run as a plain
 * web page.
 *
 * The surface is small because `sidepanel/rpc.ts` funnels every background call
 * through one `chrome.runtime.sendMessage(req)`. Beyond that the panel only
 * touches storage, tabs, and a little bookmarks/history.
 *
 * Anything the shim does not recognise resolves `{ok:false}` rather than
 * hanging: the panel's RPC retries four times with backoff on a missing
 * receiver, so a silent drop would stall the demo for seconds.
 */

export type PageStepRunner = (step: unknown, bindings?: unknown) => Promise<unknown>;

export type ShimOptions = {
  /** Resolves steps that need the page — forwarded to the harness. */
  onPageStep?: PageStepRunner;
  /** Seeds storage so the panel starts configured and never asks for a key. */
  seed?: Record<string, unknown>;
  tabId?: number;
  url?: string;
  title?: string;
};

type Listener = (changes: Record<string, unknown>, area: string) => void;

export const DEMO_TAB_ID = 1;
export const DEMO_URL = "https://demo.aipagego.local/product/ergo-chair-pro";
export const DEMO_TITLE = "人体工学办公椅 Pro";

/** Settings that make the panel behave as if it were already configured. */
export function demoSeed(): Record<string, unknown> {
  return {
    "aipagego.settings": {
      provider: "anthropic",
      model: "demo-model",
      maxTokens: 4096,
      maxRounds: 20,
      permissionMode: "default"
    },
    "aipagego.demo": true
  };
}

export function installChromeShim(opts: ShimOptions = {}): void {
  const store = new Map<string, unknown>(Object.entries({ ...demoSeed(), ...opts.seed }));
  const listeners = new Set<Listener>();
  const tabId = opts.tabId ?? DEMO_TAB_ID;
  const tab = {
    id: tabId,
    windowId: 1,
    active: true,
    url: opts.url ?? DEMO_URL,
    title: opts.title ?? DEMO_TITLE
  };

  const ok = (data: unknown) => ({ ok: true as const, data });
  const fail = (error: string) => ({ ok: false as const, error });

  async function handleRpc(req: unknown): Promise<unknown> {
    const r = (req ?? {}) as { type?: string; step?: unknown; bindings?: unknown };
    switch (r.type) {
      case "runs.runOneStep":
      case "scripting.injectMain": {
        if (!opts.onPageStep) return fail("demo: no page runner wired");
        try {
          return ok(await opts.onPageStep(r.step ?? req, r.bindings));
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      }
      case "tools.list":
      case "tools.matching":
      case "runs.list":
      case "presets.list":
        return ok([]);
      case "tabs.list":
        return ok([tab]);
      case "tabs.open":
        return ok({ tabId, url: tab.url, title: tab.title });
      case "chat.session.start":
        return ok({ id: `demo_run_${Date.now()}` });
      case "chat.session.appendLog":
        return ok(null);
      case "chat.session.end":
        return ok({ id: "demo_run", status: "ok" });
      case "runs.start":
        return ok({ id: "demo_run" });
      default:
        // Never hang. An unknown type is a bug in the demo, not a reason to
        // make the visitor wait through four retries.
        return fail(`demo shim: unhandled rpc ${String(r.type)}`);
    }
  }

  const shim = {
    runtime: {
      id: "aipagego-demo",
      getManifest: () => ({ version: "demo" }),
      getURL: (p: string) => p,
      sendMessage: (req: unknown) => handleRpc(req),
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
      lastError: undefined
    },
    storage: {
      local: {
        get: async (keys?: string | string[] | null) => {
          const out: Record<string, unknown> = {};
          const wanted =
            typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : [...store.keys()];
          for (const k of wanted) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        set: async (items: Record<string, unknown>) => {
          const changes: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: store.get(k), newValue: v };
            store.set(k, v);
          }
          for (const l of listeners) l(changes, "local");
        },
        remove: async (key: string) => {
          store.delete(key);
        },
        clear: async () => store.clear()
      },
      session: {
        get: async () => ({}),
        set: async () => undefined,
        remove: async () => undefined
      },
      onChanged: {
        addListener: (fn: Listener) => listeners.add(fn),
        removeListener: (fn: Listener) => listeners.delete(fn)
      }
    },
    tabs: {
      query: async () => [tab],
      get: async () => tab,
      update: async () => tab,
      create: async () => tab,
      remove: async () => undefined,
      sendMessage: async () => undefined,
      captureVisibleTab: async () =>
        // 1x1 transparent png — the demo never shows a screenshot, but the
        // panel's visual-evidence path expects a data URL rather than a throw.
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      onRemoved: { addListener: () => undefined, removeListener: () => undefined },
      onUpdated: { addListener: () => undefined, removeListener: () => undefined },
      onActivated: { addListener: () => undefined, removeListener: () => undefined }
    },
    windows: { update: async () => undefined },
    bookmarks: { search: async () => [], getTree: async () => [] },
    history: { search: async () => [] },
    permissions: { contains: async () => false, request: async () => false },
    alarms: {
      create: () => undefined,
      clear: async () => true,
      onAlarm: { addListener: () => undefined, removeListener: () => undefined }
    },
    sidePanel: { setOptions: async () => undefined, open: async () => undefined }
  };

  (globalThis as unknown as { chrome: unknown }).chrome = shim;
}
