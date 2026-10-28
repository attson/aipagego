import { matchesAny } from "@aipagego/shared/url-pattern";
import { ToolSchema } from "@aipagego/shared/messages";
import type {
  JsonSchema,
  PromptTool,
  Step,
  StepsTool,
  Tool,
  ToolDraft,
  ToolOrigin,
  ToolParameter,
} from "@aipagego/shared/types";
import { PRESETS } from "@aipagego/shared/presets";
import { analyzeWorkflow, getActiveStepsVersion } from "@aipagego/shared/workflow";
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
          activeVersion: 1,
          versions: [
            {
              version: 1,
              kind: "steps",
              parameters: draft.parameters ?? [],
              steps: draft.steps,
              outputBinding: draft.outputBinding,
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
  const parsed = ToolSchema.safeParse(tool);
  if (!parsed.success) throw new Error(`invalid_workflow: ${parsed.error.message}`);
  await db.put("tools", parsed.data as Tool);
  return parsed.data as Tool;
}

export async function appendVersion(
  id: string,
  patch: {
    steps: Step[];
    outputSchema: JsonSchema;
    parameters?: ToolParameter[];
    outputBinding?: string;
    basedOnVersion?: number;
    note?: string;
  }
): Promise<Tool> {
  const db = await getDB();
  const tx = db.transaction("tools", "readwrite");
  try {
    const tool = parseTool(await tx.store.get(id));
    if (!tool) throw new Error(`tool ${id} not found`);
    if (tool.kind !== "steps") throw new Error("appendVersion only supports steps tools");
    const activeSnapshot = getActiveStepsVersion(tool);
    const basedOnVersion = patch.basedOnVersion ?? activeSnapshot.version;
    const baseSnapshot = tool.versions.find((version) => version.version === basedOnVersion);
    if (!baseSnapshot) throw new Error(`workflow_version_not_found: ${basedOnVersion}`);
    const next = Math.max(...tool.versions.map((version) => version.version)) + 1;
    const now = Date.now();
    const outputBinding = Object.hasOwn(patch, "outputBinding")
      ? patch.outputBinding
      : baseSnapshot.outputBinding;
    const updated: StepsTool = {
      ...tool,
      activeVersion: next,
      updatedAt: now,
      versions: [
        ...tool.versions,
        {
          version: next,
          kind: "steps",
          parameters: patch.parameters ?? baseSnapshot.parameters ?? [],
          steps: patch.steps,
          ...(outputBinding === undefined ? {} : { outputBinding }),
          outputSchema: patch.outputSchema,
          createdAt: now,
          ...(patch.note === undefined ? {} : { note: patch.note }),
          basedOnVersion,
        }
      ]
    };
    const parsed = ToolSchema.safeParse(updated);
    if (!parsed.success) throw new Error(`invalid_workflow: ${parsed.error.message}`);
    await tx.store.put(parsed.data as Tool);
    await tx.done;
    return parsed.data as Tool;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may already have completed or aborted.
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
}

export type PublishWorkflowInput = {
  basedOnVersion: number;
  parameters: ToolParameter[];
  steps: Step[];
  outputBinding?: string;
  outputSchema: JsonSchema;
  note?: string;
};

export async function publishWorkflow(
  id: string,
  input: PublishWorkflowInput,
): Promise<Tool> {
  const db = await getDB();
  const tx = db.transaction("tools", "readwrite");
  try {
    const tool = parseTool(await tx.store.get(id));
    if (!tool) throw new Error(`tool ${id} not found`);
    if (tool.kind !== "steps") throw new Error("workflow publish only supports steps tools");

    const activeSnapshot = getActiveStepsVersion(tool);
    if (activeSnapshot.version !== input.basedOnVersion) {
      throw new Error(
        `workflow_version_conflict: expected ${input.basedOnVersion}, active ${activeSnapshot.version}`
      );
    }

    const analysis = analyzeWorkflow(input);
    if (analysis.issues.length > 0) {
      throw new Error(`invalid_workflow: ${JSON.stringify(analysis.issues)}`);
    }

    const next = Math.max(...tool.versions.map((version) => version.version)) + 1;
    const now = Date.now();
    const updated: StepsTool = {
      ...tool,
      activeVersion: next,
      updatedAt: now,
      versions: [
        ...tool.versions,
        {
          version: next,
          kind: "steps",
          parameters: input.parameters,
          steps: input.steps,
          outputBinding: input.outputBinding,
          outputSchema: input.outputSchema,
          createdAt: now,
          note: input.note,
          basedOnVersion: input.basedOnVersion,
        }
      ]
    };
    const parsed = ToolSchema.safeParse(updated);
    if (!parsed.success) {
      throw new Error(`invalid_workflow: ${parsed.error.message}`);
    }
    await tx.store.put(parsed.data as Tool);
    await tx.done;
    return parsed.data as Tool;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may already have completed or aborted after an IDB error.
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
}

export async function activateWorkflowVersion(id: string, version: number): Promise<Tool> {
  const db = await getDB();
  const tx = db.transaction("tools", "readwrite");
  try {
    const tool = parseTool(await tx.store.get(id));
    if (!tool) throw new Error(`tool ${id} not found`);
    if (tool.kind !== "steps") throw new Error("workflow activation only supports steps tools");
    if (!tool.versions.some((snapshot) => snapshot.version === version)) {
      throw new Error(`workflow_version_not_found: ${version}`);
    }
    const updated: StepsTool = {
      ...tool,
      activeVersion: version,
      updatedAt: Math.max(Date.now(), tool.updatedAt + 1),
    };
    await tx.store.put(updated);
    await tx.done;
    return updated;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may already have completed or aborted.
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
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
    activeVersion: 1,
    createdAt: now,
    updatedAt: now,
    versions: [
      {
        version: 1,
        kind: "steps",
        parameters: [],
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
