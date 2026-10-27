import { describe, expect, it } from "vitest";
import {
  createCollectionHandoff,
  isCollectionConversation,
  type CollectionConversation,
} from "@/sidepanel/chat/collection-handoff";

const base: CollectionConversation = {
  tabId: 41,
  url: "https://shop.example/list",
  status: "done" as const,
  messages: [{ role: "user" as const, content: "采集这个列表的标题和价格" }],
  executedSteps: [
    { kind: "tool" as const, tool: "createPageIndex" as const, args: {} },
    { kind: "tool" as const, tool: "extractPageFields" as const, args: { fields: ["标题", "价格"] } },
  ],
  lastOutput: {
    rows: Array.from({ length: 8 }, (_, index) => ({ title: `商品 ${index}`, price: index })),
    internal: { selector: ".product-from-chat" },
  },
};

describe("collection chat handoff", () => {
  it("recognizes only completed collection conversations with collection evidence", () => {
    expect(isCollectionConversation(base)).toBe(true);
    expect(isCollectionConversation({ ...base, status: "running" })).toBe(false);
    expect(isCollectionConversation({
      ...base,
      messages: [{ role: "user", content: "把表单提交掉" }],
    })).toBe(false);
    expect(isCollectionConversation({
      ...base,
      executedSteps: [{ kind: "tool", tool: "click", args: { selector: "button" } }],
    })).toBe(false);
  });

  it("carries the captured tab, URL and a bounded structured sample without inventing a recipe", () => {
    const handoff = createCollectionHandoff(base);

    expect(handoff).toMatchObject({
      tabId: 41,
      url: "https://shop.example/list",
      source: "chat",
    });
    const rows = (handoff.sample as { rows: unknown[] }).rows;
    expect(rows.slice(0, 2)).toEqual([
      { title: "商品 0", price: 0 },
      { title: "商品 1", price: 1 },
    ]);
    expect(rows).toHaveLength(5);
    expect(handoff).not.toHaveProperty("recipe");
    expect(JSON.stringify(handoff)).not.toContain("itemSelector");
    expect(JSON.stringify(handoff)).not.toContain(".product-from-chat");
  });
});
