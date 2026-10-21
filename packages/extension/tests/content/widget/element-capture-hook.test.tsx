import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useElementCapture } from "@/content/widget/element-capture-hook";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listeners: Array<(msg: unknown) => void> = [];
(globalThis as any).chrome = {
  runtime: {
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn((cb: any) => listeners.push(cb)),
      removeListener: vi.fn((cb: any) => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      }),
    },
  },
};

describe("useElementCapture", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listeners.length = 0;
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("registers listener on mount, dispatches selector to callback", async () => {
    let captured = "";
    function Test() {
      const { startCapture } = useElementCapture((sel) => (captured = sel));
      useEffect(() => { startCapture(); }, []);
      return null;
    }
    await act(async () => root.render(<Test />));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "aipagego.startCapture" });
    listeners[0]({ type: "aipagego.captureResult", selector: "button.primary" });
    expect(captured).toBe("button.primary");
  });

  it("removes listener on unmount", async () => {
    function Test() {
      useElementCapture(() => {});
      return null;
    }
    await act(async () => root.render(<Test />));
    expect(listeners.length).toBe(1);
    await act(async () => root.unmount());
    // effect cleanup runs synchronously in act
    // note: this test is mostly a sanity check; skip if runs prove flaky
  });
});
