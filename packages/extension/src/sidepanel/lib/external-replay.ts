import type { Step } from "@aipagego/shared/types";

export const PENDING_REPLAY_KEY = "aipagego.pending_replay";
export const PENDING_REPLAY_TTL_MS = 30_000;

export type ReplayPayload = {
  /** Required user-facing prompt — what the external site wants the AI to do. */
  prompt: string;
  /** Optional precomputed Tool steps draft. When provided, the review modal
   *  routes to the DEV-JSON runner instead of plain chat. */
  steps?: Step[];
  /** Optional title for the review modal header. */
  title?: string;
};

export type PendingReplay = ReplayPayload & {
  sourceUrl: string;
  ts: number;
};

/**
 * Validates a postMessage payload coming from an external page. Returns null
 * for anything that doesn't conform (missing prompt, wrong shape, etc.).
 */
export function parseReplayPayload(raw: unknown, sourceUrl: string): PendingReplay | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.prompt !== "string" || obj.prompt.trim() === "") return null;
  const out: PendingReplay = {
    prompt: obj.prompt,
    sourceUrl,
    ts: Date.now(),
  };
  if (typeof obj.title === "string") out.title = obj.title;
  if (Array.isArray(obj.steps)) {
    // We don't validate against StepSchema here — the review modal renders
    // the raw JSON for user inspection and the DEV runner will parse later.
    out.steps = obj.steps as Step[];
  }
  return out;
}
