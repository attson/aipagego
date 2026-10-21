/**
 * Right-click → "AIPageGo" entries. Writes the chosen prompt to
 * chrome.storage.local under `aipagego.pending_prompt` (5s TTL) and opens
 * the side panel for the active tab. The sidepanel's `usePendingPrompt`
 * hook consumes and clears the value on next mount.
 */

export const PENDING_PROMPT_KEY = "aipagego.pending_prompt";
export const PENDING_TTL_MS = 5_000;

const MENU_IDS = {
  summarize: "aipagego.summarize",
  extract: "aipagego.extract",
  custom: "aipagego.custom",
} as const;

export type PendingPrompt = {
  text: string;
  ts: number;
  sourceUrl?: string;
  autoSend: boolean;
};

export function registerContextMenus(): void {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_IDS.summarize,
        title: "AIPageGo：总结此页",
        contexts: ["page"],
      });
      chrome.contextMenus.create({
        id: MENU_IDS.extract,
        title: "AIPageGo：处理此选区",
        contexts: ["selection"],
      });
      chrome.contextMenus.create({
        id: MENU_IDS.custom,
        title: "AIPageGo：让 AI 处理…",
        contexts: ["page", "selection"],
      });
    });
  } catch {
    // contextMenus may be unavailable in some restricted contexts; fail silent.
  }
}

export function unregisterContextMenus(): void {
  try {
    chrome.contextMenus.removeAll(() => undefined);
  } catch {
    // ignore
  }
}

/**
 * Compute the prompt for a given menu click. Returns null when the click
 * targets a menu we don't own (so the caller can ignore).
 */
export function promptFor(
  menuItemId: string | number | undefined,
  info: chrome.contextMenus.OnClickData
): PendingPrompt | null {
  const sourceUrl = info.pageUrl;
  if (menuItemId === MENU_IDS.summarize) {
    return { text: "用要点总结此页。", ts: Date.now(), sourceUrl, autoSend: true };
  }
  if (menuItemId === MENU_IDS.extract) {
    const sel = (info.selectionText ?? "").trim();
    if (!sel) return null;
    return {
      text: `处理以下选区，按用户后续指令操作或抽取信息：\n\n"""\n${sel}\n"""`,
      ts: Date.now(),
      sourceUrl,
      autoSend: false,
    };
  }
  if (menuItemId === MENU_IDS.custom) {
    return { text: "", ts: Date.now(), sourceUrl, autoSend: false };
  }
  return null;
}

export async function writePendingPrompt(p: PendingPrompt): Promise<void> {
  await chrome.storage.local.set({ [PENDING_PROMPT_KEY]: p });
}

export async function consumePendingPrompt(now: number): Promise<PendingPrompt | null> {
  const cur = (await chrome.storage.local.get(PENDING_PROMPT_KEY))[PENDING_PROMPT_KEY] as
    | PendingPrompt
    | undefined;
  await chrome.storage.local.remove(PENDING_PROMPT_KEY);
  if (!cur) return null;
  if (now - cur.ts > PENDING_TTL_MS) return null;
  return cur;
}

export async function handleMenuClick(
  menuItemId: string | number | undefined,
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined
): Promise<void> {
  const prompt = promptFor(menuItemId, info);
  if (!prompt) return;
  await writePendingPrompt(prompt);
  if (tab?.id != null) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch {
      // sidePanel.open may reject if user gesture context lost; sidepanel
      // will still consume the prompt on next manual open within the TTL.
    }
  }
}
