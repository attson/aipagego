import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRpc } from "@/background/rpc-handlers";
import { _resetDBForTests } from "@/background/storage/db";
import { appendVersion, saveDraft } from "@/background/storage/tools";
import { getRun } from "@/background/storage/runs";
import { getDB } from "@/background/storage/db";

function chromeForJobs() {
  return {
    storage: {
      local: {
        get: vi.fn(async () => ({
          "aipagego.llm": {
            defaultInjectionMode: "operate",
            defaultAssistantEnabled: false,
            siteInjectionRules: [],
            selfHealEnabled: true,
          },
        })),
      },
      session: { get: vi.fn(async () => ({})) },
    },
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: "https://example.com/products", status: "complete" }]),
      get: vi.fn(async () => ({ id: 7, url: "https://example.com/products", status: "complete" })),
      create: vi.fn(),
      remove: vi.fn(),
      sendMessage: vi.fn(async (_tabId: number, request: { step?: { args?: unknown } }) => ({
        ok: true,
        data: request.step?.args,
      })),
    },
    runtime: { sendMessage: vi.fn(), getManifest: vi.fn(() => ({ content_scripts: [] })) },
  };
}

describe("Jobs RPC", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
    vi.stubGlobal("chrome", chromeForJobs());
  });
  afterEach(() => {
    _resetDBForTests();
    vi.unstubAllGlobals();
  });

  it("saves a manual Job pinned to an immutable version and runs that version", async () => {
    const tool = await saveDraft({
      kind: "steps",
      name: "Pinned",
      description: "",
      urlPatterns: ["https://example.com/**"],
      parameters: [{ key: "selector", label: "Selector", type: "string", required: true }],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "${selector}", marker: "v1" } }],
      outputSchema: {},
    });
    await appendVersion(tool.id, {
      parameters: [{ key: "selector", label: "Selector", type: "string", required: true }],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "${selector}", marker: "v2" } }],
      outputSchema: {},
    });

    const saved = await handleRpc({
      type: "jobs.save",
      draft: {
        name: "Pinned daily",
        toolId: tool.id,
        toolVersion: 1,
        targetUrl: "https://example.com/products",
        inputs: { selector: "h1" },
        trigger: { kind: "manual" },
        retry: { maxAttempts: 3, backoffMinutes: [1, 5] },
        notifications: { onChange: true, onSuccess: false, onFailure: true },
      },
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const job = saved.data as unknown as { id: string; toolVersion: number; toolVersionHash: string };
    expect(job.toolVersion).toBe(1);
    expect(job.toolVersionHash).toMatch(/^[a-f0-9]{64}$/);

    const runResponse = await handleRpc({ type: "jobs.runNow", id: job.id });
    expect(runResponse.ok).toBe(true);
    if (!runResponse.ok) return;
    const jobRun = runResponse.data as unknown as {
      status: string;
      toolVersion: number;
      attempts: Array<{ runId?: string }>;
    };
    expect(jobRun).toMatchObject({ status: "ok", toolVersion: 1 });
    const run = await getRun(jobRun.attempts[0].runId!);
    expect(run).toMatchObject({
      source: "job",
      toolVersion: 1,
      output: { selector: "h1", marker: "v1" },
    });
  });

  it("rejects prompt tools, URL mismatches and stored sensitive inputs", async () => {
    const prompt = await saveDraft({
      kind: "prompt",
      name: "Prompt",
      description: "",
      urlPatterns: ["https://example.com/**"],
      prompt: "summarize",
    });
    const base = {
      name: "Invalid",
      toolId: prompt.id,
      toolVersion: 1,
      targetUrl: "https://example.com/products",
      inputs: {},
      trigger: { kind: "manual" as const },
      retry: { maxAttempts: 3, backoffMinutes: [1, 5] },
      notifications: { onChange: true, onSuccess: false, onFailure: true },
    };
    const promptResult = await handleRpc({ type: "jobs.save", draft: base });
    expect(promptResult.ok).toBe(false);

    const sensitive = await saveDraft({
      kind: "steps",
      name: "Sensitive",
      description: "",
      urlPatterns: ["https://example.com/**"],
      parameters: [{
        key: "token",
        label: "Token",
        type: "string",
        required: true,
        sensitive: true,
      }],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h1" } }],
      outputSchema: {},
    });
    const sensitiveResult = await handleRpc({
      type: "jobs.save",
      draft: { ...base, toolId: sensitive.id, inputs: { token: "secret" } },
    });
    expect(sensitiveResult.ok).toBe(false);
    if (!sensitiveResult.ok) expect(sensitiveResult.error).not.toContain("secret");

    const mismatch = await handleRpc({
      type: "jobs.save",
      draft: {
        ...base,
        toolId: sensitive.id,
        inputs: {},
        targetUrl: "https://other.example.net/",
      },
    });
    expect(mismatch.ok).toBe(false);
  });

  it("lists, reads and deletes Jobs with their JobRuns", async () => {
    const tool = await saveDraft({
      kind: "steps",
      name: "List",
      description: "",
      urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h1" } }],
      outputSchema: {},
    });
    const created = await handleRpc({
      type: "jobs.save",
      draft: {
        name: "List job",
        toolId: tool.id,
        toolVersion: 1,
        targetUrl: "https://example.com/products",
        inputs: {},
        trigger: { kind: "manual" },
        retry: { maxAttempts: 1, backoffMinutes: [] },
        notifications: { onChange: true, onSuccess: false, onFailure: true },
      },
    });
    if (!created.ok) throw new Error(created.error);
    const id = (created.data as unknown as { id: string }).id;
    await handleRpc({ type: "jobs.runNow", id });
    const list = await handleRpc({ type: "jobs.list" });
    const get = await handleRpc({ type: "jobs.get", id });
    const runs = await handleRpc({ type: "jobRuns.list", jobId: id, limit: 20 });
    expect(list.ok && (list.data as unknown[])).toHaveLength(1);
    expect(get.ok && (get.data as unknown as { id: string }).id).toBe(id);
    expect(runs.ok && (runs.data as unknown as { items: unknown[] }).items).toHaveLength(1);
    expect((await handleRpc({ type: "jobs.delete", id })).ok).toBe(true);
    const after = await handleRpc({ type: "jobRuns.list", jobId: id, limit: 20 });
    expect(after.ok && (after.data as unknown as { items: unknown[] }).items).toHaveLength(0);
  });

  it("requires a creation acknowledgement for caution and invalidates it on input change", async () => {
    const tool = await saveDraft({
      kind: "steps",
      name: "Caution",
      description: "",
      urlPatterns: ["https://example.com/**"],
      parameters: [{ key: "value", label: "Value", type: "string", required: true }],
      steps: [{ kind: "tool", tool: "fillInput", args: { selector: "#q", value: "${value}" } }],
      outputSchema: {},
    });
    const draft = {
      name: "Fill",
      toolId: tool.id,
      toolVersion: 1,
      targetUrl: "https://example.com/products",
      inputs: { value: "first" },
      trigger: { kind: "schedule" as const, schedule: { kind: "interval" as const, everyMinutes: 30 } },
      retry: { maxAttempts: 1, backoffMinutes: [] },
      notifications: { onChange: true, onSuccess: false, onFailure: true },
    };
    const denied = await handleRpc({ type: "jobs.save", draft });
    expect(denied.ok).toBe(false);
    const accepted = await handleRpc({ type: "jobs.save", draft, acknowledgeCaution: true });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const job = accepted.data as unknown as {
      id: string;
      safety: { severity: string; acknowledgementHash?: string };
    };
    expect(job.safety.severity).toBe("caution");
    expect(job.safety.acknowledgementHash).toMatch(/^[a-f0-9]{64}$/);

    const changed = await handleRpc({
      type: "jobs.save",
      id: job.id,
      draft: { ...draft, inputs: { value: "changed" } },
    });
    expect(changed.ok).toBe(false);
  });

  it("blocks dangerous automatic Jobs and requires approval for every manual run", async () => {
    const tool = await saveDraft({
      kind: "steps",
      name: "Danger",
      description: "",
      urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "submitForm", args: { selector: "form" } }],
      outputSchema: {},
    });
    const base = {
      name: "Submit",
      toolId: tool.id,
      toolVersion: 1,
      targetUrl: "https://example.com/products",
      inputs: {},
      retry: { maxAttempts: 1, backoffMinutes: [] },
      notifications: { onChange: true, onSuccess: false, onFailure: true },
    };
    const automatic = await handleRpc({
      type: "jobs.save",
      draft: {
        ...base,
        trigger: { kind: "schedule", schedule: { kind: "interval", everyMinutes: 30 } },
      },
    });
    expect(automatic.ok).toBe(false);

    const manual = await handleRpc({
      type: "jobs.save",
      draft: { ...base, trigger: { kind: "manual" } },
    });
    expect(manual.ok).toBe(true);
    if (!manual.ok) return;
    const id = (manual.data as unknown as { id: string }).id;
    expect((await handleRpc({ type: "jobs.runNow", id })).ok).toBe(false);
    expect((await handleRpc({
      type: "jobs.runNow",
      id,
      approveDangerousOnce: true,
    })).ok).toBe(true);
    expect((await handleRpc({ type: "jobs.runNow", id })).ok).toBe(false);
  });

  it("keeps the pinned version until an explicit reviewed upgrade", async () => {
    const tool = await saveDraft({
      kind: "steps",
      name: "Upgrade",
      description: "",
      urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h1" } }],
      outputSchema: {},
    });
    await appendVersion(tool.id, {
      steps: [{ kind: "tool", tool: "fillInput", args: { selector: "#q", value: "next" } }],
      outputSchema: {},
    });
    const created = await handleRpc({
      type: "jobs.save",
      draft: {
        name: "Upgrade",
        toolId: tool.id,
        toolVersion: 1,
        targetUrl: "https://example.com/products",
        inputs: {},
        trigger: { kind: "manual" },
        retry: { maxAttempts: 1, backoffMinutes: [] },
        notifications: { onChange: true, onSuccess: false, onFailure: true },
      },
    });
    if (!created.ok) throw new Error(created.error);
    const job = created.data as unknown as { id: string; toolVersion: number };
    const listed = await handleRpc({ type: "jobs.list" });
    expect(listed.ok && (listed.data as unknown as Array<{ upgradeAvailable?: number }>)[0].upgradeAvailable)
      .toBe(2);

    const denied = await handleRpc({ type: "jobs.upgrade", id: job.id, toolVersion: 2 });
    expect(denied.ok).toBe(false);
    const upgraded = await handleRpc({
      type: "jobs.upgrade",
      id: job.id,
      toolVersion: 2,
      acknowledgeCaution: true,
    });
    expect(upgraded.ok && (upgraded.data as unknown as { toolVersion: number }).toolVersion).toBe(2);
  });

  it("marks a Job needs_attention when the pinned snapshot hash changes", async () => {
    const tool = await saveDraft({
      kind: "steps",
      name: "Hash",
      description: "",
      urlPatterns: ["https://example.com/**"],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h1" } }],
      outputSchema: {},
    });
    const created = await handleRpc({
      type: "jobs.save",
      draft: {
        name: "Hash",
        toolId: tool.id,
        toolVersion: 1,
        targetUrl: "https://example.com/products",
        inputs: {},
        trigger: { kind: "manual" },
        retry: { maxAttempts: 1, backoffMinutes: [] },
        notifications: { onChange: true, onSuccess: false, onFailure: true },
      },
    });
    if (!created.ok) throw new Error(created.error);
    const id = (created.data as unknown as { id: string }).id;
    const db = await getDB();
    const raw = await db.get("tools", tool.id);
    if (!raw || raw.kind !== "steps") throw new Error("missing tool");
    raw.versions[0].steps = [{ kind: "tool", tool: "extractText", args: { selector: "h2" } }];
    await db.put("tools", raw);

    expect((await handleRpc({ type: "jobs.runNow", id })).ok).toBe(false);
    const read = await handleRpc({ type: "jobs.get", id });
    expect(read.ok && read.data).toMatchObject({
      status: "needs_attention",
      attentionReason: "tool_version_changed",
    });
  });

  it("uses required sensitive inputs only for one manual run and redacts them", async () => {
    const tool = await saveDraft({
      kind: "steps",
      name: "Secret",
      description: "",
      urlPatterns: ["https://example.com/**"],
      parameters: [{
        key: "token",
        label: "Token",
        type: "string",
        required: true,
        sensitive: true,
      }],
      steps: [{
        kind: "tool",
        tool: "extractText",
        args: { selector: "${token}" },
      }],
      outputSchema: {},
    });
    const created = await handleRpc({
      type: "jobs.save",
      draft: {
        name: "Secret",
        toolId: tool.id,
        toolVersion: 1,
        targetUrl: "https://example.com/products",
        inputs: {},
        trigger: { kind: "manual" },
        retry: { maxAttempts: 1, backoffMinutes: [] },
        notifications: { onChange: true, onSuccess: false, onFailure: true },
      },
    });
    if (!created.ok) throw new Error(created.error);
    const job = created.data as unknown as { id: string; inputs: Record<string, unknown> };
    expect(job.inputs).toEqual({});
    const ran = await handleRpc({
      type: "jobs.runNow",
      id: job.id,
      inputs: { token: "never-persist-me" },
    });
    expect(ran.ok).toBe(true);
    expect(JSON.stringify(ran)).not.toContain("never-persist-me");
    if (!ran.ok) return;
    const runId = (ran.data as unknown as { attempts: Array<{ runId: string }> }).attempts[0].runId;
    expect(JSON.stringify(await getRun(runId))).not.toContain("never-persist-me");
  });
});
