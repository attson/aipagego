import { describe, expect, it } from "vitest";
import { classifyTool, evaluateAutoApproval, type PermissionMode } from "@/sidepanel/chat/severity";

describe("classifyTool", () => {
  it("safe tools", () => {
    expect(classifyTool("snapshotDOM", {})).toBe("safe");
    expect(classifyTool("extractText", { selector: "h1" })).toBe("safe");
    expect(classifyTool("scroll", { to: "bottom" })).toBe("safe");
    expect(classifyTool("inspectElement", { selector: "#app" })).toBe("safe");
  });

  it("click is caution", () => {
    expect(classifyTool("click", { selector: "#a" })).toBe("caution");
  });

  it("httpRequest depends on withCredentials", () => {
    expect(classifyTool("httpRequest", { url: "https://x/" })).toBe("caution");
    expect(classifyTool("httpRequest", { url: "https://x/", withCredentials: true })).toBe("dangerous");
  });

  it("readStorage is dangerous", () => {
    expect(classifyTool("readStorage", { store: "local", key: "k" })).toBe("dangerous");
  });

  it("runJS classified by static scan", () => {
    expect(classifyTool("runJS", { source: "return document.title" })).toBe("caution");
    expect(classifyTool("runJS", { source: "return document.cookie" })).toBe("dangerous");
    expect(classifyTool("runJS", { source: "return await fetch('/x').then(r => r.text())" })).toBe("caution");
  });

  it("safe interaction tools", () => {
    expect(classifyTool("hover", { selector: "x" })).toBe("safe");
    expect(classifyTool("focus", { selector: "x" })).toBe("safe");
    expect(classifyTool("getValue", { selector: "x" })).toBe("safe");
    expect(classifyTool("extractFormState", {})).toBe("safe");
  });

  it("caution interaction tools", () => {
    expect(classifyTool("fillInput", { selector: "x", value: "y" })).toBe("caution");
    expect(classifyTool("setCheckbox", { selector: "x", checked: true })).toBe("caution");
    expect(classifyTool("selectOption", { selector: "x", value: "y" })).toBe("caution");
  });

  it("dangerous side-effect tools", () => {
    expect(classifyTool("submitForm", {})).toBe("dangerous");
    expect(classifyTool("uploadFile", { selector: "x", url: "u" })).toBe("dangerous");
  });

  it("classifies getPageInfo as safe", () => {
    expect(classifyTool("getPageInfo", {})).toBe("safe");
  });

  it("classifies page-index tools as safe", () => {
    for (const name of ["createPageIndex", "searchPageIndex", "readPageBlock", "extractPageFields"]) {
      expect(classifyTool(name, {}), name).toBe("safe");
    }
  });

  it("classifies pressKey as caution", () => {
    expect(classifyTool("pressKey", { key: "Enter" })).toBe("caution");
  });

  it("classifies downloadSpreadsheet as caution", () => {
    expect(classifyTool("downloadSpreadsheet", { sheets: [] })).toBe("caution");
  });

  it("classifies structured collection replay as caution", () => {
    expect(classifyTool("collectStructuredData", { recipe: {} })).toBe("caution");
  });

  it("classifies writeStorage as dangerous", () => {
    expect(classifyTool("writeStorage", { store: "local", key: "k", value: "v" })).toBe("dangerous");
  });

  it("classifies navigate back/forward/reload as safe", () => {
    expect(classifyTool("navigate", { action: "back" })).toBe("safe");
    expect(classifyTool("navigate", { action: "forward" })).toBe("safe");
    expect(classifyTool("navigate", { action: "reload" })).toBe("safe");
  });

  it("classifies navigate goto as caution", () => {
    expect(classifyTool("navigate", { action: "goto", url: "https://x.test/" })).toBe("caution");
  });
});

describe("control-plane tools", () => {
  it("listTabs / openTab / attachTab are caution", () => {
    expect(classifyTool("listTabs", {})).toBe("caution");
    expect(classifyTool("openTab", { url: "https://x" })).toBe("caution");
    expect(classifyTool("attachTab", { tabId: 1 })).toBe("caution");
  });

  it("detachTab is safe", () => {
    expect(classifyTool("detachTab", { tabId: 1 })).toBe("safe");
  });
});

describe("evaluateAutoApproval (4-mode)", () => {
  const MODES: PermissionMode[] = ["read", "default", "trust", "yolo"];

  it("safe is auto in every mode", () => {
    for (const m of MODES) {
      expect(evaluateAutoApproval("snapshotDOM", "safe", m, [])).toBe(true);
    }
  });

  it("read mode asks for everything non-safe (ignores allowlist)", () => {
    expect(evaluateAutoApproval("click", "caution", "read", [])).toBe(false);
    expect(evaluateAutoApproval("submitForm", "dangerous", "read", [])).toBe(false);
    expect(evaluateAutoApproval("submitForm", "dangerous", "read", ["submitForm"])).toBe(false);
  });

  it("default auto-passes caution but always asks dangerous (allowlist ignored)", () => {
    expect(evaluateAutoApproval("click", "caution", "default", [])).toBe(true);
    expect(evaluateAutoApproval("submitForm", "dangerous", "default", [])).toBe(false);
    expect(evaluateAutoApproval("submitForm", "dangerous", "default", ["submitForm"])).toBe(false);
  });

  it("trust auto-passes caution + allowlisted dangerous only", () => {
    expect(evaluateAutoApproval("click", "caution", "trust", [])).toBe(true);
    expect(evaluateAutoApproval("submitForm", "dangerous", "trust", ["submitForm"])).toBe(true);
    expect(evaluateAutoApproval("uploadFile", "dangerous", "trust", ["submitForm"])).toBe(false);
  });

  it("yolo passes everything", () => {
    expect(evaluateAutoApproval("submitForm", "dangerous", "yolo", [])).toBe(true);
    expect(evaluateAutoApproval("runJS", "dangerous", "yolo", [])).toBe(true);
    expect(evaluateAutoApproval("click", "caution", "yolo", [])).toBe(true);
  });
});

describe("classifyTool — Plan 32 tools", () => {
  it("treats console reads and element search as safe", () => {
    expect(classifyTool("consoleMessages", { level: "error" })).toBe("safe");
    expect(classifyTool("findElements", { text: "x" })).toBe("safe");
  });

  it("treats network summaries and page mutations as caution", () => {
    for (const n of [
      "networkRequests", "recorderConfig", "handleDialog",
      "drag", "navigateBack", "navigateForward", "resize"
    ]) {
      expect(classifyTool(n, {}), n).toBe("caution");
    }
  });

  it("treats network bodies as dangerous — headers carry tokens", () => {
    expect(classifyTool("networkRequestDetail", { id: 1 })).toBe("dangerous");
  });

  it("escalates drop only when it carries files", () => {
    expect(classifyTool("drop", { selector: "#z" })).toBe("caution");
    expect(classifyTool("drop", { selector: "#z", files: [{ name: "a", base64: "" }] })).toBe(
      "dangerous"
    );
  });
});
