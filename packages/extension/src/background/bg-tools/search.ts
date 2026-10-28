import type { Json } from "@aipagego/shared/types";
import { requireOptionalPermission } from "@/permissions/optional-permissions";

function asObj(raw: Json): Record<string, unknown> {
  return (raw ?? {}) as Record<string, unknown>;
}

export async function searchBookmarks(raw: Json): Promise<Json> {
  const { query, limit } = asObj(raw) as { query?: string; limit?: number };
  if (typeof query !== "string" || query.trim() === "") {
    throw new Error("searchBookmarks: query required");
  }
  await requireOptionalPermission("bookmarks", "searchBookmarks");
  if (!chrome.bookmarks?.search) throw new Error("searchBookmarks: bookmarks API unavailable");
  const nodes = await chrome.bookmarks.search(query);
  const cap = typeof limit === "number" && limit > 0 ? limit : 50;
  return nodes
    .filter((n) => !!n.url)
    .slice(0, cap)
    .map((n) => ({ id: n.id, title: n.title, url: n.url! })) as unknown as Json;
}

export async function searchHistory(raw: Json): Promise<Json> {
  const { query, daysBack, limit } = asObj(raw) as {
    query?: string;
    daysBack?: number;
    limit?: number;
  };
  if (typeof query !== "string") throw new Error("searchHistory: query required");
  await requireOptionalPermission("history", "searchHistory");
  if (!chrome.history?.search) throw new Error("searchHistory: history API unavailable");
  const start = Date.now() - (daysBack && daysBack > 0 ? daysBack : 7) * 24 * 60 * 60 * 1000;
  const items = await chrome.history.search({
    text: query,
    startTime: start,
    maxResults: typeof limit === "number" && limit > 0 ? limit : 50
  });
  return items.map((h) => ({
    url: h.url,
    title: h.title,
    lastVisitTime: h.lastVisitTime,
    visitCount: h.visitCount
  })) as unknown as Json;
}
