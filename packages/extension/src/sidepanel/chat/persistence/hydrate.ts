import type { PersistedSession } from "@aipagego/shared/types";
import { rehydrateFromPersisted } from "@/sidepanel/chat/session-store";
import { setPersistIdFor } from "./auto-persist";
import * as ss from "./sessions-storage";

export type HydrateResult =
  | { kind: "rehydrated"; persistedId: string }
  | { kind: "url-candidates"; candidates: PersistedSession[] }
  | { kind: "empty" };

/**
 * Called once at sidepanel boot. Priority:
 *   1. tabId has active session with matching url → silent rehydrate
 *   2. tabId mismatch but url has archived candidates → return candidates list (banner UI shows them)
 *   3. neither → empty
 *
 * Any IDB failure falls back to empty (persistence is a cache, not source of truth).
 */
export async function hydrateOnBoot(tabId: number, url: string): Promise<HydrateResult> {
  try {
    const active = await ss.getActiveByTabId(tabId);
    if (active && active.url === url) {
      rehydrateFromPersisted(tabId, active.data);
      setPersistIdFor(tabId, active.id);
      return { kind: "rehydrated", persistedId: active.id };
    }
    const candidates = await ss.listArchivedByUrl(url, 5);
    if (candidates.length > 0) return { kind: "url-candidates", candidates };
    return { kind: "empty" };
  } catch (e) {
    console.warn("[persistence] hydrate failed; falling back to empty", e);
    return { kind: "empty" };
  }
}
