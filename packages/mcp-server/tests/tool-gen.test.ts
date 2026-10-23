import { describe, it, expect } from "vitest";
import {
  BLOCKED_TOOLS,
  CORE_TOOLS,
  DISCOVERABLE_GROUPS,
  discoveryCatalog,
  generateBrowserTools,
  groupOf,
  readToolMode
} from "../src/tool-gen";

describe("generateBrowserTools", () => {
  const tools = generateBrowserTools("full");

  it("exposes every tool except the block-list", () => {
    const names = tools.map((t) => t.builtinTool);
    // 58 TOOL_DEFS minus three blocked, minus six merged into two.
    expect(names).toHaveLength(51);
    for (const b of BLOCKED_TOOLS) expect(names).not.toContain(b);
    expect(new Set(names).size).toBe(names.length);
  });

  it("reaches the tools the old 19-name allow-list withheld", () => {
    const names = new Set(tools.map((t) => t.name));
    for (const n of [
      "browser_runJS",
      "browser_listTabs",
      "browser_openTab",
      "browser_takeSnapshot",
      "browser_clickByUid",
      "browser_screenshot",
      "browser_downloadSpreadsheet",
      "browser_createPageIndex"
    ]) {
      expect(names.has(n), n).toBe(true);
    }
  });

  it("reaches the Plan 32 parity tools", () => {
    const names = new Set(tools.map((t) => t.name));
    for (const n of [
      "browser_consoleMessages",
      "browser_networkRequests",
      "browser_networkRequestDetail",
      "browser_handleDialog",
      "browser_recorderConfig",
      "browser_drag",
      "browser_drop",
      "browser_resize",
      "browser_findElements"
    ]) {
      expect(names.has(n), n).toBe(true);
    }
  });

  it("still withholds the blocked tools", () => {
    const names = new Set(tools.map((t) => t.name));
    for (const n of ["browser_askUser", "browser_attachTab", "browser_detachTab"]) {
      expect(names.has(n), n).toBe(false);
    }
  });

  it("injects required session_id and keeps optional tabId for multi-tab routing", () => {
    const click = tools.find((t) => t.name === "browser_click")!;
    const props = click.inputSchema.properties as Record<string, unknown>;
    expect(props.session_id).toBeTruthy();
    expect(props.tabId).toMatchObject({ type: "integer" });
    expect((click.inputSchema.required as string[]).includes("session_id")).toBe(true);
    expect((click.inputSchema.required as string[]).includes("selector")).toBe(true);
    expect((click.inputSchema.required as string[]).includes("tabId")).toBe(false);
  });

  it("makes tab commands targetable while defaulting to the primary tab", () => {
    for (const name of ["browser_closeTab", "browser_switchToTab"]) {
      const tool = tools.find((entry) => entry.name === name)!;
      expect(tool.inputSchema.properties?.tabId).toMatchObject({ type: "integer" });
      expect(tool.inputSchema.required).not.toContain("tabId");
    }
  });

  it("records the underlying builtin tool name", () => {
    const click = tools.find((t) => t.name === "browser_click")!;
    expect(click.builtinTool).toBe("click");
  });

  it("marks screenshot as an image result and everything else as json", () => {
    expect(tools.find((t) => t.builtinTool === "screenshot")!.resultKind).toBe("image");
    expect(tools.find((t) => t.builtinTool === "click")!.resultKind).toBe("json");
  });

  it("marks runJS as a js step so the caller does not send it as a tool step", () => {
    expect(tools.find((t) => t.builtinTool === "runJS")!.stepKind).toBe("js");
    expect(tools.find((t) => t.builtinTool === "click")!.stepKind).toBe("tool");
  });
});

describe("core mode", () => {
  it("is the documented core set and a strict subset of full", () => {
    const core = generateBrowserTools("core").map((t) => t.builtinTool);
    const full = new Set(generateBrowserTools("full").map((t) => t.builtinTool));
    expect(core.sort()).toEqual([...CORE_TOOLS].sort());
    for (const n of core) expect(full.has(n), n).toBe(true);
  });

  it("covers browse / scrape / fill / navigate / capture without discovery", () => {
    const core = new Set(generateBrowserTools("core").map((t) => t.builtinTool));
    for (const n of [
      "takeSnapshot", "findElements", "getPageInfo", "extractText",
      "createPageIndex", "searchPageIndex", "readPageBlock", "extractPageFields",
      "clickByUid", "click", "fillByUid", "fillInput", "fillForm", "selectOption", "setCheckbox",
      "hover", "pressKey", "drag", "drop", "uploadFile",
      "navigate", "listTabs", "openTab", "closeTab", "resize", "scroll",
      "screenshot", "waitFor", "runJS", "consoleMessages", "networkRequests"
    ]) expect(core.has(n), n).toBe(true);
    for (const n of ["switchToTab", "downloadSpreadsheet", "httpRequest", "readStorage", "snapshotDOM", "searchHistory"]) {
      expect(core.has(n), n).toBe(false);
    }
  });
});

describe("mcp descriptions", () => {
  const tools = generateBrowserTools("full");
  it("uses the English mcp.description, not the side-panel text", () => {
    const click = tools.find((t) => t.builtinTool === "click")!;
    expect(click.description).not.toMatch(/[一-鿿]/);
    expect(click.description).toMatch(/^Click/);
  });
  it("keeps only mcp.params property descriptions and a short session_id", () => {
    const fill = tools.find((t) => t.builtinTool === "fillInput")!;
    const props = fill.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.slowly.description).toBe("type char by char for controlled components");
    expect(props.selector.description).toBeUndefined();
    expect(props.session_id.description).toBe("Session id");
  });
  it("never leaks CJK text into the MCP surface", () => {
    for (const t of tools) {
      expect(JSON.stringify({ d: t.description, s: t.inputSchema }), t.name).not.toMatch(/[一-鿿]/);
    }
  });

  it("warns that switchToTab is only for an explicit foreground request", () => {
    const switcher = tools.find((t) => t.builtinTool === "switchToTab")!;
    expect(switcher.description).toMatch(/only when the user explicitly asks/i);
    expect(switcher.description).toMatch(/already operate on the session-bound tab/i);
  });
});

describe("merged tools", () => {
  const full = generateBrowserTools("full");
  const byName = new Map(full.map((t) => [t.name, t]));

  it("removes navigateBack/navigateForward in favour of navigate({action})", () => {
    expect(byName.has("browser_navigateBack")).toBe(false);
    expect(byName.has("browser_navigateForward")).toBe(false);
    expect(byName.has("browser_navigate")).toBe(true);
  });

  it("exposes browser_highlight resolving to highlightText or highlightElement", () => {
    const h = byName.get("browser_highlight")!;
    expect(byName.has("browser_highlightElement")).toBe(false);
    expect(byName.has("browser_highlightText")).toBe(false);
    expect([...h.builtinTools].sort()).toEqual(["highlightElement", "highlightText"]);
    expect(h.resolve!({ text: "hello", ms: 500 })).toEqual({ builtinTool: "highlightText", args: { text: "hello", ms: 500 } });
    expect(h.resolve!({ selector: ".x" })).toEqual({ builtinTool: "highlightElement", args: { selector: ".x" } });
    expect(h.resolve!({ uid: "el_1" })).toEqual({ builtinTool: "highlightElement", args: { uid: "el_1" } });
    expect(() => h.resolve!({})).toThrow(/InvalidArgs/);
    expect(() => h.resolve!({ text: "a", selector: ".x" })).toThrow(/InvalidArgs/);
  });

  it("exposes browser_storage resolving on op", () => {
    const s = byName.get("browser_storage")!;
    expect(byName.has("browser_readStorage")).toBe(false);
    expect(byName.has("browser_writeStorage")).toBe(false);
    expect([...s.builtinTools].sort()).toEqual(["readStorage", "writeStorage"]);
    expect(s.resolve!({ op: "get", store: "local", key: "k" })).toEqual({ builtinTool: "readStorage", args: { store: "local", key: "k" } });
    expect(s.resolve!({ op: "set", store: "session", key: "k", value: "v" })).toEqual({ builtinTool: "writeStorage", args: { store: "session", key: "k", value: "v" } });
    expect(() => s.resolve!({ op: "set", store: "local", key: "k" })).toThrow(/InvalidArgs/);
    expect(() => s.resolve!({ op: "delete", store: "local", key: "k" })).toThrow(/InvalidArgs/);
    expect((s.inputSchema.properties!.op as { enum: string[] }).enum).toEqual(["get", "set"]);
    expect(s.inputSchema.required).toEqual(expect.arrayContaining(["op", "store", "key", "session_id"]));
  });

  it("plain tools carry a single builtin and no resolve", () => {
    const click = byName.get("browser_click")!;
    expect(click.builtinTools).toEqual(["click"]);
    expect(click.resolve).toBeUndefined();
  });

  it("full mode has 58 - 3 blocked - 6 merged-away + 2 merged = 51 browser tools", () => {
    expect(full.length).toBe(51);
  });
});

describe("readToolMode", () => {
  it("defaults to core", () => {
    expect(readToolMode({})).toBe("core");
    expect(readToolMode({ AIPAGEGO_MCP_TOOLS: "" })).toBe("core");
  });
  it("accepts full", () => {
    expect(readToolMode({ AIPAGEGO_MCP_TOOLS: "full" })).toBe("full");
  });
  it("falls back to core on an unrecognised value (including the removed parity)", () => {
    expect(readToolMode({ AIPAGEGO_MCP_TOOLS: "parity" })).toBe("core");
    expect(readToolMode({ AIPAGEGO_MCP_TOOLS: "nonsense" })).toBe("core");
  });
});

describe("discovery catalog", () => {
  const full = generateBrowserTools("full");
  const core = new Set(generateBrowserTools("core").map((t) => t.name));

  it("assigns every non-core tool to exactly one group and no core tool to any", () => {
    const grouped = Object.values(DISCOVERABLE_GROUPS).flat();
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const t of full) {
      if (core.has(t.name)) expect(groupOf(t.name), t.name).toBeUndefined();
      else expect(groupOf(t.name), t.name).toBeTruthy();
    }
    for (const n of grouped) expect(full.some((t) => t.name === n), n).toBe(true);
  });

  it("lists what is not advertised, sorted by group then name", () => {
    const cat = discoveryCatalog(full, core);
    expect(cat.length).toBe(full.length - core.size);
    expect(cat.map((c) => c.name)).toContain("browser_downloadSpreadsheet");
    expect(cat).toContainEqual(expect.objectContaining({ name: "browser_switchToTab", group: "tabs" }));
    expect(cat.map((c) => c.name)).not.toContain("browser_click");
    const keys = cat.map((c) => `${c.group} ${c.name}`);
    expect(keys).toEqual([...keys].sort());
    for (const c of cat) expect(c.description).not.toMatch(/[一-鿿]/);
  });

  it("shrinks as tools get advertised", () => {
    const adv = new Set([...core, "browser_downloadSpreadsheet"]);
    expect(discoveryCatalog(full, adv).map((c) => c.name)).not.toContain("browser_downloadSpreadsheet");
  });
});
