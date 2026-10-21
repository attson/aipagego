import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Panel } from "@/content/widget/panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mock chrome APIs
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
    id: "test-extension-id",
  },
  tabs: {
    query: vi.fn(async () => [{ id: 42, url: "https://example.com" }]),
  },
};

// Mock per-site
vi.mock("@/content/widget/per-site", () => ({
  getPanelSize: vi.fn().mockResolvedValue({ w: 320, h: 480 }),
  setPanelSize: vi.fn().mockResolvedValue(undefined),
  getFabPos: vi.fn().mockResolvedValue(null),
  setFabPos: vi.fn().mockResolvedValue(undefined),
}));

// Mock rpc
vi.mock("@/sidepanel/rpc", () => ({
  rpc: {
    widgetOpenSidepanel: vi.fn().mockResolvedValue(undefined),
  },
}));

// Widget looks up its tab via a content-script-safe helper (calls the
// aipagego.getTabId side-channel through chrome.runtime, not chrome.tabs).
vi.mock("@/content/widget/tab-info", () => ({
  getWidgetTabInfo: vi.fn().mockResolvedValue({ tabId: 42, url: "https://example.com" }),
}));

describe("Panel", () => {
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
    vi.clearAllMocks();
  });

  it("renders header with title", async () => {
    await act(async () => {
      root.render(<Panel onClose={() => {}} onMinimize={() => {}} />);
    });
    expect(container.textContent).toContain("AIPageGo");
  });

  it("renders the input textarea", async () => {
    await act(async () => {
      root.render(<Panel onClose={() => {}} onMinimize={() => {}} />);
    });
    const textarea = container.querySelector("[data-testid='input-box']");
    expect(textarea).toBeTruthy();
  });

  it("renders close and minimize buttons", async () => {
    await act(async () => {
      root.render(<Panel onClose={() => {}} onMinimize={() => {}} />);
    });
    const buttons = container.querySelectorAll("button");
    const titles = Array.from(buttons).map((b) => b.getAttribute("title"));
    expect(titles).toContain("关闭");
    expect(titles).toContain("最小化");
  });

  it("calls onClose when close button is clicked", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<Panel onClose={onClose} onMinimize={() => {}} />);
    });
    const closeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("title") === "关闭"
    );
    await act(async () => {
      closeBtn?.click();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onMinimize when minimize button is clicked", async () => {
    const onMinimize = vi.fn();
    await act(async () => {
      root.render(<Panel onClose={() => {}} onMinimize={onMinimize} />);
    });
    const minimizeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("title") === "最小化"
    );
    await act(async () => {
      minimizeBtn?.click();
    });
    expect(onMinimize).toHaveBeenCalledOnce();
  });
});
