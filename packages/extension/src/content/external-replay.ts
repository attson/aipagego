/**
 * External replay receiver. Listens for window.postMessage from the host page;
 * any message tagged `{source: "aipagego-replay", payload}` is forwarded to
 * the BG, which validates and stages it in chrome.storage.local.
 *
 * The sidepanel hook `useExternalReplay` consumes the staged value and shows
 * a review modal — never auto-executed.
 */

const listener = (event: MessageEvent) => {
  const data = event.data as unknown;
  if (!data || typeof data !== "object") return;
  const m = data as { source?: string; payload?: unknown };
  if (m.source !== "aipagego-replay") return;
  void chrome.runtime
    .sendMessage({
      type: "aipagego.externalReplay",
      payload: m.payload,
      sourceUrl: location.href,
    })
    .catch(() => undefined);
};

export function installExternalReplay(): () => void {
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
