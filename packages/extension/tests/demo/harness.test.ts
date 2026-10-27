import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDemoStep } from "../../demo/harness";
import { COMMENTS_ID, EXPAND_BUTTON_ID, mountMockPage } from "../../demo/page";

describe("demo harness", () => {
  beforeEach(() => {
    document.body.innerHTML = "<div id='root'></div>";
    mountMockPage(document.getElementById("root")!);
  });

  it("runs the real content tool against the mock page", async () => {
    // This is the demo's whole claim: the visible change is produced by the
    // product's own click tool, not by demo choreography.
    expect(document.querySelector<HTMLElement>(`#${COMMENTS_ID}`)!.hidden).toBe(true);
    await runDemoStep({ kind: "tool", tool: "click", args: { selector: `#${EXPAND_BUTTON_ID}` } });
    expect(document.querySelector<HTMLElement>(`#${COMMENTS_ID}`)!.hidden).toBe(false);
  });

  it("extracts real text from the page", async () => {
    await runDemoStep({ kind: "tool", tool: "click", args: { selector: `#${EXPAND_BUTTON_ID}` } });
    const out = (await runDemoStep({
      kind: "tool",
      tool: "extractText",
      args: { selector: `#${COMMENTS_ID}` }
    })) as unknown as { text?: string } | string;
    const text = typeof out === "string" ? out : (out.text ?? JSON.stringify(out));
    expect(text).toContain("腰托");
  });

  it("serves canned results for extension-only tools", async () => {
    const shot = (await runDemoStep({ kind: "tool", tool: "screenshot", args: {} })) as {
      media_type: string;
    };
    expect(shot.media_type).toBe("image/png");
  });

  it("refuses runJS", async () => {
    const out = (await runDemoStep({ kind: "js", source: "return 1" })) as { ok: boolean };
    expect(out.ok).toBe(false);
  });

  it("rejects a step with no tool", async () => {
    await expect(runDemoStep({})).rejects.toThrow("no tool");
  });

  it("propagates a tool error rather than swallowing it", async () => {
    await expect(
      runDemoStep({ kind: "tool", tool: "click", args: { selector: "#nope" } })
    ).rejects.toThrow();
  });

  it("runs collection previews with the production extractor", async () => {
    const out = await runDemoStep({
      kind: "collectionPreview",
      recipe: {
        version: 1,
        mode: "single",
        fields: [{
          id: "title",
          name: "标题",
          selector: ".demo-title",
          valueMode: "text",
          required: true,
        }],
        pagination: { kind: "single" },
        dedupeBy: [],
        maxRows: 2_000,
        maxBytes: 5 * 1024 * 1024,
      },
    });

    expect(out).toMatchObject({
      returnedCount: 1,
      rows: [{ values: { title: "人体工学办公椅 Pro" } }],
    });
  });

  it("runs full single-page collection extraction with the production extractor", async () => {
    const out = await runDemoStep({
      kind: "collectionExtractPage",
      recipe: {
        version: 1,
        mode: "single",
        fields: [{
          id: "title",
          name: "标题",
          selector: "h1",
          valueMode: "text",
          required: true,
        }],
        pagination: { kind: "single" },
        dedupeBy: [],
        maxRows: 2_000,
        maxBytes: 5 * 1024 * 1024,
      },
    });

    expect(out).toMatchObject({
      matchedCount: 1,
      rows: [{ values: { title: "人体工学办公椅 Pro" } }],
      truncatedBy: null,
    });
  });

  it("advances a next control with the production pagination primitive", async () => {
    document.body.insertAdjacentHTML("beforeend", '<button class="demo-next">下一页</button>');
    const click = document.querySelector<HTMLButtonElement>(".demo-next")!;
    let clicked = false;
    click.addEventListener("click", () => { clicked = true; });

    expect(await runDemoStep({
      kind: "collectionAdvanceNext",
      selector: ".demo-next",
    })).toEqual({ status: "clicked" });
    expect(clicked).toBe(true);
  });

  it("advances load-more and infinite-scroll with production primitives", async () => {
    document.body.insertAdjacentHTML("beforeend", '<button class="demo-more">加载更多</button>');
    const button = document.querySelector<HTMLButtonElement>(".demo-more")!;
    const click = vi.spyOn(button, "click");

    expect(await runDemoStep({
      kind: "collectionAdvanceDynamic",
      action: { kind: "loadMore", selector: ".demo-more" },
    })).toEqual({ status: "clicked" });
    expect(click).toHaveBeenCalledOnce();

    const scrollTo = vi.fn();
    window.scrollTo = scrollTo;
    expect(await runDemoStep({
      kind: "collectionAdvanceDynamic",
      action: { kind: "infiniteScroll" },
    })).toEqual({ status: "scrolled" });
    expect(scrollTo).toHaveBeenCalledOnce();
  });
});
