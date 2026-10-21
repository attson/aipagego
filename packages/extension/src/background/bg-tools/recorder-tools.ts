import type { Json } from "@aipagego/shared/types";
import type {
  ConsoleLevel,
  DialogPolicy,
  NetworkPart,
  RecorderConfigPatch
} from "@aipagego/shared/recorder";
import { getRecorder } from "../recorder/host";

/**
 * Thin adapters from tool arguments to the backend-agnostic `PageRecorder`.
 * Every result carries `backend` so the caller can tell full-fidelity CDP
 * output from the MAIN-world approximation.
 */

function asObj(raw: Json): Record<string, unknown> {
  return (raw ?? {}) as Record<string, unknown>;
}

export async function consoleMessages(raw: Json, tabId: number): Promise<Json> {
  const a = asObj(raw) as { level?: ConsoleLevel; limit?: number; sinceId?: number };
  const out = await getRecorder(tabId).readConsole({
    level: a.level,
    limit: a.limit ?? 100,
    sinceId: a.sinceId
  });
  return out as unknown as Json;
}

export async function networkRequests(raw: Json, tabId: number): Promise<Json> {
  const a = asObj(raw) as {
    urlPattern?: string;
    method?: string;
    status?: number;
    includeStatic?: boolean;
    limit?: number;
    sinceId?: number;
  };
  const out = await getRecorder(tabId).readNetwork({
    urlPattern: a.urlPattern,
    method: a.method,
    status: a.status,
    includeStatic: a.includeStatic === true,
    limit: a.limit ?? 50,
    sinceId: a.sinceId
  });
  return out as unknown as Json;
}

export async function networkRequestDetail(raw: Json, tabId: number): Promise<Json> {
  const a = asObj(raw) as { id?: number; part?: NetworkPart };
  if (typeof a.id !== "number") throw new Error("networkRequestDetail: id required");
  const out = await getRecorder(tabId).readNetworkDetail({ id: a.id, part: a.part });
  return out as unknown as Json;
}

/**
 * Sets the standing dialog policy and returns what has been recorded so far.
 * On the MAIN-world backend this is necessarily a pre-set policy: `alert`,
 * `confirm`, and `prompt` are synchronous, so a patched implementation cannot
 * await a round trip to the agent. Under CDP the dialog genuinely suspends.
 */
export async function handleDialog(raw: Json, tabId: number): Promise<Json> {
  const a = asObj(raw) as { accept?: boolean; promptText?: string; scope?: "next" | "all" };
  if (typeof a.accept !== "boolean") throw new Error("handleDialog: accept required");
  const policy: DialogPolicy = {
    accept: a.accept,
    promptText: a.promptText,
    scope: a.scope === "all" ? "all" : "next"
  };
  const out = await getRecorder(tabId).setDialogPolicy(policy);
  return { ...out, policy } as unknown as Json;
}

export async function recorderConfig(raw: Json, tabId: number): Promise<Json> {
  const a = asObj(raw) as RecorderConfigPatch;
  const patch: RecorderConfigPatch = {};
  if (typeof a.console === "boolean") patch.console = a.console;
  if (typeof a.network === "boolean") patch.network = a.network;
  if (typeof a.bodies === "boolean") patch.bodies = a.bodies;
  if (typeof a.dialog === "boolean") patch.dialog = a.dialog;
  if (Array.isArray(a.clear)) patch.clear = a.clear;
  const out = await getRecorder(tabId).configure(patch);
  return out as unknown as Json;
}
