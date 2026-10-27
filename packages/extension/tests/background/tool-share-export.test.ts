import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportToolSharePackage } from "@/background/tool-share-export";
import { handleRpc } from "@/background/rpc-handlers";
import { _resetDBForTests, getDB } from "@/background/storage/db";
import {
  activateWorkflowVersion,
  appendVersion,
  recordRunStat,
  saveDraft,
} from "@/background/storage/tools";

describe("secure tool package export", () => {
  beforeEach(() => {
    _resetDBForTests();
    indexedDB = new IDBFactory();
  });
  afterEach(() => _resetDBForTests());

  it("exports each selected tool as an active-only portable snapshot", async () => {
    const workflow = await saveDraft({
      kind: "steps",
      name: "Reader",
      urlPatterns: ["https://example.com/**"],
      description: "Read the page",
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "main" } }],
      outputSchema: { type: "string" },
    });
    if (workflow.kind !== "steps") throw new Error("expected steps tool");
    await appendVersion(workflow.id, {
      steps: [{
        kind: "tool",
        tool: "httpRequest",
        args: { url: "https://api.example.com", headers: { Authorization: "Bearer inactive-secret" } },
      }],
      outputSchema: {},
      basedOnVersion: 1,
    });
    await activateWorkflowVersion(workflow.id, 1);
    await recordRunStat(workflow.id, true);
    const prompt = await saveDraft({
      kind: "prompt",
      name: "Summarizer",
      urlPatterns: ["https://example.com/**"],
      description: "Summarize",
      prompt: "Summarize this page",
    });

    const bundle = await exportToolSharePackage({
      toolIds: [workflow.id, prompt.id],
      name: "Research kit",
      description: "Portable definitions",
    });

    expect(bundle).toMatchObject({
      schema: "aipagego.tool-package/v1",
      package: { name: "Research kit", description: "Portable definitions" },
    });
    expect(bundle.tools.map((tool) => tool.id)).toEqual([workflow.id, prompt.id]);
    expect(bundle.tools[0]).toMatchObject({ activeVersion: 1, stats: { runs: 0 } });
    expect(bundle.tools[0].versions).toHaveLength(1);
    expect(bundle.tools[0].versions[0]).toMatchObject({ version: 1 });
    expect(JSON.stringify(bundle)).not.toContain("inactive-secret");
    expect(JSON.stringify(bundle)).not.toContain("lastRunAt");
    expect(JSON.stringify(bundle)).not.toContain("origin");
  });

  it("fails the whole request when a selected tool is missing", async () => {
    const existing = await saveDraft({
      kind: "prompt",
      name: "Existing",
      urlPatterns: ["https://example.com/**"],
      description: "",
      prompt: "Hello",
    });

    await expect(exportToolSharePackage({
      toolIds: [existing.id, "missing-tool"],
      name: "Incomplete",
    })).rejects.toThrow("tool_not_found: missing-tool");
  });

  it("does not read connector, job, run, delivery or collection stores into the package", async () => {
    const tool = await saveDraft({
      kind: "prompt",
      name: "Portable only",
      urlPatterns: ["https://example.com/**"],
      description: "",
      prompt: "Summarize",
    });
    const db = await getDB();
    const sentinel = "local-runtime-sentinel";
    await db.put("connectors", { id: "connector-local", name: sentinel } as never);
    await db.put("connector_deliveries", { id: "delivery-local", payload: sentinel } as never);
    await db.put("jobs", { id: "job-local", inputs: { sentinel } } as never);
    await db.put("job_runs", { id: "job-run-local", output: sentinel } as never);
    await db.put("runs", { id: "run-local", output: sentinel } as never);
    await db.put("collection_results", { resultId: "collection-local", rows: [{ sentinel }] } as never);

    const serialized = JSON.stringify(await exportToolSharePackage({
      toolIds: [tool.id],
      name: "Portable",
    }));

    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("connector-local");
    expect(serialized).not.toContain("job-local");
    expect(serialized).not.toContain("run-local");
    expect(serialized).not.toContain("collection-local");
  });

  it("rejects an active literal credential without returning its value", async () => {
    const tool = await saveDraft({
      kind: "steps",
      name: "Unsafe",
      urlPatterns: ["https://example.com/**"],
      description: "",
      steps: [{
        kind: "tool",
        tool: "httpRequest",
        args: { url: "https://api.example.com?token=active-secret-value" },
      }],
      outputSchema: {},
    });

    let message = "";
    try {
      await exportToolSharePackage({ toolIds: [tool.id], name: "Unsafe" });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toContain("package_secret_detected");
    expect(message).toContain("url-sensitive-query");
    expect(message).not.toContain("active-secret-value");
  });

  it("exposes the safe package through the background RPC", async () => {
    const tool = await saveDraft({
      kind: "prompt",
      name: "RPC tool",
      urlPatterns: ["https://example.com/**"],
      description: "",
      prompt: "Summarize",
    });

    const response = await handleRpc({
      type: "tools.share.export",
      toolIds: [tool.id],
      name: "RPC package",
    });

    expect(response).toMatchObject({
      ok: true,
      data: {
        schema: "aipagego.tool-package/v1",
        package: { name: "RPC package" },
      },
    });
  });
});
