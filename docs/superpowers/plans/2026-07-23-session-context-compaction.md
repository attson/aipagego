# Session Context Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve cross-send conversation memory and proactively compress old history before model calls.

**Architecture:** Add a pure `context-manager` module that turns prior session messages into safe `initialMessages`. Wire sidepanel and widget submit paths to pass prior history plus current multimodal user content into the existing `runChatSession` loop.

**Tech Stack:** TypeScript, React 18, Zustand session store, existing `ChatMessage` LLM abstraction, Vitest.

---

### Task 1: Context Manager Pure Module

**Files:**
- Create: `packages/extension/src/sidepanel/chat/context-manager.ts`
- Test: `packages/extension/tests/sidepanel/chat/context-manager.test.ts`

- [x] **Step 1: Write failing tests**

Add tests that verify:

```ts
buildInitialMessagesForNextTurn(history, { softCharBudget: 10_000 })
```

keeps small prior history, and:

```ts
buildInitialMessagesForNextTurn(history, {
  recentMessageLimit: 2,
  softCharBudget: 300,
  memoryCharLimit: 800,
})
```

returns a first `[上下文记忆]` message, preserves `page-index-1` /
`block-review-7`, omits image base64, and keeps the last two turns raw.

- [x] **Step 2: Verify RED**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/sidepanel/chat/context-manager.test.ts
```

Expected: fails because `@/sidepanel/chat/context-manager` does not exist.

- [x] **Step 3: Implement module**

Implement:

```ts
export function buildCurrentUserContent(text: string, images: ImagePart[]): UserMessageContent
export function buildInitialMessagesForNextTurn(
  history: ChatMessage[],
  options?: ContextBuildOptions
): ContextBuildResult
```

Rules:

- Small sanitized history passes through.
- Over-budget history becomes `[上下文记忆] + recent raw turns`.
- Old image parts become text placeholders.
- Old screenshot/tool-result images become text placeholders.
- Text and tool results use existing `truncateContent`.

- [x] **Step 4: Verify GREEN**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/sidepanel/chat/context-manager.test.ts
```

Expected: passes.

### Task 2: Current Multimodal Message Support

**Files:**
- Modify: `packages/extension/src/sidepanel/chat/run-session.ts`
- Test: `packages/extension/tests/sidepanel/chat/run-session.test.ts`

- [x] **Step 1: Write failing test**

Add a test that calls `runChatSession` with:

```ts
initialMessages: [{ role: "user", content: "previous goal" }],
input: {
  userPrompt: "describe image",
  userContent: [image, { type: "text", text: "describe image" }],
  tabId: 1,
  url: "u",
}
```

Expected captured LLM messages contain both the prior user message and the
current image/text content.

- [x] **Step 2: Verify RED**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/sidepanel/chat/run-session.test.ts -t "current multimodal"
```

Expected: fails because `runChatSession` still appends `userPrompt` only.

- [x] **Step 3: Implement `userContent`**

Add:

```ts
export type RunSessionInput = {
  userPrompt: string;
  userContent?: UserMessageContent;
  tabId: number;
  url: string;
};
```

Initialize messages with:

```ts
{ role: "user", content: args.input.userContent ?? args.input.userPrompt }
```

- [x] **Step 4: Verify GREEN**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/sidepanel/chat/run-session.test.ts -t "current multimodal"
```

Expected: passes.

### Task 3: Sidepanel and Widget Wiring

**Files:**
- Modify: `packages/extension/src/sidepanel/shell/app-shell.tsx`
- Modify: `packages/extension/src/content/widget/panel.tsx`
- Modify: `packages/extension/src/content/widget/run-widget-session.ts`

- [x] **Step 1: Wire sidepanel submit**

Before appending the current UI message:

```ts
const context = buildInitialMessagesForNextTurn(session0.messages);
const userContentForLlm = buildCurrentUserContent(promptForLlm, imgsToSend);
```

Pass:

```ts
initialMessages: context.initialMessages,
input: { userPrompt: promptForLlm, userContent: userContentForLlm, tabId, url }
```

Log:

```ts
"[上下文] 已压缩早期对话"
```

when `context.compressed` is true.

- [x] **Step 2: Wire widget submit**

Capture:

```ts
const historyMessages = session.messages;
const imagesToSend = stagedImages;
```

Then call:

```ts
await runFromInput(tabId, text, { images: imagesToSend, historyMessages });
```

- [x] **Step 3: Wire widget runner**

In `runFromInput`, build:

```ts
const context = buildInitialMessagesForNextTurn(inputContext.historyMessages ?? sessionState.messages);
const userContent = buildCurrentUserContent(text, inputContext.images ?? []);
```

Pass both into `runChatSession`.

- [x] **Step 4: Typecheck**

Run:

```bash
pnpm --filter @aipagego/extension typecheck
```

Expected: passes.

### Task 4: Final Verification

**Files:**
- Modify: `docs/superpowers/specs/README.md`
- Create: `docs/superpowers/specs/2026-07-23-session-context-compaction-design.md`
- Create: `docs/superpowers/plans/2026-07-23-session-context-compaction.md`

- [x] **Step 1: Update docs**

Add Plan 31 to the specs index and describe:

- Cross-send context memory.
- Proactive deterministic compression.
- Old image/base64 omission.
- Current staged image delivery to the model.

- [x] **Step 2: Run focused tests**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/sidepanel/chat/context-manager.test.ts tests/sidepanel/chat/run-session.test.ts
```

Expected: passes.

- [x] **Step 3: Run input image-only tests**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/sidepanel/input/input-box.test.tsx tests/sidepanel/input/input-toolbar.test.tsx
```

Expected: passes.

- [x] **Step 4: Run package typecheck**

Run:

```bash
pnpm --filter @aipagego/extension typecheck
```

Expected: passes.

- [x] **Step 5: Run build**

Run:

```bash
pnpm build
```

Expected: extension build completes and writes `packages/extension/dist/`.

- [x] **Step 6: Run repo verification**

Run:

```bash
pnpm test
pnpm typecheck
```

Expected: all workspace tests and typechecks pass.

### Task 5: Configurable Context Policy + Settings Tabs

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/extension/src/sidepanel/chat/context-manager.ts`
- Modify: `packages/extension/src/sidepanel/chat/settings-store.ts`
- Modify: `packages/extension/src/sidepanel/shell/app-shell.tsx`
- Modify: `packages/extension/src/content/widget/run-widget-session.ts`
- Modify: `packages/extension/src/sidepanel/drawers/settings-drawer.tsx`
- Create: `packages/extension/src/sidepanel/drawers/settings/section-context.tsx`
- Test: `packages/extension/tests/sidepanel/chat/context-manager.test.ts`
- Test: `packages/extension/tests/sidepanel/drawers/settings/section-context.test.tsx`
- Test: `packages/extension/tests/sidepanel/drawers/settings-drawer.test.tsx`

- [x] **Step 1: Write failing context policy tests**

Add tests for:

```ts
resolveContextBuildOptions({ contextPolicy: "auto", model: "gpt-4o" })
resolveContextBuildOptions({ contextPolicy: "auto", model: "claude-sonnet-4-6" })
resolveContextBuildOptions({ contextPolicy: "auto", model: "gemini-2.5-pro-1m" })
```

Expected: budgets are materially larger than the old 24k window.

- [x] **Step 2: Write failing settings UI tests**

Add tests for:

- `SectionContext` saves `contextPolicy`.
- Custom mode shows numeric inputs.
- Settings drawer mounts one left-tabbed section at a time.

- [x] **Step 3: Implement policy resolver**

Add `ContextPolicy` to shared types and implement:

```ts
resolveContextBuildOptions(settings)
```

with `auto / conservative / large / huge / custom` behavior.

- [x] **Step 4: Wire policy into chat paths**

Sidepanel and widget call:

```ts
buildInitialMessagesForNextTurn(messages, resolveContextBuildOptions(settings))
```

- [x] **Step 5: Add settings UI**

Create `SectionContext` and convert `SettingsDrawer` to left-tab navigation:

```txt
LLM / 上下文 / MCP / 权限 / 外观 / 浮窗 / Coordinator / 高级
```

- [x] **Step 6: Verify focused tests**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/sidepanel/chat/context-manager.test.ts tests/sidepanel/drawers/settings/section-context.test.tsx tests/sidepanel/drawers/settings-drawer.test.tsx tests/sidepanel/drawers/settings/section-llm.test.tsx
pnpm --filter @aipagego/extension typecheck
```

Expected: passes.
