import {
  SESSION_IDLE_TIMEOUT_MS,
  ORPHAN_RECOVERY_MS
} from "@aipagego/shared/protocol";
import type { Capability } from "@aipagego/shared/capability";
import type { Clock, IdGen } from "./clock";
import type { Session, SessionState } from "./types";
import { QUOTA_DEFAULTS } from "./types";

export interface OpenSessionInput {
  ai_client_fingerprint: string;
  worker_id: string;
  tab_id: string;
  scope: ReadonlySet<Capability>;
  idle_timeout_ms?: number;
  auto_reusable?: boolean;
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(
    private clock: Clock,
    private idGen: IdGen
  ) {}

  open(input: OpenSessionInput): Session {
    const id = this.idGen.next("session");
    const now = this.clock.now();
    const s: Session = {
      id,
      ai_client_fingerprint: input.ai_client_fingerprint,
      worker_id: input.worker_id,
      tab_id: input.tab_id,
      tab_ids: [input.tab_id],
      auto_reusable: input.auto_reusable ?? true,
      scope: input.scope,
      state: "active",
      created_at: now,
      last_activity_at: now,
      idle_timeout_ms: input.idle_timeout_ms ?? SESSION_IDLE_TIMEOUT_MS,
      step_count: 0,
      dangerous_count: 0
    };
    this.sessions.set(id, s);
    return s;
  }

  findReusable(input: OpenSessionInput): Session | undefined {
    const matches = [...this.sessions.values()].filter((session) =>
      session.state === "active" &&
      session.auto_reusable &&
      session.ai_client_fingerprint === input.ai_client_fingerprint &&
      session.worker_id === input.worker_id &&
      session.tab_ids.includes(input.tab_id) &&
      session.idle_timeout_ms === (input.idle_timeout_ms ?? SESSION_IDLE_TIMEOUT_MS) &&
      sameSet(session.scope, input.scope)
    );
    return matches.sort((a, b) =>
      b.last_activity_at - a.last_activity_at || b.created_at - a.created_at
    )[0];
  }

  attachTab(id: string, worker_id: string, tab_id: string): { session: Session; attached: boolean } {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    if (session.state !== "active") throw new Error(`Session ${id} not active (state=${session.state})`);
    if (session.worker_id !== worker_id) {
      throw new Error(`Session ${id} belongs to worker ${session.worker_id}, not worker ${worker_id}`);
    }
    if (session.tab_ids.includes(tab_id)) return { session, attached: false };
    const next = { ...session, tab_ids: [...session.tab_ids, tab_id] };
    this.sessions.set(id, next);
    return { session: next, attached: true };
  }

  detachTab(
    id: string,
    worker_id: string,
    tab_id: string
  ): { session: Session; detached: boolean; closed: boolean } {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    if (session.worker_id !== worker_id) {
      throw new Error(`Session ${id} belongs to worker ${session.worker_id}, not worker ${worker_id}`);
    }
    if (!session.tab_ids.includes(tab_id)) {
      return { session, detached: false, closed: session.state === "closed" };
    }
    if (session.state !== "active") {
      throw new Error(`Session ${id} not active (state=${session.state})`);
    }

    const tab_ids = session.tab_ids.filter((candidate) => candidate !== tab_id);
    const closed = tab_ids.length === 0;
    const next: Session = {
      ...session,
      ...(closed ? {} : { tab_id: tab_ids[0] }),
      tab_ids,
      state: closed ? "closed" : "active"
    };
    this.sessions.set(id, next);
    return { session: next, detached: true, closed };
  }

  reconcileWorkerTabs(
    worker_id: string,
    available: ReadonlySet<string>
  ): { closed_session_ids: string[] } {
    const closed_session_ids: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.worker_id !== worker_id || session.state !== "active") continue;
      const tab_ids = session.tab_ids.filter((tabId) => available.has(tabId));
      if (tab_ids.length === session.tab_ids.length) continue;
      if (tab_ids.length === 0) {
        this.sessions.set(session.id, { ...session, state: "closed", tab_ids: [] });
        closed_session_ids.push(session.id);
        continue;
      }
      this.sessions.set(session.id, { ...session, tab_id: tab_ids[0], tab_ids });
    }
    return { closed_session_ids };
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /** Record activity on a session, increment counters. Throws if not active. */
  touch(id: string, opts: { dangerous: boolean }): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session ${id} not found`);
    if (s.state !== "active") throw new Error(`Session ${id} not active (state=${s.state})`);
    const next: Session = {
      ...s,
      last_activity_at: this.clock.now(),
      step_count: s.step_count + 1,
      dangerous_count: s.dangerous_count + (opts.dangerous ? 1 : 0)
    };
    this.sessions.set(id, next);
  }

  close(id: string): void {
    this.transition(id, "closed");
  }

  fail(id: string, code: string, message: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.set(id, { ...s, state: "error", error: { code, message } });
  }

  /** Mark all sessions belonging to a worker as paused (worker dropped). */
  pauseByWorker(worker_id: string): string[] {
    const ids: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.worker_id === worker_id && s.state === "active") {
        this.sessions.set(s.id, { ...s, state: "paused" });
        ids.push(s.id);
      }
    }
    return ids;
  }

  /**
   * When a worker reconnects, resume sessions present in last_session_states;
   * any paused sessions NOT in the snapshot become error (worker lost them).
   */
  resumeByWorker(worker_id: string, restoredIds: Set<string>): void {
    for (const s of this.sessions.values()) {
      if (s.worker_id !== worker_id || s.state !== "paused") continue;
      if (restoredIds.has(s.id)) {
        this.sessions.set(s.id, { ...s, state: "active", last_activity_at: this.clock.now() });
      } else {
        this.sessions.set(s.id, {
          ...s,
          state: "error",
          error: { code: "WorkerDisconnected", message: "Lost during worker disconnect" }
        });
      }
    }
  }

  /** Orphan all sessions whose AI client just disconnected. */
  orphan(ai_client_fingerprint: string): string[] {
    const ids: string[] = [];
    const now = this.clock.now();
    for (const s of this.sessions.values()) {
      if (s.ai_client_fingerprint === ai_client_fingerprint && s.state === "active") {
        this.sessions.set(s.id, { ...s, state: "orphan", orphaned_at: now });
        ids.push(s.id);
      }
    }
    return ids;
  }

  /** Re-claim orphaned sessions when same AI client reconnects within window. */
  recover(ai_client_fingerprint: string): string[] {
    const ids: string[] = [];
    const now = this.clock.now();
    for (const s of this.sessions.values()) {
      if (s.state !== "orphan" || s.ai_client_fingerprint !== ai_client_fingerprint) continue;
      if (s.orphaned_at !== undefined && now - s.orphaned_at <= ORPHAN_RECOVERY_MS) {
        this.sessions.set(s.id, {
          ...s,
          state: "active",
          last_activity_at: now,
          orphaned_at: undefined
        });
        ids.push(s.id);
      }
    }
    return ids;
  }

  /**
   * Periodic housekeeping. Returns ids whose state changed.
   *   - active too long idle → expired
   *   - orphan past ORPHAN_RECOVERY_MS → closed
   */
  tick(): string[] {
    const now = this.clock.now();
    const changed: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.state === "active" && now - s.last_activity_at >= s.idle_timeout_ms) {
        this.sessions.set(s.id, { ...s, state: "expired" });
        changed.push(s.id);
      } else if (
        s.state === "orphan" &&
        s.orphaned_at !== undefined &&
        now - s.orphaned_at > ORPHAN_RECOVERY_MS
      ) {
        this.sessions.set(s.id, { ...s, state: "closed" });
        changed.push(s.id);
      }
    }
    return changed;
  }

  /** Quota snapshot for get_quota MCP tool. */
  quota(id: string) {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    const now = this.clock.now();
    const ms_until_expiry = Math.max(0, s.idle_timeout_ms - (now - s.last_activity_at));
    return {
      max_steps: QUOTA_DEFAULTS.max_steps_per_session,
      steps_used: s.step_count,
      max_dangerous: QUOTA_DEFAULTS.max_dangerous_per_session,
      dangerous_used: s.dangerous_count,
      ms_until_expiry
    };
  }

  private transition(id: string, target: SessionState): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.set(id, { ...s, state: target });
  }
}

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
