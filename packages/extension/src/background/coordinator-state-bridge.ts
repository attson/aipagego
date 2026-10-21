import type { ServerToClient, ClientToServer, ReadSidepanelState } from "@aipagego/shared/protocol";
import { PROTOCOL_VERSION } from "@aipagego/shared/protocol";

interface SnapshotPayload {
  status: string;
  messagesCount: number;
  attachedTabs: Array<{ tabId: number; source: string; lastSeenUrl: string }>;
  lastSystemNote?: string;
}

interface PongMessage {
  type: "pong.sidepanelState";
  req_id: string;
  found: boolean;
  snapshot?: SnapshotPayload;
}

export interface CoordinatorStateBridgeOptions {
  sendRuntimeMessage: (msg: unknown) => void | Promise<unknown>;
  onRuntimeMessage: (fn: (msg: unknown) => void) => void;
  offRuntimeMessage?: (fn: (msg: unknown) => void) => void;
  timeoutMs?: number;
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class CoordinatorStateBridge {
  private pending = new Map<string, (pong: PongMessage) => void>();
  private readonly listener: (msg: unknown) => void;

  constructor(private opts: CoordinatorStateBridgeOptions) {
    this.listener = (msg) => this.maybePong(msg);
    opts.onRuntimeMessage(this.listener);
  }

  dispose(): void {
    this.opts.offRuntimeMessage?.(this.listener);
  }

  async handle(
    msg: ServerToClient,
    send: (m: ClientToServer) => void
  ): Promise<void> {
    if (msg.type !== "READ_SIDEPANEL_STATE") return;
    const reply = await this.request(msg);
    send({
      type: "SIDEPANEL_STATE_REPLY",
      req_id: msg.req_id,
      found: reply.found,
      ...(reply.snapshot ? { snapshot: reply.snapshot as never } : {}),
      nonce: randomNonce(),
      ts: Date.now(),
      protocol_version: PROTOCOL_VERSION
    });
  }

  private request(msg: ReadSidepanelState): Promise<PongMessage> {
    const timeoutMs = this.opts.timeoutMs ?? 500;
    return new Promise<PongMessage>((resolve) => {
      const done = (pong: PongMessage) => {
        this.pending.delete(msg.req_id);
        clearTimeout(timer);
        resolve(pong);
      };
      const timer = setTimeout(() => done({
        type: "pong.sidepanelState",
        req_id: msg.req_id,
        found: false
      }), timeoutMs);
      this.pending.set(msg.req_id, done);
      void this.opts.sendRuntimeMessage({
        type: "ping.sidepanelState",
        req_id: msg.req_id,
        tab_id: msg.tab_id
      });
    });
  }

  private maybePong(raw: unknown): void {
    if (
      typeof raw !== "object" || raw === null ||
      (raw as { type?: unknown }).type !== "pong.sidepanelState"
    ) return;
    const pong = raw as PongMessage;
    const cb = this.pending.get(pong.req_id);
    if (cb) cb(pong);
  }
}
