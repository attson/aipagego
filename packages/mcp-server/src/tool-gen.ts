import { TOOL_DEFS } from "@aipagego/shared/llm";
import type { LlmTool } from "@aipagego/shared/llm";
import type { JsonSchema } from "@aipagego/shared/types";
import { readAIPageGoEnv } from "./env";

/**
 * Tools deliberately withheld from MCP.
 *
 * - askUser needs a human at the side panel; an MCP session has none.
 * - attachTab / detachTab are side-panel multi-tab bookkeeping. An MCP
 *   session already has its tab bound by open_session.
 */
export const BLOCKED_TOOLS = new Set<string>(["askUser", "attachTab", "detachTab"]);

/**
 * Advertised by default. The boundary rule: everyday browse / scrape / fill /
 * navigate / capture tasks must close without calling browser_discoverTools.
 */
export const CORE_TOOLS: readonly string[] = [
  // page state
  "takeSnapshot", "findElements", "getPageInfo", "extractText",
  // page index
  "createPageIndex", "searchPageIndex", "readPageBlock", "extractPageFields",
  // interaction
  "clickByUid", "click", "fillByUid", "fillInput", "fillForm", "selectOption", "setCheckbox",
  "hover", "pressKey", "drag", "drop", "uploadFile",
  // navigation and tabs
  "navigate", "listTabs", "openTab", "closeTab", "resize", "scroll",
  // observation
  "screenshot", "waitFor", "runJS", "consoleMessages", "networkRequests"
] as const;

export type ToolMode = "core" | "full";

/** Result payloads that must reach MCP as an image block rather than JSON. */
const IMAGE_RESULT_TOOLS = new Set<string>(["screenshot"]);

/** runJS travels as a `js` step, not a `tool` step. */
const JS_STEP_TOOLS = new Set<string>(["runJS"]);

export type GeneratedTool = {
  name: string;
  /** Default/first builtin; what `tools/list` filtering and legacy paths use. */
  builtinTool: string;
  /** Every builtin this MCP tool may resolve to. Length 1 unless merged. */
  builtinTools: readonly string[];
  description: string;
  resultKind: "json" | "image";
  stepKind: "tool" | "js";
  inputSchema: { type: string; properties?: Record<string, JsonSchema>; required?: string[] };
  /**
   * Merged tools pick their real builtin from the arguments. Runs before
   * capability validation so tiers and dangerous accounting see the builtin.
   */
  resolve?: (args: Record<string, unknown>) => { builtinTool: string; args: Record<string, unknown> };
};

const SESSION_ID_FIELD: JsonSchema = {
  type: "string",
  description: "Session id"
} as JsonSchema;

/**
 * Recursively strips every `description` key from a JSON-schema value: the
 * side-panel wording is Chinese and example-heavy, and nests inside
 * `items` / nested `properties` / `oneOf`/`anyOf`/`allOf`, so a shallow strip
 * would still leak CJK text into the MCP surface.
 */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripDescriptions);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === "description") continue;
      out[key] = stripDescriptions(v);
    }
    return out;
  }
  return value;
}

/**
 * MCP schemas drop every property description that `mcp.params` does not
 * override: the side-panel wording is Chinese and example-heavy, and the
 * agent reads strategy from the skill bundle instead. Descriptions are
 * stripped recursively (nested `items` / `properties` / `oneOf` and friends),
 * then `mcp.params` overrides are applied to the top-level properties only.
 */
function rebuildSchema(src: JsonSchema, params: Record<string, string>): GeneratedTool["inputSchema"] {
  const s = src as { type?: string; properties?: Record<string, JsonSchema>; required?: string[] };
  const properties: Record<string, JsonSchema> = {};
  for (const [key, prop] of Object.entries(s.properties ?? {})) {
    const stripped = stripDescriptions(prop) as Record<string, unknown>;
    properties[key] = (params[key] ? { ...stripped, description: params[key] } : stripped) as JsonSchema;
  }
  properties.session_id = SESSION_ID_FIELD;
  if (!properties.tabId) {
    properties.tabId = { type: "integer" } as JsonSchema;
  }
  const required = [...new Set([...(s.required ?? []).filter((r) => r !== "tabId"), "session_id"])];
  return { type: "object", properties, required };
}

function fromDef(t: LlmTool): GeneratedTool {
  return {
    name: `browser_${t.name}`,
    builtinTool: t.name,
    builtinTools: [t.name],
    description: t.mcp?.description ?? t.description,
    resultKind: IMAGE_RESULT_TOOLS.has(t.name) ? "image" : "json",
    stepKind: JS_STEP_TOOLS.has(t.name) ? "js" : "tool",
    inputSchema: rebuildSchema(t.input_schema, t.mcp?.params ?? {})
  };
}

/**
 * TOOL_DEFS entries folded into another MCP tool. They stay available to the
 * side panel; over MCP they are reached through the merged tool below or,
 * for back/forward, through navigate({action}).
 */
export const MERGED_AWAY_TOOLS = new Set<string>([
  "navigateBack", "navigateForward",
  "highlightElement", "highlightText",
  "readStorage", "writeStorage"
]);

function schemaWithSession(
  properties: Record<string, JsonSchema>,
  required: string[]
): GeneratedTool["inputSchema"] {
  return { type: "object", properties: { ...properties, session_id: SESSION_ID_FIELD }, required: [...required, "session_id"] };
}

const STORE_ENUM = { type: "string", enum: ["local", "session"] } as JsonSchema;

export const MERGED_TOOLS: GeneratedTool[] = [
  {
    name: "browser_highlight",
    builtinTool: "highlightElement",
    builtinTools: ["highlightElement", "highlightText"],
    description: "Temporarily outline an element (selector or uid) or highlight the first occurrence of text. Visual only; exactly one of text/selector/uid.",
    resultKind: "json",
    stepKind: "tool",
    inputSchema: schemaWithSession(
      {
        text: { type: "string" } as JsonSchema,
        selector: { type: "string" } as JsonSchema,
        uid: { type: "string" } as JsonSchema,
        ms: { type: "integer", default: 3000 } as JsonSchema
      },
      []
    ),
    resolve(args) {
      const given = ["text", "selector", "uid"].filter((k) => args[k] != null && args[k] !== "");
      if (given.length !== 1) {
        throw new Error("InvalidArgs: browser_highlight needs exactly one of text / selector / uid");
      }
      const { text, selector, uid, ms } = args;
      const withMs = (o: Record<string, unknown>) => (ms == null ? o : { ...o, ms });
      if (given[0] === "text") return { builtinTool: "highlightText", args: withMs({ text }) };
      return { builtinTool: "highlightElement", args: withMs(selector != null ? { selector } : { uid }) };
    }
  },
  {
    name: "browser_storage",
    builtinTool: "readStorage",
    builtinTools: ["readStorage", "writeStorage"],
    description: "Read (op=get) or write (op=set, needs value) one key in localStorage or sessionStorage. Dangerous, reviewed.",
    resultKind: "json",
    stepKind: "tool",
    inputSchema: schemaWithSession(
      {
        op: { type: "string", enum: ["get", "set"] } as JsonSchema,
        store: STORE_ENUM,
        key: { type: "string" } as JsonSchema,
        value: { type: "string", description: "set only; JSON.stringify non-strings yourself" } as JsonSchema
      },
      ["op", "store", "key"]
    ),
    resolve(args) {
      const { op, store, key, value } = args;
      if (op === "get") return { builtinTool: "readStorage", args: { store, key } };
      if (op === "set") {
        if (typeof value !== "string") throw new Error("InvalidArgs: browser_storage op=set requires a string value");
        return { builtinTool: "writeStorage", args: { store, key, value } };
      }
      throw new Error(`InvalidArgs: browser_storage op must be "get" or "set", got ${JSON.stringify(op)}`);
    }
  }
];

export function generateBrowserTools(mode: ToolMode = "core"): GeneratedTool[] {
  const core = new Set(CORE_TOOLS);
  const plain = TOOL_DEFS.filter((t) => {
    if (BLOCKED_TOOLS.has(t.name) || MERGED_AWAY_TOOLS.has(t.name)) return false;
    return mode === "full" || core.has(t.name);
  }).map(fromDef);
  return mode === "full" ? [...plain, ...MERGED_TOOLS] : plain;
}

/**
 * Defaults to `core`. An unrecognised value falls back to `core` with a
 * warning on stderr — stdout is the MCP channel and must stay clean.
 */
export function readToolMode(env: Record<string, string | undefined>): ToolMode {
  const raw = readAIPageGoEnv(env, "MCP_TOOLS");
  if (raw == null || raw === "") return "core";
  if (raw === "core" || raw === "full") return raw;
  process.stderr.write(
    `[aipagego-mcp] AIPAGEGO_MCP_TOOLS="${raw}" is not recognised; using "core"\n`
  );
  return "core";
}

export type DiscoverGroup = "export" | "network" | "storage" | "browser-data" | "inspect" | "legacy-dom" | "form" | "tabs";

/** Keyed by MCP name. Everything outside CORE_TOOLS must appear exactly once. */
export const DISCOVERABLE_GROUPS: Record<DiscoverGroup, readonly string[]> = {
  export: ["browser_downloadImage", "browser_downloadSpreadsheet"],
  network: ["browser_httpRequest", "browser_networkRequestDetail", "browser_recorderConfig", "browser_handleDialog"],
  storage: ["browser_storage"],
  "browser-data": ["browser_searchBookmarks", "browser_searchHistory"],
  inspect: [
    "browser_inspectElement",
    "browser_highlight",
    "browser_getValue",
    "browser_extractFormState",
    "browser_collectStructuredData"
  ],
  "legacy-dom": ["browser_snapshotDOM", "browser_querySelector", "browser_querySelectorAll", "browser_extractImages", "browser_focus"],
  form: ["browser_submitForm"],
  tabs: ["browser_switchToTab"]
};

const GROUP_BY_NAME = new Map<string, DiscoverGroup>(
  (Object.entries(DISCOVERABLE_GROUPS) as Array<[DiscoverGroup, readonly string[]]>)
    .flatMap(([g, names]) => names.map((n) => [n, g] as const))
);

export function groupOf(mcpName: string): DiscoverGroup | undefined {
  return GROUP_BY_NAME.get(mcpName);
}

export type CatalogEntry = { name: string; group: DiscoverGroup; description: string };

/** Tools in `all` that `advertised` does not yet contain, grouped for the agent. */
export function discoveryCatalog(all: GeneratedTool[], advertised: ReadonlySet<string>): CatalogEntry[] {
  return all
    .filter((t) => !advertised.has(t.name))
    .map((t) => ({ name: t.name, group: groupOf(t.name) ?? ("legacy-dom" as DiscoverGroup), description: t.description }))
    .sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
