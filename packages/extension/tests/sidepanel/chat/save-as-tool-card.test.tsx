import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SaveAsToolCard } from "@/sidepanel/chat/save-as-tool-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactNode) {
  const c = document.createElement("div");
  document.body.appendChild(c);
  const r = createRoot(c);
  act(() => r.render(node));
  return { c, cleanup: () => { act(() => r.unmount()); c.remove(); } };
}

describe("SaveAsToolCard", () => {
  it("renders the step count and invokes onSave when button clicked", () => {
    const onSave = vi.fn();
    const { c, cleanup } = mount(<SaveAsToolCard stepCount={9} onSave={onSave} />);
    expect(c.textContent).toContain("9 步成功执行");
    const btn = Array.from(c.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("保存为工具")
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeTruthy();
    act(() => btn?.click());
    expect(onSave).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("offers the collection-studio handoff for a completed collection conversation", () => {
    const onContinueCollection = vi.fn();
    const { c, cleanup } = mount(
      <SaveAsToolCard
        stepCount={3}
        onSave={vi.fn()}
        onContinueCollection={onContinueCollection}
      />
    );

    const button = Array.from(c.querySelectorAll("button")).find((item) =>
      item.textContent?.includes("在采集工作台继续")
    ) as HTMLButtonElement | undefined;
    expect(button).toBeTruthy();
    act(() => button?.click());
    expect(onContinueCollection).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
