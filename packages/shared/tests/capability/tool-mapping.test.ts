import { describe, it, expect } from "vitest";
import {
  capabilityForTool,
  capabilityForRunJs
} from "../../src/capability/tool-mapping";
import {
  DANGEROUS_CAPABILITIES,
  IMPLICIT_CAPABILITIES
} from "../../src/capability/catalog";

describe("capabilityForTool", () => {
  it("read:dom for safe inspectors", () => {
    expect(capabilityForTool("snapshotDOM")).toBe("read:dom");
    expect(capabilityForTool("getValue")).toBe("read:dom");
    expect(capabilityForTool("extractFormState")).toBe("read:dom");
    expect(capabilityForTool("inspectElement")).toBe("read:dom");
  });
  it("read:dom for page-index inspectors", () => {
    expect(capabilityForTool("createPageIndex")).toBe("read:dom");
    expect(capabilityForTool("searchPageIndex")).toBe("read:dom");
    expect(capabilityForTool("readPageBlock")).toBe("read:dom");
    expect(capabilityForTool("extractPageFields")).toBe("read:dom");
  });
  it("read:image for extractImages", () => {
    expect(capabilityForTool("extractImages")).toBe("read:image");
  });
  it("read:storage for readStorage", () => {
    expect(capabilityForTool("readStorage")).toBe("read:storage");
  });
  it("nav:tab for movement", () => {
    expect(capabilityForTool("hover")).toBe("nav:tab");
    expect(capabilityForTool("scroll")).toBe("nav:tab");
    expect(capabilityForTool("waitFor")).toBe("nav:tab");
  });
  it("interact:form for caution interactions", () => {
    expect(capabilityForTool("click")).toBe("interact:form");
    expect(capabilityForTool("fillInput")).toBe("interact:form");
    expect(capabilityForTool("setCheckbox")).toBe("interact:form");
    expect(capabilityForTool("selectOption")).toBe("interact:form");
    expect(capabilityForTool("collectStructuredData")).toBe("interact:form");
  });
  it("submit:form for submitForm", () => {
    expect(capabilityForTool("submitForm")).toBe("submit:form");
  });
  it("submit:form for local downloads", () => {
    expect(capabilityForTool("downloadImage")).toBe("submit:form");
    expect(capabilityForTool("downloadSpreadsheet")).toBe("submit:form");
  });
  it("upload:file for uploadFile", () => {
    expect(capabilityForTool("uploadFile")).toBe("upload:file");
  });
  it("httpRequest splits by cookied option", () => {
    expect(capabilityForTool("httpRequest", { httpCookied: false })).toBe(
      "httpRequest:no-cookie"
    );
    expect(capabilityForTool("httpRequest", { httpCookied: true })).toBe(
      "httpRequest:cookied"
    );
  });
});

describe("capabilityForRunJs", () => {
  it("runJS:scanned when scan passed", () => {
    expect(capabilityForRunJs(false)).toBe("runJS:scanned");
  });
  it("runJS:unsafe when scan failed", () => {
    expect(capabilityForRunJs(true)).toBe("runJS:unsafe");
  });
});

describe("Plan 32 parity tools", () => {
  it("maps recorder reads to their tiers", () => {
    expect(capabilityForTool("consoleMessages")).toBe("read:console");
    expect(capabilityForTool("networkRequests")).toBe("read:network");
    expect(capabilityForTool("networkRequestDetail")).toBe("read:network-body");
  });

  it("treats console reads as implicitly safe and bodies as dangerous", () => {
    expect(IMPLICIT_CAPABILITIES.has("read:console")).toBe(true);
    expect(DANGEROUS_CAPABILITIES.has("read:network-body")).toBe(true);
    expect(DANGEROUS_CAPABILITIES.has("read:network")).toBe(false);
  });

  it("escalates drop when it carries files", () => {
    expect(capabilityForTool("drop")).toBe("interact:form");
    expect(capabilityForTool("drop", { dropHasFiles: true })).toBe("upload:file");
  });

  it("escalates recorderConfig when it arms body capture", () => {
    expect(capabilityForTool("recorderConfig")).toBe("read:network");
    expect(capabilityForTool("recorderConfig", { recorderArmsBodies: true })).toBe(
      "read:network-body"
    );
  });

  it("maps navigation and interaction helpers", () => {
    expect(capabilityForTool("navigateBack")).toBe("nav:tab");
    expect(capabilityForTool("navigateForward")).toBe("nav:tab");
    expect(capabilityForTool("resize")).toBe("nav:tab");
    expect(capabilityForTool("drag")).toBe("interact:form");
    expect(capabilityForTool("handleDialog")).toBe("interact:form");
    expect(capabilityForTool("findElements")).toBe("read:dom");
  });
});
