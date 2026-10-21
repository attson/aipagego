import { describe, expect, it, vi } from "vitest";
import { captureVisualEvidence } from "@/sidepanel/llm/visual-evidence";
import type { Json, Step } from "@aipagego/shared/types";

describe("captureVisualEvidence", () => {
  it("resolves page-index block target, prepares the element, and captures the viewport", async () => {
    const runStep = vi.fn(async (input: { step: Step; tabId: number; bindings?: Record<string, Json> }) => {
      if (input.step.kind === "tool" && input.step.tool === "readPageBlock") {
        return {
          indexId: "pi_1",
          blockId: "b2",
          label: "Price",
          selectorHint: ".price-row",
          text: "Price $20.99"
        } as Json;
      }
      if (input.step.kind === "js") {
        expect(input.bindings).toEqual({ selector: ".price-row", highlightMs: 1500 });
        return {
          ok: true,
          selector: ".price-row",
          rect: { x: 10, y: 20, width: 200, height: 40 },
          viewport: { width: 800, height: 600 },
          visible: true
        } as Json;
      }
      throw new Error("unexpected step");
    });

    const result = await captureVisualEvidence({
      raw: { blockId: "b2", indexId: "pi_1" },
      defaultTabId: 7,
      getTab: vi.fn(async () => ({ windowId: 3 })),
      captureVisibleTab: vi.fn(async () => "data:image/png;base64,AAAA"),
      runStep
    });

    expect(result.byteLen).toBe(3);
    expect(result.target).toEqual(
      expect.objectContaining({
        kind: "pageBlock",
        indexId: "pi_1",
        blockId: "b2",
        selector: ".price-row",
        label: "Price",
        visible: true
      })
    );
    expect(runStep).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tabId: 7,
        step: { kind: "tool", tool: "readPageBlock", args: { indexId: "pi_1", blockId: "b2", maxChars: 1 } }
      })
    );
    expect(runStep).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tabId: 7,
        step: expect.objectContaining({ kind: "js" })
      })
    );
  });

  it("captures by explicit selector without resolving a page block", async () => {
    const runStep = vi.fn(async () => ({ ok: true, selector: ".card", visible: true }) as Json);

    const result = await captureVisualEvidence({
      raw: { selector: ".card", tabId: 9, highlightMs: 500 },
      defaultTabId: 7,
      getTab: vi.fn(async (tabId: number) => ({ windowId: tabId + 1 })),
      captureVisibleTab: vi.fn(async () => "data:image/png;base64,AAAA"),
      runStep
    });

    expect(result.target).toEqual(expect.objectContaining({ kind: "selector", selector: ".card" }));
    expect(runStep).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 9,
        bindings: { selector: ".card", highlightMs: 500 }
      })
    );
  });
});
