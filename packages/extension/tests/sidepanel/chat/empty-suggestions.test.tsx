import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { EmptySuggestions, type SuggestedTool } from "@/sidepanel/chat/empty-suggestions";
import type { Preset } from "@aipagego/shared/preset";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactNode) {
  const c = document.createElement("div");
  document.body.appendChild(c);
  const r = createRoot(c);
  act(() => r.render(node));
  return { c, cleanup: () => { act(() => r.unmount()); c.remove(); } };
}

const mk = (i: number): SuggestedTool => ({
  id: `t${i}`,
  name: `tool ${i}`,
  description: `desc ${i}`,
  runCount: i,
});

describe("EmptySuggestions", () => {
  it("renders default prompt when 0 tools", () => {
    const { c, cleanup } = mount(
      <EmptySuggestions matchedTools={[]} onRun={() => {}} onDetail={() => {}} />
    );
    expect(c.textContent).not.toContain("此页有");
    expect(c.textContent).toContain("告诉 AI 你要做什么");
    cleanup();
  });

  it("renders 1 card when 1 tool", () => {
    const { c, cleanup } = mount(
      <EmptySuggestions matchedTools={[mk(1)]} onRun={() => {}} onDetail={() => {}} />
    );
    expect(c.textContent).toContain("此页有 1 个匹配工具");
    expect(c.textContent).toContain("tool 1");
    cleanup();
  });

  it("shows only 3 + expander when 5 tools", () => {
    const tools = [1, 2, 3, 4, 5].map(mk);
    const { c, cleanup } = mount(
      <EmptySuggestions matchedTools={tools} onRun={() => {}} onDetail={() => {}} />
    );
    expect(c.textContent).toContain("tool 1");
    expect(c.textContent).toContain("tool 3");
    expect(c.textContent).not.toContain("tool 4");
    expect(c.textContent).toContain("+ 展开剩余 2 个");
    cleanup();
  });

  it("clicking 运行 / name invokes the callbacks", () => {
    const onRun = vi.fn();
    const onDetail = vi.fn();
    const { c, cleanup } = mount(
      <EmptySuggestions matchedTools={[mk(7)]} onRun={onRun} onDetail={onDetail} />
    );
    const runBtn = Array.from(c.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("运行")
    ) as HTMLButtonElement | undefined;
    const nameBtn = Array.from(c.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("tool 7")
    ) as HTMLButtonElement | undefined;
    act(() => runBtn?.click());
    act(() => nameBtn?.click());
    expect(onRun).toHaveBeenCalledWith("t7");
    expect(onDetail).toHaveBeenCalledWith("t7");
    cleanup();
  });

  describe("preset banner", () => {
    const mkToolPreset = (): Preset => ({
      id: "p-tool-1",
      kind: "tool",
      name: "提取商品信息",
      description: "自动抓取当前页面商品数据",
      category: "ecommerce",
      urlPatterns: ["https://item.taobao.com/*"],
      version: 1,
      steps: [{ kind: "tool", tool: "querySelector", args: { selector: "h1" } }],
    });

    const mkPromptPreset = (): Preset => ({
      id: "p-prompt-1",
      kind: "prompt",
      name: "总结页面",
      description: "用 AI 总结当前页面要点",
      category: "content",
      urlPatterns: ["https://*/*"],
      version: 1,
      prompt: "请总结这个页面的主要内容",
    });

    it("renders no preset section when presets is empty", () => {
      const { c, cleanup } = mount(
        <EmptySuggestions matchedTools={[]} onRun={() => {}} onDetail={() => {}} presets={[]} />
      );
      expect(c.textContent).not.toContain("推荐场景");
      cleanup();
    });

    it("renders preset section when presets provided", () => {
      const { c, cleanup } = mount(
        <EmptySuggestions
          matchedTools={[]}
          onRun={() => {}}
          onDetail={() => {}}
          presets={[mkToolPreset(), mkPromptPreset()]}
        />
      );
      expect(c.textContent).toContain("推荐场景");
      expect(c.textContent).toContain("提取商品信息");
      expect(c.textContent).toContain("总结页面");
      cleanup();
    });

    it("tool preset button shows 运行, prompt preset shows 使用", () => {
      const { c, cleanup } = mount(
        <EmptySuggestions
          matchedTools={[]}
          onRun={() => {}}
          onDetail={() => {}}
          presets={[mkToolPreset(), mkPromptPreset()]}
        />
      );
      const buttons = Array.from(c.querySelectorAll("button")).map((b) => b.textContent ?? "");
      expect(buttons).toContain("运行");
      expect(buttons).toContain("使用");
      cleanup();
    });

    it("clicking preset button invokes onPresetPick with the preset", () => {
      const onPresetPick = vi.fn();
      const preset = mkPromptPreset();
      const { c, cleanup } = mount(
        <EmptySuggestions
          matchedTools={[]}
          onRun={() => {}}
          onDetail={() => {}}
          presets={[preset]}
          onPresetPick={onPresetPick}
        />
      );
      const useBtn = Array.from(c.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("使用")
      ) as HTMLButtonElement | undefined;
      act(() => useBtn?.click());
      expect(onPresetPick).toHaveBeenCalledWith(preset);
      cleanup();
    });

    it("backward-compat: omitting presets prop still renders without crash", () => {
      const { c, cleanup } = mount(
        <EmptySuggestions matchedTools={[mk(1)]} onRun={() => {}} onDetail={() => {}} />
      );
      expect(c.textContent).toContain("tool 1");
      expect(c.textContent).not.toContain("推荐场景");
      cleanup();
    });
  });
});
