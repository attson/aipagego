import type { Capability } from "@aipagego/shared/capability";

/** Internal coordinator types. None of these cross the WS wire — those are in @aipagego/shared/protocol. */

export type SessionState = "active" | "expired" | "paused" | "error" | "closed" | "orphan";

export interface Session {
  id: string;
  ai_client_fingerprint: string;
  worker_id: string;
  tab_id: string;
  scope: ReadonlySet<Capability>;
  state: SessionState;
  created_at: number;
  last_activity_at: number;
  idle_timeout_ms: number;
  /** Number of tool calls (any kind) executed in this session. */
  step_count: number;
  /** Number of dangerous tool calls; capped to prevent runaway. */
  dangerous_count: number;
  /** Filled when state transitions to orphan, used for recovery window. */
  orphaned_at?: number;
  error?: { code: string; message: string };
}

export interface WorkerFingerprint {
  ext_hash: string;
  os: string;
  chrome: string;
}

export interface TabInfo {
  tab_id: string;
  url: string;
  title?: string;
  /** Plan 33 — ownership as seen by the connection this list was built for. */
  mine?: boolean;
  busy?: boolean;
  busy_label?: string;
}

export interface SavedToolMetadata {
  id: string;
  version: number;
  hash: string;
  url_pattern: string[];
  description?: string;
}

export interface Worker {
  id: string;
  fingerprint: WorkerFingerprint;
  /** What the worker can do. Different from session.scope (what current AI is allowed). */
  capabilities: ReadonlySet<Capability>;
  /**
   * Tool names this worker can execute. Undefined for workers predating
   * Plan 32, which is meaningful: the server then advertises only the legacy
   * surface rather than assuming full support.
   */
  supported_tools?: ReadonlySet<string>;
  attended: boolean;
  labels: ReadonlySet<string>;
  available_tabs: TabInfo[];
  saved_tools: SavedToolMetadata[];
  protocol_version: number;
  connected_at: number;
  last_heartbeat_at: number;
}

export interface Quota {
  max_steps: number;
  steps_used: number;
  max_dangerous: number;
  dangerous_used: number;
  /** Milliseconds until the session expires (undefined if no expiry). */
  ms_until_expiry?: number;
}

export const QUOTA_DEFAULTS = {
  max_steps_per_session: 200,
  max_dangerous_per_session: 50
} as const;
