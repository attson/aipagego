import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDBForTests, getDB } from "@/background/storage/db";
import {
  appendVersion,
  deleteTool,
  getTool,
  listTools,
  matchingTools,
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

  it("appendVersion increments version and updates main steps", async () => {
    const t = await saveDraft(stepsDraft("T3"));
    const newSteps: Step[] = [
      { kind: "tool", tool: "extractText", args: { selector: "h1" } }
    ];
    const updated = await appendVersion(t.id, {
      steps: newSteps,
      outputSchema: {},
      note: "fix"
    });
    expect(updated.kind).toBe("steps");
    if (updated.kind === "steps") {
      expect(updated.versions).toHaveLength(2);
      expect(updated.versions[1]).toMatchObject({ kind: "steps", version: 2 });
      expect(updated.steps).toEqual(newSteps);
    }
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
