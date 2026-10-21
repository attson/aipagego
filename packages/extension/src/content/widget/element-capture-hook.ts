import { useEffect } from "react";

/**
 * Widget-side hook for element-capture flow:
 * - startCapture() 触发页面进入圈选模式(content/element-capture.ts 监听)
 * - 用户点选后 element-capture 发 aipagego.captureResult 消息
 * - 本 hook 挂 chrome.runtime.onMessage listener,收到就调 onSelector
 */
export function useElementCapture(onSelector: (selector: string) => void): {
  startCapture: () => void;
} {
  useEffect(() => {
    function listener(msg: unknown) {
      const m = msg as { type?: string; selector?: string } | null;
      if (!m || m.type !== "aipagego.captureResult") return;
      if (typeof m.selector === "string") onSelector(m.selector);
    }
    try {
      chrome.runtime.onMessage.addListener(listener);
    } catch { /* no chrome in test */ }
    return () => {
      try {
        chrome.runtime.onMessage.removeListener(listener);
      } catch { /* noop */ }
    };
  }, [onSelector]);

  function startCapture(): void {
    try {
      chrome.runtime.sendMessage({ type: "aipagego.startCapture" });
    } catch { /* noop */ }
  }

  return { startCapture };
}
