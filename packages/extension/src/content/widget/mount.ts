import { setTeardown, unmountWidget } from "./lifecycle";

const HOST_TAG = "aipagego-widget";

// unmountWidget() is exported from ./lifecycle so components can trigger
// teardown without importing this module (which has auto-mount side effects).

export async function mountWidget(): Promise<void> {
  // Idempotent
  if (document.querySelector(HOST_TAG)) return;

  // Top-level window only
  if (window !== window.top) return;

  // HTML only (skip PDF, XML feeds, etc.)
  // Treat absent/undefined contentType as html (happy-dom + real-browser content scripts land here).
  if (document.contentType && document.contentType !== "text/html") return;

  const host = document.createElement(HOST_TAG);
  host.style.all = "initial";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  const { attachStyles } = await import("./styles");
  attachStyles(shadow);
  const { bootstrap } = await import("./react-root");
  setTeardown(bootstrap(shadow));

}

export async function reconcileWidget(): Promise<void> {
  unmountWidget();
  await mountWidget();
}
