/**
 * BG-side broker for cross-context session and decision events.
 *
 * When a host (sidepanel or in-page widget) mutates its session-store, it
 * broadcasts a supported event via chrome.runtime.sendMessage. BG catches it
 * here and re-broadcasts to the widget content-script on the specified tab
 * (chrome.tabs.sendMessage is required — runtime broadcast does NOT reach
 * content-scripts).
 *
 * Receivers filter out self by comparing `senderId` to their own instance ID.
 */
import { pendingPermissionStorageKey } from "@/permissions/optional-permissions";

export function installSessionBroker(options: {
  onSnapshot?: (tabId: number, snapshot: unknown) => void | Promise<void>;
} = {}): () => void {
  const listener = (msg: unknown, _sender: unknown, _respond: (r?: unknown) => void) => {
    const m = msg as { type?: string; tabId?: number; snapshot?: unknown } | null;
    if (!m || typeof m.tabId !== "number") return;
    if (
      m.type !== "session.state.changed" &&
      m.type !== "approval.decision" &&
      m.type !== "permission.decision"
    ) return;
    if (m.type === "session.state.changed") {
      void options.onSnapshot?.(m.tabId, m.snapshot);
    } else if (m.type === "permission.decision") {
      const toolUseId = (m as { toolUseId?: unknown }).toolUseId;
      if (typeof toolUseId === "string") {
        void chrome.storage.session
          .remove(pendingPermissionStorageKey(m.tabId, toolUseId))
          .catch(() => {});
      }
    }
    // Fan-out to widget on that tab.
    void chrome.tabs.sendMessage(m.tabId, msg).catch(() => {});
    // Sidepanel and other extension pages receive the original runtime message
    // directly — no relay needed.
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
