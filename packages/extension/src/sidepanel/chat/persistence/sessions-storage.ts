import type { PersistedSession, PersistedSessionData } from "@aipagego/shared/types";
import { getDB } from "@/background/storage/db";

export async function putSession(s: PersistedSession): Promise<void> {
  const db = await getDB();
  await db.put("chat_sessions", s);
}

export async function getById(id: string): Promise<PersistedSession | undefined> {
  const db = await getDB();
  return db.get("chat_sessions", id);
}

/**
 * Update data + meta, but keep status unchanged. auto-persist uses this path
 * so it cannot flip status accidentally. If id doesn't exist, no-op (prevents
 * resurrection of already-deleted rows).
 */
export async function putSessionData(
  id: string,
  data: PersistedSessionData,
  lastTabId: number,
  url: string
): Promise<void> {
  const db = await getDB();
  const cur = await db.get("chat_sessions", id);
  if (!cur) return;
  await db.put("chat_sessions", {
    ...cur,
    data,
    lastTabId,
    url,
    updatedAt: Date.now()
  });
}

export async function getActiveByTabId(tabId: number): Promise<PersistedSession | undefined> {
  const db = await getDB();
  const all = await db.getAllFromIndex("chat_sessions", "by_lastTabId_status", [tabId, "active"]);
  return all[0];
}

export async function listArchivedByUrl(
  url: string,
  limit = 20
): Promise<PersistedSession[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("chat_sessions", "by_url_status", [url, "archived"]);
  return all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

export async function archiveActive(id: string): Promise<void> {
  const db = await getDB();
  const cur = await db.get("chat_sessions", id);
  if (!cur) return;
  await db.put("chat_sessions", { ...cur, status: "archived", updatedAt: Date.now() });
}

export async function restoreArchived(id: string, lastTabId: number): Promise<void> {
  const db = await getDB();
  const cur = await db.get("chat_sessions", id);
  if (!cur) return;
  await db.put("chat_sessions", {
    ...cur,
    status: "active",
    lastTabId,
    updatedAt: Date.now()
  });
}

/**
 * Keep at most N archived per URL. Evict oldest by updatedAt asc.
 * Returns runRecordIds of evicted sessions (for cascade delete in runs table).
 */
export async function pruneOverLimit(url: string, n = 20): Promise<string[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("chat_sessions", "by_url_status", [url, "archived"]);
  if (all.length <= n) return [];
  const sortedAsc = all.sort((a, b) => a.updatedAt - b.updatedAt);
  const toEvict = sortedAsc.slice(0, all.length - n);
  const runIds: string[] = [];
  for (const s of toEvict) {
    if (s.data.runRecordId) runIds.push(s.data.runRecordId);
    await db.delete("chat_sessions", s.id);
  }
  return runIds;
}

export async function deleteOne(id: string): Promise<string | null> {
  const db = await getDB();
  const cur = await db.get("chat_sessions", id);
  if (!cur) return null;
  await db.delete("chat_sessions", id);
  return cur.data.runRecordId ?? null;
}

export async function clearAllForUrl(url: string): Promise<string[]> {
  const db = await getDB();
  const active = await db.getAllFromIndex("chat_sessions", "by_url_status", [url, "active"]);
  const archived = await db.getAllFromIndex("chat_sessions", "by_url_status", [url, "archived"]);
  const all = [...active, ...archived];
  const runIds: string[] = [];
  for (const s of all) {
    if (s.data.runRecordId) runIds.push(s.data.runRecordId);
    await db.delete("chat_sessions", s.id);
  }
  return runIds;
}

/**
 * Cascade delete runs rows. Swallows errors — runs growth is harmless.
 */
export async function cascadeDeleteRuns(runIds: string[]): Promise<void> {
  if (runIds.length === 0) return;
  try {
    const db = await getDB();
    for (const id of runIds) {
      const run = await db.get("runs", id);
      if (run?.collection?.resultId) {
        await db.delete("collection_results", run.collection.resultId);
      }
      await db.delete("runs", id);
    }
  } catch (e) {
    console.warn("[persistence] cascadeDeleteRuns failed (non-fatal)", e);
  }
}
