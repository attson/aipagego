import { matchingTools } from "./storage/tools";
import { matchPresetsByUrl } from "@aipagego/shared/match-presets";
import type { Preset } from "@aipagego/shared/preset";
import type { Tool } from "@aipagego/shared/types";

export async function refreshRecommendations(tabId: number, url: string): Promise<void> {
  const tools = await matchingTools(url);
  const rawPresets = matchPresetsByUrl(url);

  // Dedup: if a preset has already been materialized as a user tool
  // (tool.origin.presetId === preset.id), don't surface the preset again.
  const materializedIds = new Set(
    tools
      .map((t: Tool) => t.origin)
      .filter((o): o is NonNullable<Tool["origin"]> => !!o && o.kind === "preset")
      .map((o) => o.presetId)
  );
  const presets = rawPresets.filter((p: Preset) => !materializedIds.has(p.id));

  const badgeCount = tools.length + presets.length;
  await chrome.action.setBadgeText({
    tabId,
    text: badgeCount ? String(badgeCount) : ""
  });
  if (badgeCount) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#10b981" });
  }
  try {
    await chrome.runtime.sendMessage({
      type: "tabs.recommendations",
      tabId,
      url,
      tools,
      presets
    });
  } catch {
    // sidepanel 不在听就 swallow
  }
}

export function installTabWatcher(): void {
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url) void refreshRecommendations(tabId, change.url);
    if (change.status === "complete" && (change.url || tab.url)) {
      void broadcast({
        type: "tabs.urlChanged",
        tabId,
        newUrl: change.url ?? tab.url ?? "",
        newTitle: tab.title ?? ""
      });
    }
  });
  chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, url }) => {
    void refreshRecommendations(tabId, url);
    void broadcast({ type: "tabs.urlChanged", tabId, newUrl: url, newTitle: "" });
  });
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id == null) return;
    void broadcast({
      type: "tabs.spawned",
      tabId: tab.id,
      openerTabId: tab.openerTabId ?? null,
      windowId: tab.windowId,
      url: tab.url ?? "",
      title: tab.title ?? ""
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void broadcast({ type: "tabs.removed", tabId });
  });
}

async function broadcast(msg: unknown): Promise<void> {
  try {
    await chrome.runtime.sendMessage(msg);
  } catch {
    // sidepanel 不在听就 swallow
  }
}
