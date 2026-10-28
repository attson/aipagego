import { describe, expect, it, vi } from "vitest";
import type { Connector } from "@aipagego/shared/connectors";
import type { ConnectorDelivery } from "@aipagego/shared/connectors";
import type { Job, JobDraft, JobRun } from "@aipagego/shared/jobs";
import type { RunRecord, Tool } from "@aipagego/shared/types";
import { JobService, jobDeliveryId, type JobServiceDeps } from "@/background/jobs/service";

const tool: Tool = {
  kind: "steps",
  id: "tool-1",
  name: "Read",
  description: "",
  urlPatterns: ["https://example.com/**"],
  activeVersion: 1,
  versions: [{
    version: 1,
    kind: "steps",
    parameters: [],
    steps: [{ kind: "tool", tool: "extractText", args: { selector: "h1" } }],
    outputSchema: {},
    createdAt: 1,
  }],
  stats: { runs: 0 },
  createdAt: 1,
  updatedAt: 1,
};

const draft: JobDraft = {
  name: "Scheduled",
  toolId: tool.id,
  toolVersion: 1,
  targetUrl: "https://example.com/products",
  inputs: {},
  trigger: {
    kind: "schedule",
    schedule: { kind: "interval", everyMinutes: 10 },
  },
  retry: { maxAttempts: 3, backoffMinutes: [1, 5] },
  notifications: { onChange: true, onSuccess: false, onFailure: true },
  connectorBindings: [],
};

function connector(id: string, overrides: Partial<Connector> = {}): Connector {
  return {
    id,
    name: `Connector ${id}`,
    kind: "webhook",
    publicConfig: {
      kind: "webhook",
      method: "POST",
      endpointOrigin: "https://hooks.example.com",
      headerCount: 0,
    },
    credentialMode: "persistent",
    credentialConfigured: true,
    status: "ready",
    configHash: "b".repeat(64),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function harness(runPinned: ReturnType<typeof vi.fn>) {
  let now = 1_000;
  let serial = 0;
  const jobs = new Map<string, Job>();
  const runs = new Map<string, JobRun>();
  const deps: Partial<JobServiceDeps> = {
    now: () => now,
    uuid: () => "id-" + (++serial),
    getTool: async () => tool,
    getConnector: async () => undefined,
    getJob: async (id) => jobs.get(id),
    listJobs: async () => [...jobs.values()],
    putJob: async (job) => { jobs.set(job.id, structuredClone(job)); return job; },
    deleteJob: async (id) => { jobs.delete(id); },
    getJobRun: async (id) => runs.get(id),
    listJobRuns: async (jobId) => [...runs.values()].filter((run) => run.jobId === jobId),
    putJobRun: async (run) => { runs.set(run.id, structuredClone(run)); return run; },
    acquireTab: async () => ({ tabId: 7, ownership: "existing" }),
    releaseTab: vi.fn(async () => undefined),
    readWatchText: vi.fn(async () => ["unchanged"]),
    notifyTerminal: vi.fn(async () => undefined),
    ensureDelivery: vi.fn(async (id, connectorId, source): Promise<ConnectorDelivery> => ({
      id,
      connectorId,
      connectorConfigHash: "b".repeat(64),
      source,
      status: "ok",
      attempt: 1,
      nextOffset: 0,
      createdAt: now,
      finishedAt: now,
    })),
    getDelivery: async () => undefined,
  };
  const service = new JobService(runPinned, deps);
  return { service, jobs, runs, deps, setNow: (value: number) => { now = value; } };
}

describe("JobService connector destination save gate", () => {
  it("requires a separate caution acknowledgement and binds it to sorted destinations", async () => {
    const h = harness(vi.fn());
    const connectors = new Map([
      ["connector-a", connector("connector-a")],
      ["connector-b", connector("connector-b", { configHash: "c".repeat(64) })],
    ]);
    h.deps.getConnector = async (id) => connectors.get(id);
    const service = new JobService(vi.fn(), h.deps);
    const withA: JobDraft = {
      ...draft,
      connectorBindings: [{
        connectorId: "connector-a",
        connectorConfigHash: "b".repeat(64),
      }],
    };

    await expect(service.save(withA)).rejects.toThrow("caution_acknowledgement_required");
    const savedA = await service.save(withA, undefined, true);
    const savedB = await service.save({
      ...draft,
      connectorBindings: [{
        connectorId: "connector-b",
        connectorConfigHash: "c".repeat(64),
      }],
    }, undefined, true);

    expect(savedA.safety).toMatchObject({ severity: "caution" });
    expect(savedA.safety.acknowledgementHash).not.toBe(savedB.safety.acknowledgementHash);
  });

  it.each([
    ["missing", undefined, "connector_missing"],
    ["session", connector("connector-1", { credentialMode: "session" }), "connector_credentials_missing"],
    ["credentials missing", connector("connector-1", { credentialConfigured: false }), "connector_credentials_missing"],
    ["not ready", connector("connector-1", { status: "needs_attention" }), "connector_credentials_missing"],
    ["changed", connector("connector-1", { configHash: "c".repeat(64) }), "connector_changed"],
  ])("rejects a %s destination", async (_label, value, error) => {
    const h = harness(vi.fn());
    h.deps.getConnector = async () => value;
    const service = new JobService(vi.fn(), h.deps);

    await expect(service.save({
      ...draft,
      connectorBindings: [{
        connectorId: "connector-1",
        connectorConfigHash: "b".repeat(64),
      }],
    }, undefined, true)).rejects.toThrow(error);
  });

  it("preserves connector bindings when upgrading the pinned tool version", async () => {
    const h = harness(vi.fn());
    h.deps.getConnector = async () => connector("connector-1");
    const service = new JobService(vi.fn(), h.deps);
    const saved = await service.save({
      ...draft,
      connectorBindings: [{
        connectorId: "connector-1",
        connectorConfigHash: "b".repeat(64),
      }],
    }, undefined, true);

    const upgraded = await service.upgrade(saved.id, 1, true);

    expect(upgraded.connectorBindings).toEqual(saved.connectorBindings);
  });

  it("keeps connector confirmation separate from dangerous one-run approval", async () => {
    const dangerousTool: Tool = {
      ...tool,
      versions: [{
        ...tool.versions[0],
        steps: [{ kind: "tool", tool: "submitForm", args: { selector: "form" } }],
      }],
    };
    const runPinned = vi.fn(async () => runRecord("ok", "run-1"));
    const h = harness(runPinned);
    h.deps.getTool = async () => dangerousTool;
    h.deps.getConnector = async () => connector("connector-1");
    const service = new JobService(runPinned, h.deps);
    const boundDraft: JobDraft = {
      ...draft,
      trigger: { kind: "manual" },
      connectorBindings: [{
        connectorId: "connector-1",
        connectorConfigHash: "b".repeat(64),
      }],
    };

    await expect(service.save(boundDraft)).rejects.toThrow("caution_acknowledgement_required");
    const saved = await service.save(boundDraft, undefined, true);
    expect(saved.safety).toMatchObject({
      severity: "dangerous",
      acknowledgementHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(service.runNow(saved.id)).rejects.toThrow("dangerous_approval_required");
    await expect(service.runNow(saved.id, {}, true)).resolves.toMatchObject({ status: "ok" });
  });
});

describe("JobService connector destination run gate", () => {
  it.each([
    ["missing", undefined, "connector_missing"],
    ["credentials missing", connector("connector-1", { credentialConfigured: false }), "connector_credentials_missing"],
    ["changed", connector("connector-1", { configHash: "c".repeat(64) }), "connector_changed"],
  ])("moves to attention before opening a page when the connector is %s", async (_label, invalid, reason) => {
    let current: Connector | undefined = connector("connector-1");
    const runPinned = vi.fn(async () => runRecord("ok", "run-1"));
    const h = harness(runPinned);
    const acquireTab = vi.fn(async () => ({ tabId: 7, ownership: "existing" as const }));
    h.deps.acquireTab = acquireTab;
    h.deps.getConnector = async () => current;
    const service = new JobService(runPinned, h.deps);
    const saved = await service.save({
      ...draft,
      connectorBindings: [{
        connectorId: "connector-1",
        connectorConfigHash: "b".repeat(64),
      }],
    }, undefined, true);
    current = invalid;

    await expect(service.runNow(saved.id)).rejects.toThrow(reason);

    expect(acquireTab).not.toHaveBeenCalled();
    expect(runPinned).not.toHaveBeenCalled();
    expect(h.jobs.get(saved.id)).toMatchObject({
      status: "needs_attention",
      attentionReason: reason,
      nextRunAt: undefined,
    });
  });

  it("checks page-change destinations before acquiring the watcher tab", async () => {
    let current: Connector | undefined = connector("connector-1");
    const runPinned = vi.fn();
    const h = harness(runPinned);
    const acquireTab = vi.fn(async () => ({ tabId: 7, ownership: "existing" as const }));
    h.deps.acquireTab = acquireTab;
    h.deps.getConnector = async () => current;
    const service = new JobService(runPinned, h.deps);
    const saved = await service.save({
      ...draft,
      trigger: { kind: "page_change", everyMinutes: 5, watch: { selector: "#price" } },
      connectorBindings: [{
        connectorId: "connector-1",
        connectorConfigHash: "b".repeat(64),
      }],
    }, undefined, true);
    current = undefined;

    await expect(service.runAutomatic(saved.id, "page_change")).rejects.toThrow("connector_missing");

    expect(acquireTab).not.toHaveBeenCalled();
    expect(h.jobs.get(saved.id)).toMatchObject({
      status: "needs_attention",
      attentionReason: "connector_missing",
    });
  });
});

describe("JobService connector delivery", () => {
  it("persists the successful JobRun before ensuring a stable delivery and clearing the lease", async () => {
    const events: string[] = [];
    const runPinned = vi.fn(async () => runRecord("ok", "run-1", { value: 42 }));
    const h = harness(runPinned);
    h.deps.getConnector = async () => connector("connector-1");
    const originalPutRun = h.deps.putJobRun!;
    h.deps.putJobRun = async (run) => {
      events.push(`run:${run.status}`);
      return originalPutRun(run);
    };
    const originalPutJob = h.deps.putJob!;
    h.deps.putJob = async (value) => {
      if (value.lastStatus === "ok") events.push(value.lease ? "job:baseline-with-lease" : "job:cleared");
      return originalPutJob(value);
    };
    h.deps.ensureDelivery = vi.fn(async (id, connectorId, source) => {
      events.push("delivery:ensure");
      expect(h.runs.get(source.kind === "job_run" ? source.jobRunId : "")?.status).toBe("ok");
      expect(h.jobs.get(source.kind === "job_run" ? h.runs.get(source.jobRunId)!.jobId : "")?.lease)
        .toBeDefined();
      return {
        id, connectorId, connectorConfigHash: "b".repeat(64), source,
        status: "ok" as const, attempt: 1, nextOffset: 0, createdAt: 1, finishedAt: 2,
      };
    });
    const service = new JobService(runPinned, h.deps);
    const saved = await service.save({
      ...draft,
      connectorBindings: [{ connectorId: "connector-1", connectorConfigHash: "b".repeat(64) }],
    }, undefined, true);
    h.setNow(saved.nextRunAt!);

    const result = await service.runAutomatic(saved.id, "schedule");

    expect(result.status).toBe("ok");
    expect(h.deps.ensureDelivery).toHaveBeenCalledWith(
      jobDeliveryId(result.id, "connector-1"),
      "connector-1",
      { kind: "job_run", jobRunId: result.id },
      "b".repeat(64),
    );
    expect(events.indexOf("run:ok")).toBeLessThan(events.indexOf("delivery:ensure"));
    expect(events.indexOf("job:baseline-with-lease")).toBeLessThan(events.indexOf("delivery:ensure"));
    expect(events.at(-1)).toBe("job:cleared");
  });

  it.each(["error", "partial", "unknown_commit"] as const)(
    "keeps JobRun ok and pauses future scheduling when delivery is %s",
    async (deliveryStatus) => {
      const runPinned = vi.fn(async () => runRecord("ok", "run-1", { price: 12 }));
      const h = harness(runPinned);
      h.deps.getConnector = async () => connector("connector-1");
      h.deps.readWatchText = vi.fn(async () => ["changed"]);
      h.deps.ensureDelivery = vi.fn(async (id, connectorId, source) => ({
        id, connectorId, connectorConfigHash: "b".repeat(64), source,
        status: deliveryStatus, attempt: 1, nextOffset: 0, createdAt: 1, finishedAt: 2,
        ...(deliveryStatus === "unknown_commit"
          ? { errorCode: "connector_unknown_commit" as const }
          : { errorCode: "connector_http_error" as const }),
      }));
      const service = new JobService(runPinned, h.deps);
      const saved = await service.save({
        ...draft,
        trigger: { kind: "page_change", everyMinutes: 5, watch: { selector: "#price" } },
        connectorBindings: [{ connectorId: "connector-1", connectorConfigHash: "b".repeat(64) }],
      }, undefined, true);
      const oldBaseline = { hash: "a".repeat(64), capturedAt: 1 };
      h.jobs.set(saved.id, { ...saved, changeBaseline: oldBaseline });
      h.setNow(saved.nextRunAt!);

      const result = await service.runAutomatic(saved.id, "page_change");

      expect(result).toMatchObject({ status: "ok" });
      expect(runPinned).toHaveBeenCalledOnce();
      expect(h.jobs.get(saved.id)).toMatchObject({
        status: "needs_attention",
        attentionReason: "connector_delivery_failed",
        lastStatus: "ok",
      });
      expect(h.jobs.get(saved.id)?.nextRunAt).toBeUndefined();
      expect(h.jobs.get(saved.id)?.lease).toBeUndefined();
      expect(h.jobs.get(saved.id)?.changeBaseline).not.toEqual(oldBaseline);
    },
  );

  it("treats an ensure exception as delivery attention without retrying the tool", async () => {
    const runPinned = vi.fn(async () => runRecord("ok", "run-1"));
    const h = harness(runPinned);
    h.deps.getConnector = async () => connector("connector-1");
    h.deps.ensureDelivery = vi.fn(async () => { throw new Error("storage_unavailable"); });
    const service = new JobService(runPinned, h.deps);
    const saved = await service.save({
      ...draft,
      connectorBindings: [{ connectorId: "connector-1", connectorConfigHash: "b".repeat(64) }],
    }, undefined, true);
    h.setNow(saved.nextRunAt!);

    const result = await service.runAutomatic(saved.id, "schedule");

    expect(result.status).toBe("ok");
    expect(runPinned).toHaveBeenCalledOnce();
    expect(h.jobs.get(saved.id)).toMatchObject({
      status: "needs_attention",
      attentionReason: "connector_delivery_failed",
      lease: { jobRunId: result.id },
    });

    h.deps.ensureDelivery = vi.fn(async (id, connectorId, source) => ({
      id, connectorId, connectorConfigHash: "b".repeat(64), source,
      status: "ok" as const, attempt: 1, nextOffset: 0, createdAt: 1, finishedAt: 2,
    }));
    const recoveringService = new JobService(runPinned, h.deps);
    await expect(recoveringService.resume(saved.id)).resolves.toMatchObject({ status: "active" });
    expect(runPinned).toHaveBeenCalledOnce();
    expect(h.jobs.get(saved.id)).toMatchObject({ status: "active" });
    expect(h.jobs.get(saved.id)?.lease).toBeUndefined();
  });

  it("reconciles a successful leased JobRun without rerunning the tool", async () => {
    const runPinned = vi.fn();
    const h = harness(runPinned);
    h.deps.getConnector = async () => connector("connector-1");
    const service = new JobService(runPinned, h.deps);
    const saved = await service.save({
      ...draft,
      connectorBindings: [{ connectorId: "connector-1", connectorConfigHash: "b".repeat(64) }],
    }, undefined, true);
    const finishedAt = 5_000;
    const successfulRun: JobRun = {
      id: "job-run-recover",
      jobId: saved.id,
      cause: "schedule",
      startedAt: 4_000,
      finishedAt,
      status: "ok",
      toolId: saved.toolId,
      toolVersion: saved.toolVersion,
      attempts: [{
        attempt: 1,
        startedAt: 4_000,
        finishedAt,
        runId: "run-already-finished",
        status: "ok",
      }],
      tab: { ownership: "created", tabId: 7 },
    };
    h.runs.set(successfulRun.id, successfulRun);
    h.jobs.set(saved.id, {
      ...saved,
      lastRunAt: finishedAt,
      lastStatus: "ok",
      nextRunAt: undefined,
      lease: { jobRunId: successfulRun.id, expiresAt: 999_999 },
    });

    await service.reconcileDeliveries();

    expect(runPinned).not.toHaveBeenCalled();
    expect(h.deps.ensureDelivery).toHaveBeenCalledWith(
      jobDeliveryId(successfulRun.id, "connector-1"),
      "connector-1",
      { kind: "job_run", jobRunId: successfulRun.id },
      "b".repeat(64),
    );
    expect(h.jobs.get(saved.id)).toMatchObject({
      status: "active",
      lastStatus: "ok",
      nextRunAt: finishedAt + 600_000,
    });
    expect(h.jobs.get(saved.id)?.lease).toBeUndefined();
  });

  it("protects a successful leased JobRun from edits, deletes and reruns until delivery reconcile", async () => {
    const runPinned = vi.fn();
    const h = harness(runPinned);
    h.deps.getConnector = async () => connector("connector-1");
    const service = new JobService(runPinned, h.deps);
    const saved = await service.save({
      ...draft,
      connectorBindings: [{ connectorId: "connector-1", connectorConfigHash: "b".repeat(64) }],
    }, undefined, true);
    const completed: JobRun = {
      id: "job-run-pending-delivery",
      jobId: saved.id,
      cause: "schedule",
      startedAt: 1,
      finishedAt: 2,
      status: "ok",
      toolId: saved.toolId,
      toolVersion: saved.toolVersion,
      attempts: [{ attempt: 1, startedAt: 1, finishedAt: 2, runId: "run-1", status: "ok" }],
      tab: { ownership: "created", tabId: 7 },
    };
    h.runs.set(completed.id, completed);
    h.jobs.set(saved.id, {
      ...saved,
      lastRunAt: 2,
      lastStatus: "ok",
      nextRunAt: undefined,
      lease: { jobRunId: completed.id, expiresAt: 999_999 },
    });

    await expect(service.save({ ...draft, connectorBindings: saved.connectorBindings }, saved.id, true))
      .rejects.toThrow("job_delivery_pending");
    await expect(service.delete(saved.id)).rejects.toThrow("job_delivery_pending");
    await expect(service.runNow(saved.id)).rejects.toThrow("job_delivery_pending");
    expect(runPinned).not.toHaveBeenCalled();

    const paused = await service.pause(saved.id);
    expect(paused).toMatchObject({
      status: "paused",
      lease: { jobRunId: completed.id },
    });
    await service.reconcileDeliveries();
    expect(h.deps.ensureDelivery).toHaveBeenCalledOnce();
    expect(h.jobs.get(saved.id)).toMatchObject({ status: "paused" });
    expect(h.jobs.get(saved.id)?.lease).toBeUndefined();
  });

  it("requires all failed deliveries to be retried successfully before explicit resume", async () => {
    const h = harness(vi.fn());
    h.deps.getConnector = async () => connector("connector-1");
    let deliveryStatus: ConnectorDelivery["status"] = "error";
    h.deps.getDelivery = async (id) => ({
      id,
      connectorId: "connector-1",
      connectorConfigHash: "b".repeat(64),
      source: { kind: "job_run", jobRunId: "job-run-1" },
      status: deliveryStatus,
      attempt: 1,
      nextOffset: 0,
      createdAt: 1,
      finishedAt: 2,
    });
    const service = new JobService(vi.fn(), h.deps);
    const saved = await service.save({
      ...draft,
      connectorBindings: [{ connectorId: "connector-1", connectorConfigHash: "b".repeat(64) }],
    }, undefined, true);
    h.runs.set("job-run-1", {
      id: "job-run-1",
      jobId: saved.id,
      cause: "schedule",
      startedAt: 1,
      finishedAt: 2,
      status: "ok",
      toolId: saved.toolId,
      toolVersion: saved.toolVersion,
      attempts: [{ attempt: 1, startedAt: 1, finishedAt: 2, runId: "run-1", status: "ok" }],
      tab: { ownership: "created", tabId: 7 },
    });
    h.jobs.set(saved.id, {
      ...saved,
      status: "needs_attention",
      attentionReason: "connector_delivery_failed",
      lastRunAt: 2,
      lastStatus: "ok",
      nextRunAt: undefined,
    });

    await expect(service.resume(saved.id)).rejects.toThrow("connector_delivery_unresolved");
    deliveryStatus = "ok";
    await expect(service.resume(saved.id)).resolves.toMatchObject({
      status: "active",
      attentionReason: undefined,
    });
  });

  it("does not let editing bypass delivery attention and explicit resume", async () => {
    const h = harness(vi.fn());
    h.deps.getConnector = async () => connector("connector-1");
    const service = new JobService(vi.fn(), h.deps);
    const saved = await service.save({
      ...draft,
      connectorBindings: [{ connectorId: "connector-1", connectorConfigHash: "b".repeat(64) }],
    }, undefined, true);
    h.jobs.set(saved.id, {
      ...saved,
      status: "needs_attention",
      attentionReason: "connector_delivery_failed",
      nextRunAt: undefined,
    });

    const edited = await service.save({
      ...draft,
      name: "Edited while attention is unresolved",
      connectorBindings: saved.connectorBindings,
    }, saved.id, true);

    expect(edited).toMatchObject({
      status: "needs_attention",
      attentionReason: "connector_delivery_failed",
    });
    expect(edited.nextRunAt).toBeUndefined();
  });
});

function runRecord(status: RunRecord["status"], id: string, output?: RunRecord["output"]): RunRecord {
  return {
    id,
    toolId: tool.id,
    toolVersion: 1,
    url: "https://example.com/products",
    startedAt: 1,
    finishedAt: 2,
    status,
    stepLog: [],
    source: "job",
    ...(output === undefined ? {} : { output }),
  };
}

describe("JobService scheduled attempts", () => {
  it("assigns nextRunAt when an automatic Job is saved", async () => {
    const h = harness(vi.fn());
    const saved = await h.service.save(draft);
    expect(saved.nextRunAt).toBe(601_000);
  });

  it("keeps retries in one JobRun and schedules the next recurring run after success", async () => {
    const runPinned = vi.fn()
      .mockResolvedValueOnce(runRecord("error", "run-1"))
      .mockResolvedValueOnce(runRecord("ok", "run-2"));
    const h = harness(runPinned);
    const saved = await h.service.save(draft);
    h.setNow(saved.nextRunAt!);
    const first = await h.service.runAutomatic(saved.id, "schedule");
    expect(first).toMatchObject({ status: "retry_wait" });
    expect(first.attempts).toHaveLength(1);
    expect(h.jobs.get(saved.id)).toMatchObject({
      nextRunAt: saved.nextRunAt! + 60_000,
      lease: { jobRunId: first.id, expiresAt: saved.nextRunAt! + 60_000 },
    });
    expect(h.deps.notifyTerminal).not.toHaveBeenCalled();

    h.setNow(saved.nextRunAt! + 60_000);
    const second = await h.service.runAutomatic(saved.id, "schedule");
    expect(second.status).toBe("ok");
    expect(second.attempts.map((attempt) => attempt.runId)).toEqual(["run-1", "run-2"]);
    expect(h.jobs.get(saved.id)?.lease).toBeUndefined();
    expect(h.jobs.get(saved.id)?.nextRunAt).toBe(saved.nextRunAt! + 60_000 + 600_000);
    expect(h.deps.notifyTerminal).toHaveBeenCalledTimes(1);
  });

  it("moves to needs_attention after retries are exhausted", async () => {
    const runPinned = vi.fn(async () => runRecord("error", "run-" + Math.random()));
    const h = harness(runPinned);
    const saved = await h.service.save({
      ...draft,
      retry: { maxAttempts: 1, backoffMinutes: [] },
    });
    h.setNow(saved.nextRunAt!);
    const result = await h.service.runAutomatic(saved.id, "schedule");
    expect(result.status).toBe("error");
    expect(h.jobs.get(saved.id)).toMatchObject({
      status: "needs_attention",
      attentionReason: "retry_exhausted",
    });
    expect(h.jobs.get(saved.id)?.nextRunAt).toBeUndefined();
  });

  it("resumes a manual retry from the same JobRun", async () => {
    const runPinned = vi.fn()
      .mockResolvedValueOnce(runRecord("error", "run-1"))
      .mockResolvedValueOnce(runRecord("ok", "run-2"));
    const h = harness(runPinned);
    const saved = await h.service.save({ ...draft, trigger: { kind: "manual" } });
    const first = await h.service.runNow(saved.id);
    expect(first.status).toBe("retry_wait");
    h.setNow(h.jobs.get(saved.id)!.nextRunAt!);
    const second = await h.service.runAutomatic(saved.id, "manual");
    expect(second?.status).toBe("ok");
    expect(second?.attempts.map((attempt) => attempt.runId)).toEqual(["run-1", "run-2"]);
  });

  it("carries a dangerous approval only across retries of the same manual run", async () => {
    const dangerousTool: Tool = {
      ...tool,
      versions: [{ ...tool.versions[0], steps: [{ kind: "tool", tool: "submitForm", args: { selector: "form" } }] }],
    };
    const runPinned = vi.fn()
      .mockResolvedValueOnce(runRecord("error", "run-1"))
      .mockResolvedValueOnce(runRecord("ok", "run-2"));
    const h = harness(runPinned);
    h.deps.getTool = async () => dangerousTool;
    const service = new JobService(runPinned, h.deps);
    const saved = await service.save({ ...draft, trigger: { kind: "manual" } });
    const first = await service.runNow(saved.id, {}, true);
    expect(first).toMatchObject({ status: "retry_wait", dangerousApproved: true });
    h.setNow(h.jobs.get(saved.id)!.nextRunAt!);
    expect((await service.runAutomatic(saved.id, "manual")).status).toBe("ok");
    await expect(service.runNow(saved.id)).rejects.toThrow("dangerous_approval_required");
  });

  it("cancels a pending retry lease when the Job is paused", async () => {
    const h = harness(vi.fn(async () => runRecord("error", "run-1")));
    const saved = await h.service.save(draft);
    h.setNow(saved.nextRunAt!);
    const run = await h.service.runAutomatic(saved.id, "schedule");
    expect(run.status).toBe("retry_wait");
    const paused = await h.service.pause(saved.id);
    expect(paused.lease).toBeUndefined();
    expect(h.runs.get(run.id)).toMatchObject({ status: "aborted" });
  });

  it("rejects a concurrent manual run while the Job lease is active", async () => {
    let resolveRun!: (run: RunRecord) => void;
    const runPinned = vi.fn(() => new Promise<RunRecord>((resolve) => { resolveRun = resolve; }));
    const h = harness(runPinned);
    const saved = await h.service.save({ ...draft, trigger: { kind: "manual" } });
    const first = h.service.runNow(saved.id);
    await vi.waitFor(() => expect(runPinned).toHaveBeenCalledTimes(1));
    await expect(h.service.runNow(saved.id)).rejects.toThrow("job_already_running");
    await expect(h.service.delete(saved.id)).rejects.toThrow("job_already_running");
    await expect(h.service.upgrade(saved.id, 1)).rejects.toThrow("job_already_running");
    resolveRun(runRecord("ok", "run-1"));
    await first;
  });

  it("serializes simultaneous manual starts before either call can persist a lease", async () => {
    const runPinned = vi.fn(async () => runRecord("ok", "run-1"));
    const h = harness(runPinned);
    const saved = await h.service.save({ ...draft, trigger: { kind: "manual" } });

    const results = await Promise.allSettled([
      h.service.runNow(saved.id),
      h.service.runNow(saved.id),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(runPinned).toHaveBeenCalledTimes(1);
  });

  it("keeps a Job paused when an in-flight run completes", async () => {
    let resolveRun!: (run: RunRecord) => void;
    const runPinned = vi.fn(() => new Promise<RunRecord>((resolve) => { resolveRun = resolve; }));
    const h = harness(runPinned);
    const saved = await h.service.save(draft);
    h.setNow(saved.nextRunAt!);
    const running = h.service.runAutomatic(saved.id, "schedule");
    await vi.waitFor(() => expect(runPinned).toHaveBeenCalledTimes(1));
    const paused = await h.service.pause(saved.id);
    expect(paused).toMatchObject({ status: "paused" });
    expect(paused.lease).toBeDefined();
    resolveRun(runRecord("ok", "run-1"));
    await running;
    expect(h.jobs.get(saved.id)).toMatchObject({ status: "paused" });
    expect(h.jobs.get(saved.id)?.lease).toBeUndefined();
    expect(h.jobs.get(saved.id)?.nextRunAt).toBeUndefined();
  });

  it("converts an expired running attempt to interrupted before retrying", async () => {
    const h = harness(vi.fn(async () => runRecord("ok", "run-2")));
    const saved = await h.service.save(draft);
    const stuck: JobRun = {
      id: "stuck",
      jobId: saved.id,
      cause: "schedule",
      startedAt: 10,
      status: "running",
      toolId: tool.id,
      toolVersion: 1,
      attempts: [{ attempt: 1, startedAt: 10, status: "running" }],
      tab: { ownership: "created", tabId: 99 },
    };
    h.runs.set(stuck.id, stuck);
    h.jobs.set(saved.id, {
      ...saved,
      nextRunAt: 1_000,
      lease: { jobRunId: stuck.id, expiresAt: 1_000 },
    });
    h.setNow(2_000);
    const result = await h.service.runAutomatic(saved.id, "schedule");
    expect(result.attempts[0]).toMatchObject({
      status: "error",
      errorCode: "service_worker_interrupted",
    });
    expect(result.attempts[1]).toMatchObject({ status: "ok", runId: "run-2" });
  });

  it("clears scheduling while paused and recomputes from the resume time", async () => {
    const h = harness(vi.fn());
    const saved = await h.service.save(draft);
    h.setNow(5_000);
    const paused = await h.service.pause(saved.id);
    expect(paused).toMatchObject({ status: "paused" });
    expect(paused.nextRunAt).toBeUndefined();

    h.setNow(10_000);
    const resumed = await h.service.resume(saved.id);
    expect(resumed).toMatchObject({ status: "active", nextRunAt: 610_000 });
  });

  it("snapshots output and diffs against the previous successful JobRun", async () => {
    const runPinned = vi.fn()
      .mockResolvedValueOnce(runRecord("ok", "run-1", { price: 10, stock: true }))
      .mockResolvedValueOnce(runRecord("ok", "run-2", { price: 12, stock: true }));
    const h = harness(runPinned);
    const saved = await h.service.save(draft);
    h.setNow(saved.nextRunAt!);
    const first = await h.service.runAutomatic(saved.id, "schedule");
    expect(first.output).toMatchObject({ truncated: false, preview: { price: 10, stock: true } });
    expect(first.diff).toBeUndefined();

    h.setNow(h.jobs.get(saved.id)!.nextRunAt!);
    const second = await h.service.runAutomatic(saved.id, "schedule");
    expect(second.diffFromJobRunId).toBe(first.id);
    expect(second.diff).toEqual({
      changes: [{ path: "$.price", before: 10, after: 12 }],
      truncated: false,
    });
  });
});

describe("JobService page-change checks", () => {
  const pageChangeDraft: JobDraft = {
    ...draft,
    trigger: { kind: "page_change", everyMinutes: 5, watch: { selector: "#price" } },
  };

  it("stores only a normalized SHA-256 baseline on the first check", async () => {
    const runPinned = vi.fn();
    const h = harness(runPinned);
    h.deps.readWatchText = vi.fn(async () => ["  A\u030A\n\t B  "]);
    const service = new JobService(runPinned, h.deps);
    const saved = await service.save(pageChangeDraft);
    h.setNow(saved.nextRunAt!);
    const result = await service.runAutomatic(saved.id, "page_change");
    expect(result).toBeUndefined();
    expect(runPinned).not.toHaveBeenCalled();
    expect(h.jobs.get(saved.id)).toMatchObject({
      lastCheckAt: saved.nextRunAt,
      changeBaseline: {
        hash: "b65e6b6a5c0de4385022fac13e744fdb4716265d0927221b1bb369a5b0c2838d",
        capturedAt: saved.nextRunAt,
      },
    });
    expect(JSON.stringify(h.jobs.get(saved.id))).not.toContain("Å B");
  });

  it("stores the initial baseline when a failed first check succeeds on retry", async () => {
    const runPinned = vi.fn();
    const h = harness(runPinned);
    h.deps.readWatchText = vi.fn()
      .mockRejectedValueOnce(new Error("tab_closed"))
      .mockResolvedValueOnce(["ready"]);
    const service = new JobService(runPinned, h.deps);
    const saved = await service.save(pageChangeDraft);
    h.setNow(saved.nextRunAt!);

    const failed = await service.runAutomatic(saved.id, "page_change");
    expect(failed?.status).toBe("retry_wait");
    h.setNow(h.jobs.get(saved.id)!.nextRunAt!);
    await service.runAutomatic(saved.id, "page_change");

    expect(h.jobs.get(saved.id)?.changeBaseline).toEqual({
      hash: "b24d6d33736ecd5604a4b17bc9c6481039fac362bb7df044ef1c10a2bfd21db6",
      capturedAt: h.jobs.get(saved.id)?.lastCheckAt,
    });
    expect(runPinned).not.toHaveBeenCalled();
  });

  it("does not create a JobRun when the normalized content is unchanged", async () => {
    const runPinned = vi.fn();
    const h = harness(runPinned);
    h.deps.readWatchText = vi.fn(async () => [" A\u030A B "]);
    const service = new JobService(runPinned, h.deps);
    const saved = await service.save(pageChangeDraft);
    h.jobs.set(saved.id, {
      ...saved,
      changeBaseline: {
        hash: "b65e6b6a5c0de4385022fac13e744fdb4716265d0927221b1bb369a5b0c2838d",
        capturedAt: 1,
      },
    });
    h.setNow(saved.nextRunAt!);
    expect(await service.runAutomatic(saved.id, "page_change")).toBeUndefined();
    expect(runPinned).not.toHaveBeenCalled();
    expect(h.runs.size).toBe(0);
  });

  it("closes a retry chain when the watched change reverts before retry", async () => {
    const runPinned = vi.fn(async () => runRecord("error", "run-1"));
    const h = harness(runPinned);
    h.deps.readWatchText = vi.fn()
      .mockResolvedValueOnce(["changed"])
      .mockResolvedValueOnce(["original"]);
    const service = new JobService(runPinned, h.deps);
    const saved = await service.save(pageChangeDraft);
    h.jobs.set(saved.id, {
      ...saved,
      changeBaseline: { hash: "0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5", capturedAt: 1 },
    });
    h.setNow(saved.nextRunAt!);
    const first = await service.runAutomatic(saved.id, "page_change");
    expect(first?.status).toBe("retry_wait");
    h.setNow(h.jobs.get(saved.id)!.nextRunAt!);
    const second = await service.runAutomatic(saved.id, "page_change");
    expect(second).toMatchObject({ status: "aborted", errorCode: "change_reverted" });
    expect(h.jobs.get(saved.id)?.lease).toBeUndefined();
  });

  it("runs only after a change and advances the baseline only on success", async () => {
    const runPinned = vi.fn()
      .mockResolvedValueOnce(runRecord("error", "run-1"))
      .mockResolvedValueOnce(runRecord("ok", "run-2"));
    const h = harness(runPinned);
    h.deps.readWatchText = vi.fn(async () => ["changed"]);
    const service = new JobService(runPinned, h.deps);
    const saved = await service.save(pageChangeDraft);
    const oldBaseline = { hash: "a".repeat(64), capturedAt: 1 };
    h.jobs.set(saved.id, { ...saved, changeBaseline: oldBaseline });
    h.setNow(saved.nextRunAt!);
    const first = await service.runAutomatic(saved.id, "page_change");
    expect(first?.status).toBe("retry_wait");
    expect(h.jobs.get(saved.id)?.changeBaseline).toEqual(oldBaseline);

    h.setNow(h.jobs.get(saved.id)!.nextRunAt!);
    const second = await service.runAutomatic(saved.id, "page_change");
    expect(second?.status).toBe("ok");
    expect(h.jobs.get(saved.id)?.changeBaseline?.hash)
      .toBe("d67e2e944994496c8d8ec76eed0cf9f09679448d584b532bebf941852a37f5ed");
  });

  it.each([
    [[], "watch_selector_missing"],
    [["one", "two"], "watch_selector_ambiguous"],
  ])("records %s as a failed attempt and pauses after exhaustion", async (values, code) => {
    const runPinned = vi.fn();
    const h = harness(runPinned);
    h.deps.readWatchText = vi.fn(async () => values);
    const service = new JobService(runPinned, h.deps);
    const saved = await service.save({
      ...pageChangeDraft,
      retry: { maxAttempts: 1, backoffMinutes: [] },
    });
    h.jobs.set(saved.id, {
      ...saved,
      changeBaseline: { hash: "a".repeat(64), capturedAt: 1 },
    });
    h.setNow(saved.nextRunAt!);
    const result = await service.runAutomatic(saved.id, "page_change");
    expect(result).toMatchObject({ status: "error", errorCode: code });
    expect(h.jobs.get(saved.id)).toMatchObject({
      status: "needs_attention",
      attentionReason: code,
    });
    expect(runPinned).not.toHaveBeenCalled();
  });
});
