import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FAB } from "@/content/widget/fab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mock chrome storage (needed by per-site)
const storage: Record<string, any> = {};
(globalThis as any).chrome = {
  storage: {
    local: {
      get: vi.fn(async (keys: string[]) =>
        Object.fromEntries(keys.map((k) => [k, storage[k]]))
      ),
      set: vi.fn(async (obj: Record<string, any>) => {
        Object.assign(storage, obj);
      }),
    },
  },
  runtime: {
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  tabs: {
    query: vi.fn(async () => [{ id: 1 }]),
  },
};

vi.mock("@/content/widget/per-site", () => ({
  getFabPos: vi.fn().mockResolvedValue(null),
  setFabPos: vi.fn().mockResolvedValue(undefined),
  hideHost: vi.fn().mockResolvedValue(undefined),
}));

describe("FAB", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    // Do not restoreAllMocks — module-level mocks (vi.mock) must persist.
    vi.clearAllMocks();
  });

  it("renders as button with aria-label", async () => {
    await act(async () => {
      root.render(<FAB onToggle={() => {}} active={false} />);
    });
    const btn = container.querySelector("[aria-label='AIPageGo 助手']");
    expect(btn).toBeTruthy();
  });

  it("applies active class when active=true", async () => {
    await act(async () => {
      root.render(<FAB onToggle={() => {}} active={true} />);
    });
    const btn = container.querySelector("[aria-label='AIPageGo 助手']");
    expect(btn?.className).toContain("bg-emerald-600");
  });

  it("applies inactive class when active=false", async () => {
    await act(async () => {
      root.render(<FAB onToggle={() => {}} active={false} />);
    });
    const btn = container.querySelector("[aria-label='AIPageGo 助手']");
    expect(btn?.className).toContain("bg-zinc-800");
  });
});
