import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  MentionPicker,
  type MentionTabOption,
  type MentionToolOption,
} from "@/sidepanel/input/mention-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactNode) {
  const c = document.createElement("div");
  document.body.appendChild(c);
  const r = createRoot(c);
  act(() => r.render(node));
  return { c, cleanup: () => { act(() => r.unmount()); c.remove(); } };
}

const t = (id: number, extras: Partial<MentionTabOption> = {}): MentionTabOption => ({
  tabId: id,
  title: `T${id}`,
  url: `https://t${id}`,
  ...extras,
});

const tool = (id: string, extras: Partial<MentionToolOption> = {}): MentionToolOption => ({
  id,
  name: `tool-${id}`,
  ...extras,
});

describe("MentionPicker (Tabs + Tools)", () => {
  it("starts on Tabs tab and renders a row per tab", () => {
    const { c, cleanup } = mount(
      <MentionPicker
        tabs={[t(1), t(2)]}
        tools={[]}
        bookmarks={[]}
        onPickBookmark={() => {}}
        onPickTab={() => {}}
        onPickTool={() => {}}
        onClose={() => {}}
      />
    );
    expect(c.querySelector('[data-testid="mention-opt-tab-1"]')).toBeTruthy();
    expect(c.querySelector('[data-testid="mention-opt-tab-2"]')).toBeTruthy();
    cleanup();
  });

  it("clicking a tab invokes onPickTab", () => {
    const onPickTab = vi.fn();
    const { c, cleanup } = mount(
      <MentionPicker
        tabs={[t(5)]}
        tools={[]}
        bookmarks={[]}
        onPickBookmark={() => {}}
        onPickTab={onPickTab}
        onPickTool={() => {}}
        onClose={() => {}}
      />
    );
    const btn = c.querySelector('[data-testid="mention-opt-tab-5"]') as HTMLButtonElement;
    act(() => btn.click());
    expect(onPickTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 5 }));
    cleanup();
  });

  it("ArrowDown + Enter picks the next tab", () => {
    const onPickTab = vi.fn();
    const { cleanup } = mount(
      <MentionPicker
        tabs={[t(1), t(2)]}
        tools={[]}
        bookmarks={[]}
        onPickBookmark={() => {}}
        onPickTab={onPickTab}
        onPickTool={() => {}}
        onClose={() => {}}
      />
    );
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })));
    expect(onPickTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 2 }));
    cleanup();
  });

  it("ArrowRight switches to Tools tab; Enter picks tool", () => {
    const onPickTool = vi.fn();
    const { c, cleanup } = mount(
      <MentionPicker
        tabs={[t(1)]}
        tools={[tool("a"), tool("b")]}
        bookmarks={[]}
        onPickBookmark={() => {}}
        onPickTab={() => {}}
        onPickTool={onPickTool}
        onClose={() => {}}
      />
    );
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })));
    expect(c.querySelector('[data-testid="mention-opt-tool-a"]')).toBeTruthy();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })));
    expect(onPickTool).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    cleanup();
  });

  it("matching tools sort first when Tools tab opens", () => {
    const { c, cleanup } = mount(
      <MentionPicker
        tabs={[]}
        tools={[tool("z"), tool("a", { matchesCurrentUrl: true })]}
        bookmarks={[]}
        onPickBookmark={() => {}}
        onPickTab={() => {}}
        onPickTool={() => {}}
        onClose={() => {}}
      />
    );
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })));
    const buttons = c.querySelectorAll<HTMLButtonElement>("button[role='option']");
    expect(buttons[0].getAttribute("data-testid")).toBe("mention-opt-tool-a");
    expect(buttons[1].getAttribute("data-testid")).toBe("mention-opt-tool-z");
    cleanup();
  });

  it("Escape invokes onClose", () => {
    const onClose = vi.fn();
    const { cleanup } = mount(
      <MentionPicker
        tabs={[t(1)]}
        tools={[]}
        bookmarks={[]}
        onPickBookmark={() => {}}
        onPickTab={() => {}}
        onPickTool={() => {}}
        onClose={onClose}
      />
    );
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalled();
    cleanup();
  });

  it("empty Tabs shows '没有可挂载的 tab'", () => {
    const { c, cleanup } = mount(
      <MentionPicker
        tabs={[]}
        tools={[]}
        bookmarks={[]}
        onPickBookmark={() => {}}
        onPickTab={() => {}}
        onPickTool={() => {}}
        onClose={() => {}}
      />
    );
    expect(c.textContent).toContain("没有可挂载的 tab");
    cleanup();
  });

  it("shows a purpose-specific permission card before reading bookmarks", () => {
    const onRequestBookmarkPermission = vi.fn();
    const { c, cleanup } = mount(
      <MentionPicker
        tabs={[]}
        tools={[]}
        bookmarks={[]}
        bookmarkPermission={{ state: "required" }}
        onRequestBookmarkPermission={onRequestBookmarkPermission}
        onPickBookmark={() => {}}
        onPickTab={() => {}}
        onPickTool={() => {}}
        onClose={() => {}}
      />
    );

    const bookmarkTab = [...c.querySelectorAll('button[role="tab"]')].find((item) =>
      (item.textContent ?? "").includes("Bookmarks")
    ) as HTMLButtonElement;
    act(() => bookmarkTab.click());

    expect(c.textContent).toContain("仅用于在本机搜索并引用你的书签");
    const grant = c.querySelector('[data-testid="grant-bookmarks"]') as HTMLButtonElement;
    act(() => grant.click());
    expect(onRequestBookmarkPermission).toHaveBeenCalledOnce();
    cleanup();
  });
});
