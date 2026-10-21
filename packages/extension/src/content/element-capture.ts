/**
 * Visual element capture overlay. Listens for a one-shot "start capture"
 * message from the sidepanel; while active, hovering highlights the element
 * under the cursor, clicking sends its selector back. ESC / 5s timeout cancels.
 *
 * Implementation guards:
 *  - overlay is a fixed full-screen <div> with pointer-events: none so the
 *    cursor still hits real elements (we use mousemove on `document` and
 *    only ever READ the element).
 *  - the single click event listener uses capture-phase + preventDefault to
 *    swallow the user's click on the page (so they don't accidentally
 *    navigate / submit during capture).
 *  - on ESC / completion the listener + overlay are removed.
 */

import { selectorFor } from "@/sidepanel/lib/selector-for";

type Active = {
  overlay: HTMLDivElement;
  hover: HTMLDivElement;
  cleanup: () => void;
};

let active: Active | null = null;

function ensureStyle(): void {
  if (document.getElementById("aipagego-capture-style")) return;
  const s = document.createElement("style");
  s.id = "aipagego-capture-style";
  s.textContent = `
    .aipagego-capture-hover {
      position: fixed;
      pointer-events: none;
      border: 2px dashed #ef4444;
      background: rgba(239, 68, 68, 0.08);
      box-sizing: border-box;
      z-index: 2147483646;
      transition: all 70ms ease-out;
    }
    .aipagego-capture-banner {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      padding: 6px 12px;
      background: #ef4444;
      color: #fff;
      font-size: 12px;
      font-family: ui-sans-serif, system-ui, sans-serif;
      z-index: 2147483647;
      pointer-events: none;
      text-align: center;
    }
  `;
  (document.head || document.documentElement).appendChild(s);
}

function stop(): void {
  if (!active) return;
  active.cleanup();
  active = null;
}

function start(): void {
  if (active) return;
  ensureStyle();
  const overlay = document.createElement("div");
  overlay.className = "aipagego-capture-banner";
  overlay.textContent = "AIPageGo: 点击页面上要选的元素（ESC 取消）";
  const hover = document.createElement("div");
  hover.className = "aipagego-capture-hover";
  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(hover);

  let lastTarget: Element | null = null;
  const timeout = window.setTimeout(stop, 30_000);

  function onMove(e: MouseEvent) {
    const t = e.target as Element | null;
    if (!t || t === overlay || t === hover) return;
    lastTarget = t;
    const r = t.getBoundingClientRect();
    hover.style.left = `${r.left}px`;
    hover.style.top = `${r.top}px`;
    hover.style.width = `${r.width}px`;
    hover.style.height = `${r.height}px`;
  }
  function onClick(e: MouseEvent) {
    if (!lastTarget) return;
    e.preventDefault();
    e.stopPropagation();
    const sel = selectorFor(lastTarget);
    void chrome.runtime
      .sendMessage({ type: "aipagego.captureResult", selector: sel })
      .catch(() => undefined);
    stop();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      void chrome.runtime
        .sendMessage({ type: "aipagego.captureCancelled" })
        .catch(() => undefined);
      stop();
    }
  }

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);

  active = {
    overlay,
    hover,
    cleanup: () => {
      window.clearTimeout(timeout);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      hover.remove();
    },
  };
}

const listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (msg) => {
  if (msg && typeof msg === "object") {
    if ((msg as { type?: string }).type === "aipagego.startCapture") start();
    if ((msg as { type?: string }).type === "aipagego.stopCapture") stop();
  }
  return false;
};

export function installElementCapture(): () => void {
  chrome.runtime.onMessage.addListener(listener);
  return () => {
    stop();
    chrome.runtime.onMessage.removeListener(listener);
  };
}
