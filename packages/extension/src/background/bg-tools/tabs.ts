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

export interface OpenTabInput {
  url: string;
  active?: boolean;
  incognito?: boolean;
  windowId?: number;
}

export interface OpenTabResult {
  tabId: number;
  windowId: number;
  incognito: boolean;
  url: string;
  title: string;
}

function incognitoAccessAllowed(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    chrome.extension.isAllowedIncognitoAccess((allowed) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(`openTab: 无法检查无痕模式权限：${lastError.message}`));
        return;
      }
      resolve(allowed);
    });
  });
}

function tabResult(
  tab: chrome.tabs.Tab,
  fallback: { url: string; windowId?: number; incognito: boolean }
): OpenTabResult {
  if (tab.id == null) throw new Error("openTab: chrome did not return a tab id");
  const windowId = tab.windowId ?? fallback.windowId;
  if (windowId == null) throw new Error("openTab: chrome did not return a window id");
  return {
    tabId: tab.id,
    windowId,
    incognito: tab.incognito ?? fallback.incognito,
    url: tab.url ?? fallback.url,
    title: tab.title ?? ""
  };
}

export async function openTabInBrowser(input: OpenTabInput): Promise<OpenTabResult> {
  const { url, windowId } = input;
  if (!url) throw new Error("openTab: url required");
  const active = input.active === true;

  if (input.incognito !== true) {
    const tab = await chrome.tabs.create({
      url,
      active,
      ...(windowId == null ? {} : { windowId })
    });
    return tabResult(tab, { url, windowId, incognito: false });
  }

  if (!(await incognitoAccessAllowed())) {
    throw new Error(
      "AIPageGo 尚未获准在无痕模式下运行，请在 Chrome 扩展详情中开启“允许在无痕模式下运行”"
    );
  }

  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const target = windowId == null
    ? windows.find((window) => window.incognito === true)
    : windows.find((window) => window.id === windowId);

  if (windowId != null && !target) {
    throw new Error(`openTab: window ${windowId} does not exist`);
  }
  if (target && target.incognito !== true) {
    throw new Error(`openTab: window ${target.id ?? windowId} is not incognito`);
  }

  if (target?.id != null) {
    const tab = await chrome.tabs.create({ url, active, windowId: target.id });
    return tabResult(tab, { url, windowId: target.id, incognito: true });
  }

  const createdWindow = await chrome.windows.create({
    url,
    incognito: true,
    focused: active
  });
  if (createdWindow.id == null) {
    throw new Error("openTab: chrome did not return an incognito window id");
  }
  const createdTab = createdWindow.tabs?.find((tab) => tab.id != null) ??
    (await chrome.tabs.query({ windowId: createdWindow.id }))[0];
  if (!createdTab) throw new Error("openTab: chrome did not return the incognito tab");
  return tabResult(createdTab, { url, windowId: createdWindow.id, incognito: true });
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
  const { url, active, incognito, windowId } = asObj(raw) as {
    url?: string;
    active?: boolean;
    incognito?: boolean;
    windowId?: number;
  };
  if (typeof url !== "string" || !url) throw new Error("openTab: url required");
  return (await openTabInBrowser({ url, active, incognito, windowId })) as unknown as Json;
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
