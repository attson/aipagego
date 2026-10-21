import { useEffect } from "react";
import { useStore } from "./session-store";

const KEY = "aipagego.heartbeat";
const INTERVAL_MS = 2_000;

type Heartbeat = { ts: number; activeTabIds: number[] };

function computeActiveTabIds(): number[] {
  const state = useStore.getState();
  const out = new Set<number>();
  for (const [tabIdStr, s] of Object.entries(state.sessionsByTab)) {
    if (s.status !== "streaming" && s.status !== "awaiting" && s.status !== "running") continue;
    out.add(Number(tabIdStr));
    for (const a of s.attachedTabs) out.add(a.tabId);
  }
  return Array.from(out);
}

async function write(active: number[]): Promise<void> {
  try {
    if (active.length === 0) {
      await chrome.storage.local.remove(KEY);
    } else {
      const hb: Heartbeat = { ts: Date.now(), activeTabIds: active };
      await chrome.storage.local.set({ [KEY]: hb });
    }
  } catch {
    // storage may be busy; next tick will retry
  }
}

/**
 * Sidepanel-side heartbeat writer. Every 2s while any session is non-idle,
 * write `{ts, activeTabIds}` to `chrome.storage.local: aipagego.heartbeat`.
 * Content scripts in tabs listed in `activeTabIds` show a breathing border.
 *
 * The hook also clears the key on unmount / when nothing's active.
 */
export function useHeartbeat(): void {
  useEffect(() => {
    let last: string | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    function tick(): void {
      const active = computeActiveTabIds();
      const sig = active.join(",");
      if (sig === last && active.length === 0) return;
      last = sig;
      void write(active);
    }

    tick();
    timer = setInterval(tick, INTERVAL_MS);

    function onVisibility() {
      if (document.hidden) {
        last = "";
        void chrome.storage.local.remove(KEY).catch(() => undefined);
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) clearInterval(timer);
      void chrome.storage.local.remove(KEY).catch(() => undefined);
    };
  }, []);
}

// Pure helpers exported for tests
export const __test = { computeActiveTabIds };
