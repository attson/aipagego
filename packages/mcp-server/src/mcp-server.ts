import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchema } from "@atwebpilot/shared/types";
import { CONTROL_TOOLS } from "./control-tools";
import { DISCOVER_TOOL, handleDiscover } from "./discover-tool";
import { BROWSER_CALL_TOOL } from "./browser-call";
import { generateBrowserTools, readToolMode, type GeneratedTool, type ToolMode } from "./tool-gen";
import {
  handlePairingStatus, handleListTabs, handleOpenSession, handleCloseSession, handleGetQuota, handleBrowserTool,
  type Deps
} from "./handlers";
import { readSkillBundle, SKILL_TOOL } from "./skill-bundle";
import { MCP_VERSION } from "./version";
import { createPairingPresenter, type OpenUrl } from "./pairing-presenter";

export type ToolListEntry = { name: string; description: string; inputSchema: JsonSchema };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type CallResult = { content: ContentBlock[]; isError?: boolean };

/** Every tool the server can execute, regardless of what is currently advertised. */
const ALL_BROWSER_TOOLS: GeneratedTool[] = generateBrowserTools("full");
const BROWSER_BY_NAME = new Map(ALL_BROWSER_TOOLS.map((t) => [t.name, t]));

/**
 * Process-wide advertised set. MCP `tools/list` has no per-session scope, so
 * neither does this; discovery only ever grows it.
 */
export type ToolState = { advertised: Set<string>; browserSurfaceVisible: boolean };

export function createToolState(mode: ToolMode): ToolState {
  return {
    advertised: new Set(generateBrowserTools(mode).map((t) => t.name)),
    browserSurfaceVisible: false
  };
}

const DEFAULT_STATE = createToolState(readToolMode(process.env));

/**
 * The surface an extension predating Plan 32 can execute. Used when a worker
 * connects without `supported_tools`, so the server never advertises a tool
 * that would fail at call time with "unknown tool".
 */
export const LEGACY_TOOLS: readonly string[] = [
  "snapshotDOM", "querySelector", "querySelectorAll", "extractText", "extractImages",
  "getValue", "extractFormState", "hover", "focus", "scroll", "waitFor",
  "click", "fillInput", "setCheckbox", "selectOption", "httpRequest",
  "submitForm", "uploadFile", "readStorage"
] as const;

/**
 * Which built-ins the connected worker can run. Undefined means "no worker
 * connected yet" — `tools/list` is often called before the browser attaches,
 * and answering with an empty surface then would be worse than optimistic.
 */
function workerToolSupport(deps?: Deps): ReadonlySet<string> | undefined {
  // peek(), never ensure(): answering tools/list must not bind a port.
  const bundle = deps?.peek();
  if (!bundle) return undefined;
  const workers = bundle.coordinator.workers.list();
  if (workers.length === 0) return undefined;
  const supported = workers[0].supported_tools;
  return supported ?? new Set(LEGACY_TOOLS);
}

export function buildToolList(deps?: Deps, state: ToolState = DEFAULT_STATE): ToolListEntry[] {
  const supported = workerToolSupport(deps);
  const browser = state.browserSurfaceVisible || supported
    ? ALL_BROWSER_TOOLS.filter((t) => state.advertised.has(t.name))
      .filter((t) => !supported || t.builtinTools.every((b) => supported.has(b)))
    : [];
  return [
    { name: SKILL_TOOL.name, description: SKILL_TOOL.description, inputSchema: SKILL_TOOL.inputSchema as JsonSchema },
    ...CONTROL_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    { name: DISCOVER_TOOL.name, description: DISCOVER_TOOL.description, inputSchema: DISCOVER_TOOL.inputSchema },
    { name: BROWSER_CALL_TOOL.name, description: BROWSER_CALL_TOOL.description, inputSchema: BROWSER_CALL_TOOL.inputSchema },
    ...browser.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as JsonSchema }))
  ];
}

const ok = (data: unknown): CallResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? null) }]
});

/**
 * Screenshots have to reach the model as an image block; JSON-stringifying the
 * base64 would just burn context. Falls back to text when the payload does not
 * look like an image so a malformed result is still legible.
 */
function toolResult(gen: GeneratedTool, data: unknown): CallResult {
  if (gen.resultKind !== "image") return ok(data);
  const d = (data ?? {}) as Record<string, unknown>;
  if (typeof d.data !== "string") return ok(data);
  const mimeType = typeof d.media_type === "string" ? d.media_type : "image/png";
  const { data: imageData, media_type: _mediaType, ...metadata } = d;
  const content: ContentBlock[] = [{ type: "image", data: imageData as string, mimeType }];
  if (Object.keys(metadata).length > 0) {
    content.push({ type: "text", text: JSON.stringify(metadata) });
  }
  return { content };
}
const fail = (message: string): CallResult => ({ content: [{ type: "text", text: message }], isError: true });

export async function dispatchCall(
  deps: Deps,
  name: string,
  args: Record<string, unknown>,
  state: ToolState = DEFAULT_STATE,
  onListChanged?: () => Promise<void>,
  onPairingRequired?: (url: string) => void
): Promise<CallResult> {
  try {
    if (name === SKILL_TOOL.name) {
      const bundle = readSkillBundle(args.topic);
      return { content: [{ type: "text", text: bundle.content }] };
    }
    if (name === DISCOVER_TOOL.name) {
      const r = handleDiscover({
        all: ALL_BROWSER_TOOLS, advertised: state.advertised, args,
        supported: workerToolSupport(deps)
      });
      if (r.changed && onListChanged) await onListChanged();
      const { changed: _c, ...body } = r;
      return ok(body);
    }
    if (name === BROWSER_CALL_TOOL.name) {
      return handleBrowserCall(deps, args, state);
    }
    if (name === "pairing_status") {
      const result = await handlePairingStatus(deps);
      if (result.status === "connected") await revealBrowserSurface(state, onListChanged);
      else onPairingRequired?.(result.pair_url);
      return ok(result);
    }
    if (name === "list_tabs") {
      const result = await handleListTabs(deps);
      if (result.status === "connected") await revealBrowserSurface(state, onListChanged);
      else onPairingRequired?.(result.pair_url);
      return ok(result);
    }
    if (name === "open_session") {
      const result = await handleOpenSession(deps, args);
      await revealBrowserSurface(state, onListChanged);
      return ok(result);
    }
    if (name === "close_session") return ok(await handleCloseSession(deps, args));
    if (name === "get_quota") return ok(await handleGetQuota(deps, args));
    const gen = BROWSER_BY_NAME.get(name);
    if (gen) return toolResult(gen, await handleBrowserTool(deps, gen, args));
    return fail(`unknown tool: ${name}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("PAIRING_REQUIRED")) {
      const pairUrl = deps.pairUrl();
      if (pairUrl) onPairingRequired?.(pairUrl);
    }
    return fail(message);
  }
}

async function handleBrowserCall(
  deps: Deps,
  args: Record<string, unknown>,
  state: ToolState
): Promise<CallResult> {
  const rawName = typeof args.tool === "string" ? args.tool.trim() : "";
  if (!rawName) return fail("InvalidArgs: browser_call requires tool");
  const name = rawName.startsWith("browser_") ? rawName : `browser_${rawName}`;
  const gen = BROWSER_BY_NAME.get(name);
  if (!gen) return fail(`Unknown browser tool: ${rawName}`);
  if (!state.advertised.has(name)) {
    return fail(`${name} is not enabled; call browser_discoverTools first`);
  }

  const supported = workerToolSupport(deps);
  if (supported && !gen.builtinTools.every((tool) => supported.has(tool))) {
    return fail(`${name} is not supported by the connected browser extension`);
  }

  if (typeof args.session_id !== "string" || args.session_id.length === 0) {
    return fail("InvalidArgs: browser_call requires session_id");
  }
  if (args.args === null || typeof args.args !== "object" || Array.isArray(args.args)) {
    return fail("InvalidArgs: browser_call args must be an object");
  }

  const toolArgs = {
    ...(args.args as Record<string, unknown>),
    session_id: args.session_id
  };
  return toolResult(gen, await handleBrowserTool(deps, gen, toolArgs));
}

async function revealBrowserSurface(
  state: ToolState,
  onListChanged?: () => Promise<void>
): Promise<void> {
  if (state.browserSurfaceVisible) return;
  state.browserSurfaceVisible = true;
  await onListChanged?.();
}

export type McpServerOptions = { fallbackOpenUrl?: OpenUrl };

export function createMcpServer(
  deps: Deps,
  state: ToolState = DEFAULT_STATE,
  options: McpServerOptions = {}
): Server {
  const server = new Server(
    { name: "atwebpilot-mcp", version: MCP_VERSION },
    { capabilities: { tools: { listChanged: true }, logging: {} } }
  );
  const presentPairing = createPairingPresenter(server, options.fallbackOpenUrl);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildToolList(deps, state) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const onListChanged = async () => {
      try {
        await server.sendToolListChanged();
      } catch (error) {
        console.error("[atwebpilot-mcp] failed to send tools/list_changed:", error instanceof Error ? error.message : String(error));
      }
    };
    return dispatchCall(deps, req.params.name, args, state, onListChanged, presentPairing);
  });
  return server;
}
