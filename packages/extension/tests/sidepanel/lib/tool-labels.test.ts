import { describe, expect, it } from "vitest";
import { TOOL_DEFS } from "@aipagego/shared/llm";
import { labelFor, TOOL_LABELS } from "@/sidepanel/lib/tool-labels";

describe("labelFor", () => {
  it("returns Chinese alias for known tools", () => {
    expect(labelFor("takeSnapshot")).toBe("抓页面快照");
    expect(labelFor("getPageInfo")).toBe("获取页面信息");
    expect(labelFor("clickByUid")).toBe("点击元素");
    expect(labelFor("httpRequest")).toBe("发请求");
  });

  it("returns null for unknown tools", () => {
    expect(labelFor("unknownTool")).toBeNull();
    expect(labelFor("")).toBeNull();
  });
});

describe("TOOL_LABELS", () => {
  it("every key is a known tool in TOOL_DEFS (guards against renames/typos)", () => {
    const known = new Set(TOOL_DEFS.map((t) => t.name));
    const stale = Object.keys(TOOL_LABELS).filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  it("has non-empty Chinese alias for every entry", () => {
    for (const [name, alias] of Object.entries(TOOL_LABELS)) {
      expect(alias, `label for ${name}`).toBeTruthy();
      expect(alias.length, `label for ${name}`).toBeGreaterThan(0);
    }
  });
});
