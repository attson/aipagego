import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AttachedTab } from "@aipagego/shared/types";
import { AboveInputTabs } from "@/sidepanel/input/above-input-tabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tab = (id: number, extras: Partial<AttachedTab> = {}): AttachedTab => ({
  tabId: id,
  windowId: 1,
  source: "mention",
  lastSeenUrl: `https://t${id}`,
  lastSeenTitle: `T${id}`,
  addedAt: 0,
  ...extras,
});

function mount(node: React.ReactNode) {
  const c = document.createElement("div");
  document.body.appendChild(c);
  const r = createRoot(c);
  act(() => r.render(node));
  return { c, cleanup: () => { act(() => r.unmount()); c.remove(); } };
}

describe("AboveInputTabs", () => {
  it("always shows 🏠 当前 and + tab buttons", () => {
    const { c, cleanup } = mount(
      <AboveInputTabs
        currentTabUrl="https://x"
        attachedTabs={[]}
        onDetach={() => {}}
        onAddTab={() => {}}
      />
    );
    expect(c.textContent).toContain("🏠 当前");
    expect(c.textContent).toContain("+ tab");
    cleanup();
  });

  it("renders a chip per attached tab", () => {
    const { c, cleanup } = mount(
      <AboveInputTabs
        currentTabUrl="https://x"
        attachedTabs={[tab(1), tab(2)]}
        onDetach={() => {}}
        onAddTab={() => {}}
      />
    );
    expect(c.querySelector('[data-testid="above-chip-1"]')).toBeTruthy();
    expect(c.querySelector('[data-testid="above-chip-2"]')).toBeTruthy();
    cleanup();
  });

  it("× triggers onDetach with the right tab id", () => {
    const onDetach = vi.fn();
    const { c, cleanup } = mount(
      <AboveInputTabs
        currentTabUrl="https://x"
        attachedTabs={[tab(7)]}
        onDetach={onDetach}
        onAddTab={() => {}}
      />
    );
    const xBtn = c.querySelector('button[aria-label="卸载 tab 7"]') as HTMLButtonElement;
    act(() => xBtn.click());
    expect(onDetach).toHaveBeenCalledWith(7);
    cleanup();
  });

  it("+ tab triggers onAddTab", () => {
    const onAddTab = vi.fn();
    const { c, cleanup } = mount(
      <AboveInputTabs
        currentTabUrl="https://x"
        attachedTabs={[]}
        onDetach={() => {}}
        onAddTab={onAddTab}
      />
    );
    const btn = Array.from(c.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("+ tab")
    ) as HTMLButtonElement | undefined;
    act(() => btn?.click());
    expect(onAddTab).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
