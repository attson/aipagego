import { matchesAny } from "@aipagego/shared/url-pattern";
import type { WorkerRegistry } from "./worker-registry";

export interface CatalogEntry {
  id: string;
  version: number;
  hash: string;
  url_pattern: string[];
  description?: string;
  provided_by_workers: string[];
  /** True if more than one worker exposes this id with different hashes. */
  conflicting_hashes: boolean;
}

export class Catalog {
  constructor(private registry: WorkerRegistry) {}

  /**
   * Aggregate saved_tools across all workers and return those whose url_pattern
   * matches the given URL. Entries with conflicting hashes are flagged so the
   * UI / AI client can warn before invocation.
   */
  listFor(url: string): CatalogEntry[] {
    const byId = new Map<string, CatalogEntry>();
    for (const w of this.registry.list()) {
      for (const t of w.saved_tools) {
        if (!matchesAny(url, t.url_pattern)) continue;
        const existing = byId.get(t.id);
        if (!existing) {
          byId.set(t.id, {
            id: t.id,
            version: t.version,
            hash: t.hash,
            url_pattern: t.url_pattern,
            description: t.description,
            provided_by_workers: [w.id],
            conflicting_hashes: false
          });
        } else {
          existing.provided_by_workers = [...new Set([...existing.provided_by_workers, w.id])];
          if (existing.hash !== t.hash) existing.conflicting_hashes = true;
        }
      }
    }
    return [...byId.values()];
  }

  lookup(tool_id: string, url: string): CatalogEntry | undefined {
    return this.listFor(url).find((e) => e.id === tool_id);
  }
}
