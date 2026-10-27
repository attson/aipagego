// packages/shared/src/protocol/chat-event.ts
import { z } from "zod";
import {
  OptionalCapabilityPermissionSchema,
  PermissionCapabilitySchema,
} from "../optional-permissions";

export const ChatSessionStatusSchema = z.enum([
  "idle", "streaming", "awaiting", "running", "done", "error", "aborted"
]);
export type ChatSessionStatus = z.infer<typeof ChatSessionStatusSchema>;

// Mirrors SessionEvent in packages/extension/src/sidepanel/chat/run-session.ts.
// Round-trip test in chat-event.test.ts guards drift.
const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(), z.number(), z.boolean(), z.null(),
    z.array(JsonValue),
    z.record(JsonValue)
  ])
);

const ToolUsePartSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: JsonValue
});

const SessionEndStatus = z.enum(["done", "aborted", "max_rounds", "error"]);

export const ChatSessionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("round_start"), round: z.number().int() }),
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({ type: z.literal("tool_use_start"), id: z.string(), name: z.string() }),
  z.object({ type: z.literal("tool_use_input_delta"), id: z.string(), partial_json: z.string() }),
  z.object({ type: z.literal("tool_use_end"), id: z.string(), input: JsonValue }),
  z.object({ type: z.literal("assistant_turn_end"), toolUses: z.array(ToolUsePartSchema) }),
  z.object({ type: z.literal("tool_running"), id: z.string() }),
  z.object({ type: z.literal("tool_done"), id: z.string(), output: JsonValue, ms: z.number() }),
  z.object({ type: z.literal("tool_error"), id: z.string(), error: z.string(), ms: z.number() }),
  z.object({ type: z.literal("tool_skipped"), id: z.string() }),
  z.object({ type: z.literal("usage"), input_tokens: z.number().int(), output_tokens: z.number().int() }),
  z.object({ type: z.literal("continuation_nudge"), round: z.number().int(), attempt: z.number().int() }),
  z.object({ type: z.literal("stream_error"), error: z.string() }),
  z.object({ type: z.literal("exception"), error: z.string() }),
  z.object({
    type: z.literal("session_end"),
    status: SessionEndStatus,
    lastOutput: JsonValue.nullable(),
    reason: z.string().optional()
  }),
  z.object({
    type: z.literal("self_heal_started"),
    toolId: z.string(),
    toolName: z.string(),
    failedStepIndex: z.number().int().min(0)
  }),
  z.object({
    type: z.literal("self_heal_completed"),
    toolId: z.string(),
    newVersion: z.number().int().min(2),
    fixedStepIndex: z.number().int().min(0)
  }),
  z.object({
    type: z.literal("self_heal_failed"),
    toolId: z.string(),
    reason: z.enum([
      "llm_error", "budget_exceeded", "invalid_output",
      "static_scan_reject", "step_still_fails",
      "no_sidepanel", "no_api_key", "self_heal_disabled"
    ])
  }),
  z.object({
    type: z.literal("permission_required"),
    toolUseId: z.string(),
    permission: OptionalCapabilityPermissionSchema,
    capability: PermissionCapabilitySchema
  }),
  z.object({
    type: z.literal("permission_resolved"),
    toolUseId: z.string(),
    permission: OptionalCapabilityPermissionSchema,
    granted: z.boolean()
  })
]);
export type ChatSessionEvent = z.infer<typeof ChatSessionEventSchema>;
