import { z } from "zod";
import { EnvelopeFields } from "./envelope";
import { ErrorBodySchema } from "./errors";
import { ChatSessionEventSchema, ChatSessionStatusSchema } from "./chat-event";

export const ProtocolStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool"),
    tool: z.string(),
    args: z.unknown(),
    timeoutMs: z.number().int().positive().optional()
  }),
  z.object({
    kind: z.literal("js"),
    source: z.string(),
    timeoutMs: z.number().int().positive().optional()
  })
]);

// === C → S messages ===

/**
 * Ownership fields derived per connection (Plan 33). Optional throughout:
 * an extension predating multi-session pairing simply omits them.
 */
const DerivedTabFields = {
  /** true when the receiving connection owns this tab */
  mine: z.boolean().optional(),
  /** true when some *other* connection owns it */
  busy: z.boolean().optional(),
  /** the owning session's label, present only when busy */
  busy_label: z.string().optional()
};

export const HelloSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("HELLO"),
  worker_id: z.string().min(1),
  fingerprint: z.object({
    ext_hash: z.string(),
    os: z.string(),
    chrome: z.string()
  }),
  capabilities: z.array(z.string()),
  /**
   * Tool names this worker can actually execute. Optional for backward
   * compatibility: an extension predating Plan 32 does not send it, and the
   * server then falls back to the legacy 19-tool surface rather than
   * advertising tools that would fail at call time with "unknown tool".
   */
  supported_tools: z.array(z.string()).optional(),
  attended: z.boolean(),
  available_tabs: z.array(
    z.object({
      tab_id: z.string(),
      url: z.string(),
      title: z.string().optional(),
      ...DerivedTabFields
    })
  ),
  saved_tools: z.array(
    z.object({
      id: z.string(),
      version: z.number().int().nonnegative(),
      hash: z.string(),
      url_pattern: z.array(z.string()),
      description: z.string().optional()
    })
  ),
  labels: z.array(z.string())
});

export const PingSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("PING")
});

export const TabReadySchema = z.object({
  ...EnvelopeFields,
  type: z.literal("TAB_READY"),
  session_id: z.string(),
  tab_id: z.string(),
  current_url: z.string()
});

export const ProgressSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("PROGRESS"),
  req_id: z.string(),
  partial: z.unknown()
});

export const ResultSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("RESULT"),
  req_id: z.string(),
  ok: z.boolean(),
  return: z.unknown().optional(),
  error: ErrorBodySchema.optional()
});

export const SessionEventSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("SESSION_EVENT"),
  session_id: z.string(),
  kind: z.enum(["navigated", "tab_closed", "audit"]),
  payload: z.unknown()
});

export const StateSnapshotSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("STATE_SNAPSHOT"),
  last_session_states: z.array(
    z.object({
      session_id: z.string(),
      tab_id: z.string(),
      state: z.string()
    })
  )
});

// === S → C messages ===

export const WelcomeSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("WELCOME"),
  server_time: z.number(),
  heartbeat_interval_ms: z.number().int().positive(),
  server_pubkey_pin: z.string().optional()
});

export const PongSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("PONG"),
  echo_nonce: z.string()
});

export const OpenTabSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("OPEN_TAB"),
  session_id: z.string(),
  url: z.string(),
  reuse_if_match: z.array(z.string()).optional()
});

export const ExecSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("EXEC"),
  req_id: z.string(),
  session_id: z.string(),
  tab_id: z.string(),
  step: ProtocolStepSchema
});

export const CloseSessionSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("CLOSE_SESSION"),
  session_id: z.string()
});

// === Mock LLM stream event (subset re-checked here so messages.ts is self-contained) ===

const LlmStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({ type: z.literal("tool_use_start"), id: z.string(), name: z.string() }),
  z.object({ type: z.literal("tool_use_input_delta"), id: z.string(), partial_json: z.string() }),
  z.object({ type: z.literal("tool_use_end"), id: z.string(), input: z.unknown() }),
  z.object({
    type: z.literal("message_end"),
    usage: z.object({
      input_tokens: z.number().int(),
      output_tokens: z.number().int()
    }).optional(),
    stop_reason: z.string().optional()
  }),
  z.object({ type: z.literal("error"), error: z.string() })
]);

// === New S → C ===

export const StartChatSessionSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("START_CHAT_SESSION"),
  session_id: z.string().min(1),
  user_prompt: z.string(),
  tab_id: z.string().optional(),
  mock_llm: z.object({
    rounds: z.array(z.array(LlmStreamEventSchema))
  }).optional(),
  settings_override: z.object({
    maxRounds: z.number().int().positive().optional(),
    maxContinuationNudges: z.number().int().nonnegative().optional()
  }).optional()
});

export const AbortSessionSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("ABORT_SESSION"),
  session_id: z.string().min(1)
});

export const ReadSidepanelStateSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("READ_SIDEPANEL_STATE"),
  req_id: z.string().min(1),
  tab_id: z.string().min(1)
});

// === New C → S ===

export const ChatEventSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("CHAT_EVENT"),
  session_id: z.string().min(1),
  event: ChatSessionEventSchema
});

export const SidepanelStateReplySchema = z.object({
  ...EnvelopeFields,
  type: z.literal("SIDEPANEL_STATE_REPLY"),
  req_id: z.string().min(1),
  found: z.boolean(),
  snapshot: z.object({
    status: ChatSessionStatusSchema,
    messagesCount: z.number().int().nonnegative(),
    attachedTabs: z.array(z.object({
      tabId: z.number().int(),
      source: z.string(),
      lastSeenUrl: z.string()
    })),
    lastSystemNote: z.string().optional()
  }).optional()
});

// === Discriminated unions ===

export const SessionOpenedSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("SESSION_OPENED"),
  session_id: z.string(),
  tab_id: z.string()
});

export const TabsUpdateSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("TABS_UPDATE"),
  tabs: z.array(
    z.object({
      tab_id: z.string(),
      url: z.string(),
      title: z.string().optional(),
      ...DerivedTabFields
    })
  )
});

export const ClientToServerSchema = z.discriminatedUnion("type", [
  HelloSchema,
  PingSchema,
  TabReadySchema,
  ProgressSchema,
  ResultSchema,
  SessionEventSchema,
  StateSnapshotSchema,
  ChatEventSchema,
  SidepanelStateReplySchema,
  TabsUpdateSchema
]);

export const ServerToClientSchema = z.discriminatedUnion("type", [
  WelcomeSchema,
  PongSchema,
  OpenTabSchema,
  ExecSchema,
  CloseSessionSchema,
  StartChatSessionSchema,
  AbortSessionSchema,
  ReadSidepanelStateSchema,
  SessionOpenedSchema
]);

export const ProtocolMessageSchema = z.union([ClientToServerSchema, ServerToClientSchema]);

export type ClientToServer = z.infer<typeof ClientToServerSchema>;
export type ServerToClient = z.infer<typeof ServerToClientSchema>;
export type ProtocolMessage = z.infer<typeof ProtocolMessageSchema>;

export type Hello = z.infer<typeof HelloSchema>;
export type SessionOpened = z.infer<typeof SessionOpenedSchema>;
export type TabsUpdate = z.infer<typeof TabsUpdateSchema>;
export type Welcome = z.infer<typeof WelcomeSchema>;
export type Exec = z.infer<typeof ExecSchema>;
export type ProtocolStep = z.infer<typeof ProtocolStepSchema>;
export type Result = z.infer<typeof ResultSchema>;
export type Progress = z.infer<typeof ProgressSchema>;

export type StartChatSession = z.infer<typeof StartChatSessionSchema>;
export type AbortSession = z.infer<typeof AbortSessionSchema>;
export type ReadSidepanelState = z.infer<typeof ReadSidepanelStateSchema>;
export type ChatEvent = z.infer<typeof ChatEventSchema>;
export type SidepanelStateReply = z.infer<typeof SidepanelStateReplySchema>;
