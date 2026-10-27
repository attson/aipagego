import { ToolParameterSchema } from "@aipagego/shared/messages";
import type { Step } from "@aipagego/shared/types";
import { analyzeWorkflow, type WorkflowIssueCode } from "@aipagego/shared/workflow";
import type { WorkflowDraft } from "./draft-storage";

export type WorkflowEditorIssue =
  | {
      code: "invalid_parameter";
      parameterIndex: number;
      message: string;
    }
  | {
      code: WorkflowIssueCode;
      binding: string;
      stepIndex?: number;
      path?: string;
    };

function cloneStep(step: Step): Step {
  return JSON.parse(JSON.stringify(step)) as Step;
}

function withSteps(draft: WorkflowDraft, steps: Step[]): WorkflowDraft {
  return { ...draft, steps };
}

export function addWorkflowStep(draft: WorkflowDraft, step: Step): WorkflowDraft {
  return withSteps(draft, [...draft.steps, cloneStep(step)]);
}

export function duplicateWorkflowStep(draft: WorkflowDraft, index: number): WorkflowDraft {
  const step = draft.steps[index];
  if (!step) return draft;
  const steps = [...draft.steps];
  steps.splice(index + 1, 0, cloneStep(step));
  return withSteps(draft, steps);
}

export function deleteWorkflowStep(draft: WorkflowDraft, index: number): WorkflowDraft {
  if (!draft.steps[index]) return draft;
  return withSteps(draft, draft.steps.filter((_, current) => current !== index));
}

export function reorderWorkflowStep(
  draft: WorkflowDraft,
  from: number,
  to: number,
): WorkflowDraft {
  if (from === to || from < 0 || to < 0 || from >= draft.steps.length || to >= draft.steps.length) {
    return draft;
  }
  const steps = [...draft.steps];
  const [step] = steps.splice(from, 1);
  steps.splice(to, 0, step);
  return withSteps(draft, steps);
}

export function moveWorkflowStep(
  draft: WorkflowDraft,
  index: number,
  delta: -1 | 1,
): WorkflowDraft {
  return reorderWorkflowStep(draft, index, index + delta);
}

export function validateWorkflowDraft(draft: WorkflowDraft): WorkflowEditorIssue[] {
  const parameterIssues: WorkflowEditorIssue[] = [];
  draft.parameters.forEach((parameter, parameterIndex) => {
    const parsed = ToolParameterSchema.safeParse(parameter);
    if (!parsed.success) {
      parameterIssues.push({
        code: "invalid_parameter",
        parameterIndex,
        message: parsed.error.issues[0]?.message ?? "invalid parameter"
      });
    }
  });
  return [
    ...parameterIssues,
    ...analyzeWorkflow({
      parameters: draft.parameters,
      steps: draft.steps,
      outputBinding: draft.outputBinding,
    }).issues
  ];
}
