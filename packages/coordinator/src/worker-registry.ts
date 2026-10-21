import { matchesAny } from "@aipagego/shared/url-pattern";
import type { Clock } from "./clock";
import type { Worker } from "./types";

export class WorkerRegistry {
  private workers = new Map<string, Worker>();

  constructor(private clock: Clock) {}

  register(w: Worker): void {
    if (this.workers.has(w.id)) {
      throw new Error(`Worker ${w.id} already registered`);
    }
    this.workers.set(w.id, { ...w, connected_at: this.clock.now() });
  }

  unregister(id: string): void {
    this.workers.delete(id);
  }

  get(id: string): Worker | undefined {
    return this.workers.get(id);
  }

  list(): Worker[] {
    return [...this.workers.values()];
  }

  heartbeat(id: string): void {
    const w = this.workers.get(id);
    if (!w) return;
    this.workers.set(id, { ...w, last_heartbeat_at: this.clock.now() });
  }

  /**
   * Pick workers whose saved_tools have any url_pattern matching the given URL.
   * When labels are provided, workers carrying any matching label sort first.
   */
  pickForUrl(url: string, preferLabels: string[] = []): Worker[] {
    const all = this.list();
    const matching = all.filter((w) =>
      w.saved_tools.some((t) => matchesAny(url, t.url_pattern))
    );
    if (preferLabels.length === 0) return matching;
    return matching.sort((a, b) => labelScore(b, preferLabels) - labelScore(a, preferLabels));
  }
}

function labelScore(w: Worker, prefer: string[]): number {
  let score = 0;
  for (const l of prefer) if (w.labels.has(l)) score += 1;
  return score;
}
