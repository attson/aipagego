# AI-Generated Tool Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mechanical save-as-tool with AI-generated `prompt` tools and AI-generated `steps` tools.

**Architecture:** Tools become a discriminated union: `kind: "prompt"` runs by jumping into ChatPage with auto-send, while `kind: "steps"` keeps the existing background/content runner. Save-as-tool becomes a two-stage AI generation flow that first selects a type, then asks the LLM to produce `name`, `description`, and either `prompt` or `steps`.

**Tech Stack:** TypeScript strict, React 18, Zustand, zod, IDB, Vitest + happy-dom + fake-indexeddb, existing Anthropic/OpenAI `LlmClient`.

---

## File Structure

- Modify `src/shared/types.ts`: define `StepsTool`, `PromptTool`, typed versions, draft types, and v2 export bundle.
- Modify `src/shared/messages.ts`: expose zod schemas for `StepSchema`, `StepsToolDraftSchema`, `PromptToolDraftSchema`, `ToolDraftSchema`, and `ToolSchema`.
- Modify `src/background/storage/tools.ts`: save/list/get/match only valid v2 tools; save both tool kinds; run stats only for steps tools.
- Modify `src/background/storage/export-import.ts`: export/import only `aipagego.tools/v2` and validated tools.
- Modify `src/background/rpc-handlers.ts`: route `tools.save` union drafts and reject `runs.start` for prompt tools.
- Create `src/sidepanel/llm/tool-draft-generator.ts`: generate and validate AI JSON for prompt/steps tool candidates.
- Modify `src/sidepanel/components/save-as-tool-dialog.tsx`: replace summary-step flow with type selection + AI candidate generation.
- Modify `src/sidepanel/app.tsx`: add prompt-tool route handoff and `autoSend` support.
- Modify `src/sidepanel/pages/chat-page.tsx`: auto-send initial prompt once after session/tab readiness and include source log/context.
- Modify `src/sidepanel/pages/tool-detail-page.tsx`: render prompt vs steps details and route prompt tools into chat.
- Modify `src/sidepanel/components/recommendations-banner.tsx`: run prompt tools directly through chat handoff.
- Modify `src/sidepanel/pages/tools-page.tsx`: display kind badge for prompt/steps tools.
- Tests: update existing storage/export/tool-detail tests; add generator, schema, save-dialog, and route tests.

---

### Task 1: Shared Tool Types And Schemas

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/messages.ts`
- Test: `tests/shared/messages.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `tests/shared/messages.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ToolDraftSchema, ToolSchema } from "@/shared/messages";

const base = {
  id: "tool-1",
  name: "采集商品",
  urlPatterns: ["https://example.com/**"],
  description: "采集当前页面",
  createdAt: 1,
  updatedAt: 1,
  stats: { runs: 0 }
};

describe("tool schemas", () => {
  it("accepts prompt tool drafts", () => {
    const parsed = ToolDraftSchema.parse({
      kind: "prompt",
      name: "智能采集",
      urlPatterns: ["https://example.com/**"],
      description: "让 AI 根据当前页面采集",
      prompt: "请读取当前页面并返回 JSON"
    });
    expect(parsed.kind).toBe("prompt");
    expect(parsed.prompt).toContain("JSON");
  });

  it("accepts steps tool drafts", () => {
    const parsed = ToolDraftSchema.parse({
      kind: "steps",
      name: "固定采集",
      urlPatterns: ["https://example.com/**"],
      description: "固定提取 h1",
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h1" } }],
      outputSchema: {}
    });
    expect(parsed.kind).toBe("steps");
    expect(parsed.steps).toHaveLength(1);
  });

  it("rejects old drafts without kind", () => {
    expect(() =>
      ToolDraftSchema.parse({
        name: "旧工具",
        urlPatterns: ["https://example.com/**"],
        description: "old",
        steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
        outputSchema: {}
      })
    ).toThrow();
  });

  it("accepts prompt and steps persisted tools", () => {
    expect(
      ToolSchema.parse({
        ...base,
        kind: "prompt",
        prompt: "请总结当前页",
        versions: [{ version: 1, kind: "prompt", prompt: "请总结当前页", createdAt: 1 }]
      }).kind
    ).toBe("prompt");

    expect(
      ToolSchema.parse({
        ...base,
        kind: "steps",
        steps: [{ kind: "js", source: "return { ok: true };" }],
        outputSchema: {},
        versions: [
          {
            version: 1,
            kind: "steps",
            steps: [{ kind: "js", source: "return { ok: true };" }],
            outputSchema: {},
            createdAt: 1
          }
        ]
      }).kind
    ).toBe("steps");
  });
});
```

- [ ] **Step 2: Run schema test to verify RED**

Run: `pnpm vitest run tests/shared/messages.test.ts`

Expected: fail because `ToolSchema` is not exported and `ToolDraftSchema` still accepts old non-discriminated drafts.

- [ ] **Step 3: Implement shared types**

In `src/shared/types.ts`, replace the current `ToolVersion`, `Tool`, and `ExportBundle` definitions with:

```typescript
export type StepsToolVersion = {
  version: number;
  kind: "steps";
  steps: Step[];
  outputSchema: JsonSchema;
  createdAt: number;
  note?: string;
};

export type PromptToolVersion = {
  version: number;
  kind: "prompt";
  prompt: string;
  createdAt: number;
  note?: string;
};

export type ToolVersion = StepsToolVersion | PromptToolVersion;

export type ToolStats = { runs: number; lastRunAt?: number; lastRunOk?: boolean };

export type StepsTool = {
  kind: "steps";
  id: string;
  name: string;
  urlPatterns: string[];
  description: string;
  steps: Step[];
  outputSchema: JsonSchema;
  createdAt: number;
  updatedAt: number;
  versions: StepsToolVersion[];
  stats: ToolStats;
};

export type PromptTool = {
  kind: "prompt";
  id: string;
  name: string;
  urlPatterns: string[];
  description: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
  versions: PromptToolVersion[];
  stats: ToolStats;
};

export type Tool = StepsTool | PromptTool;

export type StepsToolDraft = {
  kind: "steps";
  name: string;
  urlPatterns: string[];
  description: string;
  steps: Step[];
  outputSchema: JsonSchema;
};

export type PromptToolDraft = {
  kind: "prompt";
  name: string;
  urlPatterns: string[];
  description: string;
  prompt: string;
};

export type ToolDraft = StepsToolDraft | PromptToolDraft;

export type ExportBundle = {
  schema: "aipagego.tools/v2";
  exportedAt: number;
  tools: Tool[];
};
```

- [ ] **Step 4: Implement zod schemas**

In `src/shared/messages.ts`, after `StepSchema`, replace `ToolDraftSchema` and add persisted schemas:

```typescript
const ToolStatsSchema = z.object({
  runs: z.number().int().min(0),
  lastRunAt: z.number().optional(),
  lastRunOk: z.boolean().optional()
});

export const StepsToolDraftSchema = z.object({
  kind: z.literal("steps"),
  name: z.string().min(1),
  urlPatterns: z.array(z.string().min(1)).min(1),
  description: z.string().default(""),
  steps: z.array(StepSchema).min(1),
  outputSchema: z.unknown().default({})
});

export const PromptToolDraftSchema = z.object({
  kind: z.literal("prompt"),
  name: z.string().min(1),
  urlPatterns: z.array(z.string().min(1)).min(1),
  description: z.string().default(""),
  prompt: z.string().min(1)
});

export const ToolDraftSchema = z.discriminatedUnion("kind", [
  StepsToolDraftSchema,
  PromptToolDraftSchema
]);

const StepsToolVersionSchema = z.object({
  version: z.number().int().positive(),
  kind: z.literal("steps"),
  steps: z.array(StepSchema).min(1),
  outputSchema: z.unknown().default({}),
  createdAt: z.number(),
  note: z.string().optional()
});

const PromptToolVersionSchema = z.object({
  version: z.number().int().positive(),
  kind: z.literal("prompt"),
  prompt: z.string().min(1),
  createdAt: z.number(),
  note: z.string().optional()
});

export const StepsToolSchema = z.object({
  kind: z.literal("steps"),
  id: z.string().min(1),
  name: z.string().min(1),
  urlPatterns: z.array(z.string().min(1)).min(1),
  description: z.string().default(""),
  steps: z.array(StepSchema).min(1),
  outputSchema: z.unknown().default({}),
  createdAt: z.number(),
  updatedAt: z.number(),
  versions: z.array(StepsToolVersionSchema).min(1),
  stats: ToolStatsSchema
});

export const PromptToolSchema = z.object({
  kind: z.literal("prompt"),
  id: z.string().min(1),
  name: z.string().min(1),
  urlPatterns: z.array(z.string().min(1)).min(1),
  description: z.string().default(""),
  prompt: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
  versions: z.array(PromptToolVersionSchema).min(1),
  stats: ToolStatsSchema
});

export const ToolSchema = z.discriminatedUnion("kind", [StepsToolSchema, PromptToolSchema]);
```

Keep `RpcRequest` using `ToolDraftSchema`; no other RPC schema changes in this task.

- [ ] **Step 5: Run schema test to verify GREEN**

Run: `pnpm vitest run tests/shared/messages.test.ts`

Expected: pass.

- [ ] **Step 6: Confirm expected typecheck failures and do not commit yet**

Run: `pnpm typecheck`

Expected: fail in storage/UI callsites still using old draft shape. Do not commit after this task; Task 2 completes the storage migration and creates the first green checkpoint commit.

---

### Task 2: Storage And Export/Import V2

**Files:**
- Modify: `src/background/storage/tools.ts`
- Modify: `src/background/storage/export-import.ts`
- Test: `tests/background/storage/tools.test.ts`
- Test: `tests/background/storage/export-import.test.ts`

- [ ] **Step 1: Update storage tests for both tool kinds**

Replace old draft objects in `tests/background/storage/tools.test.ts` with helpers:

```typescript
import type { PromptToolDraft, Step, StepsToolDraft } from "@/shared/types";

const sampleSteps: Step[] = [{ kind: "tool", tool: "snapshotDOM", args: { maxDepth: 3 } }];

function stepsDraft(name: string): StepsToolDraft {
  return {
    kind: "steps",
    name,
    urlPatterns: ["https://example.com/*"],
    description: "",
    steps: sampleSteps,
    outputSchema: {}
  };
}

function promptDraft(name: string): PromptToolDraft {
  return {
    kind: "prompt",
    name,
    urlPatterns: ["https://example.com/*"],
    description: "",
    prompt: "请总结当前页面并返回 JSON"
  };
}
```

Add these assertions:

```typescript
it("saveDraft creates prompt and steps tools with v1", async () => {
  const steps = await saveDraft(stepsDraft("Steps"));
  const prompt = await saveDraft(promptDraft("Prompt"));

  expect(steps.kind).toBe("steps");
  expect(steps.versions[0]).toMatchObject({ kind: "steps", version: 1 });
  expect(prompt.kind).toBe("prompt");
  expect(prompt.versions[0]).toMatchObject({ kind: "prompt", version: 1 });

  const list = await listTools();
  expect(list.map((t) => t.kind).sort()).toEqual(["prompt", "steps"]);
});

it("filters invalid old tools from list/get/matching", async () => {
  const db = await getDB();
  await db.put("tools", {
    id: "old-1",
    name: "Old",
    urlPatterns: ["https://example.com/*"],
    description: "old",
    steps: sampleSteps,
    outputSchema: {},
    createdAt: 1,
    updatedAt: 1,
    versions: [{ version: 1, steps: sampleSteps, outputSchema: {}, createdAt: 1 }],
    stats: { runs: 0 }
  } as never);

  expect(await listTools()).toEqual([]);
  expect(await getTool("old-1")).toBeUndefined();
  expect(await matchingTools("https://example.com/a")).toEqual([]);
});
```

Import `getDB` from `@/background/storage/db` for the invalid old tool test.

- [ ] **Step 2: Update export/import tests for v2**

In `tests/background/storage/export-import.test.ts`, change all draft saves to include `kind: "steps"`. Change schema expectations to v2:

```typescript
expect(bundle.schema).toBe("aipagego.tools/v2");
```

Add prompt export test:

```typescript
it("exports prompt tools in v2 bundles", async () => {
  const t = await saveDraft({
    kind: "prompt",
    name: "Prompt",
    urlPatterns: ["https://example.com/*"],
    description: "",
    prompt: "请总结当前页面"
  });
  const bundle = await exportAll();
  expect(bundle.schema).toBe("aipagego.tools/v2");
  expect(bundle.tools[0]).toMatchObject({ id: t.id, kind: "prompt", prompt: "请总结当前页面" });
});
```

Change invalid schema test to assert v1 rejection:

```typescript
await expect(
  importBundle({ schema: "aipagego.tools/v1", exportedAt: Date.now(), tools: [] } as never, {
    onConflict: "skip"
  })
).rejects.toThrow("schema mismatch");
```

- [ ] **Step 3: Run storage tests to verify RED**

Run: `pnpm vitest run tests/background/storage/tools.test.ts tests/background/storage/export-import.test.ts`

Expected: fail because storage still writes old tools and v1 bundles.

- [ ] **Step 4: Implement storage union support**

In `src/background/storage/tools.ts`:

```typescript
import { ToolSchema } from "@/shared/messages";
import type { JsonSchema, PromptTool, StepsTool, Tool, ToolDraft } from "@/shared/types";
```

Replace local `ToolDraft` type with imported `ToolDraft`. Add helper:

```typescript
function parseTool(raw: unknown): Tool | undefined {
  const parsed = ToolSchema.safeParse(raw);
  return parsed.success ? (parsed.data as Tool) : undefined;
}
```

Replace `saveDraft` with:

```typescript
export async function saveDraft(draft: ToolDraft): Promise<Tool> {
  const db = await getDB();
  const now = Date.now();
  const base = {
    id: uuid(),
    name: draft.name,
    urlPatterns: draft.urlPatterns,
    description: draft.description,
    createdAt: now,
    updatedAt: now,
    stats: { runs: 0 }
  };

  const tool: Tool =
    draft.kind === "steps"
      ? ({
          ...base,
          kind: "steps",
          steps: draft.steps,
          outputSchema: draft.outputSchema,
          versions: [
            {
              version: 1,
              kind: "steps",
              steps: draft.steps,
              outputSchema: draft.outputSchema,
              createdAt: now
            }
          ]
        } satisfies StepsTool)
      : ({
          ...base,
          kind: "prompt",
          prompt: draft.prompt,
          versions: [{ version: 1, kind: "prompt", prompt: draft.prompt, createdAt: now }]
        } satisfies PromptTool);

  await db.put("tools", tool);
  return tool;
}
```

Replace `getTool` and `listTools` bodies:

```typescript
export async function listTools(): Promise<Tool[]> {
  const db = await getDB();
  return (await db.getAll("tools")).map(parseTool).filter((t): t is Tool => !!t);
}

export async function getTool(id: string): Promise<Tool | undefined> {
  const db = await getDB();
  return parseTool(await db.get("tools", id));
}
```

Update `appendVersion` to reject prompt tools for now because UI only uses it for steps repair:

```typescript
export async function appendVersion(
  id: string,
  patch: { steps: Step[]; outputSchema: JsonSchema; note?: string }
): Promise<Tool> {
  const db = await getDB();
  const tool = parseTool(await db.get("tools", id));
  if (!tool) throw new Error(`tool ${id} not found`);
  if (tool.kind !== "steps") throw new Error("appendVersion only supports steps tools");
  const next = (tool.versions.at(-1)?.version ?? 0) + 1;
  const now = Date.now();
  const updated: StepsTool = {
    ...tool,
    steps: patch.steps,
    outputSchema: patch.outputSchema,
    updatedAt: now,
    versions: [
      ...tool.versions,
      {
        version: next,
        kind: "steps",
        steps: patch.steps,
        outputSchema: patch.outputSchema,
        createdAt: now,
        note: patch.note
      }
    ]
  };
  await db.put("tools", updated);
  return updated;
}
```

Keep `matchingTools` using `listTools()`.

Keep `recordRunStat` parsing and updating both kinds safely:

```typescript
const tool = parseTool(await db.get("tools", id));
if (!tool) return;
```

- [ ] **Step 5: Implement export/import v2 validation**

In `src/background/storage/export-import.ts`, import `ToolSchema` and change export/import:

```typescript
import { ToolSchema } from "@/shared/messages";
import type { ExportBundle, Tool } from "@/shared/types";

function parseTool(raw: unknown): Tool | undefined {
  const parsed = ToolSchema.safeParse(raw);
  return parsed.success ? (parsed.data as Tool) : undefined;
}

export async function exportAll(): Promise<ExportBundle> {
  const db = await getDB();
  const tools = (await db.getAll("tools")).map(parseTool).filter((t): t is Tool => !!t);
  return { schema: "aipagego.tools/v2", exportedAt: Date.now(), tools };
}

export async function importBundle(
  raw: ExportBundle,
  opts: { onConflict: ConflictPolicy }
): Promise<ImportResult> {
  if (!raw || raw.schema !== "aipagego.tools/v2" || !Array.isArray(raw.tools)) {
    throw new Error("invalid bundle: schema mismatch");
  }
  const db = await getDB();
  let imported = 0;
  let skipped = 0;
  for (const candidate of raw.tools) {
    const incoming = parseTool(candidate);
    if (!incoming) {
      skipped++;
      continue;
    }
    const existing = parseTool(await db.get("tools", incoming.id));
    if (!existing) {
      await db.put("tools", incoming);
      imported++;
      continue;
    }
    if (opts.onConflict === "skip") {
      skipped++;
    } else if (opts.onConflict === "overwrite") {
      await db.put("tools", incoming);
      imported++;
    } else if (opts.onConflict === "copy") {
      await db.put("tools", { ...incoming, id: crypto.randomUUID() });
      imported++;
    }
  }
  return { imported, skipped };
}
```

- [ ] **Step 6: Run storage tests to verify GREEN**

Run: `pnpm vitest run tests/background/storage/tools.test.ts tests/background/storage/export-import.test.ts tests/shared/messages.test.ts`

Expected: pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/shared/types.ts src/shared/messages.ts src/background/storage/tools.ts src/background/storage/export-import.ts tests/shared/messages.test.ts tests/background/storage/tools.test.ts tests/background/storage/export-import.test.ts
git commit -m "feat: add prompt and steps tool schemas"
```

Expected: commit succeeds.

---

### Task 3: RPC And Runner Guardrails

**Files:**
- Modify: `src/background/rpc-handlers.ts`
- Modify: `src/sidepanel/rpc.ts`
- Test: `tests/background/rpc-handlers.test.ts`

- [ ] **Step 1: Write failing RPC tests**

Create `tests/background/rpc-handlers.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRpc } from "@/background/rpc-handlers";
import { _resetDBForTests } from "@/background/storage/db";
import { saveDraft } from "@/background/storage/tools";

vi.stubGlobal("chrome", {
  tabs: {
    get: vi.fn(async () => ({ id: 1, url: "https://example.com/" })),
    sendMessage: vi.fn()
  }
});

describe("rpc handlers tool kinds", () => {
  beforeEach(() => {
    _resetDBForTests();
    indexedDB = new IDBFactory();
    vi.clearAllMocks();
  });

  it("saves prompt drafts", async () => {
    const res = await handleRpc({
      type: "tools.save",
      draft: {
        kind: "prompt",
        name: "Prompt",
        urlPatterns: ["https://example.com/**"],
        description: "",
        prompt: "请总结当前页"
      }
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ kind: "prompt", prompt: "请总结当前页" });
  });

  it("rejects running prompt tools in background runner", async () => {
    const tool = await saveDraft({
      kind: "prompt",
      name: "Prompt",
      urlPatterns: ["https://example.com/**"],
      description: "",
      prompt: "请总结当前页"
    });

    const res = await handleRpc({ type: "runs.start", target: { kind: "tool", id: tool.id }, tabId: 1 });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("prompt tools run in chat");
  });
});
```

- [ ] **Step 2: Run RPC test to verify RED**

Run: `pnpm vitest run tests/background/rpc-handlers.test.ts`

Expected: fail because `runTool` still assumes every tool has `steps`.

- [ ] **Step 3: Update RPC handler**

In `src/background/rpc-handlers.ts`, update `tools.save` to pass the discriminated draft directly:

```typescript
case "tools.save":
  return (await saveDraft(req.draft as ToolDraft)) as unknown as Json;
```

Add `ToolDraft` import from `@/shared/types`.

In `runTool`, after `const tool = await getTool(req.target.id);` add:

```typescript
if (tool.kind !== "steps") throw new Error("prompt tools run in chat, not background runner");
steps = tool.steps;
```

For draft runs:

```typescript
if (req.target.kind === "draft") {
  if (req.target.draft.kind !== "steps") throw new Error("draft runs require steps tools");
  steps = req.target.draft.steps as Tool["steps"];
}
```

If `Tool["steps"]` no longer narrows cleanly, import `Step` and use `let steps: Step[];`.

- [ ] **Step 4: Run RPC test to verify GREEN**

Run: `pnpm vitest run tests/background/rpc-handlers.test.ts`

Expected: pass.

- [ ] **Step 5: Run background-related tests and commit**

Run: `pnpm vitest run tests/background tests/shared/messages.test.ts`

Expected: pass.

Commit:

```bash
git add src/background/rpc-handlers.ts src/sidepanel/rpc.ts tests/background/rpc-handlers.test.ts
git commit -m "feat: route prompt tools away from runner"
```

---

### Task 4: AI Tool Draft Generator

**Files:**
- Create: `src/sidepanel/llm/tool-draft-generator.ts`
- Test: `tests/sidepanel/llm/tool-draft-generator.test.ts`

- [ ] **Step 1: Write failing generator tests**

Create `tests/sidepanel/llm/tool-draft-generator.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { LlmClient, LlmStreamEvent } from "@/sidepanel/llm/types";
import {
  generatePromptToolDraft,
  generateStepsToolDraft,
  parseGeneratedJson
} from "@/sidepanel/llm/tool-draft-generator";

function clientWithText(text: string): LlmClient {
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield { type: "text_delta", text };
      yield { type: "message_end", usage: { input_tokens: 1, output_tokens: 1 } };
    }
  };
}

const base = {
  apiKey: "sk-test",
  model: "test-model",
  currentUrl: "https://example.com/item/1",
  messages: [{ role: "user" as const, content: "采集标题和评论" }],
  executedSteps: [{ kind: "tool" as const, tool: "snapshotDOM" as const, args: {} }],
  lastOutput: { title: "A" }
};

describe("tool draft generator", () => {
  it("parses fenced JSON", () => {
    expect(parseGeneratedJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("generates prompt tool drafts", async () => {
    const draft = await generatePromptToolDraft({
      ...base,
      client: clientWithText(
        JSON.stringify({
          name: "商品采集",
          description: "采集商品页字段",
          prompt: "请读取当前页面，返回 { title, reviews } JSON。"
        })
      )
    });

    expect(draft).toEqual({
      name: "商品采集",
      description: "采集商品页字段",
      prompt: "请读取当前页面，返回 { title, reviews } JSON。"
    });
  });

  it("rejects prompt drafts with secrets", async () => {
    await expect(
      generatePromptToolDraft({
        ...base,
        client: clientWithText(
          JSON.stringify({ name: "X", description: "Y", prompt: "Authorization: Bearer abc.def" })
        )
      })
    ).rejects.toThrow("sensitive");
  });

  it("generates steps tool drafts", async () => {
    const draft = await generateStepsToolDraft({
      ...base,
      client: clientWithText(
        JSON.stringify({
          name: "固定采集",
          description: "固定返回标题",
          steps: [{ kind: "js", source: "return { title: document.title };" }]
        })
      )
    });

    expect(draft.steps).toEqual([{ kind: "js", source: "return { title: document.title };" }]);
  });

  it("rejects invalid steps", async () => {
    await expect(
      generateStepsToolDraft({
        ...base,
        client: clientWithText(JSON.stringify({ name: "Bad", description: "Bad", steps: [] }))
      })
    ).rejects.toThrow("steps");
  });
});
```

- [ ] **Step 2: Run generator tests to verify RED**

Run: `pnpm vitest run tests/sidepanel/llm/tool-draft-generator.test.ts`

Expected: fail because the module does not exist.

- [ ] **Step 3: Implement generator**

Create `src/sidepanel/llm/tool-draft-generator.ts`:

```typescript
import { StepSchema } from "@/shared/messages";
import type { ChatMessage, Json, Step } from "@/shared/types";
import type { LlmClient } from "./types";

const MAX_NAME = 80;
const MAX_DESCRIPTION = 300;
const MAX_PROMPT = 8 * 1024;
const MAX_SOURCE = 32 * 1024;

export type ToolDraftGenerationInput = {
  client: LlmClient;
  apiKey: string;
  model: string;
  endpoint?: string;
  maxTokens?: number;
  currentUrl: string;
  messages: ChatMessage[];
  executedSteps: Step[];
  lastOutput: Json;
  abortSignal?: AbortSignal;
};

export type GeneratedPromptToolDraft = { name: string; description: string; prompt: string };
export type GeneratedStepsToolDraft = { name: string; description: string; steps: Step[] };

export function parseGeneratedJson(raw: string): unknown {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error(`AI returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function textFromMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (typeof m.content === "string") return `${m.role}: ${m.content}`;
      return `${m.role}: ${m.content
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n")}`;
    })
    .join("\n")
    .slice(0, 6000);
}

function stepsSummary(steps: Step[]): string {
  return steps
    .map((s, i) =>
      s.kind === "tool"
        ? `[${i}] tool ${s.tool} ${JSON.stringify(s.args).slice(0, 300)}`
        : `[${i}] js ${s.source.replace(/\s+/g, " ").slice(0, 300)}`
    )
    .join("\n");
}

function buildUserPrompt(input: ToolDraftGenerationInput, mode: "prompt" | "steps"): string {
  return [
    `# 当前 URL\n${input.currentUrl}`,
    `# 目标类型\n${mode === "prompt" ? "提示词工具" : "纯函数/固定步骤工具"}`,
    `# 多轮对话摘要\n${textFromMessages(input.messages)}`,
    `# 已执行步骤\n${stepsSummary(input.executedSteps)}`,
    `# 最后输出节选\n${JSON.stringify(input.lastOutput).slice(0, 2000)}`,
    "# 要求\n总结任务意图，不要机械复刻对话。只返回 JSON。"
  ].join("\n\n");
}

async function callJson(input: ToolDraftGenerationInput, system: string, mode: "prompt" | "steps"): Promise<unknown> {
  const stream = input.client.stream({
    apiKey: input.apiKey,
    model: input.model,
    endpoint: input.endpoint,
    maxTokens: input.maxTokens,
    system,
    messages: [{ role: "user", content: buildUserPrompt(input, mode) }],
    tools: [],
    abortSignal: input.abortSignal
  });
  let text = "";
  for await (const ev of stream) {
    if (input.abortSignal?.aborted) throw new DOMException("aborted", "AbortError");
    if (ev.type === "text_delta") text += ev.text;
    if (ev.type === "error") throw new Error(ev.error);
  }
  return parseGeneratedJson(text);
}

function requireString(obj: Record<string, unknown>, key: string, max: number): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`AI JSON field ${key} must be a non-empty string`);
  const s = v.trim();
  if (s.length > max) throw new Error(`AI JSON field ${key} is too long (${s.length} > ${max})`);
  return s;
}

function rejectSensitive(text: string): void {
  if (/\bBearer\s+[A-Za-z0-9._-]+/i.test(text) || /sk-[A-Za-z0-9_-]{12,}/.test(text) || /cookie\s*[:=]/i.test(text)) {
    throw new Error("AI prompt contains sensitive-looking content");
  }
}

export async function generatePromptToolDraft(input: ToolDraftGenerationInput): Promise<GeneratedPromptToolDraft> {
  const raw = await callJson(
    input,
    [
      "你是 AIPageGo 的提示词工具生成器。",
      "输出 JSON: {\"name\": string, \"description\": string, \"prompt\": string}。",
      "prompt 面向未来运行，要求 AI 基于当前页面执行任务，不引用旧对话。",
      "不要包含 API key、cookie、账号密码或 token。"
    ].join("\n"),
    "prompt"
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("AI JSON must be an object");
  const obj = raw as Record<string, unknown>;
  const draft = {
    name: requireString(obj, "name", MAX_NAME),
    description: requireString(obj, "description", MAX_DESCRIPTION),
    prompt: requireString(obj, "prompt", MAX_PROMPT)
  };
  rejectSensitive(draft.prompt);
  return draft;
}

export async function generateStepsToolDraft(input: ToolDraftGenerationInput): Promise<GeneratedStepsToolDraft> {
  const raw = await callJson(
    input,
    [
      "你是 AIPageGo 的纯函数/固定步骤工具生成器。",
      "输出 JSON: {\"name\": string, \"description\": string, \"steps\": Step[]}。",
      "优先生成单个 runJS 函数体；需要滚动、等待、点击时可以生成多 step。",
      "runJS 不调用 LLM、扩展 API，不输出敏感凭证。"
    ].join("\n"),
    "steps"
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("AI JSON must be an object");
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) throw new Error("AI JSON steps must be a non-empty array");
  const steps = obj.steps.map((s, i) => {
    const parsed = StepSchema.safeParse(s);
    if (!parsed.success) throw new Error(`AI step ${i} is invalid: ${parsed.error.message}`);
    if (parsed.data.kind === "js" && parsed.data.source.length > MAX_SOURCE) {
      throw new Error(`AI step ${i} source is too long`);
    }
    return parsed.data as Step;
  });
  return {
    name: requireString(obj, "name", MAX_NAME),
    description: requireString(obj, "description", MAX_DESCRIPTION),
    steps
  };
}
```

- [ ] **Step 4: Run generator tests to verify GREEN**

Run: `pnpm vitest run tests/sidepanel/llm/tool-draft-generator.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/sidepanel/llm/tool-draft-generator.ts tests/sidepanel/llm/tool-draft-generator.test.ts
git commit -m "feat: generate AI tool drafts"
```

---

### Task 5: Save-As-Tool Dialog Type Selection

**Files:**
- Modify: `src/sidepanel/components/save-as-tool-dialog.tsx`
- Test: `tests/sidepanel/components/save-as-tool-dialog.test.tsx`

- [ ] **Step 1: Write failing save dialog tests**

Create `tests/sidepanel/components/save-as-tool-dialog.test.tsx` with mocked generator and RPC:

```typescript
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SaveAsToolDialog } from "@/sidepanel/components/save-as-tool-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saveTool = vi.fn(async (draft) => ({ id: "saved-1", ...draft }));
const generatePromptToolDraft = vi.fn(async () => ({
  name: "提示词采集",
  description: "AI 重新执行采集",
  prompt: "请读取当前页面并返回 JSON"
}));
const generateStepsToolDraft = vi.fn(async () => ({
  name: "固定采集",
  description: "固定返回标题",
  steps: [{ kind: "js", source: "return { title: document.title };" }]
}));

vi.mock("@/sidepanel/rpc", () => ({ rpc: { saveTool } }));
vi.mock("@/sidepanel/llm/tool-draft-generator", () => ({
  generatePromptToolDraft,
  generateStepsToolDraft
}));
vi.mock("@/sidepanel/llm/client", () => ({ pickClient: vi.fn(() => ({ stream: vi.fn() })) }));

describe("SaveAsToolDialog", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    saveTool.mockClear();
    generatePromptToolDraft.mockClear();
    generateStepsToolDraft.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    act(() => {
      root.render(
        <SaveAsToolDialog
          initialName="old"
          initialDescription="old desc"
          initialUrl="https://example.com/item/1"
          steps={[{ kind: "tool", tool: "snapshotDOM", args: {} }]}
          lastOutput={{ title: "A" }}
          messages={[{ role: "user", content: "采集" }]}
          llmSettings={{
            provider: "openai",
            model: "gpt-test",
            apiKey: "sk-test",
            apiKeyMode: "session",
            maxRounds: 10,
            autoApproveDangerous: []
          }}
          onClose={() => undefined}
          onSaved={() => undefined}
        />
      );
    });
  }

  it("starts with type selection", () => {
    render();
    expect(container.textContent).toContain("提示词工具");
    expect(container.textContent).toContain("纯函数工具");
    expect(container.textContent).not.toContain("保存中");
  });

  it("generates and saves prompt tools", async () => {
    render();
    const promptBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "提示词工具");
    await act(async () => promptBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const genBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "让 AI 生成候选");
    await act(async () => genBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.textContent).toContain("请读取当前页面并返回 JSON");

    const saveBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "保存");
    await act(async () => saveBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(saveTool).toHaveBeenCalledWith(expect.objectContaining({ kind: "prompt", prompt: "请读取当前页面并返回 JSON" }));
  });

  it("generates and saves steps tools", async () => {
    render();
    const stepsBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "纯函数工具");
    await act(async () => stepsBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const genBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "让 AI 生成候选");
    await act(async () => genBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.textContent).toContain("return { title: document.title };");

    const saveBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "保存");
    await act(async () => saveBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(saveTool).toHaveBeenCalledWith(expect.objectContaining({ kind: "steps", steps: [{ kind: "js", source: "return { title: document.title };" }] }));
  });
});
```

- [ ] **Step 2: Run save dialog tests to verify RED**

Run: `pnpm vitest run tests/sidepanel/components/save-as-tool-dialog.test.tsx`

Expected: fail because current dialog has no type selection and still saves old `steps` draft.

- [ ] **Step 3: Replace summary state with candidate state**

In `src/sidepanel/components/save-as-tool-dialog.tsx`, remove `generateSummaryStep` import and `SummaryStepPanel`. Add imports:

```typescript
import {
  generatePromptToolDraft,
  generateStepsToolDraft,
  type GeneratedPromptToolDraft,
  type GeneratedStepsToolDraft
} from "../llm/tool-draft-generator";
```

Add state types:

```typescript
type ToolKindChoice = "prompt" | "steps";

type CandidateState =
  | { phase: "idle" }
  | { phase: "generating"; abort: AbortController }
  | { phase: "promptReady"; draft: GeneratedPromptToolDraft }
  | {
      phase: "stepsReady";
      draft: GeneratedStepsToolDraft;
      findings: ScanFinding[];
      severity: "info" | "caution" | "dangerous";
    }
  | { phase: "error"; error: string };
```

Use state:

```typescript
const [choice, setChoice] = useState<ToolKindChoice | null>(null);
const [candidate, setCandidate] = useState<CandidateState>({ phase: "idle" });
```

- [ ] **Step 4: Implement generation and save functions**

Replace old `generateSummary`, `acceptSummary`, and `save` with:

```typescript
async function generateCandidate() {
  if (!choice) return;
  if (!props.llmSettings.apiKey) {
    setCandidate({ phase: "error", error: "请先在设置页填入 API Key" });
    return;
  }
  const ac = new AbortController();
  setCandidate({ phase: "generating", abort: ac });
  try {
    const client = pickClient(props.llmSettings.provider);
    const input = {
      client,
      apiKey: props.llmSettings.apiKey,
      model: props.llmSettings.model,
      endpoint: props.llmSettings.endpoint,
      maxTokens: props.llmSettings.maxTokens,
      currentUrl: props.initialUrl,
      messages: props.messages,
      executedSteps: props.steps,
      lastOutput: props.lastOutput,
      abortSignal: ac.signal
    };
    if (choice === "prompt") {
      const draft = await generatePromptToolDraft(input);
      setName(draft.name);
      setDescription(draft.description);
      setCandidate({ phase: "promptReady", draft });
    } else {
      const draft = await generateStepsToolDraft(input);
      setName(draft.name);
      setDescription(draft.description);
      const findings = draft.steps.flatMap((step) => (step.kind === "js" ? runStaticScan(step.source) : []));
      setCandidate({ phase: "stepsReady", draft, findings, severity: highestSeverity(findings) });
    }
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") {
      setCandidate({ phase: "idle" });
      return;
    }
    setCandidate({ phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

function cancelGeneration() {
  if (candidate.phase === "generating") candidate.abort.abort();
  setCandidate({ phase: "idle" });
}

async function save() {
  setErr(null);
  setBusy(true);
  try {
    const urlPatterns = patternsText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (urlPatterns.length === 0) throw new Error("至少填一个 URL 模式");
    if (candidate.phase === "promptReady") {
      const tool = await rpc.saveTool({
        kind: "prompt",
        name,
        urlPatterns,
        description,
        prompt: candidate.draft.prompt
      });
      props.onSaved(tool.id);
      return;
    }
    if (candidate.phase === "stepsReady") {
      const tool = await rpc.saveTool({
        kind: "steps",
        name,
        urlPatterns,
        description,
        steps: candidate.draft.steps,
        outputSchema: inferJsonSchema(props.lastOutput)
      });
      props.onSaved(tool.id);
      return;
    }
    throw new Error("请先让 AI 生成候选工具");
  } catch (e) {
    setErr(e instanceof Error ? e.message : String(e));
  } finally {
    setBusy(false);
  }
}
```

- [ ] **Step 5: Implement two-stage JSX**

In the dialog body after `<h3>`, render type selection if `!choice`:

```tsx
{!choice && (
  <div className="grid grid-cols-1 gap-2">
    <button onClick={() => setChoice("prompt")} className="text-left bg-zinc-800 hover:bg-zinc-700 rounded p-3">
      <div className="text-emerald-300 font-medium">提示词工具</div>
      <div className="text-zinc-400 mt-1">适合多轮对话沉淀、页面略有变化、需要 AI 判断的任务。运行时回到聊天页由 AI 重新执行。</div>
    </button>
    <button onClick={() => setChoice("steps")} className="text-left bg-zinc-800 hover:bg-zinc-700 rounded p-3">
      <div className="text-sky-300 font-medium">纯函数工具</div>
      <div className="text-zinc-400 mt-1">适合字段采集、格式转换、页面结构稳定的任务。运行时不调用 LLM，直接执行固定 steps。</div>
    </button>
  </div>
)}
```

Render the existing name/url/description fields only when `choice` is set. Replace `SummaryStepPanel` with a new `CandidatePanel` local component that displays `promptReady` prompt or `stepsReady` JSON in `<pre>`. Save button disabled unless ready:

```tsx
disabled={busy || !(candidate.phase === "promptReady" || candidate.phase === "stepsReady")}
```

- [ ] **Step 6: Run save dialog tests to verify GREEN**

Run: `pnpm vitest run tests/sidepanel/components/save-as-tool-dialog.test.tsx`

Expected: pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/sidepanel/components/save-as-tool-dialog.tsx tests/sidepanel/components/save-as-tool-dialog.test.tsx
git commit -m "feat: generate tool candidates in save dialog"
```

---

### Task 6: Prompt Tool Chat Auto-Send Routing

**Files:**
- Modify: `src/sidepanel/app.tsx`
- Modify: `src/sidepanel/pages/chat-page.tsx`
- Test: `tests/sidepanel/pages/chat-page-autosend.test.tsx`

- [ ] **Step 1: Write failing ChatPage auto-send test**

Create `tests/sidepanel/pages/chat-page-autosend.test.tsx`:

```typescript
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatPage } from "@/sidepanel/pages/chat-page";
import { ensureSession, setCurrentTab, useStore } from "@/sidepanel/chat/session-store";
import { useSettings } from "@/sidepanel/chat/settings-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/sidepanel/rpc", () => ({
  currentTabInfo: vi.fn(async () => ({ tabId: 1, url: "https://example.com/" })),
  onTabRecommendations: vi.fn(() => () => undefined),
  rpc: {
    matchingTools: vi.fn(async () => []),
    startSession: vi.fn(async () => ({ id: "run-1" })),
    finalizeSession: vi.fn(async () => undefined)
  }
}));

vi.mock("@/sidepanel/llm/client", () => ({
  pickClient: vi.fn(() => ({
    async *stream() {
      yield { type: "text_delta", text: "完成" };
      yield { type: "message_end", usage: { input_tokens: 1, output_tokens: 1 } };
    }
  }))
}));

describe("ChatPage autoSend", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    useSettings.setState({
      loaded: true,
      provider: "openai",
      model: "gpt-test",
      apiKey: "sk-test",
      apiKeyMode: "session",
      endpoint: "",
      maxRounds: 5,
      maxTokens: 1000,
      autoApproveDangerous: []
    });
    useStore.setState({ sessionsByTab: {}, closedSessions: [], currentTabId: null });
    ensureSession(1, "https://example.com/");
    setCurrentTab(1);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("auto-sends the initial prompt once", async () => {
    await act(async () => {
      root.render(
        <ChatPage
          initialPrompt="请总结当前页"
          initialContext="# 保存的提示词工具\n名称：总结"
          autoSend
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const session = useStore.getState().sessionsByTab[1];
    expect(session.messages.some((m) => m.role === "user" && m.content === "请总结当前页")).toBe(true);
    expect(session.logs.some((l) => l.message.includes("autoSend"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run auto-send test to verify RED**

Run: `pnpm vitest run tests/sidepanel/pages/chat-page-autosend.test.tsx`

Expected: fail because `ChatPage` has no `autoSend` prop.

- [ ] **Step 3: Add route and prop types**

In `src/sidepanel/pages/chat-page.tsx`, extend props:

```typescript
type ChatPageProps = {
  initialPrompt?: string;
  initialContext?: string;
  autoSend?: boolean;
  sourceTool?: { id: string; name: string; description: string; urlPatterns: string[] };
  onOpenTool?: (id: string, autoRun: boolean) => void;
};
```

In `src/sidepanel/app.tsx`, extend route:

```typescript
type Route =
  | {
      name: "chat";
      initialPrompt?: string;
      initialContext?: string;
      autoSend?: boolean;
      sourceTool?: { id: string; name: string; description: string; urlPatterns: string[] };
    }
  | ...;
```

Add helper:

```typescript
function runPromptTool(tool: { id: string; name: string; description: string; prompt: string; urlPatterns: string[] }) {
  setRoute({
    name: "chat",
    initialPrompt: tool.prompt,
    initialContext: [
      "# 保存的提示词工具",
      `名称：${tool.name}`,
      `描述：${tool.description}`,
      `URL 模式：${tool.urlPatterns.join(", ")}`,
      "",
      "请把接下来用户消息视为一个已保存工具的任务说明。基于当前页面重新执行，不要机械复述旧对话；如果页面结构变化，请先读取页面再判断。"
    ].join("\n"),
    autoSend: true,
    sourceTool: { id: tool.id, name: tool.name, description: tool.description, urlPatterns: tool.urlPatterns }
  });
}
```

Pass props to `ChatPage`:

```tsx
<ChatPage
  key={(route.initialPrompt ?? "") + (route.initialContext ?? "") + (route.autoSend ? "auto" : "manual")}
  initialPrompt={route.initialPrompt}
  initialContext={route.initialContext}
  autoSend={route.autoSend}
  sourceTool={route.sourceTool}
  onOpenTool={openTool}
/>
```

- [ ] **Step 4: Implement ChatPage auto-send once**

In `ChatPage`, import `useRef` and add:

```typescript
const autoSentRef = useRef(false);
```

After `send` is defined, add effect:

```typescript
useEffect(() => {
  if (!autoSend || autoSentRef.current || !initialPrompt?.trim()) return;
  if (currentTabId == null || !settings.loaded) return;
  autoSentRef.current = true;
  if (sourceTool) {
    session.appendLog("info", `autoSend source tool: ${sourceTool.name} (${sourceTool.id})`);
  } else {
    session.appendLog("info", "autoSend initial prompt");
  }
  void send(initialPrompt);
}, [autoSend, initialPrompt, currentTabId, settings.loaded, send, session, sourceTool]);
```

Keep textarea initialized with `initialPrompt`; auto-send will clear it through existing `send()`.

- [ ] **Step 5: Run auto-send test to verify GREEN**

Run: `pnpm vitest run tests/sidepanel/pages/chat-page-autosend.test.tsx`

Expected: pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/sidepanel/app.tsx src/sidepanel/pages/chat-page.tsx tests/sidepanel/pages/chat-page-autosend.test.tsx
git commit -m "feat: auto-send prompt tools in chat"
```

---

### Task 7: Tool Detail And Recommendations By Tool Kind

**Files:**
- Modify: `src/sidepanel/pages/tool-detail-page.tsx`
- Modify: `src/sidepanel/components/recommendations-banner.tsx`
- Modify: `src/sidepanel/pages/tools-page.tsx`
- Test: `tests/sidepanel/pages/tool-detail-page.test.tsx`
- Test: `tests/sidepanel/components/recommendations-banner.test.tsx`

- [ ] **Step 1: Update ToolDetailPage tests**

In `tests/sidepanel/pages/tool-detail-page.test.tsx`, update mock steps tool to include `kind: "steps"` in root and version. Add prompt test:

```typescript
import { rpc } from "@/sidepanel/rpc";

it("renders prompt tools with chat run action", async () => {
  vi.mocked(rpc.getTool).mockResolvedValueOnce({
    kind: "prompt",
    id: "prompt-1",
    name: "智能总结",
    urlPatterns: ["https://example.com/**"],
    description: "总结当前页",
    prompt: "请总结当前页",
    createdAt: 1,
    updatedAt: 1,
    versions: [{ version: 1, kind: "prompt", prompt: "请总结当前页", createdAt: 1 }],
    stats: { runs: 0 }
  });
  const runPromptTool = vi.fn();

  await act(async () => {
    root.render(<ToolDetailPage id="prompt-1" onBack={() => undefined} onRunPromptTool={runPromptTool} />);
  });
  await act(async () => Promise.resolve());

  expect(container.textContent).toContain("提示词工具");
  expect(container.textContent).toContain("请总结当前页");
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "在聊天中运行");
  await act(async () => btn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(runPromptTool).toHaveBeenCalledWith(expect.objectContaining({ id: "prompt-1", prompt: "请总结当前页" }));
});
```

- [ ] **Step 2: Add RecommendationsBanner tests**

Create `tests/sidepanel/components/recommendations-banner.test.tsx`:

```typescript
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RecommendationsBanner } from "@/sidepanel/components/recommendations-banner";
import type { Tool } from "@/shared/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const promptTool: Tool = {
  kind: "prompt",
  id: "p1",
  name: "智能总结",
  urlPatterns: ["https://example.com/**"],
  description: "",
  prompt: "请总结",
  createdAt: 1,
  updatedAt: 1,
  versions: [{ version: 1, kind: "prompt", prompt: "请总结", createdAt: 1 }],
  stats: { runs: 0 }
};

describe("RecommendationsBanner", () => {
  it("runs prompt tools through prompt callback", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onOpenTool = vi.fn();
    const onRunPromptTool = vi.fn();

    act(() => {
      root.render(<RecommendationsBanner tools={[promptTool]} onOpenTool={onOpenTool} onRunPromptTool={onRunPromptTool} />);
    });

    const run = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "运行");
    act(() => run?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onRunPromptTool).toHaveBeenCalledWith(promptTool);
    expect(onOpenTool).not.toHaveBeenCalledWith("p1", true);

    act(() => root.unmount());
    container.remove();
  });
});
```

- [ ] **Step 3: Run UI kind tests to verify RED**

Run: `pnpm vitest run tests/sidepanel/pages/tool-detail-page.test.tsx tests/sidepanel/components/recommendations-banner.test.tsx`

Expected: fail because props and kind rendering do not exist.

- [ ] **Step 4: Update ToolDetailPage**

In `src/sidepanel/pages/tool-detail-page.tsx`, extend props:

```typescript
onRunPromptTool?: (tool: Extract<Tool, { kind: "prompt" }>) => void;
```

After loading `tool`, branch render:

```typescript
if (tool.kind === "prompt") {
  return (
    <div className="h-full overflow-auto p-3 flex flex-col gap-3 text-xs">
      <button onClick={props.onBack} className="self-start text-zinc-400">← 返回</button>
      <div className="flex items-center gap-2">
        <h2 className="text-base font-medium">{tool.name}</h2>
        <span className="px-1.5 py-0.5 bg-emerald-900/50 text-emerald-200 rounded">提示词工具</span>
      </div>
      <div className="text-zinc-400">{tool.urlPatterns.join(", ")}</div>
      <p className="text-zinc-300 whitespace-pre-wrap">{tool.description}</p>
      <button
        onClick={() => props.onRunPromptTool?.(tool)}
        className="self-start px-3 py-1 bg-emerald-700 rounded disabled:opacity-50"
        disabled={!props.onRunPromptTool}
      >
        在聊天中运行
      </button>
      <details className="bg-zinc-900/40 rounded" open>
        <summary className="cursor-pointer p-2 text-zinc-300">提示词（v{tool.versions.at(-1)?.version}）</summary>
        <pre className="p-2 pt-0 text-[11px] text-zinc-300 whitespace-pre-wrap">{tool.prompt}</pre>
      </details>
    </div>
  );
}
```

Keep existing steps rendering in the `else` branch, adding badge `纯函数工具` and only using `tool.steps` after narrowing.

- [ ] **Step 5: Update RecommendationsBanner**

In `src/sidepanel/components/recommendations-banner.tsx`, extend props:

```typescript
onRunPromptTool: (tool: Extract<Tool, { kind: "prompt" }>) => void;
```

Change run button:

```tsx
<button
  onClick={() => (t.kind === "prompt" ? props.onRunPromptTool(t) : props.onOpenTool(t.id, true))}
  className="px-2 py-0.5 bg-emerald-700 rounded"
  title={t.kind === "prompt" ? "在聊天中运行提示词工具" : "跳到工具详情页并自动运行"}
>
  运行
</button>
```

Add badge near name:

```tsx
<span className="text-[10px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-400">
  {t.kind === "prompt" ? "提示词" : "纯函数"}
</span>
```

- [ ] **Step 6: Wire App and ToolsPage**

In `src/sidepanel/app.tsx`, pass `runPromptTool` into `RecommendationsBanner` through `ChatPage` and into `ToolDetailPage`:

```tsx
<ToolDetailPage ... onRunPromptTool={runPromptTool} />
```

In `ChatPageProps`, add:

```typescript
onRunPromptTool?: (tool: Extract<Tool, { kind: "prompt" }>) => void;
```

Pass to banner:

```tsx
<RecommendationsBanner tools={recommendations} onOpenTool={...} onRunPromptTool={props.onRunPromptTool ?? (() => undefined)} />
```

In `src/sidepanel/pages/tools-page.tsx`, display kind badge in each row:

```tsx
<span className="text-[10px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-400">
  {t.kind === "prompt" ? "提示词" : "纯函数"}
</span>
```

- [ ] **Step 7: Run kind UI tests to verify GREEN**

Run: `pnpm vitest run tests/sidepanel/pages/tool-detail-page.test.tsx tests/sidepanel/components/recommendations-banner.test.tsx`

Expected: pass.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/sidepanel/pages/tool-detail-page.tsx src/sidepanel/components/recommendations-banner.tsx src/sidepanel/pages/tools-page.tsx src/sidepanel/app.tsx src/sidepanel/pages/chat-page.tsx tests/sidepanel/pages/tool-detail-page.test.tsx tests/sidepanel/components/recommendations-banner.test.tsx
git commit -m "feat: run prompt tools through chat UI"
```

---

### Task 8: Update Remaining Tests And Call Sites

**Files:**
- Modify: all tests that construct `Tool` or draft objects without `kind`
- Modify: all source callsites that access `tool.steps` without narrowing

- [ ] **Step 1: Find old tool literals**

Run:

```bash
rg -n "steps: \[|outputSchema|versions: \[" tests src | head -200
```

Expected: list of remaining old literals.

- [ ] **Step 2: Update remaining literals**

For every steps tool literal, add:

```typescript
kind: "steps",
```

For every steps version literal, add:

```typescript
kind: "steps",
```

For every draft passed to `saveDraft` or `rpc.saveTool` that contains `steps`, add:

```typescript
kind: "steps",
```

For any prompt tool test literal, use:

```typescript
{
  kind: "prompt",
  id: "prompt-1",
  name: "Prompt",
  urlPatterns: ["https://example.com/**"],
  description: "Prompt tool",
  prompt: "请总结当前页",
  createdAt: 1,
  updatedAt: 1,
  versions: [{ version: 1, kind: "prompt", prompt: "请总结当前页", createdAt: 1 }],
  stats: { runs: 0 }
}
```

- [ ] **Step 3: Fix TypeScript narrowing issues**

Run: `pnpm typecheck`

For errors like `Property 'steps' does not exist on type 'Tool'`, add narrowing:

```typescript
if (tool.kind !== "steps") throw new Error("steps tool required");
```

or branch rendering by `tool.kind` in UI.

Expected after fixes: `pnpm typecheck` exits 0.

- [ ] **Step 4: Run full tests**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add src tests
git commit -m "test: update tool fixtures for typed tools"
```

---

### Task 9: Build Verification And Manual Checklist

**Files:**
- No source files expected unless verification reveals defects.

- [ ] **Step 1: Run typecheck**

Run: `pnpm typecheck`

Expected: exit 0.

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`

Expected: all test files pass, zero failures.

- [ ] **Step 3: Build extension**

Run: `pnpm build`

Expected: Vite build succeeds and `dist/manifest.json` exists.

- [ ] **Step 4: Inspect manifest version and build output**

Run:

```bash
node -e "const m=require('./dist/manifest.json'); console.log(m.name, m.version)"
```

Expected: prints AIPageGo extension name and current package version.

- [ ] **Step 5: Manual browser verification**

Load `dist/` in Chrome and verify:

1. Start a multi-turn chat on a page.
2. Click `保存为工具`.
3. Select `提示词工具`.
4. Click `让 AI 生成候选`.
5. Save the prompt tool.
6. Open a matching page and click the prompt tool `运行`.
7. Confirm ChatPage opens and auto-sends the generated prompt.
8. Repeat save flow with `纯函数工具`.
9. Confirm tool detail runs the generated steps without starting a chat LLM run.

- [ ] **Step 6: Commit verification fixes if any**

If manual verification required code changes, run the relevant focused tests plus `pnpm typecheck && pnpm test && pnpm build`, then commit:

```bash
git add src tests
git commit -m "fix: polish AI-generated tool types"
```

If no code changes were needed, do not create an empty commit.

---

## Self-Review Checklist

- Spec coverage: data model, save UX, AI generators, prompt runtime, steps runtime, matching/list/detail/export/import, errors, and tests are covered by Tasks 1-9.
- No old-data compatibility is implemented; invalid old records are filtered and v1 imports are rejected.
- Type names are consistent: `PromptTool`, `StepsTool`, `ToolDraft`, `generatePromptToolDraft`, `generateStepsToolDraft`, `autoSend`, `onRunPromptTool`.
- Prompt tools do not call the background runner; steps tools keep the existing runner.
- Static scan remains label-only for generated runJS candidates.
