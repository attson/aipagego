import { describe, expect, it } from "vitest";
import { TOOL_DEFS } from "@/sidepanel/llm/tool-schema";

describe("TOOL_DEFS", () => {
  it("has every existing tool's input_schema.properties.tabId optional integer", () => {
    const namesNeeded = [
      "snapshotDOM",
      "querySelector",
      "querySelectorAll",
      "extractText",
      "extractImages",
      "scroll",
      "waitFor",
      "click",
      "httpRequest",
      "readStorage",
      "fillInput",
      "setCheckbox",
      "selectOption",
      "submitForm",
      "hover",
      "focus",
      "uploadFile",
      "getValue",
      "extractFormState",
      "runJS"
    ];
    for (const name of namesNeeded) {
      const def = TOOL_DEFS.find((d) => d.name === name);
      expect(def, `missing tool ${name}`).toBeDefined();
      const props = (def!.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(props.tabId, `${name} missing tabId`).toBeDefined();
      expect((props.tabId as { type: string }).type).toBe("integer");
      const required = (def!.input_schema as { required?: string[] }).required ?? [];
      expect(required.includes("tabId")).toBe(false);
    }
  });

  it("declares the 4 control-plane tools", () => {
    for (const n of ["listTabs", "openTab", "attachTab", "detachTab"]) {
      expect(TOOL_DEFS.some((d) => d.name === n), `missing ${n}`).toBe(true);
    }
  });

  it("declares page-index tools with bounded-context guidance", () => {
    for (const name of ["createPageIndex", "searchPageIndex", "readPageBlock", "extractPageFields"]) {
      const def = TOOL_DEFS.find((tool) => tool.name === name);
      expect(def, `missing ${name}`).toBeDefined();
      expect(def?.description).toContain("[PAGE-INDEX]");
      const props = (def!.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(props.tabId, `${name} missing tabId`).toBeDefined();
      expect((props.tabId as { type: string }).type).toBe("integer");
    }

    const read = TOOL_DEFS.find((tool) => tool.name === "readPageBlock")!;
    expect((read.input_schema as { required?: string[] }).required).toEqual(["blockId"]);
    const screenshot = TOOL_DEFS.find((tool) => tool.name === "screenshot")!;
    const screenshotProps = (screenshot.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(screenshot.description).toContain("blockId");
    expect(screenshotProps.blockId).toBeDefined();
    expect(screenshotProps.indexId).toBeDefined();
    const extractText = TOOL_DEFS.find((tool) => tool.name === "extractText")!;
    expect(extractText.description).toContain("不要用 extractText({selector:'body'})");
  });

  it("declares downloadSpreadsheet as an xlsx export tool", () => {
    const def = TOOL_DEFS.find((tool) => tool.name === "downloadSpreadsheet");
    expect(def).toBeDefined();
    expect(def?.description).toContain(".xlsx");
    const schema = def!.input_schema as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.properties?.filename).toBeDefined();
    expect(schema.properties?.sheets).toBeDefined();
    expect(schema.required).toEqual(["sheets"]);
  });

  it("openTab requires url; attachTab/detachTab require tabId", () => {
    const openTab = TOOL_DEFS.find((d) => d.name === "openTab")!;
    expect((openTab.input_schema as { required: string[] }).required).toEqual(["url"]);
    const openTabProperties = (openTab.input_schema as { properties: Record<string, unknown> }).properties;
    expect(openTabProperties.incognito).toBeDefined();
    expect(openTabProperties.windowId).toBeDefined();
    const attachTab = TOOL_DEFS.find((d) => d.name === "attachTab")!;
    expect((attachTab.input_schema as { required: string[] }).required).toEqual(["tabId"]);
    const detachTab = TOOL_DEFS.find((d) => d.name === "detachTab")!;
    expect((detachTab.input_schema as { required: string[] }).required).toEqual(["tabId"]);
  });
});
