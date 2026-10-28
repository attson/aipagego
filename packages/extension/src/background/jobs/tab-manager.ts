export type AcquiredJobTab = {
  tabId: number;
  ownership: "existing" | "created";
};

let isBusyTab: (tabId: number) => boolean = () => false;

export function registerJobTabBusyCheck(check: (tabId: number) => boolean): void {
  isBusyTab = check;
}

function withoutFragment(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
}

export async function acquireJobTab(targetUrl: string): Promise<AcquiredJobTab> {
  const target = withoutFragment(targetUrl);
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) =>
    tab.id != null &&
    !isBusyTab(tab.id) &&
    typeof tab.url === "string" &&
    withoutFragment(tab.url) === target
  );
  if (existing?.id != null) return { tabId: existing.id, ownership: "existing" };

  const created = await chrome.tabs.create({ url: targetUrl, active: false });
  if (created.id == null) throw new Error("job_tab_create_failed");
  if (created.status !== "complete") await waitForTabComplete(created.id);
  return { tabId: created.id, ownership: "created" };
}

async function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error("job_tab_load_timeout"));
    }, timeoutMs);
    const listener = (updatedTabId: number, change: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || change.status !== "complete") return;
      finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId)
      .then((current) => {
        if (current.status === "complete") finish();
      })
      .catch(finish);
  });
}

export async function releaseJobTab(tab: AcquiredJobTab): Promise<void> {
  if (tab.ownership !== "created") return;
  await chrome.tabs.remove(tab.tabId).catch(() => undefined);
}
