import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScenariosPage } from "@/sidepanel/pages/scenarios-page";
import { PRESETS } from "@aipagego/shared/presets";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/sidepanel/rpc", () => ({
  rpc: {
    listPresets: async () => [...PRESETS],
    listTools: async () => [],
    materializePreset: async (id: string) => ({
      id: "u1",
      name: id,
      kind: "steps",
      steps: [],
      versions: [],
      urlPatterns: [],
      description: "",
      createdAt: 0,
      origin: { kind: "preset", presetId: id, presetVersion: 1 },
    }),
  },
  currentTabId: async () => 1,
  currentTabInfo: async () => ({ tabId: 1, url: "https://en.wikipedia.org/wiki/X" }),
}));

vi.mock("@/sidepanel/chat/ui-store", () => ({
  useUi: (selector: (s: { open: () => void }) => unknown) =>
    selector({ open: vi.fn() }),
}));

describe("ScenariosPage", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function flushAsync() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("renders category headers and preset cards", async () => {
    await act(async () => {
      root.render(<ScenariosPage />);
    });
    await flushAsync();

    // shows category headers
    expect(container.textContent).toContain("内容站");
    expect(container.textContent).toContain("商品采集");
    // shows at least one preset name
    expect(container.textContent).toContain("维基百科总结");
  });
});
