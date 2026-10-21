import type { Json } from "@aipagego/shared/types";

/**
 * Tab-plane tools in the service worker, so the coordinator/MCP EXEC path can
 * reach them. They used to live in the side panel, which the EXEC path never
 * touches.
 */

function asObj(raw: Json): Record<string, unknown> {
  return (raw ?? {}) as Record<string, unknown>;
}

/**
 * Tabs an MCP session is allowed to touch. `runOneStep` injects this from the
 * session's tab plus its attached set, preserving the guard the side panel
 * already applied — an MCP session must not be able to close arbitrary tabs.
 */
function allowedFrom(raw: Json): Set<number> {
  const list = asObj(raw).allowedTabIds;
  return new Set(Array.isArray(list) ? (list as number[]) : []);
}

export async function listTabs(raw: Json): Promise<Json> {
  const { windowId } = asObj(raw) as { windowId?: number };
  const tabs = await chrome.tabs.query(windowId != null ? { windowId } : {});
  return tabs
    .filter((t) => t.id != null)
    .map((t) => ({
      tabId: t.id!,
      url: t.url ?? null,
      title: t.title ?? null,
      active: t.active === true,
      windowId: t.windowId ?? null
    })) as unknown as Json;
}

export async function openTab(raw: Json): Promise<Json> {
  const { url, active } = asObj(raw) as { url?: string; active?: boolean };
  if (typeof url !== "string" || !url) throw new Error("openTab: url required");
  const tab = await chrome.tabs.create({ url, active: active === true });
  return {
    tabId: tab.id ?? null,
    url: tab.url ?? url,
    title: tab.title ?? null
  } as unknown as Json;
}

export async function closeTab(raw: Json): Promise<Json> {
  const { tabId } = asObj(raw) as { tabId?: number };
  if (typeof tabId !== "number") throw new Error("closeTab: tabId required");
  if (!allowedFrom(raw).has(tabId)) {
    throw new Error(`closeTab: tab ${tabId} not in attachedTabs; use attachTab first`);
  }
  await chrome.tabs.remove(tabId);
  return { ok: true, tabId } as unknown as Json;
}

export async function switchToTab(raw: Json): Promise<Json> {
  const { tabId } = asObj(raw) as { tabId?: number };
  if (typeof tabId !== "number") throw new Error("switchToTab: tabId required");
  if (!allowedFrom(raw).has(tabId)) {
    throw new Error(`switchToTab: tab ${tabId} not attached; use attachTab first`);
  }
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId != null) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      // Window focus fails on some platforms; the tab switch already happened.
    }
  }
  return { ok: true, tabId, url: tab.url ?? null } as unknown as Json;
}
