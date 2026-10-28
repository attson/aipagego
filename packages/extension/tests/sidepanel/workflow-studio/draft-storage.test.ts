import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StepsTool } from "@aipagego/shared/types";
import {
  createWorkflowDraft,
  loadWorkflowDraft,
  saveWorkflowDraft,
} from "@/sidepanel/workflow-studio/draft-storage";

function tool(): StepsTool {
  return {
    kind: "steps",
    id: "tool-1",
    name: "Workflow",
    description: "",
    urlPatterns: ["https://example.com/**"],
    activeVersion: 1,
    createdAt: 1,
    updatedAt: 2,
    stats: { runs: 0 },
    versions: [
      {
        version: 1,
        kind: "steps",
        parameters: [],
        steps: [{ kind: "tool", tool: "extractText", args: { selector: ".active" } }],
        outputSchema: { type: "string" },
        createdAt: 1
      },
      {
        version: 2,
        kind: "steps",
        parameters: [],
        steps: [{ kind: "tool", tool: "extractText", args: { selector: ".latest" } }],
        outputSchema: {},
        createdAt: 2
      }
    ]
  };
}

describe("workflow studio draft storage", () => {
  let rows: Record<string, unknown>;

  beforeEach(() => {
    rows = {};
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: vi.fn(async (keys?: string | string[] | null) => {
            if (keys == null) return { ...rows };
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.filter((key) => key in rows).map((key) => [key, rows[key]]));
          }),
          set: vi.fn(async (patch: Record<string, unknown>) => { Object.assign(rows, patch); }),
          remove: vi.fn(async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete rows[key];
          })
        }
      }
    });
  });

  it("starts from the active snapshot rather than the latest version", () => {
    const draft = createWorkflowDraft(tool());

    expect(draft.basedOnVersion).toBe(1);
    expect(draft.steps[0]).toMatchObject({ args: { selector: ".active" } });
    expect(draft.outputSchema).toEqual({ type: "string" });
  });

  it("strips sensitive defaults before saving and restores the matching draft", async () => {
    const draft = createWorkflowDraft(tool());
    draft.parameters = [{
      key: "secret",
      label: "Secret",
      type: "string",
      required: true,
      sensitive: true,
      defaultValue: "must-not-persist"
    }];

    await saveWorkflowDraft(draft);
    const stored = JSON.stringify(rows);
    const restored = await loadWorkflowDraft(tool());

    expect(stored).not.toContain("must-not-persist");
    expect(restored).toMatchObject({
      status: "ready",
      draft: {
        basedOnVersion: 1,
        parameters: [{ key: "secret", sensitive: true }]
      }
    });
  });

  it("reports a conflict instead of applying a draft to a changed active version", async () => {
    await saveWorkflowDraft(createWorkflowDraft(tool()));
    const changed = { ...tool(), activeVersion: 2 };

    await expect(loadWorkflowDraft(changed)).resolves.toMatchObject({
      status: "conflict",
      draft: { basedOnVersion: 1 },
      activeVersion: 2
    });
  });
});
