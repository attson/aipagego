import type { Coordinator, TabInfo } from "@aipagego/coordinator";
import {
  CAPABILITIES,
  isCapability,
  type Capability
} from "@aipagego/shared/capability";
import type { BuiltinTool, Json } from "@aipagego/shared/types";
import type { Exec, Result } from "@aipagego/shared/protocol";
import { highestSeverity, runStaticScan } from "@aipagego/shared/static-scan";
import type { GeneratedTool } from "./tool-gen";
import { PairingWaitTimeoutError } from "./pairing-errors";

const LIST_TABS_PAIRING_TIMEOUT_MS = 45_000;

export interface Hub {
  exec(worker_id: string, params: { session_id: string; tab_id: string; step: Exec["step"] }): Promise<Result>;
  /** Closes connected workers with the graceful code. Absent in test doubles. */
  shutdown?(): Promise<void>;
  /** Releases the port without the graceful close frame. Absent in test doubles. */
  close?(): Promise<void>;
}

export interface HubBundle {
  coordinator: Coordinator;
  hub: Hub;
  port: number;
}

export interface Deps {
  /** Binds the ws port on first call. Everything needing a worker awaits it. */
  ensure(): Promise<HubBundle>;
  /** Non-binding view — tools/list must not have side effects. */
  peek(): HubBundle | null;
  /** URL of the pairing page, once a hub exists. */
  pairUrl(): string | null;
  /** Waits for the extension's HELLO when the browser is not connected yet. */
  waitForWorker(
    timeoutMs?: number,
    onWaiting?: (pairUrl: string) => void | Promise<void>
  ): Promise<string>;
}

export type PairingStatus =
  | { status: "pairing_required"; pair_url: string }
  | { status: "connected"; tab_count: number };

/** Test helper: a Deps whose hub already exists. */
export function staticDeps(coordinator: Coordinator, hub: Hub, port = 0): Deps {
  const bundle: HubBundle = { coordinator, hub, port };
  return {
    ensure: async () => bundle,
    peek: () => bundle,
    pairUrl: () => `http://127.0.0.1:${port}/pair`,
    waitForWorker: async () => singleWorkerId(coordinator, `http://127.0.0.1:${port}/pair`)
  };
}

function singleWorkerId(c: Coordinator, pairUrl: string | null): string {
  const workers = c.workers.list();
  if (workers.length === 0) {
    throw new Error(
      "PAIRING_REQUIRED: 浏览器尚未连接。" +
        (pairUrl ? `请在浏览器中完成配对：${pairUrl}` : "请先调用 pairing_status 获取配对页。")
    );
  }
  if (workers.length > 1) throw new Error("检测到多个浏览器连入；v1 仅支持单 worker，请只保留一个连接");
  return workers[0].id;
}

export async function handlePairingStatus(deps: Deps): Promise<PairingStatus> {
  const { coordinator } = await deps.ensure();
  const workers = coordinator.workers.list();
  if (workers.length > 1) {
    throw new Error("检测到多个浏览器连入；v1 仅支持单 worker，请只保留一个连接");
  }
  if (workers.length === 1) {
    return { status: "connected", tab_count: workers[0].available_tabs.length };
  }
  const pairUrl = deps.pairUrl();
  if (!pairUrl) throw new Error("PAIRING_REQUIRED: 配对服务已启动，但配对页尚不可用");
  return { status: "pairing_required", pair_url: pairUrl };
}

export async function handleListTabs(
  deps: Deps,
  onPairingRequired?: (pairUrl: string) => void | Promise<void>,
  timeoutMs = LIST_TABS_PAIRING_TIMEOUT_MS
): Promise<
  | { status: "connected"; tabs: TabInfo[] }
  | { status: "pairing_required"; pair_url: string; tabs: [] }
> {
  const { coordinator } = await deps.ensure();
  const workers = coordinator.workers.list();
  if (workers.length > 1) {
    throw new Error("检测到多个浏览器连入；v1 仅支持单 worker，请只保留一个连接");
  }
  let worker = workers[0];
  if (!worker) {
    const pairUrl = deps.pairUrl();
    if (!pairUrl) throw new Error("PAIRING_REQUIRED: 配对服务已启动，但配对页尚不可用");
    try {
      await deps.waitForWorker(timeoutMs, onPairingRequired);
    } catch (error) {
      if (error instanceof PairingWaitTimeoutError) {
        return { status: "pairing_required", pair_url: pairUrl, tabs: [] };
      }
      throw error;
    }

    const connectedWorkers = coordinator.workers.list();
    if (connectedWorkers.length > 1) {
      throw new Error("检测到多个浏览器连入；v1 仅支持单 worker，请只保留一个连接");
    }
    worker = connectedWorkers[0];
    if (!worker) {
      return { status: "pairing_required", pair_url: pairUrl, tabs: [] };
    }
  }
  return { status: "connected", tabs: worker.available_tabs };
}

export type BrowserStartResult =
  | { status: "ready"; session_id: string; tab: TabInfo }
  | { status: "select_tab"; tabs: TabInfo[]; message: string }
  | { status: "pairing_required"; pair_url: string; tabs: [] };

function selectionResult(tabs: TabInfo[], message: string): BrowserStartResult {
  return { status: "select_tab", tabs, message };
}

/** Pair with the browser, select only an unambiguous tab, and open a session. */
export async function handleBrowserStart(
  deps: Deps,
  args: Record<string, unknown>,
  onPairingRequired?: (pairUrl: string) => void | Promise<void>,
  timeoutMs = LIST_TABS_PAIRING_TIMEOUT_MS
): Promise<BrowserStartResult> {
  const listed = await handleListTabs(deps, onPairingRequired, timeoutMs);
  if (listed.status === "pairing_required") return listed;

  const tabId = typeof args.tab_id === "string" && args.tab_id.length > 0
    ? args.tab_id
    : undefined;
  const url = typeof args.url === "string" && args.url.length > 0
    ? args.url
    : undefined;

  let selected: TabInfo | undefined;
  if (tabId) {
    selected = listed.tabs.find((tab) => tab.tab_id === tabId);
    if (!selected) {
      throw new Error(`InvalidArgs: browser_start tab_id ${JSON.stringify(tabId)} is not available`);
    }
    if (url && selected.url !== url) {
      throw new Error("InvalidArgs: browser_start tab_id and url must identify the same tab");
    }
  } else if (url) {
    const matches = listed.tabs.filter((tab) => tab.url === url);
    if (matches.length === 1) {
      [selected] = matches;
    } else if (matches.length > 1) {
      return selectionResult(
        matches,
        "Multiple tabs have that exact URL. Choose one and call browser_start again with tab_id."
      );
    } else {
      return selectionResult(
        listed.tabs,
        "No exact URL match. Choose a tab and call browser_start again with tab_id."
      );
    }
  } else if (listed.tabs.length === 1) {
    [selected] = listed.tabs;
  } else {
    return selectionResult(
      listed.tabs,
      "Choose a tab and call browser_start again with tab_id."
    );
  }

  const opened = await handleOpenSession(deps, {
    tab_id: selected.tab_id,
    ...(Array.isArray(args.capabilities) ? { capabilities: args.capabilities } : {}),
    ...(typeof args.idle_timeout_min === "number" ? { idle_timeout_min: args.idle_timeout_min } : {})
  });
  return { status: "ready", session_id: opened.session_id, tab: selected };
}

export async function handleOpenSession(
  deps: Deps,
  args: Record<string, unknown>
): Promise<{ session_id: string }> {
  const { coordinator } = await deps.ensure();
  const worker_id = singleWorkerId(coordinator, deps.pairUrl());
  const tab_id = String(args.tab_id);
  const requested = Array.isArray(args.capabilities) ? (args.capabilities as unknown[]).map(String).filter(isCapability) : [];
  const scope = new Set<Capability>(requested.length ? requested : (CAPABILITIES as readonly Capability[]));
  const idle_timeout_ms = typeof args.idle_timeout_min === "number" ? args.idle_timeout_min * 60_000 : undefined;
  const s = coordinator.openSession({ ai_client_fingerprint: "mcp-local", worker_id, tab_id, scope, idle_timeout_ms });
  return { session_id: s.id };
}

export async function handleCloseSession(
  deps: Deps,
  args: Record<string, unknown>
): Promise<{ ok: true }> {
  const { coordinator } = await deps.ensure();
  coordinator.closeSession(String(args.session_id));
  return { ok: true };
}

export async function handleGetQuota(deps: Deps, args: Record<string, unknown>): Promise<unknown> {
  const { coordinator } = await deps.ensure();
  const q = coordinator.quotaFor(String(args.session_id));
  if (!q) throw new Error(`session ${String(args.session_id)} not found`);
  return q;
}

/**
 * `listTabs` and `openTab` are TOOL_DEFS entries without a BuiltinTool member,
 * so `capabilityForTool`'s exhaustive switch would throw on them. They are
 * tab-plane operations, which is exactly what `tab:open` covers.
 */
const NON_BUILTIN_CAPABILITY: Record<string, Capability> = {
  listTabs: "tab:open",
  openTab: "tab:open"
};

export type PreparedBrowserTool = {
  coordinator: Coordinator;
  hub: Hub;
  session_id: string;
  worker_id: string;
  tab_id: string;
  step: Exec["step"];
  dangerous: boolean;
};

/** Resolve and validate a browser tool call without charging quota or sending EXEC. */
export async function prepareBrowserTool(
  deps: Deps,
  gen: GeneratedTool,
  args: Record<string, unknown>
): Promise<PreparedBrowserTool> {
  const { coordinator, hub } = await deps.ensure();
  const session_id = String(args.session_id);
  const session = coordinator.sessions.get(session_id);
  if (!session) throw new Error(`session ${session_id} not found`);

  const { session_id: _omit, ...suppliedToolArgs } = args;
  const resolved = gen.resolve ? gen.resolve(suppliedToolArgs) : { builtinTool: gen.builtinTool, args: suppliedToolArgs };
  const toolArgs: Record<string, unknown> = { ...resolved.args };
  const tool = resolved.builtinTool as BuiltinTool;

  // The scanner lives in shared, so MCP can select the same capability tier as
  // the extension before the step crosses the websocket.
  if (gen.stepKind === "js") {
    const source = String(toolArgs.source ?? "");
    if (!source) throw new Error("browser_runJS: source required");
    const unsafe = highestSeverity(runStaticScan(source)) === "dangerous";
    const v = coordinator.validateCall({ session_id, kind: "runJS", unsafe });
    if (!v.ok) throw new Error(`${v.error.code}: ${v.error.message}`);
    const requestedTimeout = toolArgs.timeoutMs;
    return {
      coordinator,
      hub,
      session_id,
      worker_id: session.worker_id,
      tab_id: session.tab_id,
      step: {
        kind: "js",
        source,
        ...(typeof requestedTimeout === "number" && Number.isInteger(requestedTimeout) && requestedTimeout > 0
          ? { timeoutMs: requestedTimeout }
          : {})
      },
      dangerous: v.dangerous
    };
  }

  // MCP tools are session-bound, so their schema intentionally omits tabId.
  // These two tools use tabId as their command argument rather than as a route
  // override; supply the bound tab explicitly for the background handler.
  if (tool === "switchToTab" || tool === "closeTab") {
    const boundTabId = Number.parseInt(session.tab_id, 10);
    if (!Number.isFinite(boundTabId)) {
      throw new Error(`InvalidArgs: session tab_id "${session.tab_id}" is not numeric`);
    }
    toolArgs.tabId = boundTabId;
  }

  const override = NON_BUILTIN_CAPABILITY[tool];
  let dangerous: boolean;
  if (override) {
    const v = coordinator.validateCall({ session_id, kind: "capability", capability: override });
    if (!v.ok) throw new Error(`${v.error.code}: ${v.error.message}`);
    dangerous = v.dangerous;
  } else {
    const raw = toolArgs;
    const v = coordinator.validateCall({
      session_id,
      kind: "extension_tool",
      tool,
      httpCookied: tool === "httpRequest" ? Boolean(raw.withCredentials) : undefined,
      dropHasFiles: tool === "drop" ? Array.isArray(raw.files) && raw.files.length > 0 : undefined,
      recorderArmsBodies: tool === "recorderConfig" ? raw.bodies === true : undefined
    });
    if (!v.ok) throw new Error(`${v.error.code}: ${v.error.message}`);
    dangerous = v.dangerous;
  }

  return {
    coordinator,
    hub,
    session_id,
    worker_id: session.worker_id,
    tab_id: session.tab_id,
    step: { kind: "tool", tool, args: toolArgs as Json },
    dangerous
  };
}

export async function handleBrowserTool(deps: Deps, gen: GeneratedTool, args: Record<string, unknown>): Promise<Json> {
  const prepared = await prepareBrowserTool(deps, gen, args);
  prepared.coordinator.recordCall(prepared.session_id, prepared.dangerous);
  const result = await prepared.hub.exec(prepared.worker_id, {
    session_id: prepared.session_id,
    tab_id: prepared.tab_id,
    step: prepared.step
  });
  if (!result.ok) throw new Error(result.error ? `${result.error.code}: ${result.error.message}` : "EXEC failed");
  return (result.return ?? null) as Json;
}
