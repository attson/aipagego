import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDBForTests, getDB } from "@/background/storage/db";
import {
  activateWorkflowVersion,
  appendVersion,
  deleteTool,
  getTool,
  listTools,
  matchingTools,
  publishWorkflow,
  recordRunStat,
  saveDraft
} from "@/background/storage/tools";
import type { PromptToolDraft, Step, StepsToolDraft } from "@aipagego/shared/types";

const sampleSteps: Step[] = [
  { kind: "tool", tool: "snapshotDOM", args: { maxDepth: 3 } }
];

function stepsDraft(name: string, urlPatterns = ["https://example.com/*"]): StepsToolDraft {
  return {
    kind: "steps",
    name,
    urlPatterns,
    description: "",
    steps: sampleSteps,
    outputSchema: {}
  };
}

function promptDraft(name: string, urlPatterns = ["https://example.com/*"]): PromptToolDraft {
  return {
    kind: "prompt",
    name,
    urlPatterns,
    description: "",
    prompt: "请总结当前页面并返回 JSON"
  };
}

describe("tools storage", () => {
  beforeEach(async () => {
    _resetDBForTests();
    indexedDB = new IDBFactory();
  });
  afterEach(async () => {
    _resetDBForTests();
  });

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

  it("getTool returns the saved tool", async () => {
    const t = await saveDraft(stepsDraft("T2"));
    const got = await getTool(t.id);
    expect(got?.id).toBe(t.id);
  });

  it("appendVersion increments version without restoring top-level mirrors", async () => {
    const t = await saveDraft({
      ...stepsDraft("T3"),
      parameters: [
        { key: "keyword", label: "关键词", type: "string", required: true }
      ],
      steps: [{ ...sampleSteps[0], bindResultTo: "result" }],
      outputBinding: "result"
    });
    const newSteps: Step[] = [
      { kind: "tool", tool: "extractText", args: { selector: "h1" }, bindResultTo: "result" }
    ];
    const updated = await appendVersion(t.id, {
      steps: newSteps,
      outputSchema: {},
      note: "fix"
    });
    expect(updated.kind).toBe("steps");
    if (updated.kind === "steps") {
      expect(updated.versions).toHaveLength(2);
      expect(updated.activeVersion).toBe(2);
      expect(updated.versions[1]).toMatchObject({
        kind: "steps",
        version: 2,
        basedOnVersion: 1,
        outputBinding: "result",
        parameters: [{ key: "keyword", label: "关键词", type: "string", required: true }]
      });
      expect("steps" in updated).toBe(false);
      expect("outputSchema" in updated).toBe(false);
      expect(updated.versions[1].steps).toEqual(newSteps);
    }
  });

  it("normalizes legacy tools on read without writing until the next normal mutation", async () => {
    const db = await getDB();
    const legacy = {
      id: "legacy-canonical-write",
      kind: "steps",
      name: "Legacy",
      urlPatterns: ["https://example.com/**"],
      description: "",
      steps: sampleSteps,
      outputSchema: { type: "object" },
      createdAt: 1,
      updatedAt: 1,
      versions: [{
        version: 1,
        kind: "steps",
        steps: sampleSteps,
        outputSchema: { type: "object" },
        createdAt: 1,
      }],
      stats: { runs: 0 },
    };
    await db.put("tools", legacy as never);

    const read = await getTool(legacy.id);
    expect(read).toMatchObject({ kind: "steps", activeVersion: 1 });
    expect(read && "steps" in read).toBe(false);
    expect(await db.get("tools", legacy.id)).toHaveProperty("steps");

    await recordRunStat(legacy.id, true);
    const persisted = await db.get("tools", legacy.id) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("steps");
    expect(persisted).not.toHaveProperty("outputSchema");
    expect(persisted.activeVersion).toBe(1);
  });

  it("publishes an immutable max+1 snapshot and activates it", async () => {
    const original = await saveDraft(stepsDraft("Studio"));
    if (original.kind !== "steps") throw new Error("expected steps tool");
    const historical = await appendVersion(original.id, {
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h1" } }],
      outputSchema: { type: "string" },
      note: "historical v2"
    });
    if (historical.kind !== "steps") throw new Error("expected steps tool");
    const db = await getDB();
    await db.put("tools", { ...historical, activeVersion: 1 });

    const published = await publishWorkflow(original.id, {
      basedOnVersion: 1,
      parameters: [
        { key: "selector", label: "Selector", type: "string", required: true }
      ],
      steps: [
        {
          kind: "tool",
          tool: "extractText",
          args: { selector: "${selector}" },
          bindResultTo: "result"
        }
      ],
      outputBinding: "result",
      outputSchema: { type: "string" },
      note: "studio publish"
    });

    expect(published.kind).toBe("steps");
    if (published.kind === "steps") {
      expect(published.activeVersion).toBe(3);
      expect(published.versions).toHaveLength(3);
      expect(published.versions[0]).toEqual(original.versions[0]);
      expect(published.versions[1]).toEqual(historical.versions[1]);
      expect(published.versions[2]).toMatchObject({
        version: 3,
        basedOnVersion: 1,
        note: "studio publish",
        outputBinding: "result",
        parameters: [{ key: "selector", type: "string" }]
      });
    }
  });

  it("rejects publish when the active version changed", async () => {
    const original = await saveDraft(stepsDraft("Conflict"));
    if (original.kind !== "steps") throw new Error("expected steps tool");
    await appendVersion(original.id, {
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h1" } }],
      outputSchema: {}
    });

    await expect(publishWorkflow(original.id, {
      basedOnVersion: 1,
      parameters: [],
      steps: sampleSteps,
      outputSchema: {}
    })).rejects.toThrow("workflow_version_conflict");

    const unchanged = await getTool(original.id);
    expect(unchanged?.versions).toHaveLength(2);
  });

  it("allows only one concurrent publish from the same base version", async () => {
    const original = await saveDraft(stepsDraft("Concurrent publish"));
    const publish = (selector: string) => publishWorkflow(original.id, {
      basedOnVersion: 1,
      parameters: [],
      steps: [{ kind: "tool", tool: "extractText", args: { selector } }],
      outputSchema: {}
    });

    const results = await Promise.allSettled([publish("h1"), publish("h2")]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const stored = await getTool(original.id);
    expect(stored?.versions).toHaveLength(2);
    expect(stored?.kind === "steps" ? stored.activeVersion : null).toBe(2);
  });

  it("activates an existing snapshot by pointer without copying or rewriting history", async () => {
    const original = await saveDraft(stepsDraft("Activation"));
    const latest = await appendVersion(original.id, {
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h1" } }],
      outputSchema: { type: "string" },
    });
    if (latest.kind !== "steps") throw new Error("expected steps tool");
    const historyBefore = structuredClone(latest.versions);

    const oldActive = await activateWorkflowVersion(original.id, 1);
    const latestAgain = await activateWorkflowVersion(original.id, 2);

    expect(oldActive.kind).toBe("steps");
    expect(oldActive.kind === "steps" ? oldActive.activeVersion : null).toBe(1);
    expect(latestAgain.kind).toBe("steps");
    if (latestAgain.kind === "steps") {
      expect(latestAgain.activeVersion).toBe(2);
      expect(latestAgain.versions).toEqual(historyBefore);
      expect(latestAgain.versions).toHaveLength(2);
    }
    await expect(activateWorkflowVersion(original.id, 99)).rejects.toThrow(
      "workflow_version_not_found",
    );
  });

  it.each([
    {
      label: "an unresolved binding",
      parameters: [],
      steps: [{ kind: "tool", tool: "fillInput", args: { selector: "#q", value: "${missing}" } }] as Step[]
    },
    {
      label: "a sensitive default",
      parameters: [{
        key: "secret",
        label: "Secret",
        type: "string" as const,
        required: true,
        sensitive: true,
        defaultValue: "forbidden"
      }],
      steps: sampleSteps
    }
  ])("rejects publishing $label without appending history", async ({ parameters, steps }) => {
    const original = await saveDraft(stepsDraft("Invalid publish"));

    await expect(publishWorkflow(original.id, {
      basedOnVersion: 1,
      parameters,
      steps,
      outputSchema: {}
    })).rejects.toThrow("invalid_workflow");

    expect((await getTool(original.id))?.versions).toHaveLength(1);
  });

  it("matchingTools filters both kinds by URL pattern", async () => {
    await saveDraft(stepsDraft("Shop", ["https://*.example.com/**"]));
    await saveDraft(promptDraft("Shop AI", ["https://*.example.com/**"]));
    await saveDraft(stepsDraft("TB", ["https://*.taobao.com/**"]));
    const hits = await matchingTools("https://shop.example.com/goods.html");
    expect(hits.map((t) => t.name).sort()).toEqual(["Shop", "Shop AI"]);
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

  it("deleteTool removes the tool", async () => {
    const t = await saveDraft(stepsDraft("X"));
    await deleteTool(t.id);
    expect(await getTool(t.id)).toBeUndefined();
  });
});
