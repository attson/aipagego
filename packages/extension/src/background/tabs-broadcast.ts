import { deriveTabView, type TabBase } from "@aipagego/shared/pairing";
import type { CoordinatorPool } from "./coordinator-pool";
import type { TabOwnership } from "./tab-ownership";

/**
 * Keeps every connection's tab list current.
 *
 * `available_tabs` used to be built once, inside HELLO, and never refreshed —
 * so `list_tabs` reported the browser as it stood the moment the extension
 * connected. A tab opened afterwards was invisible until the next reconnect.
 *
 * Each connection receives a list derived for it, because ownership is
 * relative: the same tab is "mine" to its owner and "busy" to everyone else.
 */

export type BroadcastDeps = {
  pool: CoordinatorPool;
  ownership: TabOwnership;
  queryTabs?: () => Promise<TabBase[]>;
};

async function defaultQueryTabs(): Promise<TabBase[]> {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => t.id != null)
    .map((t) => ({
      tab_id: String(t.id),
      url: t.url ?? "",
      title: t.title ?? ""
    }));
}

export async function broadcastTabs(deps: BroadcastDeps): Promise<void> {
  const query = deps.queryTabs ?? defaultQueryTabs;
  let tabs: TabBase[];
  try {
    tabs = await query();
  } catch {
    return;
  }
  const owners = deps.ownership.owners();
  for (const entry of deps.pool.list()) {
    const client = deps.pool.clientFor(entry.sessionId);
    if (!client) continue;
    client.sendTabsUpdate(deriveTabView(tabs, owners, entry.sessionId));
  }
}

/** Wires the browser's tab events and ownership changes to a broadcast. */
export function installTabsBroadcast(deps: BroadcastDeps): () => void {
  const fire = () => void broadcastTabs(deps);

  const onRemoved = (tabId: number) => {
    deps.ownership.releaseTab(String(tabId));
    fire();
  };

  chrome.tabs?.onCreated?.addListener(fire);
  chrome.tabs?.onUpdated?.addListener(fire);
  chrome.tabs?.onRemoved?.addListener(onRemoved);
  const unsubscribe = deps.ownership.onChange(fire);

  return () => {
    chrome.tabs?.onCreated?.removeListener(fire);
    chrome.tabs?.onUpdated?.removeListener(fire);
    chrome.tabs?.onRemoved?.removeListener(onRemoved);
    unsubscribe();
  };
}
