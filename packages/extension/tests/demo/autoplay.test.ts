import { describe, expect, it, vi } from "vitest";
import { startAutoplay } from "../../demo/autoplay";

const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("autoplay", () => {
  it("types the prompt and presses send once the panel mounts", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    startAutoplay("采集这个商品");

    // Panel not mounted yet — nothing should have happened.
    await tick(300);

    document.body.innerHTML = `
      <textarea></textarea>
      <button type="button">发送</button>`;
    const ta = document.querySelector("textarea")!;
    let clicked = false;
    document.querySelector("button")!.addEventListener("click", () => (clicked = true));

    await tick(400);
    expect(ta.value).toBe("采集这个商品");
    expect(clicked).toBe(true);
    vi.useRealTimers();
  });

  it("dispatches an input event so React sees the change", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<textarea></textarea><button>发送</button>`;
    const events: string[] = [];
    document.querySelector("textarea")!.addEventListener("input", () => events.push("input"));
    startAutoplay("x");
    await tick(400);
    expect(events).toContain("input");
    vi.useRealTimers();
  });

  it("gives up instead of spinning forever", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    startAutoplay("x");
    await tick(120 * 70);
    // Mounting late must not retro-trigger: the poller has already stopped.
    document.body.innerHTML = `<textarea></textarea><button>发送</button>`;
    await tick(1000);
    expect(document.querySelector("textarea")!.value).toBe("");
    vi.useRealTimers();
  });

  it("finds the real send button, which is an icon with aria-label", async () => {
    // Regression: the product's send button is `<button aria-label="发送">↑`,
    // so matching on textContent alone leaves the demo sitting idle.
    vi.useFakeTimers();
    document.body.innerHTML =
      `<textarea></textarea><button aria-label="发送" type="button">↑</button>`;
    let clicked = false;
    document.querySelector("button")!.addEventListener("click", () => (clicked = true));
    startAutoplay("x");
    await tick(400);
    expect(clicked).toBe(true);
    vi.useRealTimers();
  });

  it("does not mistake a quick-action prompt for the exact send button", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <textarea></textarea>
      <button aria-label="发送提示：翻译网页">翻译网页</button>
      <button aria-label="发送" type="button">↑</button>`;
    const clicked: string[] = [];
    for (const button of document.querySelectorAll("button")) {
      button.addEventListener("click", () => clicked.push(button.getAttribute("aria-label") ?? ""));
    }
    startAutoplay("采集商品信息");
    await tick(400);
    expect(clicked).toEqual(["发送"]);
    expect(document.querySelector("textarea")!.value).toBe("采集商品信息");
    vi.useRealTimers();
  });

  it("skips a disabled send button", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      `<textarea></textarea><button aria-label="发送" disabled>↑</button>`;
    let clicked = false;
    document.querySelector("button")!.addEventListener("click", () => (clicked = true));
    startAutoplay("x");
    await tick(400);
    expect(clicked).toBe(false);
    vi.useRealTimers();
  });

  it("falls back to a submit button when the label differs", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<textarea></textarea><button type="submit">Go</button>`;
    let clicked = false;
    document.querySelector("button")!.addEventListener("click", () => (clicked = true));
    startAutoplay("x");
    await tick(400);
    expect(clicked).toBe(true);
    vi.useRealTimers();
  });
});
