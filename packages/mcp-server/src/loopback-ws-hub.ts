import { WebSocketServer, WebSocket } from "ws";
import {
  createServer,
  type Server as HttpServer,
  type ServerResponse
} from "node:http";
import {
  GRACEFUL_CLOSE_CODE,
  GRACEFUL_CLOSE_REASON,
  type PairPayload
} from "@aipagego/shared/pairing";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ClientToServerSchema,
  ServerToClientSchema,
  PROTOCOL_VERSION,
  type ClientToServer,
  type ServerToClient,
  type Result,
  type Exec,
} from "@aipagego/shared/protocol";
import type { WSHub, Clock, IdGen } from "@aipagego/coordinator";
import { renderPairPage } from "./pair-page";

const HEARTBEAT_INTERVAL_MS = 20000;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 15000;

export interface LoopbackWSHubOpts {
  port: number;
  token?: string;
  clock: Clock;
  idGen: IdGen;
  execTimeoutMs?: number;
  // How often the hub pushes a server-initiated PONG to each connected worker.
  // MV3 service workers idle out in ~30s; receiving a WS message resets the
  // timer, so a sub-30s tick keeps the SW alive without the extension having
  // to fight Chrome's alarm clamp. Set to 0 to disable.
  keepaliveIntervalMs?: number;
  /**
   * Supplies the payload served at GET /pair. Omitted in tests that only
   * exercise the websocket surface.
   */
  pairPayload?: () => PairPayload;
  /** A matched denial can cancel a pending worker wait, but can never approve it. */
  onPairingDenied?: () => void;
  /** Lets the owner release pending lifecycle waits when the hub stops. */
  onClosed?: () => void;
}

type Pending = {
  resolve: (r: Result) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  worker_id: string;
};

export class LoopbackWSHub implements WSHub {
  private http: HttpServer;
  private wss: WebSocketServer;
  /** Settled by the constructor so ready() cannot race the listen outcome. */
  private readyPromise: Promise<number>;
  private byWorker = new Map<string, WebSocket>();
  private workerOf = new Map<WebSocket, string>();
  private pending = new Map<string, Pending>();
  private msgHandlers: Array<(worker_id: string, msg: ClientToServer) => void> = [];
  private disconnectHandlers: Array<(worker_id: string) => void> = [];
  private execTimeoutMs: number;
  private keepaliveIntervalMs: number;
  private keepaliveTimers = new Map<WebSocket, ReturnType<typeof setInterval>>();
  private closedNotified = false;

  constructor(private opts: LoopbackWSHubOpts) {
    this.execTimeoutMs = opts.execTimeoutMs ?? 30000;
    this.keepaliveIntervalMs = opts.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    // An explicit http server rather than letting `ws` create one: the pairing
    // page has to be served from the same port the websocket listens on, since
    // that port is exactly what the page exists to communicate.
    this.http = createServer((req, res) => this.onHttpRequest(req, res));
    // Listeners are attached before listen() and the outcome is captured in a
    // promise, because an EADDRINUSE fires before any later ready() call could
    // subscribe. Previously it surfaced as an unhandled 'error' event that
    // killed the process, reaching the caller as a bare "Connection closed".
    this.readyPromise = new Promise<number>((resolve, reject) => {
      this.http.once("listening", () => resolve((this.http.address() as AddressInfo).port));
      this.http.once("error", (err: NodeJS.ErrnoException) => {
        reject(
          err.code === "EADDRINUSE"
            ? new Error(
                `port ${opts.port} is already in use — another aipagego-mcp may be running; ` +
                  `set AIPAGEGO_WS_PORT to choose another port`
              )
            : err
        );
      });
    });
    this.wss = new WebSocketServer({
      server: this.http,
      path: "/worker",
      handleProtocols: (protocols: Set<string>) => [...protocols][0] ?? false,
    });
    this.wss.on("connection", (socket, req) => this.onConnection(socket, req));
    // Permanent sinks: the `once` handlers above settle readyPromise, but a
    // failed listen re-emits through both servers afterwards, and an 'error'
    // with no listener is a process-level crash.
    this.http.on("error", () => undefined);
    this.wss.on("error", () => undefined);
    this.http.listen(opts.port);
  }

  ready(): Promise<number> {
    return this.readyPromise;
  }

  /** Serves the pairing page; everything else is a 404. */
  private onHttpRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): void {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/pair/decision" && req.method === "POST") {
      void this.onPairDecision(req, res);
      return;
    }
    if (path !== "/pair") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const payload = this.opts.pairPayload?.();
    if (!payload) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("pairing unavailable");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(renderPairPage(payload));
  }

  private async onPairDecision(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 4096) throw new Error("pairing decision too large");
      }
      const decision = JSON.parse(body) as Record<string, unknown>;
      const payload = this.opts.pairPayload?.();
      const matches =
        payload &&
        decision.v === 1 &&
        decision.decision === "denied" &&
        decision.sessionId === payload.sessionId &&
        decision.installId === payload.installId &&
        decision.secret === payload.secret;
      if (!matches) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("pairing decision rejected");
        return;
      }
      this.opts.onPairingDenied?.();
      res.writeHead(204);
      res.end();
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("invalid pairing decision");
    }
  }

  /**
   * Tells connected extensions this shutdown is deliberate, so they drop the
   * endpoint instead of retrying it for the rest of the browser session.
   */
  async shutdown(): Promise<void> {
    for (const socket of this.wss.clients) {
      try {
        socket.close(GRACEFUL_CLOSE_CODE, GRACEFUL_CLOSE_REASON);
      } catch {
        // Already closing.
      }
    }
    await new Promise((r) => setTimeout(r, 50));
    await this.close();
  }

  close(): Promise<void> {
    if (!this.closedNotified) {
      this.closedNotified = true;
      try {
        this.opts.onClosed?.();
      } catch {
        // Lifecycle observers must not prevent socket cleanup.
      }
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("hub closing"));
    }
    this.pending.clear();
    for (const timer of this.keepaliveTimers.values()) clearInterval(timer);
    this.keepaliveTimers.clear();
    // Terminate all open client sockets so wss.close() resolves promptly.
    for (const socket of this.wss.clients) {
      socket.terminate();
    }
    return new Promise((resolve) =>
      this.wss.close(() => this.http.close(() => resolve()))
    );
  }

  private tokenOk(req: IncomingMessage): boolean {
    if (!this.opts.token) return true;
    const offered = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((s) => s.trim());
    return offered.includes(`bearer.${this.opts.token}`);
  }

  private onConnection(socket: WebSocket, req: IncomingMessage): void {
    if (!this.tokenOk(req)) {
      socket.close(4401, "bad token");
      return;
    }
    socket.on("message", (raw) => this.onMessageRaw(socket, raw.toString()));
    socket.on("close", () => this.onSocketClose(socket));
    socket.on("error", () => {
      /* close event handles cleanup */
    });
  }

  private onMessageRaw(socket: WebSocket, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const r = ClientToServerSchema.safeParse(parsed);
    if (!r.success) return;
    const msg = r.data;

    if (msg.type === "HELLO") {
      // I2: If an existing (different) socket is already registered for this worker_id,
      // detach it silently before registering the new one — this is a reconnect, not a
      // disconnect.  We remove the old socket from workerOf FIRST so that when its
      // close event fires later, onSocketClose sees no worker_id for it and no-ops,
      // preventing a spurious disconnect callback.
      const existingSocket = this.byWorker.get(msg.worker_id);
      if (existingSocket && existingSocket !== socket) {
        this.workerOf.delete(existingSocket);
        // Reject in-flight execs for this worker — the old socket is gone and the
        // new worker won't know those req_ids, so they would stall until timeout.
        for (const [req_id, p] of [...this.pending]) {
          if (p.worker_id === msg.worker_id) {
            clearTimeout(p.timer);
            this.pending.delete(req_id);
            p.reject(new Error(`worker ${msg.worker_id} reconnected, exec cancelled`));
          }
        }
        existingSocket.terminate();
      }
      this.byWorker.set(msg.worker_id, socket);
      this.workerOf.set(socket, msg.worker_id);
      this.rawSend(socket, {
        type: "WELCOME",
        nonce: this.opts.idGen.next("nonce"),
        ts: this.opts.clock.now(),
        protocol_version: PROTOCOL_VERSION,
        server_time: this.opts.clock.now(),
        heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
      });
      this.startKeepalive(socket);
      for (const h of this.msgHandlers) h(msg.worker_id, msg);
      return;
    }

    if (msg.type === "RESULT") {
      const p = this.pending.get(msg.req_id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.req_id);
        p.resolve(msg);
      }
      return;
    }

    if (msg.type === "PING") {
      this.rawSend(socket, {
        type: "PONG",
        nonce: this.opts.idGen.next("nonce"),
        ts: this.opts.clock.now(),
        protocol_version: PROTOCOL_VERSION,
        echo_nonce: msg.nonce,
      });
    }

    const wid = this.workerOf.get(socket);
    if (wid) {
      for (const h of this.msgHandlers) h(wid, msg);
    }
  }

  private onSocketClose(socket: WebSocket): void {
    this.stopKeepalive(socket);
    const wid = this.workerOf.get(socket);
    if (!wid) return;
    this.workerOf.delete(socket);
    this.byWorker.delete(wid);
    for (const [req_id, p] of [...this.pending]) {
      if (p.worker_id === wid) {
        clearTimeout(p.timer);
        this.pending.delete(req_id);
        p.reject(new Error(`worker ${wid} disconnected`));
      }
    }
    for (const h of this.disconnectHandlers) h(wid);
  }

  private startKeepalive(socket: WebSocket): void {
    if (this.keepaliveIntervalMs <= 0) return;
    if (this.keepaliveTimers.has(socket)) return;
    const timer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      this.rawSend(socket, {
        type: "PONG",
        nonce: this.opts.idGen.next("nonce"),
        ts: this.opts.clock.now(),
        protocol_version: PROTOCOL_VERSION,
        echo_nonce: "server-keepalive"
      });
    }, this.keepaliveIntervalMs);
    // Don't let the heartbeat block process exit.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this.keepaliveTimers.set(socket, timer);
  }

  private stopKeepalive(socket: WebSocket): void {
    const timer = this.keepaliveTimers.get(socket);
    if (!timer) return;
    clearInterval(timer);
    this.keepaliveTimers.delete(socket);
  }

  private rawSend(socket: WebSocket, msg: ServerToClient): void {
    const r = ServerToClientSchema.safeParse(msg);
    if (!r.success) {
      console.error("[hub] outgoing failed schema", r.error);
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  exec(
    worker_id: string,
    params: {
      session_id: string;
      tab_id: string;
      step: Exec["step"];
    }
  ): Promise<Result> {
    const socket = this.byWorker.get(worker_id);
    if (!socket)
      return Promise.reject(new Error(`worker ${worker_id} not connected`));
    const req_id = this.opts.idGen.next("req");
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(
          new Error(`EXEC ${req_id} timeout after ${this.execTimeoutMs}ms`)
        );
      }, this.execTimeoutMs);
      this.pending.set(req_id, { resolve, reject, timer, worker_id });
      this.rawSend(socket, {
        type: "EXEC",
        nonce: this.opts.idGen.next("nonce"),
        ts: this.opts.clock.now(),
        protocol_version: PROTOCOL_VERSION,
        req_id,
        session_id: params.session_id,
        tab_id: params.tab_id,
        step: params.step,
      });
      // I1: TOCTOU guard — the socket may have closed during rawSend (and onSocketClose
      // may have already run).  If the socket is no longer the current one for this
      // worker, the close event won't clean up this pending entry (onSocketClose already
      // ran or will run for a different socket).  Reject immediately so the promise
      // doesn't hang until timeout.
      if (this.byWorker.get(worker_id) !== socket) {
        clearTimeout(timer);
        this.pending.delete(req_id);
        reject(new Error(`worker ${worker_id} disconnected`));
      }
    });
  }

  async send(worker_id: string, msg: ServerToClient): Promise<void> {
    const socket = this.byWorker.get(worker_id);
    if (!socket) throw new Error(`worker ${worker_id} not connected`);
    this.rawSend(socket, msg);
  }

  onMessage(
    handler: (worker_id: string, msg: ClientToServer) => void
  ): void {
    this.msgHandlers.push(handler);
  }

  onDisconnect(handler: (worker_id: string) => void): void {
    this.disconnectHandlers.push(handler);
  }

  connectedWorkers(): string[] {
    return [...this.byWorker.keys()];
  }

  // Intentionally fire-and-forget: actual cleanup (byWorker/workerOf removal and
  // pending-exec rejection) happens asynchronously via the socket's close event.
  // v1 callers do not await this method.
  async disconnect(worker_id: string, _reason: string): Promise<void> {
    const socket = this.byWorker.get(worker_id);
    if (socket) socket.close();
  }
}
