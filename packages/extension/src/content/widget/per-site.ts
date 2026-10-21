const FAB_KEY = "aipagego.widget.fabPos";
const SIZE_KEY = "aipagego.widget.panelSize";
const DEFAULT_SIZE = { w: 320, h: 480 };

export async function hideHost(host: string): Promise<void> {
  const key = "aipagego.llm";
  const raw = (await chrome.storage.local.get([key]))[key] as Record<string, unknown> | undefined;
  const rules = Array.isArray(raw?.siteInjectionRules) ? [...raw.siteInjectionRules] : [];
  rules.push({
    pattern: host.trim().toLowerCase().replace(/\.$/, ""),
    injectionMode: "inherit",
    assistant: "disabled"
  });
  await chrome.storage.local.set({ [key]: { ...(raw ?? {}), siteInjectionRules: rules } });
}

export async function getFabPos(host: string): Promise<{ x: number; y: number } | null> {
  const raw = (await chrome.storage.local.get([FAB_KEY]))[FAB_KEY];
  const map = (raw && typeof raw === "object") ? raw as Record<string, { x: number; y: number }> : {};
  return map[host] ?? null;
}

export async function setFabPos(host: string, pos: { x: number; y: number }): Promise<void> {
  const raw = (await chrome.storage.local.get([FAB_KEY]))[FAB_KEY];
  const map = (raw && typeof raw === "object") ? raw as Record<string, { x: number; y: number }> : {};
  map[host] = pos;
  await chrome.storage.local.set({ [FAB_KEY]: map });
}

export async function getPanelSize(): Promise<{ w: number; h: number }> {
  const raw = (await chrome.storage.local.get([SIZE_KEY]))[SIZE_KEY];
  if (raw && typeof raw === "object" && typeof (raw as any).w === "number" && typeof (raw as any).h === "number") {
    return { w: (raw as any).w, h: (raw as any).h };
  }
  return { ...DEFAULT_SIZE };
}

export async function setPanelSize(size: { w: number; h: number }): Promise<void> {
  await chrome.storage.local.set({ [SIZE_KEY]: size });
}
