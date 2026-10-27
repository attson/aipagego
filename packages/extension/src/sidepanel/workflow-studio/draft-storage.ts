import type {
  JsonSchema,
  Step,
  StepsTool,
  ToolParameter,
} from "@aipagego/shared/types";
import { getActiveStepsVersion } from "@aipagego/shared/workflow";

const DRAFT_PREFIX = "aipagego.workflowDraft:";

export type WorkflowDraft = {
  toolId: string;
  basedOnVersion: number;
  parameters: ToolParameter[];
  steps: Step[];
  outputBinding?: string;
  outputSchema: JsonSchema;
  note?: string;
};

export type WorkflowDraftLoadResult =
  | { status: "none"; draft: WorkflowDraft }
  | { status: "ready"; draft: WorkflowDraft }
  | { status: "conflict"; draft: WorkflowDraft; activeVersion: number };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function draftKey(toolId: string, basedOnVersion: number): string {
  return `${DRAFT_PREFIX}${toolId}:${basedOnVersion}`;
}

function toolPrefix(toolId: string): string {
  return `${DRAFT_PREFIX}${toolId}:`;
}

function sanitizeDraft(draft: WorkflowDraft): WorkflowDraft {
  return clone({
    ...draft,
    parameters: draft.parameters.map((parameter) => {
      if (!parameter.sensitive) return parameter;
      const { defaultValue: _defaultValue, ...safe } = parameter;
      return safe;
    })
  });
}

function isWorkflowDraft(value: unknown): value is WorkflowDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<WorkflowDraft>;
  return typeof draft.toolId === "string" &&
    Number.isInteger(draft.basedOnVersion) &&
    Array.isArray(draft.parameters) &&
    Array.isArray(draft.steps);
}

export function createWorkflowDraft(tool: StepsTool): WorkflowDraft {
  const snapshot = getActiveStepsVersion(tool);
  return clone({
    toolId: tool.id,
    basedOnVersion: snapshot.version,
    parameters: snapshot.parameters,
    steps: snapshot.steps,
    ...(snapshot.outputBinding === undefined ? {} : { outputBinding: snapshot.outputBinding }),
    outputSchema: snapshot.outputSchema,
  });
}

export async function saveWorkflowDraft(draft: WorkflowDraft): Promise<void> {
  const safe = sanitizeDraft(draft);
  await chrome.storage.session.set({
    [draftKey(safe.toolId, safe.basedOnVersion)]: safe
  });
}

export async function loadWorkflowDraft(tool: StepsTool): Promise<WorkflowDraftLoadResult> {
  const fresh = createWorkflowDraft(tool);
  const all = await chrome.storage.session.get(null);
  const prefix = toolPrefix(tool.id);
  const stored = Object.entries(all)
    .filter(([key, value]) => key.startsWith(prefix) && isWorkflowDraft(value))
    .map(([, value]) => sanitizeDraft(value as WorkflowDraft))
    .sort((a, b) => b.basedOnVersion - a.basedOnVersion)[0];
  if (!stored) return { status: "none", draft: fresh };
  if (stored.basedOnVersion !== fresh.basedOnVersion) {
    return {
      status: "conflict",
      draft: stored,
      activeVersion: fresh.basedOnVersion
    };
  }
  return { status: "ready", draft: stored };
}

export async function clearWorkflowDraft(toolId: string): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(toolPrefix(toolId)));
  if (keys.length > 0) await chrome.storage.session.remove(keys);
}
