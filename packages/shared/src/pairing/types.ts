/**
 * Shapes shared by the MCP server and the extension for multi-session pairing
 * (Plan 33). Kept free of `chrome.*` and `node:*` so both sides can import them.
 */

/** Payload the server's /pair page posts to the extension. */
export type PairPayload = {
  v: 1;
  installId: string;
  secret: string;
  /** Per-process, regenerated on every start. Display and management only. */
  sessionId: string;
  /** The server's working directory, home collapsed to `~`. Display only. */
  label: string;
  pid: number;
  port: number;
  /** MCP package version. Optional so extensions can still pair with older clients. */
  mcpVersion?: string;
};

/**
 * What the extension persists once an install is approved. Trust is
 * install-level: `sessionId` and `label` take no part in the decision, because
 * anything able to read the identity file could claim any of them.
 */
export type TrustRecord = { installId: string; secret: string; approvedAt: number };

export type ReconnectStatus = "active" | "dormant";

export type ReconnectState = {
  failures: number;
  status: ReconnectStatus;
  delayMs: number;
};

export type ReconnectOutcome = "failure" | "success" | "graceful-close";

/** WS close code the server sends when it is shutting down on purpose. */
export const GRACEFUL_CLOSE_CODE = 4000;
export const GRACEFUL_CLOSE_REASON = "server-shutting-down";

/** Runtime-message types between the content-script relay and the worker. */
export const PAIR_PAGE_SOURCE = "aipagego-pair";
export const PAIR_RESULT_SOURCE = "aipagego-pair-result";
/**
 * Broadcast by the relay as soon as it installs.
 *
 * The pairing page's inline script runs while the document is parsing, but the
 * content script hosting the relay runs at document_idle — so a page that
 * announces itself once is talking to nobody. The relay says hello instead,
 * and the page answers.
 */
export const PAIR_READY_SOURCE = "aipagego-pair-ready";

export type PairingDecision = "trusted" | "ask";
