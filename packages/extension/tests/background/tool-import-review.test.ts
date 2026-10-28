import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDBForTests, getDB } from "@/background/storage/db";
import { listTools, saveDraft } from "@/background/storage/tools";
import { commitToolImport, previewToolImport } from "@/background/tool-import-review";
import { getJob, putJob } from "@/background/storage/jobs";
import { sha256Json } from "@/background/jobs/hash";
import { handleRpc } from "@/background/rpc-handlers";

describe("two-phase tool import", () => {
  beforeEach(() => {
    _resetDBForTests();
    indexedDB = new IDBFactory();
  });
  afterEach(() => _resetDBForTests());

  it("previews v3 compatibility, capabilities, hosts, severity and conflicts without writing", async () => {
    const existing = await saveDraft({
      kind: "steps", name: "Existing", description: "", urlPatterns: ["https://shop.example/**"],
      steps: [{ kind: "tool", tool: "submitForm", args: { selector: "form" } }], outputSchema: {},
    });
    const before = await listTools();
    const preview = await previewToolImport({
      schema: "aipagego.tools/v3",
      exportedAt: 1,
      tools: [existing],
    });

    expect(preview.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.secretFindings).toEqual([]);
    expect(preview.items).toEqual([expect.objectContaining({
      index: 0,
      toolId: existing.id,
      kind: "steps",
      hosts: ["shop.example"],
      capabilities: ["submit:form"],
      severity: "dangerous",
      conflict: true,
      suggestedAction: "copy",
    })]);
    expect(await listTools()).toEqual(before);
  });

  it("reports secrets and invalid tools without echoing secret values", async () => {
    const preview = await previewToolImport({
      schema: "aipagego.tools/v3",
      exportedAt: 1,
      tools: [{
        kind: "steps", id: "bad", name: "Bad", description: "", urlPatterns: ["https://example.com/**"],
        activeVersion: 1, createdAt: 1, updatedAt: 1, stats: { runs: 0 },
        versions: [{ version: 1, kind: "steps", parameters: [], createdAt: 1, outputSchema: {},
          steps: [{ kind: "tool", tool: "futureTool", args: { token: "preview-secret-value" } }] }],
      }],
    });

    expect(preview.secretFindings).toContainEqual(expect.objectContaining({ path: expect.stringContaining("token") }));
    expect(preview.items[0]).toMatchObject({ valid: false, errorCode: "package_unknown_capability" });
    expect(JSON.stringify(preview)).not.toContain("preview-secret-value");
  });

  it("accepts legacy v2 and package v1 while auditing every imported version", async () => {
    const source = await saveDraft({
      kind: "steps", name: "Versioned", description: "", urlPatterns: ["https://docs.example/**"],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "main" } }], outputSchema: {},
    });
    if (source.kind !== "steps") throw new Error("expected steps tool");
    const versioned = {
      ...source,
      activeVersion: 1,
      versions: [
        source.versions[0],
        {
          ...source.versions[0],
          version: 2,
          steps: [{ kind: "tool" as const, tool: "submitForm" as const, args: { selector: "form" } }],
        },
      ],
    };
    const packagePreview = await previewToolImport({
      schema: "aipagego.tool-package/v1",
      exportedAt: 1,
      package: { name: "Versioned package" },
      tools: [versioned],
    });

    expect(packagePreview.items[0]).toMatchObject({
      activeVersion: 1,
      capabilities: ["read:dom", "submit:form"],
      severity: "dangerous",
      dangerousSteps: ["v2 step 1: submitForm"],
    });

    const legacyPreview = await previewToolImport({
      schema: "aipagego.tools/v2",
      exportedAt: 1,
      tools: [{
        ...source,
        activeVersion: undefined,
        versions: [],
        steps: source.versions[0].steps,
        outputSchema: source.versions[0].outputSchema,
      }],
    });
    expect(legacyPreview.items[0]).toMatchObject({ valid: true, activeVersion: 1 });
  });

  it("rejects malformed package envelopes before previewing individual tools", async () => {
    const tool = await saveDraft({
      kind: "steps", name: "Valid tool", description: "", urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "extractText", args: {} }], outputSchema: {},
    });

    await expect(previewToolImport({
      schema: "aipagego.tool-package/v1",
      exportedAt: 1,
      package: { name: "" },
      tools: [tool],
    })).rejects.toThrow("invalid_bundle");
  });

  it("rejects a changed digest and requires explicit dangerous approval", async () => {
    const tool = await saveDraft({
      kind: "steps", name: "Danger", description: "", urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "submitForm", args: { selector: "form" } }], outputSchema: {},
    });
    const bundle = { schema: "aipagego.tools/v3", exportedAt: 1, tools: [{ ...tool, id: "incoming" }] };
    const preview = await previewToolImport(bundle);

    await expect(commitToolImport({
      bundle,
      digest: "0".repeat(64),
      decisions: [{ index: 0, action: "copy" }],
      approveDangerous: true,
    })).rejects.toThrow("import_digest_changed");

    const denied = await commitToolImport({
      bundle,
      digest: preview.digest,
      decisions: [{ index: 0, action: "copy" }],
      approveDangerous: false,
    });
    expect(denied.items).toEqual([{ index: 0, status: "rejected", code: "package_dangerous_confirmation_required" }]);
    expect((await listTools()).find((candidate) => candidate.id === "incoming")).toBeUndefined();
  });

  it("keeps the incoming id for a non-conflicting default copy decision", async () => {
    const source = await saveDraft({
      kind: "steps", name: "Portable", description: "", urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "main" } }], outputSchema: {},
    });
    const incoming = { ...source, id: "portable-stable-id" };
    _resetDBForTests();
    indexedDB = new IDBFactory();
    const bundle = { schema: "aipagego.tools/v3", exportedAt: 1, tools: [incoming] };
    const preview = await previewToolImport(bundle);

    const result = await commitToolImport({ bundle, digest: preview.digest });

    expect(result.items).toEqual([{ index: 0, status: "imported", id: "portable-stable-id" }]);
    expect((await listTools()).map((tool) => tool.id)).toEqual(["portable-stable-id"]);
  });

  it("commits copy, skip and overwrite decisions independently", async () => {
    const existing = await saveDraft({
      kind: "steps", name: "Original", description: "", urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "main" } }], outputSchema: {},
    });
    const incoming = { ...existing, name: "Incoming", stats: { runs: 99 } };
    const bundle = { schema: "aipagego.tools/v3", exportedAt: 1, tools: [incoming, incoming, incoming] };
    const preview = await previewToolImport(bundle);
    const result = await commitToolImport({
      bundle,
      digest: preview.digest,
      decisions: [
        { index: 0, action: "copy" },
        { index: 1, action: "skip" },
        { index: 2, action: "overwrite" },
      ],
      approveDangerous: false,
    });

    expect(result.items.map((item) => item.status)).toEqual(["imported", "skipped", "imported"]);
    const tools = await listTools();
    expect(tools).toHaveLength(2);
    expect(tools.find((candidate) => candidate.id === existing.id)?.name).toBe("Incoming");
    expect(tools.find((candidate) => candidate.id !== existing.id)?.name).toBe("Incoming");
  });

  it("serializes concurrent default copies without silently overwriting either import", async () => {
    const source = await saveDraft({
      kind: "steps", name: "Concurrent", description: "", urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "extractText", args: {} }], outputSchema: {},
    });
    const incoming = { ...source, id: "concurrent-stable-id" };
    _resetDBForTests();
    indexedDB = new IDBFactory();
    const bundle = { schema: "aipagego.tools/v3", exportedAt: 1, tools: [incoming] };
    const preview = await previewToolImport(bundle);

    const [first, second] = await Promise.all([
      commitToolImport({ bundle, digest: preview.digest }),
      commitToolImport({ bundle, digest: preview.digest }),
    ]);

    expect(first.items[0].status).toBe("imported");
    expect(second.items[0].status).toBe("imported");
    const ids = (await listTools()).map((tool) => tool.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("concurrent-stable-id");
  });

  it("rolls back an overwrite when a dependent Job cannot be updated", async () => {
    const existing = await saveDraft({
      kind: "steps", name: "Before", description: "", urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "extractText", args: {} }], outputSchema: {},
    });
    const db = await getDB();
    await db.put("jobs", {
      id: "corrupt-dependent",
      toolId: existing.id,
      toolVersion: 1,
      toolVersionHash: "0".repeat(64),
    } as never);
    const incoming = { ...existing, name: "After" };
    const bundle = { schema: "aipagego.tools/v3", exportedAt: 1, tools: [incoming] };
    const preview = await previewToolImport(bundle);

    const result = await commitToolImport({
      bundle,
      digest: preview.digest,
      decisions: [{ index: 0, action: "overwrite" }],
    });

    expect(result.items).toEqual([{ index: 0, status: "rejected", code: "import_write_failed" }]);
    expect((await listTools()).find((tool) => tool.id === existing.id)?.name).toBe("Before");
  });

  it("shows dependent Jobs and atomically marks stale hashes on overwrite without clearing leases", async () => {
    const existing = await saveDraft({
      kind: "steps", name: "Original", description: "", urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "main" } }], outputSchema: {},
    });
    if (existing.kind !== "steps") throw new Error("expected steps tool");
    await putJob({
      id: "dependent-job",
      name: "Dependent",
      toolId: existing.id,
      toolVersion: 1,
      toolVersionHash: await sha256Json(existing.versions[0]),
      targetUrl: "https://example.com/page",
      inputs: {},
      trigger: { kind: "schedule", schedule: { kind: "interval", everyMinutes: 60 } },
      retry: { maxAttempts: 1, backoffMinutes: [] },
      notifications: { onChange: false, onSuccess: false, onFailure: true },
      connectorBindings: [],
      status: "active",
      safety: { severity: "safe" },
      nextRunAt: 100,
      lease: { jobRunId: "in-flight", expiresAt: 200 },
      createdAt: 1,
      updatedAt: 1,
    });
    const incoming = {
      ...existing,
      versions: [{
        ...existing.versions[0],
        steps: [{ kind: "tool" as const, tool: "extractText" as const, args: { selector: "article" } }],
      }],
    };
    const bundle = { schema: "aipagego.tools/v3", exportedAt: 1, tools: [incoming] };
    const preview = await previewToolImport(bundle);

    expect(preview.items[0]).toMatchObject({ conflict: true, dependentJobs: 1 });
    await commitToolImport({
      bundle,
      digest: preview.digest,
      decisions: [{ index: 0, action: "overwrite" }],
    });

    expect(await getJob("dependent-job")).toMatchObject({
      status: "needs_attention",
      attentionReason: "tool_version_changed",
      lease: { jobRunId: "in-flight", expiresAt: 200 },
    });
    expect((await getJob("dependent-job"))?.nextRunAt).toBeUndefined();
  });

  it("exposes preview and digest-checked commit over RPC while blocking the legacy import", async () => {
    const tool = await saveDraft({
      kind: "steps", name: "RPC import", description: "", urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "main" } }], outputSchema: {},
    });
    const bundle = { schema: "aipagego.tools/v3", exportedAt: 1, tools: [{ ...tool, id: "rpc-incoming" }] };

    expect(await handleRpc({ type: "tools.import", bundle })).toEqual({
      ok: false,
      error: "import_preview_required",
    });
    const previewResponse = await handleRpc({ type: "tools.import.preview", bundle });
    expect(previewResponse).toMatchObject({ ok: true, data: { schema: "aipagego.tools/v3" } });
    if (!previewResponse.ok) throw new Error(previewResponse.error);
    const digest = (previewResponse.data as unknown as { digest: string }).digest;
    const commitResponse = await handleRpc({
      type: "tools.import.commit",
      bundle,
      digest,
      decisions: [{ index: 0, action: "copy" }],
    });

    expect(commitResponse).toMatchObject({
      ok: true,
      data: { items: [{ index: 0, status: "imported" }] },
    });
  });
});
