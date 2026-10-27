import { PROTOCOL_VERSION, type Exec, type Result, type ErrorBody } from "@aipagego/shared/protocol";
import type { Step, Json } from "@aipagego/shared/types";
import { runOneStep } from "./rpc-handlers";
import { parsePermissionRequired } from "@aipagego/shared/optional-permissions";

const MAX_EXEC_STEP_TIMEOUT_MS = 25_000;
const MAX_COLLECTION_EXEC_TIMEOUT_MS = 600_000;

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function makeError(
  code: ErrorBody["code"],
  message: string,
  retryable = false,
  hints?: Record<string, unknown>,
): ErrorBody {
  return { code, message, retryable, ...(hints ? { hints } : {}) };
}

function makeResult(req_id: string, ok: boolean, ret?: Json, error?: ErrorBody): Result {
  return {
    type: "RESULT",
    nonce: randomNonce(),
    ts: Date.now(),
    protocol_version: PROTOCOL_VERSION,
    req_id,
    ok,
    ...(ret !== undefined ? { return: ret } : {}),
    ...(error ? { error } : {})
  };
}

/**
 * Handle a single EXEC message from the coordinator: parse tab id, delegate
 * to runOneStep, and wrap the outcome in a RESULT envelope. Never throws —
 * any error becomes an `ok: false` RESULT.
 *
 * runOneStep's real signature is (step, rpcTabId, attachedTabIds, bindings)
 * → Promise<Json>; it throws Error on failure. We pass empty attachedTabIds
 * (the coordinator is responsible for tab/session bookkeeping in Phase 2+)
 * and empty bindings (the coordinator dispatches one step at a time, no
 * cross-step bindings yet — that's a Phase 3+ concern for saved tools).
 */
export async function handleExec(exec: Exec): Promise<Result> {
  const tabId = Number.parseInt(exec.tab_id, 10);
  if (!Number.isFinite(tabId)) {
    return makeResult(exec.req_id, false, undefined, makeError(
      "InvalidArgs",
      `tab_id "${exec.tab_id}" is not a number`
    ));
  }

  try {
    const collectionStep = exec.step.kind === "tool" && exec.step.tool === "collectStructuredData";
    const maxTimeout = collectionStep ? MAX_COLLECTION_EXEC_TIMEOUT_MS : MAX_EXEC_STEP_TIMEOUT_MS;
    const timeoutMs = Math.min(exec.step.timeoutMs ?? maxTimeout, maxTimeout);
    const value = await withTimeout(
      runOneStep(exec.step as Step, tabId, [], {}, { source: "coordinator" }),
      timeoutMs
    );
    return makeResult(exec.req_id, true, value);
  } catch (err) {
    const required = parsePermissionRequired(err);
    if (required) {
      return makeResult(exec.req_id, false, undefined, makeError(
        "PermissionDenied",
        `${required.permission} permission is required for ${required.capability}`,
        true,
        {
          reason: required.code,
          permission: required.permission,
          capability: required.capability,
        },
      ));
    }
    const message = err instanceof Error ? err.message : String(err);
    return makeResult(exec.req_id, false, undefined, makeError(
      "PageScriptError",
      message,
      false
    ));
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`step timeout after ${timeoutMs}ms`)),
      timeoutMs
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
