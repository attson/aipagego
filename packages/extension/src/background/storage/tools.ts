import { matchesAny } from "@aipagego/shared/url-pattern";
import { ToolSchema } from "@aipagego/shared/messages";
import type { JsonSchema, PromptTool, Step, StepsTool, Tool, ToolDraft, ToolOrigin } from "@aipagego/shared/types";
import { PRESETS } from "@aipagego/shared/presets";
import { getDB } from "./db";

function uuid(): string {
  return crypto.randomUUID();
}

function parseTool(raw: unknown): Tool | undefined {
  const parsed = ToolSchema.safeParse(raw);
  return parsed.success ? (parsed.data as Tool) : undefined;
}

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

export async function listTools(): Promise<Tool[]> {
  const db = await getDB();
  return (await db.getAll("tools")).map(parseTool).filter((t): t is Tool => !!t);
}

export async function getTool(id: string): Promise<Tool | undefined> {
  const db = await getDB();
  return parseTool(await db.get("tools", id));
}

export async function deleteTool(id: string): Promise<void> {
  const db = await getDB();
  await db.delete("tools", id);
}

export async function matchingTools(url: string): Promise<Tool[]> {
  const all = await listTools();
  return all.filter((t) => matchesAny(url, t.urlPatterns));
}

/**
 * Copy a tool-form Preset into IDB. If a tool already exists for the same
 * presetId, return it (idempotent). Prompt-form presets cannot be materialized
 * — they are used as suggestion text only.
 */
export async function materializePreset(presetId: string): Promise<Tool> {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`unknown preset: ${presetId}`);
  if (preset.kind !== "tool") {
    throw new Error(`prompt preset ${presetId} is not materializable`);
  }

  const existing = (await listTools()).find(
    (t) => t.origin?.kind === "preset" && t.origin.presetId === presetId
  );
  if (existing) return existing;

  const origin: ToolOrigin = {
    kind: "preset",
    presetId: preset.id,
    presetVersion: preset.version
  };
  const now = Date.now();
  const tool: StepsTool = {
    id: uuid(),
    kind: "steps",
    name: preset.name,
    description: preset.description,
    urlPatterns: [...preset.urlPatterns],
    steps: JSON.parse(JSON.stringify(preset.steps)) as Step[],
    outputSchema: (preset.expectedResultShape ?? {}) as JsonSchema,
    createdAt: now,
    updatedAt: now,
    versions: [
      {
        version: 1,
        kind: "steps",
        steps: JSON.parse(JSON.stringify(preset.steps)) as Step[],
        outputSchema: (preset.expectedResultShape ?? {}) as JsonSchema,
        createdAt: now
      }
    ],
    stats: { runs: 0 },
    origin
  };

  const db = await getDB();
  await db.put("tools", tool);
  return tool;
}

export async function recordRunStat(id: string, ok: boolean): Promise<void> {
  const db = await getDB();
  const tool = parseTool(await db.get("tools", id));
  if (!tool) return;
  tool.stats.runs += 1;
  tool.stats.lastRunAt = Date.now();
  tool.stats.lastRunOk = ok;
  await db.put("tools", tool);
}
