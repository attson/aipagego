import type { PersistedSession, PersistedSessionData } from "@aipagego/shared/types";
import { useStore, type SessionData } from "@/sidepanel/chat/session-store";
import * as ss from "./sessions-storage";

const DEBOUNCE_MS = 300;

type Entry = { timer: ReturnType<typeof setTimeout> | null; persistedId: string | null };
const state = new Map<number, Entry>();

export function toPersistedData(s: SessionData): PersistedSessionData {
  return {
    messages: s.messages,
    cards: s.cards,
    executedSteps: s.executedSteps,
    tokenUsage: s.tokenUsage,
    roundCount: s.roundCount,
    attachedTabs: s.attachedTabs,
    url: s.url,
    runRecordId: s.runRecordId,
    errorMessage: s.errorMessage,
    llmExchanges: s.llmExchanges
  };
}

async function writeFor(tabId: number, session: SessionData): Promise<void> {
  try {
    const entry = state.get(tabId);
    if (entry?.persistedId) {
      await ss.putSessionData(entry.persistedId, toPersistedData(session), tabId, session.url);
    } else {
      const now = Date.now();
      const row: PersistedSession = {
        id: crypto.randomUUID(),
        url: session.url,
        lastTabId: tabId,
        status: "active",
        data: toPersistedData(session),
        createdAt: now,
        updatedAt: now
      };
      await ss.putSession(row);
      const cur = state.get(tabId) ?? { timer: null, persistedId: null };
      cur.persistedId = row.id;
      state.set(tabId, cur);
    }
  } catch (e) {
    console.warn("[persistence] auto-persist write failed", e);
  }
}

function schedule(tabId: number): void {
  let entry = state.get(tabId);
  if (!entry) {
    entry = { timer: null, persistedId: null };
    state.set(tabId, entry);
  }
  if (entry.timer != null) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    const e = state.get(tabId);
    if (e) e.timer = null;
    const s = useStore.getState().sessionsByTab[tabId];
    if (s) void writeFor(tabId, s);
  }, DEBOUNCE_MS);
}

/**
 * Subscribe to zustand sessionsByTab; schedule a debounced write per tab whose
 * SessionData changed. Returns unsubscribe.
 */
export function installAutoPersist(): () => void {
  let prev = useStore.getState().sessionsByTab;
  const unsub = useStore.subscribe((storeState) => {
    const cur = storeState.sessionsByTab;
    if (cur === prev) return;
    for (const [k, s] of Object.entries(cur)) {
      const tabId = Number(k);
      if (s !== prev[tabId]) {
        // Skip empty sessions — don't create a row until first real content
        if (s.messages.length === 0 && s.cards.length === 0) continue;
        schedule(tabId);
      }
    }
    prev = cur;
  });
  const flush = () => { void flushAllPending(); };
  if (typeof window !== "undefined") window.addEventListener("beforeunload", flush);
  return () => {
    unsub();
    if (typeof window !== "undefined") window.removeEventListener("beforeunload", flush);
    for (const entry of state.values()) {
      if (entry.timer != null) clearTimeout(entry.timer);
    }
    state.clear();
  };
}

/**
 * Force-write all pending sessions. Used by beforeunload and the
 * new-session button (which needs the row to exist before archiving).
 */
export async function flushAllPending(): Promise<void> {
  const sessions = useStore.getState().sessionsByTab;
  const pending: Array<{ tabId: number; session: SessionData }> = [];
  for (const [k, entry] of state) {
    if (entry.timer != null) {
      clearTimeout(entry.timer);
      entry.timer = null;
      const s = sessions[k];
      if (s) pending.push({ tabId: k, session: s });
    }
  }
  for (const { tabId, session } of pending) {
    await writeFor(tabId, session);
  }
}

/**
 * Reset auto-persist state for a tab after starting a new session.
 * Clears any pending timer and sets persistedId to null so the next
 * mutation creates a fresh row instead of overwriting the archived one.
 */
export function clearPersistStateFor(tabId: number): void {
  const entry = state.get(tabId);
  if (entry) {
    if (entry.timer != null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.persistedId = null;
  }
}

/**
 * Tell auto-persist that tabId is now backed by a specific persisted row.
 * Must be called after restoring an archived session so subsequent mutations
 * update the restored row instead of creating a duplicate active row.
 */
export function setPersistIdFor(tabId: number, persistedId: string): void {
  let entry = state.get(tabId);
  if (!entry) {
    entry = { timer: null, persistedId: null };
    state.set(tabId, entry);
  }
  if (entry.timer != null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.persistedId = persistedId;
}

/** Test helper — clears module-level state map. */
export function _resetAutoPersistForTests(): void {
  for (const entry of state.values()) {
    if (entry.timer != null) clearTimeout(entry.timer);
  }
  state.clear();
}
