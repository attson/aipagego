# Remote-testable Chat Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose `runChatSession()` and a read-only sidepanel state probe over the existing WS coordinator protocol so that the continuation-guard loop and the cross-tab-events handler can be exercised end-to-end from a remote test harness — without browser automation, an LLM API key, or sidepanel interaction.

**Architecture:** Background-only coordinator-driven chat sessions reuse the pure `runChatSession()` function but with injected mock LLM, background tool runner, auto-approver, and a "source: coordinator" rpc. A one-shot `READ_SIDEPANEL_STATE` request bridges background → sidepanel for state assertions. Opt-in flag in `chrome.storage.local` gates `START_CHAT_SESSION` only — existing EXEC behavior is unchanged.

**Tech Stack:** TypeScript, zod (protocol schemas), vitest 2 + happy-dom (tests), `ws` package (E2E WS server), Chrome extension MV3 APIs (`chrome.runtime.sendMessage`, `chrome.storage.local`), existing React 18 sidepanel.

---

## File structure overview (end state)

```
packages/shared/src/
├─ llm/
│  ├─ types.ts                       ← NEW (moved from extension/src/sidepanel/llm/types.ts)
│  └─ index.ts                       ← NEW (barrel)
├─ protocol/
│  ├─ chat-event.ts                  ← NEW (zod ChatSessionEvent / ChatSessionStatus)
│  ├─ messages.ts                    ← MOD (+5 schemas, +unions)
│  └─ index.ts                       ← MOD (export new types)
└─ types.ts                          ← MOD (add `source` to RunRecord)

packages/extension/src/
├─ background/
│  ├─ mock-llm-client.ts             ← NEW
│  ├─ bg-tool-runner.ts              ← NEW
│  ├─ coordinator-chat.ts            ← NEW (CoordinatorChatHost)
│  ├─ coordinator-state-bridge.ts    ← NEW (BG side of READ_SIDEPANEL_STATE)
│  ├─ coordinator-state.ts           ← MOD (allow_remote_chat accessors)
│  ├─ coordinator-client.ts          ← MOD (route 3 new server messages)
│  ├─ storage/runs.ts                ← MOD (accept source on create)
│  ├─ rpc-handlers.ts                ← MOD (pass source through createRun)
│  └─ index.ts                       ← MOD (wire host + bridge)
├─ sidepanel/
│  ├─ coordinator-state-bridge.ts    ← NEW (ping/pong listener)
│  ├─ app.tsx                        ← MOD (mount bridge once)
│  ├─ llm/types.ts                   ← MOD (re-export from shared, no behavior change)
│  └─ pages/coordinator-settings-page.tsx  ← MOD (allow-remote-chat checkbox)
└─ tests/
   ├─ shared (via test of moved types) covered by existing
   ├─ background/
   │  ├─ mock-llm-client.test.ts             ← NEW
   │  ├─ bg-tool-runner.test.ts              ← NEW
   │  ├─ coordinator-chat-host.test.ts       ← NEW
   │  ├─ coordinator-state-bridge.test.ts    ← NEW
   │  └─ coordinator-e2e.test.ts             ← MOD (4 new cases)
   ├─ sidepanel/
   │  └─ coordinator-state-bridge.test.ts    ← NEW
   └─ shared/protocol/
      ├─ chat-event.test.ts                  ← NEW
      ├─ start-chat-session.test.ts          ← NEW
      ├─ abort-session.test.ts               ← NEW
      ├─ read-sidepanel-state.test.ts        ← NEW
      └─ chat-event-wire.test.ts             ← NEW

docs/superpowers/scripts/
└─ mini-coordinator.mjs               ← NEW (Layer 5 smoke helper)
```

**Key boundaries:** the user-facing sidepanel chat path (`packages/extension/src/sidepanel/chat/*`) is **untouched**. The only new sidepanel runtime behavior is the state-bridge listener.

---

## Task 1: Move LLM client types to `packages/shared`

**Why:** Background needs `LlmClient` / `LlmStreamEvent` / `LlmTool` to build `MockLlmClient` and accept mock rounds inside `START_CHAT_SESSION`. Currently they live in the extension package; `packages/coordinator` and `packages/shared` would need a peer dep on extension if we kept them there. Move once, re-export to keep all existing imports working.

**Files:**
- Create: `packages/shared/src/llm/types.ts`
- Create: `packages/shared/src/llm/index.ts`
- Modify: `packages/shared/src/index.ts` (if it has a barrel; add `export * from "./llm"`)
- Modify: `packages/extension/src/sidepanel/llm/types.ts` (replace contents with re-exports)

- [ ] **Step 1: Create the new shared file with the exact contents currently in extension**

```ts
// packages/shared/src/llm/types.ts
import type { ChatMessage, Json, JsonSchema } from "../types";

export type LlmTool = {
  name: string;
  description: string;
  input_schema: JsonSchema;
};

export type LlmStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; partial_json: string }
  | { type: "tool_use_end"; id: string; input: Json }
  | { type: "message_end"; usage?: { input_tokens: number; output_tokens: number }; stop_reason?: string }
  | { type: "error"; error: string };

export interface LlmClient {
  stream(input: {
    apiKey: string;
    model: string;
    system: string;
    messages: ChatMessage[];
    tools: LlmTool[];
    maxTokens?: number;
    abortSignal?: AbortSignal;
    endpoint?: string;
  }): AsyncIterable<LlmStreamEvent>;
}
```

- [ ] **Step 2: Create barrel**

```ts
// packages/shared/src/llm/index.ts
export * from "./types";
```

- [ ] **Step 3: Verify the shared package builds**

Run: `pnpm --filter @aipagego/shared typecheck`
Expected: PASS

- [ ] **Step 4: Replace extension's `llm/types.ts` with re-exports for backward compat**

```ts
// packages/extension/src/sidepanel/llm/types.ts
export type { LlmTool, LlmStreamEvent, LlmClient } from "@aipagego/shared/llm";
```

- [ ] **Step 5: Confirm extension typecheck still passes**

Run: `pnpm --filter @aipagego/extension typecheck`
Expected: PASS — every existing import of `@/sidepanel/llm/types` resolves transparently via the re-export.

- [ ] **Step 6: Run the full test suite**

Run: `pnpm -r test`
Expected: PASS (315/315 — same as baseline)

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/llm packages/extension/src/sidepanel/llm/types.ts
git commit -m "refactor(shared): move LlmClient + LlmStreamEvent types to shared package

Background needs these types to build MockLlmClient; moving them to shared
keeps coordinator-chat dependency direction one-way (extension/background →
shared). The extension's sidepanel/llm/types.ts now re-exports for back-compat
so no other files need to change."
```

---

## Task 2: Add `source` field to `RunRecord`

**Why:** Coordinator-driven sessions share persistence with user sessions but must be tag-distinguishable. The field defaults to `"user"` so existing reads of pre-fix records continue to work.

**Files:**
- Modify: `packages/shared/src/types.ts:114-126`
- Modify: `packages/extension/src/background/storage/runs.ts`
- Test: `packages/extension/tests/background/storage/runs.test.ts` (existing file)

- [ ] **Step 1: Add the failing test**

Append to `packages/extension/tests/background/storage/runs.test.ts`:

```ts
it("createRun defaults source to user when omitted", async () => {
  const run = await createRun({ toolId: null, toolVersion: null, url: "u" });
  expect(run.source).toBe("user");
});

it("createRun preserves source when given", async () => {
  const run = await createRun({ toolId: null, toolVersion: null, url: "u", source: "coordinator" });
  expect(run.source).toBe("coordinator");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aipagego/extension test -- --run runs.test`
Expected: FAIL on `source` property — undefined / missing.

- [ ] **Step 3: Extend the type in shared**

In `packages/shared/src/types.ts`, replace the `RunRecord` type:

```ts
export type RunSource = "user" | "coordinator";

export type RunRecord = {
  id: string;
  toolId: string | null;
  toolVersion: number | null;
  url: string;
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  stepLog: RunStepLogEntry[];
  output?: Json;
  source: RunSource;   // NEW; required on new records, defaulted on read
};
```

- [ ] **Step 4: Update createRun to accept + default the field**

Replace `createRun` in `packages/extension/src/background/storage/runs.ts`:

```ts
export async function createRun(input: {
  toolId: string | null;
  toolVersion: number | null;
  url: string;
  source?: RunSource;
}): Promise<RunRecord> {
  const db = await getDB();
  const run: RunRecord = {
    id: crypto.randomUUID(),
    toolId: input.toolId,
    toolVersion: input.toolVersion,
    url: input.url,
    startedAt: Date.now(),
    status: "running",
    stepLog: [],
    source: input.source ?? "user"
  };
  await db.put("runs", run);
  return run;
}
```

Add `RunSource` to the imports at the top of the file:

```ts
import type { Json, RunRecord, RunSource, RunStepLogEntry, RunStatus } from "@aipagego/shared/types";
```

- [ ] **Step 5: Backfill read path so old records without `source` parse as "user"**

In the same file, update `getRun` and `listRuns` to coerce:

```ts
function withSourceDefault(r: RunRecord | undefined): RunRecord | undefined {
  if (!r) return r;
  return r.source ? r : { ...r, source: "user" };
}

export async function getRun(id: string): Promise<RunRecord | undefined> {
  const db = await getDB();
  return withSourceDefault(await db.get("runs", id));
}

export async function listRuns(filter?: { toolId?: string }): Promise<RunRecord[]> {
  const db = await getDB();
  const all = await db.getAll("runs");
  const list = filter?.toolId ? all.filter((r) => r.toolId === filter.toolId) : all;
  return list.map((r) => withSourceDefault(r)!);
}
```

(If the existing `listRuns` body is different, preserve its logic but pipe results through `withSourceDefault`.)

- [ ] **Step 6: Run the test**

Run: `pnpm --filter @aipagego/extension test -- --run runs.test`
Expected: PASS for the two new cases plus existing cases.

- [ ] **Step 7: Full typecheck + tests**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: clean. Any compile error pointing to a `RunRecord` literal that doesn't set `source` (e.g. in a test fixture) — set it to `"user"` to fix.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/types.ts packages/extension/src/background/storage/runs.ts \
        packages/extension/tests/background/storage/runs.test.ts
git commit -m "feat(storage): tag RunRecord with source: user | coordinator

Default \"user\" on read so pre-existing records keep working. createRun
takes an optional source for the coordinator-driven path to set
\"coordinator\". Sidepanel history will later filter by this field."
```

---

## Task 3: Add `ChatSessionEvent` + `ChatSessionStatus` zod schemas in shared

**Why:** `CHAT_EVENT` carries one chat-loop `SessionEvent` per message. We mirror the TS union from `run-session.ts` in zod so shared/protocol owns the wire shape and doesn't reverse-depend on extension code. The mirror must round-trip every variant losslessly.

**Files:**
- Create: `packages/shared/src/protocol/chat-event.ts`
- Test: `packages/shared/tests/protocol/chat-event.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/tests/protocol/chat-event.test.ts
import { describe, it, expect } from "vitest";
import { ChatSessionEventSchema, ChatSessionStatusSchema } from "../../src/protocol/chat-event";

describe("ChatSessionStatusSchema", () => {
  it.each(["idle","streaming","awaiting","running","done","error","aborted"] as const)(
    "accepts %s", (s) => {
      const r = ChatSessionStatusSchema.safeParse(s);
      expect(r.success).toBe(true);
    });
  it("rejects unknown", () => {
    expect(ChatSessionStatusSchema.safeParse("frobnicated").success).toBe(false);
  });
});

describe("ChatSessionEventSchema", () => {
  const variants: Array<unknown> = [
    { type: "round_start", round: 0 },
    { type: "text_delta", text: "hi" },
    { type: "tool_use_start", id: "t1", name: "snapshotDOM" },
    { type: "tool_use_input_delta", id: "t1", partial_json: "{" },
    { type: "tool_use_end", id: "t1", input: { a: 1 } },
    { type: "assistant_turn_end", toolUses: [] },
    { type: "tool_running", id: "t1" },
    { type: "tool_done", id: "t1", output: { ok: true }, ms: 12 },
    { type: "tool_error", id: "t1", error: "boom", ms: 5 },
    { type: "tool_skipped", id: "t1" },
    { type: "usage", input_tokens: 100, output_tokens: 50 },
    { type: "continuation_nudge", round: 2, attempt: 1 },
    { type: "stream_error", error: "x" },
    { type: "exception", error: "x" },
    { type: "session_end", status: "done", lastOutput: null },
    { type: "session_end", status: "error", lastOutput: null, reason: "explicit" }
  ];
  it.each(variants)("round-trips variant %#", (v) => {
    const r = ChatSessionEventSchema.safeParse(v);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(v);
  });

  it("rejects unknown variant", () => {
    expect(ChatSessionEventSchema.safeParse({ type: "imaginary" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @aipagego/shared test -- --run chat-event`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the schemas**

```ts
// packages/shared/src/protocol/chat-event.ts
import { z } from "zod";

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
  })
]);
export type ChatSessionEvent = z.infer<typeof ChatSessionEventSchema>;
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @aipagego/shared test -- --run chat-event`
Expected: PASS — every variant round-trips.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/protocol/chat-event.ts packages/shared/tests/protocol/chat-event.test.ts
git commit -m "feat(protocol): zod ChatSessionEvent + ChatSessionStatus schemas

Mirror of the SessionEvent discriminated union in run-session.ts. Lives in
shared/protocol so wire types don't reverse-depend on extension code.
Round-trip test guards against drift when SessionEvent variants change."
```

---

## Task 4: Add the 5 new wire schemas + extend discriminated unions

**Why:** Adds `START_CHAT_SESSION`, `ABORT_SESSION`, `READ_SIDEPANEL_STATE` to S→C and `CHAT_EVENT`, `SIDEPANEL_STATE_REPLY` to C→S. All additive — existing union variants untouched.

**Files:**
- Modify: `packages/shared/src/protocol/messages.ts`
- Modify: `packages/shared/src/protocol/index.ts`
- Test: `packages/shared/tests/protocol/wire-extensions.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/tests/protocol/wire-extensions.test.ts
import { describe, it, expect } from "vitest";
import {
  StartChatSessionSchema,
  AbortSessionSchema,
  ReadSidepanelStateSchema,
  ChatEventSchema,
  SidepanelStateReplySchema,
  ServerToClientSchema,
  ClientToServerSchema
} from "../../src/protocol/messages";

const env = { nonce: "n", ts: 1, protocol_version: 1 };

describe("StartChatSessionSchema", () => {
  it("parses minimal", () => {
    const r = StartChatSessionSchema.safeParse({
      ...env, type: "START_CHAT_SESSION",
      session_id: "s1", user_prompt: "hi"
    });
    expect(r.success).toBe(true);
  });
  it("parses with mock_llm and overrides", () => {
    const r = StartChatSessionSchema.safeParse({
      ...env, type: "START_CHAT_SESSION",
      session_id: "s1", user_prompt: "hi", tab_id: "42",
      mock_llm: { rounds: [[{ type: "message_end", usage: { input_tokens: 0, output_tokens: 0 } }]] },
      settings_override: { maxRounds: 3, maxContinuationNudges: 1 }
    });
    expect(r.success).toBe(true);
  });
  it("rejects empty session_id", () => {
    const r = StartChatSessionSchema.safeParse({
      ...env, type: "START_CHAT_SESSION", session_id: "", user_prompt: "x"
    });
    expect(r.success).toBe(false);
  });
});

describe("AbortSessionSchema", () => {
  it("parses", () => {
    const r = AbortSessionSchema.safeParse({ ...env, type: "ABORT_SESSION", session_id: "s1" });
    expect(r.success).toBe(true);
  });
});

describe("ReadSidepanelStateSchema", () => {
  it("parses", () => {
    const r = ReadSidepanelStateSchema.safeParse({
      ...env, type: "READ_SIDEPANEL_STATE", req_id: "r1", tab_id: "42"
    });
    expect(r.success).toBe(true);
  });
});

describe("ChatEventSchema", () => {
  it("wraps a text_delta event", () => {
    const r = ChatEventSchema.safeParse({
      ...env, type: "CHAT_EVENT", session_id: "s1",
      event: { type: "text_delta", text: "hi" }
    });
    expect(r.success).toBe(true);
  });
  it("rejects malformed inner event", () => {
    const r = ChatEventSchema.safeParse({
      ...env, type: "CHAT_EVENT", session_id: "s1",
      event: { type: "imaginary" }
    });
    expect(r.success).toBe(false);
  });
});

describe("SidepanelStateReplySchema", () => {
  it("parses found:false without snapshot", () => {
    const r = SidepanelStateReplySchema.safeParse({
      ...env, type: "SIDEPANEL_STATE_REPLY", req_id: "r1", found: false
    });
    expect(r.success).toBe(true);
  });
  it("parses found:true with snapshot", () => {
    const r = SidepanelStateReplySchema.safeParse({
      ...env, type: "SIDEPANEL_STATE_REPLY", req_id: "r1", found: true,
      snapshot: {
        status: "idle", messagesCount: 0, attachedTabs: [],
        lastSystemNote: undefined
      }
    });
    expect(r.success).toBe(true);
  });
});

describe("union extension", () => {
  it("ServerToClientSchema accepts START_CHAT_SESSION", () => {
    const r = ServerToClientSchema.safeParse({
      ...env, type: "START_CHAT_SESSION", session_id: "s1", user_prompt: "hi"
    });
    expect(r.success).toBe(true);
  });
  it("ClientToServerSchema accepts CHAT_EVENT", () => {
    const r = ClientToServerSchema.safeParse({
      ...env, type: "CHAT_EVENT", session_id: "s1",
      event: { type: "text_delta", text: "x" }
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @aipagego/shared test -- --run wire-extensions`
Expected: FAIL — schemas not exported.

- [ ] **Step 3: Implement in `messages.ts`**

Append after the existing schemas (before the `=== Discriminated unions ===` section) in `packages/shared/src/protocol/messages.ts`:

```ts
import { ChatSessionEventSchema, ChatSessionStatusSchema } from "./chat-event";

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
```

Then extend the existing discriminated unions (replace the existing `ClientToServerSchema` / `ServerToClientSchema` declarations):

```ts
export const ClientToServerSchema = z.discriminatedUnion("type", [
  HelloSchema,
  PingSchema,
  TabReadySchema,
  ProgressSchema,
  ResultSchema,
  SessionEventSchema,
  StateSnapshotSchema,
  ChatEventSchema,
  SidepanelStateReplySchema
]);

export const ServerToClientSchema = z.discriminatedUnion("type", [
  WelcomeSchema,
  PongSchema,
  OpenTabSchema,
  ExecSchema,
  CloseSessionSchema,
  StartChatSessionSchema,
  AbortSessionSchema,
  ReadSidepanelStateSchema
]);
```

Append exported types at the bottom:

```ts
export type StartChatSession = z.infer<typeof StartChatSessionSchema>;
export type AbortSession = z.infer<typeof AbortSessionSchema>;
export type ReadSidepanelState = z.infer<typeof ReadSidepanelStateSchema>;
export type ChatEvent = z.infer<typeof ChatEventSchema>;
export type SidepanelStateReply = z.infer<typeof SidepanelStateReplySchema>;
```

- [ ] **Step 4: Re-export from `index.ts`** (no-op if `messages.ts` is already barrelled — verify and skip if so)

In `packages/shared/src/protocol/index.ts`:

```ts
export * from "./version";
export * from "./envelope";
export * from "./errors";
export * from "./messages";
export * from "./chat-event";
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `pnpm --filter @aipagego/shared test -- --run wire-extensions`
Expected: PASS.

Also: `pnpm --filter @aipagego/shared test` to ensure existing message tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/protocol/messages.ts packages/shared/src/protocol/index.ts \
        packages/shared/tests/protocol/wire-extensions.test.ts
git commit -m "feat(protocol): START_CHAT_SESSION / ABORT_SESSION / READ_SIDEPANEL_STATE
                / CHAT_EVENT / SIDEPANEL_STATE_REPLY wire schemas

Strictly additive: new variants on existing discriminated unions, existing
messages parse identically. ChatEvent inner event uses the ChatSessionEvent
mirror added in the previous commit."
```

---

## Task 5: Add `allow_remote_chat` storage accessor

**Why:** A simple boolean in `chrome.storage.local`, default `false`, that `CoordinatorChatHost.handle` reads before accepting `START_CHAT_SESSION`. Adding it as a dedicated accessor (rather than embedding in `CoordinatorConfig`) keeps the existing config shape untouched and easy to reason about.

**Files:**
- Modify: `packages/extension/src/background/coordinator-state.ts`
- Test: `packages/extension/tests/background/coordinator-state.test.ts` (existing file — add cases)

- [ ] **Step 1: Add failing test cases**

Append to `packages/extension/tests/background/coordinator-state.test.ts`:

```ts
import { loadAllowRemoteChat, saveAllowRemoteChat } from "@/background/coordinator-state";

describe("allow_remote_chat", () => {
  it("defaults to false when unset", async () => {
    expect(await loadAllowRemoteChat()).toBe(false);
  });
  it("round-trips true", async () => {
    await saveAllowRemoteChat(true);
    expect(await loadAllowRemoteChat()).toBe(true);
  });
  it("round-trips false", async () => {
    await saveAllowRemoteChat(true);
    await saveAllowRemoteChat(false);
    expect(await loadAllowRemoteChat()).toBe(false);
  });
});
```

(The existing `coordinator-state.test.ts` likely mocks `chrome.storage.local` with an in-memory map already — reuse that mock; if the file's setup uses a global `fakeChrome()`, it's compatible as-is.)

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @aipagego/extension test -- --run coordinator-state`
Expected: FAIL — `loadAllowRemoteChat` not exported.

- [ ] **Step 3: Implement the accessors**

Append to `packages/extension/src/background/coordinator-state.ts`:

```ts
const ALLOW_REMOTE_CHAT_KEY = "aipagego.coordinator.allow_remote_chat";

export async function loadAllowRemoteChat(): Promise<boolean> {
  const got = await chrome.storage.local.get([ALLOW_REMOTE_CHAT_KEY]);
  return got[ALLOW_REMOTE_CHAT_KEY] === true;
}

export async function saveAllowRemoteChat(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [ALLOW_REMOTE_CHAT_KEY]: value });
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @aipagego/extension test -- --run coordinator-state`
Expected: PASS for the three new cases.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/background/coordinator-state.ts \
        packages/extension/tests/background/coordinator-state.test.ts
git commit -m "feat(coordinator-state): allow_remote_chat flag accessors

Boolean in chrome.storage.local, default false. Read by the coordinator
chat host before accepting START_CHAT_SESSION. Tied to a checkbox added
later in the coordinator settings page."
```

---

## Task 6: MockLlmClient

**Why:** Lets `START_CHAT_SESSION` carry a deterministic LLM script for testing. The class lives in background because that's where `runChatSession` will be invoked.

**Files:**
- Create: `packages/extension/src/background/mock-llm-client.ts`
- Test: `packages/extension/tests/background/mock-llm-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/extension/tests/background/mock-llm-client.test.ts
import { describe, it, expect } from "vitest";
import { MockLlmClient } from "@/background/mock-llm-client";
import type { LlmStreamEvent } from "@aipagego/shared/llm";

async function collect(it: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const baseArgs = {
  apiKey: "k", model: "m", system: "", messages: [], tools: []
} as const;

describe("MockLlmClient", () => {
  it("yields each round's events in order", async () => {
    const c = new MockLlmClient([
      [{ type: "text_delta", text: "hi" }, { type: "message_end" }]
    ]);
    expect(await collect(c.stream(baseArgs))).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "message_end" }
    ]);
  });

  it("advances rounds on subsequent stream() calls", async () => {
    const c = new MockLlmClient([
      [{ type: "text_delta", text: "r0" }, { type: "message_end" }],
      [{ type: "text_delta", text: "r1" }, { type: "message_end" }]
    ]);
    expect((await collect(c.stream(baseArgs))).find((e) => e.type === "text_delta")).toEqual(
      { type: "text_delta", text: "r0" }
    );
    expect((await collect(c.stream(baseArgs))).find((e) => e.type === "text_delta")).toEqual(
      { type: "text_delta", text: "r1" }
    );
  });

  it("emits default message_end when rounds are exhausted", async () => {
    const c = new MockLlmClient([]);
    const events = await collect(c.stream(baseArgs));
    expect(events).toEqual([
      { type: "message_end", usage: { input_tokens: 0, output_tokens: 0 } }
    ]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @aipagego/extension test -- --run mock-llm-client`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/extension/src/background/mock-llm-client.ts
import type { LlmClient, LlmStreamEvent } from "@aipagego/shared/llm";

/**
 * Deterministic LLM client driven by a pre-scripted list of rounds.
 * Each call to stream() yields the next round's events; exhausting the
 * script yields a single message_end so runChatSession terminates cleanly.
 */
export class MockLlmClient implements LlmClient {
  private i = 0;
  constructor(private rounds: LlmStreamEvent[][]) {}

  stream(): AsyncIterable<LlmStreamEvent> {
    const events: LlmStreamEvent[] = this.rounds[this.i++] ?? [
      { type: "message_end", usage: { input_tokens: 0, output_tokens: 0 } }
    ];
    return (async function* () {
      for (const e of events) yield e;
    })();
  }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @aipagego/extension test -- --run mock-llm-client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/background/mock-llm-client.ts \
        packages/extension/tests/background/mock-llm-client.test.ts
git commit -m "feat(background): MockLlmClient — scripted LLM stream for tests

Consumes rounds in order; auto-emits message_end when exhausted so
runChatSession's continuation guard can terminate naturally."
```

---

## Task 7: BackgroundToolRunner

**Why:** `runChatSession` takes a `ToolRunner` whose `runStep(step, tabId, attachedTabIds, bindings)` runs a single tool step. The sidepanel's runner sends an RPC to the background; the background runner just calls `runOneStep` directly. Trivial adapter — but needs its own type to satisfy the interface.

**Files:**
- Create: `packages/extension/src/background/bg-tool-runner.ts`
- Modify: `packages/extension/src/background/rpc-handlers.ts` (ensure `runOneStep` is exported — likely already is per `coordinator-exec.ts:3`)
- Test: `packages/extension/tests/background/bg-tool-runner.test.ts`

- [ ] **Step 1: Confirm `runOneStep` is exported**

```bash
grep -n "export.*runOneStep" packages/extension/src/background/rpc-handlers.ts
```

Expected: at least one match. If not, add `export` to the function declaration.

- [ ] **Step 2: Write the failing test**

```ts
// packages/extension/tests/background/bg-tool-runner.test.ts
import { describe, it, expect, vi } from "vitest";
import { BackgroundToolRunner } from "@/background/bg-tool-runner";
import * as rpc from "@/background/rpc-handlers";

describe("BackgroundToolRunner", () => {
  it("delegates runStep to runOneStep with the same args", async () => {
    const spy = vi.spyOn(rpc, "runOneStep").mockResolvedValue({ ok: true });
    const r = new BackgroundToolRunner();
    const step = { kind: "tool" as const, tool: "snapshotDOM", args: { maxDepth: 2 } };
    const out = await r.runStep(step, 42, [43, 44], { binding: "v" });
    expect(spy).toHaveBeenCalledWith(step, 42, [43, 44], { binding: "v" });
    expect(out).toEqual({ ok: true });
    spy.mockRestore();
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `pnpm --filter @aipagego/extension test -- --run bg-tool-runner`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// packages/extension/src/background/bg-tool-runner.ts
import type { Json, Step } from "@aipagego/shared/types";
import type { ToolRunner } from "@/sidepanel/chat/tool-runner";
import { runOneStep } from "./rpc-handlers";

/**
 * ToolRunner implementation that runs tools directly in the background
 * service worker. Used by CoordinatorChatHost when running a coordinator-
 * driven chat session — there's no sidepanel to round-trip through.
 */
export class BackgroundToolRunner implements ToolRunner {
  async runStep(
    step: Step,
    tabId: number,
    attachedTabIds: number[],
    bindings: Record<string, Json>
  ): Promise<Json> {
    return runOneStep(step, tabId, attachedTabIds, bindings);
  }
}
```

- [ ] **Step 5: Run, expect PASS**

Run: `pnpm --filter @aipagego/extension test -- --run bg-tool-runner`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/background/bg-tool-runner.ts \
        packages/extension/tests/background/bg-tool-runner.test.ts
git commit -m "feat(background): BackgroundToolRunner adapter

Thin ToolRunner implementation that calls runOneStep directly. Used by
the coordinator chat host so chat sessions can run entirely in the BG
service worker."
```

---

## Task 8: CoordinatorChatHost

**Why:** The new home for `START_CHAT_SESSION` / `ABORT_SESSION` handling. Owns one active session at a time, enforces the allow-flag gate, wires `runChatSession` to mock LLM + background runner + auto-approver, and forwards every `SessionEvent` to the send callback as a `CHAT_EVENT`.

`runChatSession` is injected so the host is unit-testable without the real chat loop.

**Files:**
- Create: `packages/extension/src/background/coordinator-chat.ts`
- Test: `packages/extension/tests/background/coordinator-chat-host.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/extension/tests/background/coordinator-chat-host.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoordinatorChatHost } from "@/background/coordinator-chat";
import * as state from "@/background/coordinator-state";
import type { ServerToClient, ClientToServer } from "@aipagego/shared/protocol";
import { PROTOCOL_VERSION } from "@aipagego/shared/protocol";

function makeEnv() {
  return { nonce: "n", ts: 0, protocol_version: PROTOCOL_VERSION };
}

const startMsg = (sessionId = "s1", mock_llm?: unknown): ServerToClient => ({
  ...makeEnv(),
  type: "START_CHAT_SESSION",
  session_id: sessionId,
  user_prompt: "do thing",
  ...(mock_llm ? { mock_llm } : {})
} as ServerToClient);

beforeEach(() => {
  vi.spyOn(state, "loadAllowRemoteChat").mockResolvedValue(true);
});

describe("CoordinatorChatHost.handle", () => {
  it("rejects START_CHAT_SESSION when allow flag is false", async () => {
    vi.spyOn(state, "loadAllowRemoteChat").mockResolvedValue(false);
    const sent: ClientToServer[] = [];
    const fakeRun = vi.fn();
    const host = new CoordinatorChatHost({ runChatSession: fakeRun as never });
    await host.handle(startMsg(), (m) => sent.push(m));
    expect(fakeRun).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("CHAT_EVENT");
    if (sent[0].type !== "CHAT_EVENT") throw new Error();
    expect(sent[0].event.type).toBe("session_end");
    if (sent[0].event.type !== "session_end") throw new Error();
    expect(sent[0].event.status).toBe("error");
    expect(sent[0].event.reason).toMatch(/disabled/);
  });

  it("rejects a second START_CHAT_SESSION while one is running", async () => {
    const sent: ClientToServer[] = [];
    let resolveFirst: (() => void) | null = null;
    const fakeRun = vi.fn(() =>
      new Promise<void>((r) => { resolveFirst = r; })
    );
    const host = new CoordinatorChatHost({ runChatSession: fakeRun as never });
    void host.handle(startMsg("first"), (m) => sent.push(m));
    await new Promise((r) => setTimeout(r, 0));
    await host.handle(startMsg("second"), (m) => sent.push(m));
    const rej = sent.find((m) =>
      m.type === "CHAT_EVENT" && m.session_id === "second"
    );
    expect(rej).toBeTruthy();
    if (rej && rej.type === "CHAT_EVENT" && rej.event.type === "session_end") {
      expect(rej.event.reason).toMatch(/another session/i);
    } else {
      throw new Error("expected error session_end for second");
    }
    resolveFirst?.();
  });

  it("ABORT_SESSION aborts the matching session", async () => {
    let aborted = false;
    const fakeRun = vi.fn(({ abortSignal }: { abortSignal?: AbortSignal }) => {
      return new Promise<void>((resolve) => {
        abortSignal?.addEventListener("abort", () => { aborted = true; resolve(); });
      });
    });
    const host = new CoordinatorChatHost({ runChatSession: fakeRun as never });
    void host.handle(startMsg("s1"), () => undefined);
    await new Promise((r) => setTimeout(r, 0));
    await host.handle({ ...makeEnv(), type: "ABORT_SESSION", session_id: "s1" }, () => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(aborted).toBe(true);
  });

  it("ABORT_SESSION with mismatched id is silently ignored", async () => {
    const fakeRun = vi.fn(() => new Promise<void>(() => undefined));  // never resolves
    const host = new CoordinatorChatHost({ runChatSession: fakeRun as never });
    void host.handle(startMsg("s1"), () => undefined);
    await new Promise((r) => setTimeout(r, 0));
    // doesn't throw, doesn't send anything
    await host.handle({ ...makeEnv(), type: "ABORT_SESSION", session_id: "other" }, () => undefined);
  });

  it("forwards SessionEvents as CHAT_EVENT messages", async () => {
    const sent: ClientToServer[] = [];
    const fakeRun = vi.fn(async ({ onEvent }: { onEvent?: (e: unknown) => void }) => {
      onEvent?.({ type: "round_start", round: 0 });
      onEvent?.({ type: "text_delta", text: "hi" });
      onEvent?.({ type: "session_end", status: "done", lastOutput: null });
    });
    const host = new CoordinatorChatHost({ runChatSession: fakeRun as never });
    await host.handle(startMsg("s1"), (m) => sent.push(m));
    const chatEvents = sent.filter((m) => m.type === "CHAT_EVENT");
    expect(chatEvents).toHaveLength(3);
    expect(chatEvents.every((m) => m.type === "CHAT_EVENT" && m.session_id === "s1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @aipagego/extension test -- --run coordinator-chat-host`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/extension/src/background/coordinator-chat.ts
import type {
  ServerToClient,
  ClientToServer,
  StartChatSession,
  AbortSession
} from "@aipagego/shared/protocol";
import { PROTOCOL_VERSION } from "@aipagego/shared/protocol";
import type { LlmClient, LlmStreamEvent } from "@aipagego/shared/llm";
import type { RunSessionArgs, SessionEvent } from "@/sidepanel/chat/run-session";
import { runChatSession as defaultRunChatSession } from "@/sidepanel/chat/run-session";
import { MockLlmClient } from "./mock-llm-client";
import { BackgroundToolRunner } from "./bg-tool-runner";
import { Approver } from "@/sidepanel/chat/approval";
import type { ToolRunner } from "@/sidepanel/chat/tool-runner";
import { TOOL_DEFS } from "@/sidepanel/llm/tool-schema";
import { loadAllowRemoteChat } from "./coordinator-state";
import { createRun, appendStepLog, finalizeRun } from "./storage/runs";
import type { Json, RunStepLogEntry } from "@aipagego/shared/types";

type RunChatSessionFn = (args: RunSessionArgs) => Promise<unknown>;

export interface CoordinatorChatHostOptions {
  runChatSession?: RunChatSessionFn;
  loadSystemPrompt?: () => Promise<string>;
  pickActiveTab?: () => Promise<number>;
  urlFor?: (tabId: number) => Promise<string>;
  buildRealLlmClient?: () => Promise<LlmClient>;
  /** Override the tool runner (E2E tests use this to skip real chrome.scripting calls). */
  runner?: ToolRunner;
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function chatEvent(session_id: string, event: SessionEvent): ClientToServer {
  return {
    type: "CHAT_EVENT",
    session_id,
    event: event as never,         // wire schema validates on send via CoordinatorClient
    nonce: randomNonce(),
    ts: Date.now(),
    protocol_version: PROTOCOL_VERSION
  };
}

function sessionEndError(reason: string): SessionEvent {
  return { type: "session_end", status: "error", lastOutput: null, reason };
}

export class CoordinatorChatHost {
  private active: { sessionId: string; abort: AbortController } | null = null;
  private readonly run: RunChatSessionFn;
  private readonly loadSystem: () => Promise<string>;
  private readonly pickTab: () => Promise<number>;
  private readonly url: (tabId: number) => Promise<string>;
  private readonly buildReal: () => Promise<LlmClient>;
  private readonly runner: ToolRunner | undefined;

  constructor(opts: CoordinatorChatHostOptions = {}) {
    this.run = opts.runChatSession ?? (defaultRunChatSession as RunChatSessionFn);
    this.loadSystem = opts.loadSystemPrompt ?? (async () => "");
    this.pickTab = opts.pickActiveTab ?? defaultPickActiveTab;
    this.url = opts.urlFor ?? defaultUrlFor;
    this.buildReal = opts.buildRealLlmClient ?? (async () => {
      throw new Error("no real LLM client available: mock_llm required in this build");
    });
    this.runner = opts.runner;
  }

  async handle(
    msg: ServerToClient,
    send: (m: ClientToServer) => void
  ): Promise<void> {
    switch (msg.type) {
      case "START_CHAT_SESSION":
        await this.handleStart(msg, send);
        return;
      case "ABORT_SESSION":
        this.handleAbort(msg);
        return;
      default:
        return;
    }
  }

  private async handleStart(
    msg: StartChatSession,
    send: (m: ClientToServer) => void
  ): Promise<void> {
    if (this.active) {
      send(chatEvent(msg.session_id, sessionEndError("another session is running")));
      return;
    }
    if (!(await loadAllowRemoteChat())) {
      send(chatEvent(msg.session_id, sessionEndError("remote chat disabled in settings")));
      return;
    }

    const ac = new AbortController();
    this.active = { sessionId: msg.session_id, abort: ac };

    try {
      const client: LlmClient = msg.mock_llm
        ? new MockLlmClient(msg.mock_llm.rounds as LlmStreamEvent[][])
        : await this.buildReal();

      const tabId = msg.tab_id != null ? Number.parseInt(msg.tab_id, 10) : await this.pickTab();
      const url = await this.url(tabId);

      await this.run({
        client,
        runner: this.runner ?? new BackgroundToolRunner(),
        approver: new Approver(),       // unused — autoApproves catches everything below
        rpc: makeBgRpc(),
        input: { userPrompt: msg.user_prompt, tabId, url },
        settings: {
          provider: "anthropic",
          model: "mock",
          apiKey: "",
          apiKeyMode: "session",
          maxRounds: msg.settings_override?.maxRounds ?? 20,
          autoApproveDangerous: [],
          maxContinuationNudges: msg.settings_override?.maxContinuationNudges ?? 1
        },
        systemPrompt: await this.loadSystem(),
        tools: TOOL_DEFS,
        approveAllSafe: true,
        attachedTabIds: [],
        abortSignal: ac.signal,
        onEvent: (e) => send(chatEvent(msg.session_id, e))
      });
    } catch (e) {
      send(chatEvent(msg.session_id, sessionEndError(e instanceof Error ? e.message : String(e))));
    } finally {
      this.active = null;
    }
  }

  private handleAbort(msg: AbortSession): void {
    if (this.active?.sessionId === msg.session_id) {
      this.active.abort.abort();
    }
  }
}

async function defaultPickActiveTab(): Promise<number> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const id = tabs[0]?.id;
  if (id == null) throw new Error("no active tab to drive");
  return id;
}

async function defaultUrlFor(tabId: number): Promise<string> {
  const t = await chrome.tabs.get(tabId);
  return t.url ?? "";
}

// makeBgRpc adapts the background storage functions to the SessionRpc shape
// runChatSession expects, with source="coordinator" on every run record.
function makeBgRpc() {
  return {
    async startSession(input: { url: string }): Promise<{ id: string }> {
      const r = await createRun({
        toolId: null,
        toolVersion: null,
        url: input.url,
        source: "coordinator"
      });
      return { id: r.id };
    },
    async appendStepLog(runId: string, entry: {
      stepIndex: number; input: Json; output: Json; ms: number; error?: string;
    }): Promise<unknown> {
      const log: RunStepLogEntry = {
        stepIndex: entry.stepIndex,
        input: entry.input,
        output: entry.output,
        ms: entry.ms,
        ...(entry.error != null ? { error: entry.error } : {})
      };
      await appendStepLog(runId, log);
      return null;
    },
    async finalizeSession(
      runId: string, status: "ok" | "error" | "aborted", output?: Json
    ): Promise<unknown> {
      await finalizeRun(runId, { status, output });
      return null;
    }
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @aipagego/extension test -- --run coordinator-chat-host`
Expected: PASS for all five cases.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/background/coordinator-chat.ts \
        packages/extension/tests/background/coordinator-chat-host.test.ts
git commit -m "feat(background): CoordinatorChatHost — BG-side chat session runner

Owns one optional active session, gated on allow_remote_chat flag.
Reuses runChatSession (injectable for tests) with MockLlmClient or a
real LLM client, BackgroundToolRunner, and a rpc that tags run records
with source=\"coordinator\". Forwards every SessionEvent as CHAT_EVENT."
```

---

## Task 9: Background READ_SIDEPANEL_STATE bridge

**Why:** When the coordinator sends `READ_SIDEPANEL_STATE`, the background ports it into the runtime message bus as a `ping.sidepanelState` payload tagged with `req_id`. Any open sidepanel responds via `pong.sidepanelState`; the bridge resolves the first pong (matched by req_id) or times out at 500ms with `found: false`.

**Files:**
- Create: `packages/extension/src/background/coordinator-state-bridge.ts`
- Test: `packages/extension/tests/background/coordinator-state-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/extension/tests/background/coordinator-state-bridge.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoordinatorStateBridge } from "@/background/coordinator-state-bridge";
import type { ServerToClient, ClientToServer } from "@aipagego/shared/protocol";

function makeEnv() { return { nonce: "n", ts: 0, protocol_version: 1 }; }

function fakeRuntime(): {
  send: ReturnType<typeof vi.fn>;
  listener: ((msg: unknown) => void) | null;
  addListener: (fn: (msg: unknown) => void) => void;
} {
  let listener: ((msg: unknown) => void) | null = null;
  return {
    send: vi.fn(),
    get listener() { return listener; },
    addListener(fn) { listener = fn; }
  };
}

beforeEach(() => { vi.useFakeTimers(); });

describe("CoordinatorStateBridge", () => {
  it("requests state and returns reply with snapshot when sidepanel responds", async () => {
    const out: ClientToServer[] = [];
    const rt = fakeRuntime();
    const bridge = new CoordinatorStateBridge({
      sendRuntimeMessage: rt.send,
      onRuntimeMessage: rt.addListener,
      timeoutMs: 500
    });
    const msg: ServerToClient = {
      ...makeEnv(), type: "READ_SIDEPANEL_STATE", req_id: "r1", tab_id: "42"
    };
    const p = bridge.handle(msg, (m) => out.push(m));
    // simulate sidepanel pong
    expect(rt.send).toHaveBeenCalledWith({
      type: "ping.sidepanelState", req_id: "r1", tab_id: "42"
    });
    rt.listener?.({
      type: "pong.sidepanelState", req_id: "r1", found: true,
      snapshot: { status: "idle", messagesCount: 0, attachedTabs: [] }
    });
    await p;
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("SIDEPANEL_STATE_REPLY");
    if (out[0].type !== "SIDEPANEL_STATE_REPLY") throw new Error();
    expect(out[0].req_id).toBe("r1");
    expect(out[0].found).toBe(true);
    expect(out[0].snapshot).toEqual({ status: "idle", messagesCount: 0, attachedTabs: [] });
  });

  it("returns found:false on timeout when no sidepanel responds", async () => {
    const out: ClientToServer[] = [];
    const rt = fakeRuntime();
    const bridge = new CoordinatorStateBridge({
      sendRuntimeMessage: rt.send,
      onRuntimeMessage: rt.addListener,
      timeoutMs: 500
    });
    const msg: ServerToClient = {
      ...makeEnv(), type: "READ_SIDEPANEL_STATE", req_id: "r2", tab_id: "42"
    };
    const p = bridge.handle(msg, (m) => out.push(m));
    vi.advanceTimersByTime(500);
    await p;
    expect(out).toHaveLength(1);
    if (out[0].type !== "SIDEPANEL_STATE_REPLY") throw new Error();
    expect(out[0].found).toBe(false);
    expect(out[0].snapshot).toBeUndefined();
  });

  it("ignores pongs for mismatched req_id", async () => {
    const out: ClientToServer[] = [];
    const rt = fakeRuntime();
    const bridge = new CoordinatorStateBridge({
      sendRuntimeMessage: rt.send,
      onRuntimeMessage: rt.addListener,
      timeoutMs: 500
    });
    const p = bridge.handle({
      ...makeEnv(), type: "READ_SIDEPANEL_STATE", req_id: "r3", tab_id: "42"
    }, (m) => out.push(m));
    rt.listener?.({ type: "pong.sidepanelState", req_id: "other", found: true });
    vi.advanceTimersByTime(500);
    await p;
    if (out[0].type !== "SIDEPANEL_STATE_REPLY") throw new Error();
    expect(out[0].found).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @aipagego/extension test -- --run coordinator-state-bridge`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/extension/src/background/coordinator-state-bridge.ts
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
  timeoutMs?: number;
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class CoordinatorStateBridge {
  private pending = new Map<string, (pong: PongMessage) => void>();

  constructor(private opts: CoordinatorStateBridgeOptions) {
    opts.onRuntimeMessage((msg) => this.maybePong(msg));
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
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @aipagego/extension test -- --run coordinator-state-bridge`
Expected: PASS for all three cases.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/background/coordinator-state-bridge.ts \
        packages/extension/tests/background/coordinator-state-bridge.test.ts
git commit -m "feat(background): READ_SIDEPANEL_STATE → ping/pong → reply bridge

Routes coordinator state probes through chrome.runtime.sendMessage to
any open sidepanel and resolves the first matching pong by req_id.
500ms timeout returns found:false."
```

---

## Task 10: Sidepanel READ_SIDEPANEL_STATE listener

**Why:** The sidepanel side of the same probe. When a `ping.sidepanelState` arrives, it reads the zustand store for the given `tab_id`, builds a snapshot, and sends a `pong.sidepanelState`.

**Files:**
- Create: `packages/extension/src/sidepanel/coordinator-state-bridge.ts`
- Modify: `packages/extension/src/sidepanel/app.tsx` (mount once)
- Test: `packages/extension/tests/sidepanel/coordinator-state-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/extension/tests/sidepanel/coordinator-state-bridge.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSidepanelStatePing } from "@/sidepanel/coordinator-state-bridge";
import {
  attachTab, ensureSession, setStatus, useStore
} from "@/sidepanel/chat/session-store";

beforeEach(() => { useStore.setState({ sessionsByTab: {}, currentTabId: null }); });

describe("handleSidepanelStatePing", () => {
  it("returns found:true with snapshot for a known tab", () => {
    ensureSession(100, "https://example.com");
    setStatus(100, "running");
    attachTab(100, {
      tabId: 200, windowId: 1, source: "mention",
      lastSeenUrl: "https://attached", lastSeenTitle: "A"
    });
    useStore.setState((s) => ({
      ...s,
      sessionsByTab: {
        ...s.sessionsByTab,
        100: { ...s.sessionsByTab[100], messages: [
          { role: "user", content: "hi" },
          { role: "user", content: "🆕 AI 在 #200 打开了 https://attached" }
        ] }
      }
    }));
    const pong = handleSidepanelStatePing({
      type: "ping.sidepanelState", req_id: "r1", tab_id: "100"
    });
    expect(pong).toEqual({
      type: "pong.sidepanelState", req_id: "r1", found: true,
      snapshot: {
        status: "running",
        messagesCount: 2,
        attachedTabs: [{ tabId: 200, source: "mention", lastSeenUrl: "https://attached" }],
        lastSystemNote: "🆕 AI 在 #200 打开了 https://attached"
      }
    });
  });

  it("returns found:false when no session for that tab", () => {
    const pong = handleSidepanelStatePing({
      type: "ping.sidepanelState", req_id: "r2", tab_id: "999"
    });
    expect(pong).toEqual({ type: "pong.sidepanelState", req_id: "r2", found: false });
  });

  it("returns null for non-ping payloads", () => {
    expect(handleSidepanelStatePing({ type: "other" })).toBeNull();
    expect(handleSidepanelStatePing(null)).toBeNull();
    expect(handleSidepanelStatePing("string")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @aipagego/extension test -- --run coordinator-state-bridge.test`
(matches both bridge tests; sidepanel one will fail)
Expected: sidepanel test FAILs — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/extension/src/sidepanel/coordinator-state-bridge.ts
import { useStore } from "@/sidepanel/chat/session-store";

interface PingPayload {
  type: "ping.sidepanelState";
  req_id: string;
  tab_id: string;
}

interface SnapshotPayload {
  status: string;
  messagesCount: number;
  attachedTabs: Array<{ tabId: number; source: string; lastSeenUrl: string }>;
  lastSystemNote?: string;
}

interface PongPayload {
  type: "pong.sidepanelState";
  req_id: string;
  found: boolean;
  snapshot?: SnapshotPayload;
}

function isPing(raw: unknown): raw is PingPayload {
  if (typeof raw !== "object" || raw === null) return false;
  const m = raw as Record<string, unknown>;
  return m.type === "ping.sidepanelState"
    && typeof m.req_id === "string"
    && typeof m.tab_id === "string";
}

function findLastSystemNote(messages: Array<{ role: string; content: unknown }>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content !== "string") continue;
    // System notes are user-role messages starting with an emoji/marker per session-store conventions.
    if (m.content.startsWith("🆕") || m.content.startsWith("🗑")) return m.content;
  }
  return undefined;
}

export function handleSidepanelStatePing(raw: unknown): PongPayload | null {
  if (!isPing(raw)) return null;
  const tabId = Number.parseInt(raw.tab_id, 10);
  const session = useStore.getState().sessionsByTab[tabId];
  if (!session) {
    return { type: "pong.sidepanelState", req_id: raw.req_id, found: false };
  }
  return {
    type: "pong.sidepanelState",
    req_id: raw.req_id,
    found: true,
    snapshot: {
      status: session.status,
      messagesCount: session.messages.length,
      attachedTabs: session.attachedTabs.map((a) => ({
        tabId: a.tabId, source: a.source, lastSeenUrl: a.lastSeenUrl
      })),
      ...(((): { lastSystemNote?: string } => {
        const note = findLastSystemNote(session.messages as never);
        return note != null ? { lastSystemNote: note } : {};
      })())
    }
  };
}

export function mountSidepanelStateBridge(): () => void {
  const listener = (msg: unknown): void => {
    const pong = handleSidepanelStatePing(msg);
    if (!pong) return;
    void chrome.runtime.sendMessage(pong);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @aipagego/extension test -- --run sidepanel/coordinator-state-bridge`
Expected: PASS.

- [ ] **Step 5: Mount in sidepanel app**

In `packages/extension/src/sidepanel/app.tsx`, add the import + a `useEffect` (or equivalent one-shot mount). Locate the top-level `App` component; add:

```tsx
import { useEffect } from "react";
import { mountSidepanelStateBridge } from "@/sidepanel/coordinator-state-bridge";

// inside App component, near other useEffects:
useEffect(() => mountSidepanelStateBridge(), []);
```

- [ ] **Step 6: Run all sidepanel tests**

Run: `pnpm --filter @aipagego/extension test -- --run sidepanel`
Expected: PASS (no existing test should be broken; `app.tsx` change is a mount call inside `useEffect`).

- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/sidepanel/coordinator-state-bridge.ts \
        packages/extension/src/sidepanel/app.tsx \
        packages/extension/tests/sidepanel/coordinator-state-bridge.test.ts
git commit -m "feat(sidepanel): pong.sidepanelState responder + mount hook

Reads zustand store on ping, builds a flat snapshot (status, attachedTabs,
last system note), and sends pong back over chrome.runtime. Mounted once
in App so all open sidepanels can respond — first pong by req_id wins."
```

---

## Task 11: Coordinator-settings page allow checkbox

**Why:** The user-facing opt-in. Default off; toggling it sets the storage flag immediately.

**Files:**
- Modify: `packages/extension/src/sidepanel/pages/coordinator-settings-page.tsx`
- Test: `packages/extension/tests/sidepanel/pages/coordinator-settings-page.test.tsx` (existing file)

- [ ] **Step 1: Write the failing test**

Append to `packages/extension/tests/sidepanel/pages/coordinator-settings-page.test.tsx`:

```ts
it("toggles allow_remote_chat in storage when the checkbox flips", async () => {
  // assume the existing test file already mounts the page with fake chrome.storage.local
  render(<CoordinatorSettingsPage />);
  const checkbox = await screen.findByLabelText(/允许 coordinator 远程驱动 chat/);
  expect(checkbox).not.toBeChecked();
  await userEvent.click(checkbox);
  expect(await loadAllowRemoteChat()).toBe(true);
});
```

(adjust imports / harness to match the existing file's pattern — `CoordinatorSettingsPage`, `loadAllowRemoteChat`, `render`, `screen`, `userEvent`)

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @aipagego/extension test -- --run coordinator-settings-page`
Expected: FAIL — no checkbox with that label.

- [ ] **Step 3: Add the checkbox to the page**

In `packages/extension/src/sidepanel/pages/coordinator-settings-page.tsx`, add a `useState` for `allowRemoteChat`, an effect that loads it on mount, and a `<label><input type="checkbox" /></label>` element. The exact JSX should match the page's existing layout conventions; if the page uses Tailwind, use the same classes the other controls use.

Add the import: `import { loadAllowRemoteChat, saveAllowRemoteChat } from "@/background/coordinator-state";` (Note: this file is in `background/` but its exports are pure async functions over `chrome.storage` — fine to call from sidepanel.)

State + effect:

```tsx
const [allowRemoteChat, setAllowRemoteChat] = useState(false);
useEffect(() => { void loadAllowRemoteChat().then(setAllowRemoteChat); }, []);
```

Markup placed near the other settings controls:

```tsx
<label className="flex items-start gap-2 text-sm">
  <input
    type="checkbox"
    checked={allowRemoteChat}
    onChange={async (e) => {
      const v = e.target.checked;
      setAllowRemoteChat(v);
      await saveAllowRemoteChat(v);
    }}
  />
  <span>
    允许 coordinator 远程驱动 chat session 和危险工具
    <br />
    <span className="text-xs text-gray-500">
      开启后，连接的 coordinator 可以在你的浏览器里运行任意工具。仅在你信任该 coordinator 时勾选。
    </span>
  </span>
</label>
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @aipagego/extension test -- --run coordinator-settings-page`
Expected: PASS for the new case + existing cases unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/pages/coordinator-settings-page.tsx \
        packages/extension/tests/sidepanel/pages/coordinator-settings-page.test.tsx
git commit -m "feat(settings): allow_remote_chat checkbox in coordinator settings page

Default off. Persists via saveAllowRemoteChat to chrome.storage.local.
Wording warns that enabling lets the coordinator drive arbitrary tools."
```

---

## Task 12: Route new server messages in `coordinator-client.ts`

**Why:** `CoordinatorClient.handleMessage` currently switches over WELCOME/PONG/OPEN_TAB/EXEC/CLOSE_SESSION. Add three new branches that delegate to injected handlers (chat host + state bridge). Inject via constructor options so unit tests stay isolated.

**Files:**
- Modify: `packages/extension/src/background/coordinator-client.ts`
- Modify: `packages/extension/tests/background/coordinator-client.test.ts` (existing — add cases)

- [ ] **Step 1: Write the failing test**

Append to `packages/extension/tests/background/coordinator-client.test.ts` (adjust imports to match the existing file):

```ts
it("routes START_CHAT_SESSION to onChat handler", async () => {
  const onChat = vi.fn(async () => undefined);
  const client = new CoordinatorClient({
    ws_url: "ws://x",
    token: "t",
    worker_id: "w",
    savedToolsProvider: async () => [],
    labelsProvider: async () => [],
    onChat
  });
  // construct a minimal START_CHAT_SESSION via the WS message bus mock used in the file
  await (client as unknown as { handleMessage: (raw: unknown) => Promise<void> }).handleMessage(
    JSON.stringify({
      nonce: "n", ts: 0, protocol_version: 1,
      type: "START_CHAT_SESSION", session_id: "s1", user_prompt: "hi"
    })
  );
  expect(onChat).toHaveBeenCalledTimes(1);
});

it("routes ABORT_SESSION to onChat handler", async () => {
  const onChat = vi.fn(async () => undefined);
  const client = new CoordinatorClient({
    ws_url: "ws://x", token: "t", worker_id: "w",
    savedToolsProvider: async () => [], labelsProvider: async () => [],
    onChat
  });
  await (client as unknown as { handleMessage: (raw: unknown) => Promise<void> }).handleMessage(
    JSON.stringify({
      nonce: "n", ts: 0, protocol_version: 1,
      type: "ABORT_SESSION", session_id: "s1"
    })
  );
  expect(onChat).toHaveBeenCalledTimes(1);
});

it("routes READ_SIDEPANEL_STATE to onReadState handler", async () => {
  const onReadState = vi.fn(async () => undefined);
  const client = new CoordinatorClient({
    ws_url: "ws://x", token: "t", worker_id: "w",
    savedToolsProvider: async () => [], labelsProvider: async () => [],
    onReadState
  });
  await (client as unknown as { handleMessage: (raw: unknown) => Promise<void> }).handleMessage(
    JSON.stringify({
      nonce: "n", ts: 0, protocol_version: 1,
      type: "READ_SIDEPANEL_STATE", req_id: "r1", tab_id: "42"
    })
  );
  expect(onReadState).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @aipagego/extension test -- --run coordinator-client.test`
Expected: FAIL — `onChat` / `onReadState` not in options type, or messages not routed.

- [ ] **Step 3: Extend the options interface + add the switch branches**

In `packages/extension/src/background/coordinator-client.ts`, extend `CoordinatorClientOptions`:

```ts
import type {
  StartChatSession,
  AbortSession,
  ReadSidepanelState,
  ClientToServer
} from "@aipagego/shared/protocol";

export interface CoordinatorClientOptions {
  // existing fields...
  onChat?: (
    msg: StartChatSession | AbortSession,
    send: (m: ClientToServer) => void
  ) => Promise<void>;
  onReadState?: (
    msg: ReadSidepanelState,
    send: (m: ClientToServer) => void
  ) => Promise<void>;
}
```

In `handleMessage`'s switch, add cases (place after `CLOSE_SESSION`):

```ts
case "START_CHAT_SESSION":
case "ABORT_SESSION":
  if (this.opts.onChat) {
    try { await this.opts.onChat(msg, (m) => this.send(m)); }
    catch (err) { console.error("[coordinator-client] onChat threw", err); }
  }
  return;
case "READ_SIDEPANEL_STATE":
  if (this.opts.onReadState) {
    try { await this.opts.onReadState(msg, (m) => this.send(m)); }
    catch (err) { console.error("[coordinator-client] onReadState threw", err); }
  }
  return;
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @aipagego/extension test -- --run coordinator-client.test`
Expected: PASS for the three new cases.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/background/coordinator-client.ts \
        packages/extension/tests/background/coordinator-client.test.ts
git commit -m "feat(coordinator-client): route START_CHAT_SESSION / ABORT_SESSION /
                READ_SIDEPANEL_STATE to injected handlers

Strictly additive — existing WELCOME / EXEC / etc. routing unchanged.
Handlers receive a send callback to push CHAT_EVENT / SIDEPANEL_STATE_REPLY
back over the wire."
```

---

## Task 13: Wire host + bridge into background/index.ts

**Why:** Instantiate `CoordinatorChatHost` and `CoordinatorStateBridge` once at SW start and inject them into the `CoordinatorClient`.

**Files:**
- Modify: `packages/extension/src/background/index.ts`

- [ ] **Step 1: Update `startCoordinatorClient`**

Replace the function body in `packages/extension/src/background/index.ts:56-75` with:

```ts
export async function startCoordinatorClient(): Promise<void> {
  if (activeClient) return;
  const config = await loadConfig();
  if (!config?.enabled || !config.ws_url) return;
  const token = await loadToken();
  if (!token) {
    console.warn("[aipagego] coordinator enabled but no token saved");
    return;
  }
  const worker_id = await getOrCreateWorkerId();
  const chatHost = new CoordinatorChatHost();
  const stateBridge = new CoordinatorStateBridge({
    sendRuntimeMessage: (m) => chrome.runtime.sendMessage(m),
    onRuntimeMessage: (fn) => chrome.runtime.onMessage.addListener(fn)
  });
  activeClient = new CoordinatorClient({
    ws_url: config.ws_url,
    token,
    worker_id,
    savedToolsProvider: buildSavedToolsMetadata,
    labelsProvider: async () => [],
    onExec: handleExec,
    onChat: (m, send) => chatHost.handle(m, send),
    onReadState: (m, send) => stateBridge.handle(m, send)
  });
  await activeClient.connect();
}
```

Add the imports at the top of the file:

```ts
import { CoordinatorChatHost } from "./coordinator-chat";
import { CoordinatorStateBridge } from "./coordinator-state-bridge";
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter @aipagego/extension typecheck`
Expected: PASS.

- [ ] **Step 3: Verify all tests still green**

Run: `pnpm --filter @aipagego/extension test`
Expected: full suite PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/background/index.ts
git commit -m "feat(background): wire CoordinatorChatHost + CoordinatorStateBridge

Instantiated once when the coordinator client starts; injected into the
client so START_CHAT_SESSION / ABORT_SESSION / READ_SIDEPANEL_STATE
messages have somewhere to land."
```

---

## Task 14: E2E — continuation guard via WS

**Why:** The headline test. Real `ws` server + real `CoordinatorClient` + `MockLlmClient` round-trip — proves the wire-level path can exercise the chat session and reveal the continuation guard behavior.

**Files:**
- Modify: `packages/extension/tests/background/coordinator-e2e.test.ts` (existing file)

- [ ] **Step 1: Add the failing E2E test case**

Append to the existing `describe("coordinator-client end-to-end with ws server", ...)` block in `packages/extension/tests/background/coordinator-e2e.test.ts`:

```ts
it("START_CHAT_SESSION → continuation guard nudges exactly once", async () => {
  // Pre-arm the allow flag in the fake chrome.storage.local
  const fakeStorage = new Map<string, unknown>();
  fakeStorage.set("aipagego.coordinator.allow_remote_chat", true);
  vi.stubGlobal("chrome", {
    ...((globalThis as { chrome?: unknown }).chrome as object),
    storage: {
      local: {
        async get(keys: string[] | string) {
          const arr = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of arr) if (fakeStorage.has(k)) out[k] = fakeStorage.get(k);
          return out;
        },
        async set(obj: Record<string, unknown>) {
          for (const [k, v] of Object.entries(obj)) fakeStorage.set(k, v);
        }
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    tabs: {
      query: vi.fn(async () => [{ id: 42, url: "https://example.com" }]),
      get: vi.fn(async (id: number) => ({ id, url: "https://example.com" })),
      onCreated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() }
    }
  });

  const receivedChatEvents: unknown[] = [];
  const sessionEndPromise = new Promise<void>((resolve) => {
    wss!.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === "HELLO") {
          socket.send(JSON.stringify({
            type: "WELCOME", nonce: "wn", ts: Date.now(),
            protocol_version: PROTOCOL_VERSION,
            server_time: Date.now(), heartbeat_interval_ms: 20000
          }));
          socket.send(JSON.stringify({
            type: "START_CHAT_SESSION",
            nonce: "ns", ts: Date.now(), protocol_version: PROTOCOL_VERSION,
            session_id: "test-1",
            user_prompt: "采集所有评论",
            tab_id: "42",
            mock_llm: {
              rounds: [
                [
                  { type: "text_delta", text: "采集完成 152 条" },
                  { type: "message_end", usage: { input_tokens: 1, output_tokens: 1 } }
                ],
                [
                  { type: "tool_use_start", id: "t1", name: "httpRequest" },
                  { type: "tool_use_input_delta", id: "t1", partial_json: "{\"url\":\"https://example.com\"}" },
                  { type: "tool_use_end", id: "t1", input: { url: "https://example.com" } },
                  { type: "message_end", usage: { input_tokens: 1, output_tokens: 1 } }
                ],
                [
                  { type: "text_delta", text: "确认已完成" },
                  { type: "message_end", usage: { input_tokens: 1, output_tokens: 1 } }
                ]
              ]
            }
          }));
        } else if (parsed.type === "CHAT_EVENT") {
          receivedChatEvents.push(parsed.event);
          if (parsed.event.type === "session_end") resolve();
        }
      });
    });
  });

  const client = new CoordinatorClient({
    ws_url: baseUrl, token: "t", worker_id: "w",
    savedToolsProvider: async () => [],
    labelsProvider: async () => [],
    onChat: async (msg, send) => {
      // Use the real host with a fake runner — the continuation guard logic
      // we want to verify is in run-session.ts, not in the tool runner.
      const { CoordinatorChatHost } = await import("../../src/background/coordinator-chat");
      const host = new CoordinatorChatHost({
        pickActiveTab: async () => 42,
        urlFor: async () => "https://example.com",
        loadSystemPrompt: async () => "sys",
        runner: { async runStep() { return { ok: true }; } }
      });
      await host.handle(msg, send);
    }
  });
  await client.connect();
  await sessionEndPromise;
  await client.disconnect();

  const nudges = receivedChatEvents.filter(
    (e) => (e as { type?: string }).type === "continuation_nudge"
  );
  expect(nudges.length).toBe(1);
  const endEvents = receivedChatEvents.filter(
    (e) => (e as { type?: string }).type === "session_end"
  );
  expect(endEvents.length).toBe(1);
  expect((endEvents[0] as { status: string }).status).toBe("done");
});
```

Note: the test inlines a fake `chrome.storage.local` because the file's existing `fakeChrome()` helper doesn't include it. If the existing helper is later extended, factor this out — for now, inline is fine and self-contained.

- [ ] **Step 2: Run, expect FAIL initially (the assertions pin behavior; the test may also fail on harness setup the first run)**

Run: `pnpm --filter @aipagego/extension test -- --run coordinator-e2e`
Expected: FAIL because either (a) the host wiring isn't yet right or (b) the schema for CHAT_EVENT enforces a structure that needs the env fields populated by host. If (b), make sure `coordinator-chat.ts` populates `nonce`/`ts`/`protocol_version` (it already does in Task 8).

- [ ] **Step 3: Make the test pass**

Fix any harness / wiring bugs revealed by the test. The implementation pieces are already in place from Tasks 1-13; this layer just verifies they connect.

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @aipagego/extension test -- --run coordinator-e2e`
Expected: PASS for the new case + existing E2E test still green.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/tests/background/coordinator-e2e.test.ts
git commit -m "test(e2e): coordinator-driven chat session round-trip via real WS

Drives a START_CHAT_SESSION with scripted mock_llm rounds end-to-end,
asserts exactly one continuation_nudge fires and the session terminates
with status=\"done\". Pins the v0.0.15 continuation-guard fix at the
integration level."
```

---

## Task 15: E2E — allow-flag off rejection + READ_SIDEPANEL_STATE timeout

**Why:** Verifies the two negative paths (gate works; probe degrades gracefully). One file change, two cases.

**Files:**
- Modify: `packages/extension/tests/background/coordinator-e2e.test.ts`

- [ ] **Step 1: Add two failing cases**

Append to the same `describe` block:

```ts
it("rejects START_CHAT_SESSION when allow_remote_chat is false", async () => {
  const fakeStorage = new Map<string, unknown>(); // flag absent → defaults false
  vi.stubGlobal("chrome", {
    ...((globalThis as { chrome?: unknown }).chrome as object),
    storage: { local: {
      async get(keys: string[] | string) {
        const arr = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of arr) if (fakeStorage.has(k)) out[k] = fakeStorage.get(k);
        return out;
      },
      async set(obj: Record<string, unknown>) {
        for (const [k, v] of Object.entries(obj)) fakeStorage.set(k, v);
      }
    }, onChanged: { addListener: vi.fn() } },
    tabs: { query: vi.fn(async () => [{ id: 42 }]) }
  });

  const events: unknown[] = [];
  const done = new Promise<void>((resolve) => {
    wss!.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === "HELLO") {
          socket.send(JSON.stringify({
            type: "WELCOME", nonce: "n", ts: Date.now(),
            protocol_version: PROTOCOL_VERSION,
            server_time: Date.now(), heartbeat_interval_ms: 20000
          }));
          socket.send(JSON.stringify({
            type: "START_CHAT_SESSION", nonce: "s", ts: Date.now(),
            protocol_version: PROTOCOL_VERSION,
            session_id: "denied", user_prompt: "hi"
          }));
        } else if (parsed.type === "CHAT_EVENT") {
          events.push(parsed.event);
          if (parsed.event.type === "session_end") resolve();
        }
      });
    });
  });

  const client = new CoordinatorClient({
    ws_url: baseUrl, token: "t", worker_id: "w",
    savedToolsProvider: async () => [], labelsProvider: async () => [],
    onChat: async (msg, send) => {
      const { CoordinatorChatHost } = await import("../../src/background/coordinator-chat");
      await new CoordinatorChatHost().handle(msg, send);
    }
  });
  await client.connect();
  await done;
  await client.disconnect();
  expect(events).toHaveLength(1);
  expect((events[0] as { type: string }).type).toBe("session_end");
  expect((events[0] as { reason?: string }).reason).toMatch(/disabled/);
});

it("READ_SIDEPANEL_STATE returns found:false when no sidepanel listens", async () => {
  vi.stubGlobal("chrome", {
    ...((globalThis as { chrome?: unknown }).chrome as object),
    runtime: {
      ...((globalThis as { chrome?: { runtime?: object } }).chrome?.runtime ?? {}),
      sendMessage: vi.fn(),                 // never triggers any pong
      onMessage: { addListener: vi.fn() }
    }
  });

  let replyResolve: (v: unknown) => void;
  const replyPromise = new Promise<unknown>((r) => { replyResolve = r; });
  wss!.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (parsed.type === "HELLO") {
        socket.send(JSON.stringify({
          type: "WELCOME", nonce: "n", ts: Date.now(),
          protocol_version: PROTOCOL_VERSION,
          server_time: Date.now(), heartbeat_interval_ms: 20000
        }));
        socket.send(JSON.stringify({
          type: "READ_SIDEPANEL_STATE", nonce: "r", ts: Date.now(),
          protocol_version: PROTOCOL_VERSION,
          req_id: "probe-1", tab_id: "42"
        }));
      } else if (parsed.type === "SIDEPANEL_STATE_REPLY") {
        replyResolve(parsed);
      }
    });
  });

  const client = new CoordinatorClient({
    ws_url: baseUrl, token: "t", worker_id: "w",
    savedToolsProvider: async () => [], labelsProvider: async () => [],
    onReadState: async (msg, send) => {
      const { CoordinatorStateBridge } = await import("../../src/background/coordinator-state-bridge");
      const bridge = new CoordinatorStateBridge({
        sendRuntimeMessage: () => undefined,
        onRuntimeMessage: () => undefined,
        timeoutMs: 100
      });
      await bridge.handle(msg, send);
    }
  });
  await client.connect();
  const reply = await replyPromise;
  await client.disconnect();
  expect((reply as { req_id: string; found: boolean }).req_id).toBe("probe-1");
  expect((reply as { found: boolean }).found).toBe(false);
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @aipagego/extension test -- --run coordinator-e2e`
Expected: at least one of the new cases fails if any wire path is broken.

- [ ] **Step 3: Fix any wiring issues revealed**

If `WELCOME` mismatch logs and disconnects (line 106-112 of coordinator-client.ts), the test's protocol_version must match `PROTOCOL_VERSION` exactly.

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @aipagego/extension test -- --run coordinator-e2e`
Expected: all E2E cases PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/tests/background/coordinator-e2e.test.ts
git commit -m "test(e2e): allow-flag rejection + READ_SIDEPANEL_STATE timeout

Verifies that (a) the opt-in flag blocks START_CHAT_SESSION when off, and
(b) READ_SIDEPANEL_STATE returns found:false instead of hanging when no
sidepanel is listening."
```

---

## Task 16: Smoke checklist doc + mini-coordinator script

**Why:** Layer 5 of the testing strategy — a 5-minute manual smoke that runs against a real Chrome with the extension loaded. Useful after each release.

**Files:**
- Create: `docs/superpowers/scripts/mini-coordinator.mjs`
- Modify: `docs/superpowers/specs/2026-06-04-remote-testable-chat-design.md` (point at script)

- [ ] **Step 1: Write the script**

```js
// docs/superpowers/scripts/mini-coordinator.mjs
// Minimal WS coordinator for smoke-testing the extension. Run:
//   pnpm add -wD ws    (one-time)
//   node docs/superpowers/scripts/mini-coordinator.mjs

import { WebSocketServer } from "ws";

const PROTOCOL_VERSION = 1;
const PORT = 8787;

const wss = new WebSocketServer({ port: PORT, path: "/worker" });
console.log(`mini-coordinator listening on ws://127.0.0.1:${PORT}/worker`);
console.log(`token: any non-empty string. Settings page bearer protocol works as-is.`);

wss.on("connection", (socket) => {
  console.log("worker connected");

  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "HELLO") {
      console.log("HELLO from", msg.worker_id, "tabs:", msg.available_tabs?.length ?? 0);
      socket.send(JSON.stringify({
        type: "WELCOME", nonce: "wn", ts: Date.now(),
        protocol_version: PROTOCOL_VERSION,
        server_time: Date.now(), heartbeat_interval_ms: 20000
      }));
      return;
    }
    if (msg.type === "CHAT_EVENT") {
      console.log(`[${msg.session_id}] ${msg.event.type}`,
        msg.event.type === "text_delta" ? JSON.stringify(msg.event.text).slice(0, 60)
        : msg.event.type === "session_end" ? `status=${msg.event.status}` + (msg.event.reason ? ` reason=${msg.event.reason}` : "")
        : "");
      return;
    }
    if (msg.type === "SIDEPANEL_STATE_REPLY") {
      console.log("SIDEPANEL_STATE_REPLY", JSON.stringify(msg, null, 2));
      return;
    }
    if (msg.type === "PING") return;
    console.log("← from worker:", msg.type);
  });

  // 1) After connect, immediately try a START_CHAT_SESSION with mock rounds.
  setTimeout(() => {
    socket.send(JSON.stringify({
      type: "START_CHAT_SESSION", nonce: "sc", ts: Date.now(),
      protocol_version: PROTOCOL_VERSION,
      session_id: "smoke-1", user_prompt: "smoke test prompt",
      mock_llm: {
        rounds: [
          [{ type: "text_delta", text: "采集完成 5 条" }, { type: "message_end", usage: { input_tokens: 1, output_tokens: 1 } }],
          [{ type: "tool_use_start", id: "t1", name: "httpRequest" },
           { type: "tool_use_input_delta", id: "t1", partial_json: "{\"url\":\"https://example.org\"}" },
           { type: "tool_use_end", id: "t1", input: { url: "https://example.org" } },
           { type: "message_end", usage: { input_tokens: 1, output_tokens: 1 } }],
          [{ type: "text_delta", text: "确认已完成" }, { type: "message_end", usage: { input_tokens: 1, output_tokens: 1 } }]
        ]
      }
    }));
  }, 1000);

  // 2) After 3s, probe sidepanel state for any open session.
  setTimeout(() => {
    socket.send(JSON.stringify({
      type: "READ_SIDEPANEL_STATE", nonce: "pr", ts: Date.now(),
      protocol_version: PROTOCOL_VERSION,
      req_id: "probe-1", tab_id: "ACTIVE_TAB_ID_HERE_OR_LET_DEFAULT_FAIL"
    }));
  }, 3000);
});
```

- [ ] **Step 2: Add the smoke checklist to the spec**

Edit the spec at `docs/superpowers/specs/2026-06-04-remote-testable-chat-design.md`, find the "Layer 5 — Real-Chrome smoke checklist" section, append at the bottom:

> The mini-coordinator helper script is at `docs/superpowers/scripts/mini-coordinator.mjs`. Run `node docs/superpowers/scripts/mini-coordinator.mjs` after `pnpm build` and loading `packages/extension/dist` unpacked.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/scripts/mini-coordinator.mjs \
        docs/superpowers/specs/2026-06-04-remote-testable-chat-design.md
git commit -m "docs(spec): mini-coordinator script for layer-5 smoke testing

Standalone Node script that runs a minimal WS coordinator and drives a
scripted START_CHAT_SESSION + READ_SIDEPANEL_STATE against a real
extension. Used in the post-release manual smoke checklist."
```

---

## Task 17: Final verification + release

**Why:** Ensure the whole change is internally consistent and ship it.

- [ ] **Step 1: Run full typecheck + tests**

```bash
pnpm -r typecheck && pnpm -r test
```

Expected: clean. Test count: 315 + ~20 new = ~335.

- [ ] **Step 2: Run the dev build to confirm the extension still bundles**

```bash
pnpm --filter @aipagego/extension build
```

Expected: PASS, `packages/extension/dist/` populated.

- [ ] **Step 3: Manual sanity (optional but recommended before tagging)**

Load `packages/extension/dist` as unpacked extension; open the Coordinator settings page; verify the new checkbox renders and toggles persist across reload.

- [ ] **Step 4: Use the `ship-release` skill**

The repo's standard release flow: PR → squash-merge → bump root package.json → tag v0.0.16 → push. Follow the same pattern used for v0.0.14 / v0.0.15. The ship-release skill handles each step.

PR title suggestion: `feat: remote-testable chat session (CHAT_EVENT + START_CHAT_SESSION + sidepanel state probe)`

PR body should reference the spec doc and summarize the new wire surface + the opt-in flag.

---

## Self-review checklist

After completing the plan, verify:

1. **Spec coverage**
   - Protocol additions: Tasks 1-4 ✓
   - allow_remote_chat flag: Task 5, used in Task 8 ✓
   - Background components: Tasks 6-9 ✓
   - Sidepanel bridge: Task 10 ✓
   - Settings UI: Task 11 ✓
   - Wiring: Tasks 12-13 ✓
   - Persistence with source tag: Task 2 (storage) + Task 8 (host uses source="coordinator") ✓
   - E2E tests: Tasks 14-15 ✓
   - Layer 5 smoke: Task 16 ✓
   - Release: Task 17 ✓

2. **Type consistency**
   - `LlmStreamEvent` referenced consistently from `@aipagego/shared/llm` ✓
   - `ChatSessionEvent` only used in shared/protocol; runtime uses `SessionEvent` ✓
   - `RunSource` type alias added in shared/types and used in storage/runs ✓
   - `CoordinatorChatHostOptions` shape consistent between Task 8 and Tasks 14/15 (`pickActiveTab` / `urlFor` / `loadSystemPrompt`) ✓
   - `CoordinatorStateBridgeOptions` shape consistent between Task 9 and Task 15 (`sendRuntimeMessage` / `onRuntimeMessage` / `timeoutMs`) ✓

3. **No placeholders**
   - No `TBD` / `TODO` / "implement later" anywhere in the steps ✓
   - All step bodies show actual code, commands, or exact wording ✓

4. **DRY / YAGNI**
   - No premature abstractions; each new file has one job ✓
   - No subscription / multi-session features that were deferred in spec ✓

5. **Commits cadence**
   - Each task ends with a single focused commit ✓
   - Test files are added alongside the production code they cover ✓
