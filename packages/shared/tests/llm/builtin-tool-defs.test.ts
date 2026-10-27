import { describe, it, expect } from "vitest";
import { TOOL_DEFS } from "../../src/llm";

describe("TOOL_DEFS (hoisted to shared)", () => {
  it("includes the 19 builtin exec tools by name", () => {
    const names = new Set(TOOL_DEFS.map((t) => t.name));
    for (const n of [
      "snapshotDOM", "querySelector", "querySelectorAll", "extractText", "extractImages",
      "getValue", "extractFormState", "hover", "focus", "scroll", "waitFor",
      "click", "fillInput", "setCheckbox", "selectOption", "httpRequest",
      "submitForm", "uploadFile", "readStorage"
    ]) {
      expect(names.has(n)).toBe(true);
    }
  });

  it("each def has name/description/input_schema", () => {
    for (const t of TOOL_DEFS) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(t.input_schema).toBeTruthy();
    }
  });
});

describe("Plan 32 parity tool defs", () => {
  const byName = new Map(TOOL_DEFS.map((t) => [t.name, t]));
  const props = (n: string) =>
    (byName.get(n)!.input_schema as { properties: Record<string, unknown> }).properties;

  it("defines every new tool exactly once", () => {
    for (const name of [
      "consoleMessages", "networkRequests", "networkRequestDetail", "handleDialog",
      "recorderConfig", "navigateBack", "navigateForward", "resize", "drag", "drop",
      "findElements"
    ]) {
      expect(byName.has(name), name).toBe(true);
    }
    expect(TOOL_DEFS.length).toBe(new Set(TOOL_DEFS.map((t) => t.name)).size);
    expect(TOOL_DEFS.length).toBe(59);
    const collectionSchema = byName.get("collectStructuredData")?.input_schema as {
      required?: string[];
    } | undefined;
    expect(collectionSchema?.required).toEqual(["recipe"]);
  });

  it("documents the dialog policy caveat", () => {
    expect(byName.get("handleDialog")!.description).toContain("main-world");
  });

  it("documents the strict-CSP requirement for runJS", () => {
    expect(byName.get("runJS")!.description).toMatch(/严格 CSP.*CDP/);
  });

  it("extends click, fillInput, screenshot and waitFor", () => {
    expect(Object.keys(props("click"))).toEqual(
      expect.arrayContaining(["doubleClick", "button", "modifiers"])
    );
    expect(Object.keys(props("fillInput"))).toEqual(
      expect.arrayContaining(["slowly", "submit"])
    );
    expect(Object.keys(props("screenshot"))).toEqual(
      expect.arrayContaining(["fullPage", "format", "scale"])
    );
    expect(Object.keys(props("waitFor"))).toEqual(
      expect.arrayContaining(["text", "textGone"])
    );
    expect(Object.keys(props("inspectElement"))).toEqual(
      expect.arrayContaining(["selector", "uid", "ancestorDepth", "styleProperties"])
    );
  });
});

describe("mcp short descriptions", () => {
  const MCP_BLOCKED = new Set(["askUser", "attachTab", "detachTab"]);
  const exposed = TOOL_DEFS.filter((t) => !MCP_BLOCKED.has(t.name));

  it("every MCP-exposed tool has an English mcp.description under 240 chars", () => {
    for (const t of exposed) {
      const d = t.mcp?.description;
      expect(typeof d, t.name).toBe("string");
      expect(d!.length, t.name).toBeLessThanOrEqual(240);
      // No CJK characters: MCP descriptions are English to keep token cost down.
      expect(d, t.name).not.toMatch(/[一-鿿]/);
    }
  });

  it("mcp.params only names properties that exist and are English", () => {
    for (const t of exposed) {
      const props = (t.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
      for (const [k, v] of Object.entries(t.mcp?.params ?? {})) {
        expect(props[k], `${t.name}.${k}`).toBeTruthy();
        expect(v, `${t.name}.${k}`).not.toMatch(/[一-鿿]/);
      }
    }
  });
});
