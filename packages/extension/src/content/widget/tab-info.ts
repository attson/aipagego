/**
 * Widget-side "who am I" helper.
 *
 * Content scripts don't have access to `chrome.tabs.*` even when the extension
 * declares the `tabs` permission — that surface is restricted to extension
 * pages (background, sidepanel, popup). The sidepanel-side `currentTabId()` /
 * `currentTabInfo()` call `chrome.tabs.query(...)`, which throws in a content
 * script context.
 *
 * Instead, we reuse the existing `aipagego.getTabId` side-channel (already
 * consumed by breathing-border content script) — BG's `runtime.onMessage`
 * listener extracts `sender.tab?.id` and returns it.
 *
 * URL is available locally via `location.href` — no round-trip needed.
 */

export async function getWidgetTabInfo(): Promise<{ tabId: number; url: string }> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: "aipagego.getTabId" }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message ?? "runtime error"));
          return;
        }
        const tabId = (res as { tabId?: number } | null)?.tabId;
        if (typeof tabId !== "number") {
          reject(new Error("no tab id from background"));
          return;
        }
        resolve({ tabId, url: location.href });
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
