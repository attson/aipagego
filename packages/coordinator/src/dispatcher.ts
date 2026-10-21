import {
  capabilityForTool,
  capabilityForRunJs,
  scopeCovers,
  DANGEROUS_CAPABILITIES
} from "@aipagego/shared/capability";
import type { Capability } from "@aipagego/shared/capability";
import type { ErrorBody, ErrorCode } from "@aipagego/shared/protocol";
import type { BuiltinTool } from "@aipagego/shared/types";
import type { SessionManager } from "./session-manager";
import { QUOTA_DEFAULTS } from "./types";

export type DispatchInput =
  | {
      session_id: string;
      kind: "extension_tool";
      tool: BuiltinTool;
      httpCookied?: boolean;
      /** drop carrying files is an upload in disguise */
      dropHasFiles?: boolean;
      /** recorderConfig that turns on body capture grants body reads */
      recorderArmsBodies?: boolean;
    }
  | {
      session_id: string;
      kind: "runJS";
      unsafe: boolean;
    }
  | {
      session_id: string;
      /** Tools without a BuiltinTool member, whose capability the caller knows. */
      kind: "capability";
      capability: Capability;
    };

export type DispatchValidation =
  | { ok: true; required_capability: Capability; dangerous: boolean }
  | { ok: false; error: ErrorBody };

export class Dispatcher {
  constructor(private sessions: SessionManager) {}

  validate(input: DispatchInput): DispatchValidation {
    const session = this.sessions.get(input.session_id);
    if (!session) return fail("SessionNotFound", `Session ${input.session_id} not found`);
    if (session.state === "expired")
      return fail("SessionExpired", `Session ${input.session_id} is expired`);
    if (session.state !== "active")
      return fail("InternalError", `Session ${input.session_id} state=${session.state}`);

    const required =
      input.kind === "extension_tool"
        ? capabilityForTool(input.tool, {
            httpCookied: input.httpCookied,
            dropHasFiles: input.dropHasFiles,
            recorderArmsBodies: input.recorderArmsBodies
          })
        : input.kind === "capability"
          ? input.capability
          : capabilityForRunJs(input.unsafe);

    if (!scopeCovers(session.scope, required)) {
      return fail("PermissionDenied", `Capability ${required} not in session scope`, {
        denied_capability: required
      });
    }

    const dangerous = DANGEROUS_CAPABILITIES.has(required);
    if (session.step_count >= QUOTA_DEFAULTS.max_steps_per_session) {
      return fail(
        "SessionExhausted",
        `Session reached max_steps=${QUOTA_DEFAULTS.max_steps_per_session}`
      );
    }
    if (dangerous && session.dangerous_count >= QUOTA_DEFAULTS.max_dangerous_per_session) {
      return fail(
        "DangerousQuotaExceeded",
        `Session exceeded max_dangerous=${QUOTA_DEFAULTS.max_dangerous_per_session}`
      );
    }

    return { ok: true, required_capability: required, dangerous };
  }
}

function fail(
  code: ErrorCode,
  message: string,
  hints?: Record<string, unknown>
): DispatchValidation {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: code === "WorkerBusy" || code === "QueueFull" || code === "InternalError",
      hints
    }
  };
}
