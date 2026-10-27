import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmStreamEvent } from "@aipagego/shared/llm";
import type { Json, Step } from "@aipagego/shared/types";
import { recommendCollectionRecipe } from "@/sidepanel/llm/collection-recipe-generator";

function clientWithText(text: string, capture = vi.fn()): LlmClient {
  return {
    async *stream(input): AsyncIterable<LlmStreamEvent> {
      capture(input);
      yield { type: "text_delta", text };
      yield { type: "message_end" };
    },
  };
}

function validRecipe() {
  return {
    version: 1,
    mode: "list",
    itemSelector: ".product",
    fields: [
      { id: "title", name: "标题", selector: ".title", valueMode: "text", required: true },
    ],
    pagination: { kind: "single" },
    dedupeBy: ["title"],
    maxRows: 2_000,
    maxBytes: 5 * 1024 * 1024,
  };
}

describe("recommendCollectionRecipe", () => {
  it("builds bounded Page Context Index evidence on the captured tab before asking the sidepanel LLM", async () => {
    const llmInput = vi.fn();
    const calls: Array<{ step: Step; tabId: number }> = [];
    const runStep = vi.fn(async (step: Step, tabId: number): Promise<Json> => {
      calls.push({ step, tabId });
      if (step.kind === "tool" && step.tool === "createPageIndex") {
        return {
          ok: true,
          indexId: "idx-1",
          url: "https://shop.example/list",
          title: "商品列表",
          summary: [{ blockId: "b1", kind: "list", label: "商品", text: "耳机 ¥99" }],
        };
      }
      return {
        indexId: "idx-1",
        blockId: "b1",
        kind: "list",
        selectorHint: ".product",
        text: "降噪耳机 ¥99",
        hasMore: false,
      };
    });

    const recipe = await recommendCollectionRecipe({
      client: clientWithText(JSON.stringify(validRecipe()), llmInput),
      apiKey: "sidepanel-key",
      model: "test-model",
      tabId: 41,
      url: "https://shop.example/list",
      sample: { title: "已有样例" },
      runStep,
    });

    expect(recipe).toMatchObject({ mode: "list", itemSelector: ".product" });
    expect(calls[0]).toMatchObject({
      tabId: 41,
      step: { kind: "tool", tool: "createPageIndex" },
    });
    expect(calls.every((call) => call.tabId === 41)).toBe(true);
    expect(calls.some((call) => call.step.kind === "tool" && call.step.tool === "readPageBlock"))
      .toBe(true);
    expect(llmInput).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sidepanel-key" }));
    const prompt = JSON.stringify(llmInput.mock.calls[0][0].messages);
    expect(prompt).toContain("selectorHint");
    expect(prompt).toContain("已有样例");
    expect(prompt.length).toBeLessThan(20_000);
  });

  it("rejects an invalid LLM recipe without previewing or running it", async () => {
    const tools: string[] = [];
    const runStep = vi.fn(async (step: Step): Promise<Json> => {
      if (step.kind === "tool") tools.push(step.tool);
      return step.kind === "tool" && step.tool === "createPageIndex"
        ? { ok: true, indexId: "idx", url: "https://example.com", title: "x", summary: [] }
        : {};
    });

    await expect(recommendCollectionRecipe({
      client: clientWithText('{"version":1,"mode":"list","fields":[]}'),
      apiKey: "sidepanel-key",
      model: "test-model",
      tabId: 7,
      url: "https://example.com",
      runStep,
    })).rejects.toThrow("AI 配方无效");

    expect(tools).toEqual(["createPageIndex"]);
  });

  it("rejects a valid but unsupported paginated recipe instead of silently dropping pagination", async () => {
    const paginated = {
      ...validRecipe(),
      pagination: { kind: "next", selector: "a.next", maxPages: 20 },
    };
    await expect(recommendCollectionRecipe({
      client: clientWithText(JSON.stringify(paginated)),
      apiKey: "sidepanel-key",
      model: "test-model",
      tabId: 7,
      url: "https://example.com",
      runStep: async (step): Promise<Json> => step.kind === "tool" && step.tool === "createPageIndex"
        ? { ok: true, indexId: "idx", url: "https://example.com", title: "x", summary: [] }
        : {},
    })).rejects.toThrow("只接受 single pagination");
  });
});
