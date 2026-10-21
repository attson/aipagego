import type { PairPayload } from "@aipagego/shared/pairing";
import { CoordinatorClient, type CoordinatorClientOptions } from "./coordinator-client";

/**
 * Holds one CoordinatorClient per paired MCP session.
 *
 * The extension is the websocket *client* — an MV3 service worker cannot
 * listen on a port — so every server it talks to is a separate outbound
 * connection. Each server sees exactly one worker, which is why the
 * single-worker assumption inside a coordinator still holds.
 */

export type PoolEntryStatus = "connected" | "connecting" | "disconnected" | "dormant";

export type PoolEntry = {
  source: "mcp" | "manual";
  endpoint: string;
  installId: string;
  sessionId: string;
  label: string;
  pid: number;
  port: number;
  status: PoolEntryStatus;
  failures: number;
  mcpVersion?: string;
};

type Managed = PoolEntry & { client: CoordinatorClient };

export type PoolDeps = {
  /** Everything a client needs that is not per-session. */
  clientOptions: (endpoint: string, sessionId: string) => Omit<CoordinatorClientOptions, "ws_url">;
  onChange?: () => void;
};

export function endpointFor(port: number): string {
  return `ws://127.0.0.1:${port}/worker`;
}

export class CoordinatorPool {
  private entries = new Map<string, Managed>();

  constructor(private deps: PoolDeps) {}

  private changed(): void {
    this.deps.onChange?.();
  }

  /**
   * Adds a connection for a freshly paired session. Re-pairing the same
   * session — a refreshed pairing page, say — must not open a second socket.
   */
  async addFromPairing(payload: PairPayload): Promise<void> {
    const existing = this.entries.get(payload.sessionId);
    if (existing) {
      existing.mcpVersion = payload.mcpVersion;
      existing.client.wakeUp();
      this.changed();
      return;
    }
    await this.add({
      source: "mcp",
      endpoint: endpointFor(payload.port),
      installId: payload.installId,
      sessionId: payload.sessionId,
      label: payload.label,
      pid: payload.pid,
      port: payload.port,
      mcpVersion: payload.mcpVersion
    });
  }

  /** Also used for the legacy single-URL config, which becomes one entry. */
  async add(meta: Omit<PoolEntry, "status" | "failures">): Promise<void> {
    if (this.entries.has(meta.sessionId)) return;

    const sharedOptions = this.deps.clientOptions(meta.endpoint, meta.sessionId);
    const client = new CoordinatorClient({
      ...sharedOptions,
      ws_url: meta.endpoint,
      onStatusChange: (status) => {
        sharedOptions.onStatusChange?.(status);
        const e = this.entries.get(meta.sessionId);
        if (!e) return;
        // Dormancy outranks a plain "disconnected": it means nobody is coming
        // back for this endpoint without a deliberate wake.
        if (e.status !== "dormant") e.status = status as PoolEntryStatus;
        e.failures = client.reconnectState.failures;
        this.changed();
      },
      onDormant: () => {
        sharedOptions.onDormant?.();
        const e = this.entries.get(meta.sessionId);
        if (!e) return;
        e.status = "dormant";
        this.changed();
      }
    });

    this.entries.set(meta.sessionId, {
      ...meta,
      status: "connecting",
      failures: 0,
      client
    });
    this.changed();
    await client.connect();
  }

  async remove(sessionId: string): Promise<void> {
    const e = this.entries.get(sessionId);
    if (!e) return;
    this.entries.delete(sessionId);
    await e.client.disconnect();
    this.changed();
  }

  /** Re-arms a dormant endpoint: manual reconnect, re-pairing, browser restart. */
  wake(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.status = "connecting";
    e.failures = 0;
    e.client.wakeUp();
    this.changed();
  }

  wakeAll(): void {
    for (const id of this.entries.keys()) this.wake(id);
  }

  list(): PoolEntry[] {
    return [...this.entries.values()].map(({ client: _client, ...rest }) => rest);
  }

  clientFor(sessionId: string): CoordinatorClient | undefined {
    return this.entries.get(sessionId)?.client;
  }

  get size(): number {
    return this.entries.size;
  }

  async disposeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((e) => e.client.disconnect()));
    this.changed();
  }
}
