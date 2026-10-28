import { Catalog, type CatalogEntry } from "./catalog";
import { Dispatcher, type DispatchInput, type DispatchValidation } from "./dispatcher";
import {
  SessionManager,
  type OpenSessionInput
} from "./session-manager";
import { WorkerRegistry } from "./worker-registry";
import type { Clock, IdGen } from "./clock";
import type { WSHub } from "./ws-hub";
import type { Session, Worker, Quota } from "./types";
import { PROTOCOL_VERSION } from "@aipagego/shared/protocol";

export interface CoordinatorDeps {
  hub: WSHub;
  clock: Clock;
  idGen: IdGen;
}

/**
 * Façade over the 4 internal state machines. Public methods are the verbs
 * the MCP server (Phase 3) and REST server (Phase 4) will both call.
 *
 * Coordinator is hub-aware: it sends OPEN_TAB / EXEC / CLOSE_SESSION messages
 * via this.hub.send(...). Reading messages back from workers is the consumer's
 * responsibility: they wire hub.onMessage(...) and call back into the
 * coordinator's handle* methods.
 */
export class Coordinator {
  readonly sessions: SessionManager;
  readonly workers: WorkerRegistry;
  readonly catalog: Catalog;
  readonly dispatcher: Dispatcher;
  readonly hub: WSHub;
  private readonly clock: Clock;
  private readonly idGen: IdGen;

  constructor(deps: CoordinatorDeps) {
    this.hub = deps.hub;
    this.clock = deps.clock;
    this.idGen = deps.idGen;
    this.sessions = new SessionManager(deps.clock, deps.idGen);
    this.workers = new WorkerRegistry(deps.clock);
    this.catalog = new Catalog(this.workers);
    this.dispatcher = new Dispatcher(this.sessions);
  }

  // === Worker lifecycle ===
  registerWorker(w: Worker): void {
    this.workers.register(w);
    this.sessions.resumeByWorker(w.id, new Set(/* will be filled from STATE_SNAPSHOT later */));
  }

  unregisterWorker(id: string): void {
    this.workers.unregister(id);
    this.sessions.pauseByWorker(id);
  }

  heartbeatWorker(id: string): void {
    this.workers.heartbeat(id);
  }

  // === Session lifecycle ===
  openSession(input: OpenSessionInput): Session {
    const session = this.sessions.open(input);
    // The extension cannot see open_session — it is server-local — so without
    // this it would have to infer tab ownership from whichever EXEC happened
    // to arrive first.
    void this.hub
      .send(session.worker_id, {
        type: "SESSION_OPENED",
        nonce: this.idGen.next("nonce"),
        ts: this.clock.now(),
        protocol_version: PROTOCOL_VERSION,
        session_id: session.id,
        tab_id: session.tab_id
      })
      .catch(() => {
        // A worker that vanished between openSession and here is handled by
        // the disconnect path; ownership is advisory either way.
      });
    return session;
  }

  findReusableSession(input: OpenSessionInput): Session | undefined {
    return this.sessions.findReusable(input);
  }

  attachSessionTab(
    sessionId: string,
    workerId: string,
    tabId: string
  ): { session: Session; attached: boolean } {
    const result = this.sessions.attachTab(sessionId, workerId, tabId);
    if (result.attached) this.notifySessionOpened(result.session, tabId);
    return result;
  }

  detachSessionTab(
    sessionId: string,
    workerId: string,
    tabId: string
  ): { session: Session; detached: boolean; closed: boolean } {
    const result = this.sessions.detachTab(sessionId, workerId, tabId);
    if (result.detached && result.closed) this.notifySessionClosed(result.session);
    return result;
  }

  reconcileWorkerTabs(workerId: string, available: ReadonlySet<string>): void {
    const { closed_session_ids } = this.sessions.reconcileWorkerTabs(workerId, available);
    for (const id of closed_session_ids) {
      const session = this.sessions.get(id);
      if (session) this.notifySessionClosed(session);
    }
  }

  closeSession(id: string): void {
    const session = this.sessions.get(id);
    this.sessions.close(id);
    if (session) this.notifySessionClosed(session);
  }

  // === Tool calls ===
  validateCall(input: DispatchInput): DispatchValidation {
    return this.dispatcher.validate(input);
  }

  /** Apply quota side-effects after a successful validation. Call before sending EXEC. */
  recordCall(session_id: string, dangerous: boolean): void {
    this.sessions.touch(session_id, { dangerous });
  }

  // === Catalog & quota ===
  listToolsForSession(session_id: string): CatalogEntry[] | undefined {
    const s = this.sessions.get(session_id);
    if (!s) return undefined;
    const worker = this.workers.get(s.worker_id);
    if (!worker) return [];
    const tabUrl = worker.available_tabs.find((t) => t.tab_id === s.tab_id)?.url ?? "";
    return this.catalog.listFor(tabUrl);
  }

  quotaFor(session_id: string): Quota | undefined {
    return this.sessions.quota(session_id);
  }

  // === Periodic housekeeping ===
  tick(): { expired_sessions: string[] } {
    const expired_sessions = this.sessions.tick();
    for (const id of expired_sessions) {
      const session = this.sessions.get(id);
      if (session) this.notifySessionClosed(session);
    }
    return { expired_sessions };
  }

  private notifySessionClosed(session: Session): void {
    void this.hub
      .send(session.worker_id, {
        type: "CLOSE_SESSION",
        nonce: this.idGen.next("nonce"),
        ts: this.clock.now(),
        protocol_version: PROTOCOL_VERSION,
        session_id: session.id
      })
      .catch(() => {
        // A disconnected worker releases all of its claims on the extension side.
      });
  }

  private notifySessionOpened(session: Session, tabId: string): void {
    void this.hub
      .send(session.worker_id, {
        type: "SESSION_OPENED",
        nonce: this.idGen.next("nonce"),
        ts: this.clock.now(),
        protocol_version: PROTOCOL_VERSION,
        session_id: session.id,
        tab_id: tabId
      })
      .catch(() => {
        // Ownership is advisory; disconnect reconciliation releases it.
      });
  }
}
