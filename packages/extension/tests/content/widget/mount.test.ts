import { beforeEach, describe, expect, it, vi } from "vitest";
import { unmountWidget } from "@/content/widget/lifecycle";

(globalThis as any).chrome = {
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
    session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
  },
  runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } }
};

describe("mountWidget", () => {
  beforeEach(() => {
    unmountWidget();
    document.documentElement.innerHTML = "<head></head><body></body>";
  });

  it("creates the assistant host when explicitly mounted", async () => {
    const { mountWidget } = await import("@/content/widget/mount");
    await mountWidget();
    expect(document.querySelector("aipagego-widget")?.shadowRoot).toBeTruthy();
  });

  it("is idempotent and can be unmounted", async () => {
    const { mountWidget } = await import("@/content/widget/mount");
    await mountWidget();
    await mountWidget();
    expect(document.querySelectorAll("aipagego-widget")).toHaveLength(1);
    unmountWidget();
    expect(document.querySelector("aipagego-widget")).toBeNull();
  });
});
