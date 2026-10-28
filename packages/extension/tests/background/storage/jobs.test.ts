import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Job, JobRun } from "@aipagego/shared/jobs";
import { _resetDBForTests, getDB } from "@/background/storage/db";
import {
  deleteJob,
  getJob,
  getJobRun,
  listJobRuns,
  listJobs,
  putJob,
  putJobRun,
  listJobRunsPage,
  pruneJobRuns,
} from "@/background/storage/jobs";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    name: "Price",
    toolId: "tool-1",
    toolVersion: 1,
    toolVersionHash: "a".repeat(64),
    targetUrl: "https://example.com/products",
    inputs: {},
    trigger: { kind: "manual" },
    status: "active",
    safety: { severity: "safe" },
    retry: { maxAttempts: 3, backoffMinutes: [1, 5] },
    notifications: { onChange: true, onSuccess: false, onFailure: true },
    connectorBindings: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function jobRun(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: "jr-1",
    jobId: "job-1",
    cause: "manual",
    startedAt: 1,
    status: "running",
    toolId: "tool-1",
    toolVersion: 1,
    attempts: [],
    tab: { ownership: "existing", tabId: 1 },
    ...overrides,
  };
}

describe("jobs storage", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
  });
  afterEach(() => _resetDBForTests());

  it("puts, gets and lists jobs by updated time", async () => {
    await putJob(job());
    await putJob(job({ id: "job-2", updatedAt: 2 }));
    expect(await getJob("job-1")).toMatchObject({ name: "Price" });
    expect((await listJobs()).map((item) => item.id)).toEqual(["job-2", "job-1"]);
  });

  it("lists JobRuns newest first with a bounded limit", async () => {
    await putJob(job());
    await putJobRun(jobRun());
    await putJobRun(jobRun({ id: "jr-2", startedAt: 2, status: "ok" }));
    await putJobRun(jobRun({ id: "jr-other", jobId: "other", startedAt: 3 }));
    expect((await listJobRuns("job-1", 1)).map((item) => item.id)).toEqual(["jr-2"]);
    expect(await getJobRun("jr-1")).toMatchObject({ jobId: "job-1" });
  });

  it("paginates JobRuns with a stable cursor", async () => {
    await putJob(job());
    await putJobRun(jobRun({ id: "jr-1", startedAt: 1 }));
    await putJobRun(jobRun({ id: "jr-2", startedAt: 2 }));
    await putJobRun(jobRun({ id: "jr-3", startedAt: 3 }));
    const first = await listJobRunsPage("job-1", { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["jr-3", "jr-2"]);
    expect(first.nextCursor).toBeTruthy();
    const second = await listJobRunsPage("job-1", { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.id)).toEqual(["jr-1"]);
    expect(second.nextCursor).toBeUndefined();
    await expect(listJobRunsPage("job-1", { limit: 2, cursor: "unknown" }))
      .rejects.toThrow("invalid_job_run_cursor");
  });

  it("prunes per-Job/global history and cascades owned runs and collection results", async () => {
    await putJob(job());
    const db = await getDB();
    for (let i = 1; i <= 4; i++) {
      const runId = `run-${i}`;
      await db.put("runs", {
        id: runId,
        toolId: "tool-1",
        toolVersion: 1,
        url: "https://example.com",
        startedAt: i,
        status: "ok",
        stepLog: [],
        source: "job",
      });
      await db.put("collection_results", {
        resultId: `result-${i}`,
        runId,
        tabId: 1,
        sourceUrl: "https://example.com",
        recipe: {
          version: 1,
          mode: "single",
          fields: [{ id: "name", name: "Name", selector: "h1", valueMode: "text", required: true }],
          pagination: { kind: "single" },
          dedupeBy: ["name"],
          maxRows: 1,
          maxBytes: 1_024,
        },
        rows: [],
        status: "completed",
        phase: "completed",
        rowCount: 0,
        byteSize: 0,
        pageCount: 1,
        duplicateCount: 0,
        missingRequiredCount: 0,
        startedAt: i,
        lastAccessedAt: i,
      });
      await putJobRun(jobRun({
        id: `jr-${i}`,
        startedAt: i,
        status: "ok",
        attempts: [{ attempt: 1, startedAt: i, finishedAt: i, status: "ok", runId }],
      }));
    }
    expect(await pruneJobRuns({ perJob: 2, global: 3 })).toEqual(["jr-1", "jr-2"]);
    expect(await db.get("runs", "run-1")).toBeUndefined();
    expect(await db.get("collection_results", "result-1")).toBeUndefined();
    expect(await db.get("runs", "run-4")).toBeDefined();
  });

  it("deletes a Job and its JobRuns without deleting another Job", async () => {
    await putJob(job());
    await putJob(job({ id: "job-2" }));
    await putJobRun(jobRun());
    await putJobRun(jobRun({ id: "jr-2", jobId: "job-2" }));
    await deleteJob("job-1");
    expect(await getJob("job-1")).toBeUndefined();
    expect(await getJobRun("jr-1")).toBeUndefined();
    expect(await getJob("job-2")).toBeDefined();
    expect(await getJobRun("jr-2")).toBeDefined();
  });
});
