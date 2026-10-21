import type { ClientToServer, ServerToClient } from "@aipagego/shared/protocol";

/**
 * Transport abstraction. Implementations:
 *   - LoopbackWSHub (Phase 3, daemon's local WS server)
 *   - TlsWSHub (Phase 4, server's TLS WS endpoint)
 *   - FakeWSHub (tests)
 *
 * Coordinator never touches sockets directly — it only uses this interface.
 */
export interface WSHub {
  /** Send a server→client message to a specific worker. Throws on unknown worker_id. */
  send(worker_id: string, msg: ServerToClient): Promise<void>;

  /** Register a handler invoked for each client→server message. */
  onMessage(handler: (worker_id: string, msg: ClientToServer) => void): void;

  /** Register a handler invoked when a worker's WS link drops. */
  onDisconnect(handler: (worker_id: string) => void): void;

  /** Currently connected worker ids. */
  connectedWorkers(): string[];

  /** Force-disconnect a worker (e.g. on protocol-version mismatch). */
  disconnect(worker_id: string, reason: string): Promise<void>;
}
