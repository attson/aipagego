import { describe, expect, it } from "vitest";
import { promptFor } from "@/background/context-menu";

function info(extras: Partial<chrome.contextMenus.OnClickData> = {}): chrome.contextMenus.OnClickData {
  return {
    menuItemId: "",
    editable: false,
    pageUrl: "https://example.com",
    ...extras,
  } as chrome.contextMenus.OnClickData;
}

describe("promptFor", () => {
  it("summarize → autoSend prompt", () => {
    const p = promptFor("aipagego.summarize", info());
    expect(p?.autoSend).toBe(true);
    expect(p?.text).toMatch(/总结/);
    expect(p?.sourceUrl).toBe("https://example.com");
  });

  it("extract returns null when there's no selectionText", () => {
    expect(promptFor("aipagego.extract", info())).toBeNull();
  });

  it("extract embeds the selection text", () => {
    const p = promptFor("aipagego.extract", info({ selectionText: "  hello world  " }));
    expect(p?.text).toContain("hello world");
    expect(p?.autoSend).toBe(false);
  });

  it("custom returns an empty-text prompt (auto-send off)", () => {
    const p = promptFor("aipagego.custom", info());
    expect(p?.text).toBe("");
    expect(p?.autoSend).toBe(false);
  });

  it("unknown menu id → null", () => {
    expect(promptFor("some.other.id", info())).toBeNull();
  });
});
