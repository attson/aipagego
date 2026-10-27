import { describe, expect, it } from "vitest";
import type { Step } from "@aipagego/shared/types";
import {
  addWorkflowStep,
  deleteWorkflowStep,
  duplicateWorkflowStep,
  moveWorkflowStep,
  reorderWorkflowStep,
  validateWorkflowDraft,
} from "@/sidepanel/workflow-studio/editor-model";
import type { WorkflowDraft } from "@/sidepanel/workflow-studio/draft-storage";

const first: Step = {
  kind: "tool",
  tool: "extractText",
  args: { selector: "h1" },
  bindResultTo: "title"
};
const second: Step = {
  kind: "tool",
  tool: "fillInput",
  args: { selector: "#q", value: "${title}" }
};

function draft(): WorkflowDraft {
  return {
    toolId: "tool-1",
    basedOnVersion: 1,
    parameters: [],
    steps: [first, second],
    outputSchema: {}
  };
}

describe("workflow studio editor model", () => {
  it("adds, duplicates and deletes steps without mutating the source draft", () => {
    const source = draft();
    const added = addWorkflowStep(source, { kind: "js", source: "return null" });
    const duplicated = duplicateWorkflowStep(added, 0);
    const deleted = deleteWorkflowStep(duplicated, 1);

    expect(source.steps).toHaveLength(2);
    expect(added.steps).toHaveLength(3);
    expect(duplicated.steps[1]).toEqual(first);
    expect(duplicated.steps[1]).not.toBe(first);
    expect(deleted.steps).toHaveLength(3);
  });

  it("supports button moves and drag reorder", () => {
    const source = addWorkflowStep(draft(), { kind: "js", source: "return 3" });

    expect(moveWorkflowStep(source, 1, -1).steps[0]).toEqual(second);
    expect(reorderWorkflowStep(source, 2, 0).steps.map((step) => step.kind)).toEqual([
      "js", "tool", "tool"
    ]);
  });

  it("reports parameter schema and dependency errors together", () => {
    const source = draft();
    source.parameters = [{
      key: "secret",
      label: "Secret",
      type: "string",
      required: true,
      sensitive: true,
      defaultValue: "forbidden"
    }];
    source.steps = [{
      kind: "tool",
      tool: "fillInput",
      args: { selector: "#q", value: "${future}" }
    }];

    const issues = validateWorkflowDraft(source);

    expect(issues.some((issue) => issue.code === "invalid_parameter")).toBe(true);
    expect(issues.some((issue) => issue.code === "unknown_binding")).toBe(true);
  });
});
