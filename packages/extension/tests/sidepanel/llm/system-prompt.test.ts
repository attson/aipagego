import { describe, expect, it } from "vitest";
import type { AttachedTab } from "@aipagego/shared/types";
import { buildSystemPrompt } from "@/sidepanel/llm/system-prompt";

function tab(tabId: number, url: string, source: AttachedTab["source"] = "mention"): AttachedTab {
  return { tabId, windowId: 1, source, lastSeenUrl: url, lastSeenTitle: "t", addedAt: 0 };
}

describe("buildSystemPrompt — language detection", () => {
  it("zh by default + Chinese trigger", () => {
    const p = buildSystemPrompt({ url: "https://x", lastUserText: "翻译这页" });
    expect(p).toMatch(/你是 AIPageGo/);
    expect(p).toMatch(/ReAct/);
    expect(p).toMatch(/TODO/);
  });

  it("English when user wrote English", () => {
    const p = buildSystemPrompt({ url: "https://x", lastUserText: "Translate this page" });
    expect(p).toMatch(/You are AIPageGo/);
    expect(p).toMatch(/THINK → ACT/);
  });
});

describe("buildSystemPrompt — required sections", () => {
  it("contains ReAct framework block", () => {
    const p = buildSystemPrompt({ url: "https://x" });
    expect(p).toMatch(/THINK → ACT → OBSERVE → REASON/);
  });

  it("contains tool_call format requirement", () => {
    const p = buildSystemPrompt({ url: "https://x" });
    expect(p).toMatch(/tool_calls 格式/);
  });

  it("contains 跨 tab 协议 section header", () => {
    const p = buildSystemPrompt({ url: "https://x" });
    expect(p).toMatch(/跨 tab 协议|Cross-tab protocol/);
  });

  it("contains worked examples", () => {
    const p = buildSystemPrompt({ url: "https://x" });
    expect(p).toMatch(/示例 1|Example 1/);
  });

  it("guides page read and extraction tasks through the page index first", () => {
    const p = buildSystemPrompt({ url: "https://x", lastUserText: "提取这个商品的价格和排名" });
    expect(p).toContain("createPageIndex");
    expect(p).toContain("extractPageFields");
    expect(p).toContain("searchPageIndex");
    expect(p).toContain("readPageBlock");
    expect(p).toContain("screenshot({blockId,indexId})");
    expect(p).toContain("不要盲目读取 body");
    expect(p).not.toContain("每次任务起手：takeSnapshot");
    expect(p).not.toContain("extractText 当前 tab 价格");
    expect(p).toContain("点击/填表/视觉定位任务起手");
  });
});

describe("buildSystemPrompt — context", () => {
  it("includes URL + title in current context", () => {
    const p = buildSystemPrompt({ url: "https://example.com/x", title: "Example Title" });
    expect(p).toContain("https://example.com/x");
    expect(p).toContain("Example Title");
  });

  it("lists saved tools matching the URL", () => {
    const p = buildSystemPrompt({
      url: "https://example.com",
      savedTools: [{ name: "shop-collect", description: "采前 50 条", version: 3 }],
    });
    expect(p).toContain("shop-collect");
    expect(p).toContain("v3");
  });
});

describe("buildSystemPrompt — attached tabs", () => {
  it("omits attached section when none", () => {
    const out = buildSystemPrompt({ url: "https://main", attachedTabs: [] });
    expect(out).not.toContain("[Attached tabs]");
  });

  it("lists attached tabs with id, url, source", () => {
    const out = buildSystemPrompt({
      url: "https://main",
      attachedTabs: [tab(167, "https://taobao", "mention"), tab(189, "https://tmall", "ai-open")],
    });
    expect(out).toContain("[Attached tabs]");
    expect(out).toContain("#167");
    expect(out).toContain("https://taobao");
    expect(out).toContain("source: mention");
    expect(out).toContain("#189");
    expect(out).toContain("source: ai-open");
  });

  it("truncates after 8 with a hint", () => {
    const many: AttachedTab[] = [];
    for (let i = 0; i < 12; i++) many.push(tab(100 + i, `https://t/${i}`));
    const out = buildSystemPrompt({ url: "https://main", attachedTabs: many });
    expect(out).toContain("#107");
    expect(out).not.toContain("#108");
    expect(out).toMatch(/\+4 more, call listTabs/);
  });
});
