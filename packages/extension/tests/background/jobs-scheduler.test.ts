import { describe, expect, it, vi } from "vitest";
import type { Job, JobRun } from "@aipagego/shared/jobs";
import { JobScheduler } from "@/background/jobs/scheduler";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    name: "Scheduled",
    toolId: "tool-1",
    toolVersion: 1,
    toolVersionHash: "a".repeat(64),
    targetUrl: "https://example.com/",
    inputs: {},
    trigger: {
      kind: "schedule",
      schedule: { kind: "interval", everyMinutes: 10 },
    },
    status: "active",
    safety: { severity: "safe" },
    retry: { maxAttempts: 3, backoffMinutes: [1, 5] },
    notifications: { onChange: true, onSuccess: false, onFailure: true },
    connectorBindings: [],
    nextRunAt: 1_000,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("JobScheduler", () => {
  it("never dispatches a manual Job without an active retry lease", async () => {
    const runDue = vi.fn();
    const scheduler = new JobScheduler({
      now: () => 2_000,
      listJobs: async () => [job({
        trigger: { kind: "manual" },
        nextRunAt: 1_000,
      })],
      putJob: async (value) => value,
      putJobRun: async (value) => value,
      runDue,
      createAlarm: vi.fn(),
      clearAlarm: vi.fn(async () => true),
      uuid: () => "unused",
    });
    await scheduler.reconcile();
    expect(runDue).not.toHaveBeenCalled();
  });

  it("resumes a leased manual retry with its original cause", async () => {
    const runDue = vi.fn();
    const scheduler = new JobScheduler({
      now: () => 2_000,
      listJobs: async () => [job({
        trigger: { kind: "manual" },
        nextRunAt: 1_000,
        lease: { jobRunId: "manual-run", expiresAt: 1_000 },
      })],
      putJob: async (value) => value, putJobRun: async (value) => value,
      runDue, createAlarm: vi.fn(), clearAlarm: vi.fn(async () => true), uuid: () => "unused",
    });
    await scheduler.reconcile();
    expect(runDue).toHaveBeenCalledWith("job-1", "manual");
  });

  it("runs due Jobs serially and installs one alarm for the next due time", async () => {
    const rows = [
      job({ id: "a", nextRunAt: 900 }),
      job({ id: "b", nextRunAt: 950 }),
      job({ id: "future", nextRunAt: 5_000 }),
    ];
    const order: string[] = [];
    let active = 0;
    const createAlarm = vi.fn();
    const scheduler = new JobScheduler({
      now: () => 1_000,
      listJobs: async () => rows,
      putJob: async (value) => value,
      putJobRun: async (value) => value,
      runDue: async (id) => {
        active += 1;
        expect(active).toBe(1);
        order.push(id);
        active -= 1;
      },
      createAlarm,
      clearAlarm: vi.fn(async () => true),
      uuid: () => "missed",
    });
    await scheduler.reconcile();
    expect(order).toEqual(["a", "b"]);
    expect(createAlarm).toHaveBeenLastCalledWith("aipagego.jobs.dispatch", { when: 5_000 });
  });

  it("continues with later due Jobs when one execution throws", async () => {
    const runDue = vi.fn(async (id: string) => { if (id === "a") throw new Error("broken"); });
    const onRunError = vi.fn();
    const scheduler = new JobScheduler({
      now: () => 1_000,
      listJobs: async () => [job({ id: "a", nextRunAt: 900 }), job({ id: "b", nextRunAt: 950 })],
      putJob: async (value) => value, putJobRun: async (value) => value,
      runDue, onRunError, createAlarm: vi.fn(), clearAlarm: vi.fn(async () => true), uuid: () => "unused",
    });
    await scheduler.reconcile();
    expect(runDue.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    expect(onRunError).toHaveBeenCalledWith("a", expect.any(Error));
  });

  it("records a late trigger as missed and does not run it", async () => {
    const rows = [job({ nextRunAt: 1_000 })];
    const savedJobs: Job[] = [];
    const savedRuns: JobRun[] = [];
    const runDue = vi.fn();
    const scheduler = new JobScheduler({
      now: () => 1_000 + 5 * 60_000 + 1,
      listJobs: async () => rows,
      putJob: async (value) => { savedJobs.push(value); return value; },
      putJobRun: async (value) => { savedRuns.push(value); return value; },
      runDue,
      createAlarm: vi.fn(),
      clearAlarm: vi.fn(async () => true),
      uuid: () => "missed-1",
    });
    await scheduler.reconcile();
    expect(runDue).not.toHaveBeenCalled();
    expect(savedRuns[0]).toMatchObject({
      id: "missed-1",
      status: "missed",
      scheduledAt: 1_000,
      errorCode: "browser_offline",
    });
    expect(savedJobs[0].nextRunAt).toBeGreaterThan(1_000 + 5 * 60_000);
  });

  it("treats a due lease as a retry instead of an offline miss", async () => {
    const runDue = vi.fn();
    const scheduler = new JobScheduler({
      now: () => 1_000_000,
      listJobs: async () => [job({
        nextRunAt: 1,
        lease: { jobRunId: "retry-run", expiresAt: 1 },
      })],
      putJob: async (value) => value,
      putJobRun: async (value) => value,
      runDue,
      createAlarm: vi.fn(),
      clearAlarm: vi.fn(async () => true),
      uuid: () => "unused",
    });
    await scheduler.reconcile();
    expect(runDue).toHaveBeenCalledWith("job-1", "schedule");
  });

  it("recomputes active daily Jobs when the browser timezone changes", async () => {
    const rows = [job({
      trigger: {
        kind: "schedule",
        schedule: { kind: "daily", localTime: "09:00", daysOfWeek: [1, 2, 3, 4, 5] },
      },
      nextRunAt: 20_000,
    })];
    const putJob = vi.fn(async (value: Job) => {
      rows[0] = value;
      return value;
    });
    const saveTimeZone = vi.fn(async () => undefined);
    const scheduler = new JobScheduler({
      now: () => 1_000,
      listJobs: async () => rows,
      putJob,
      putJobRun: async (value) => value,
      runDue: vi.fn(),
      createAlarm: vi.fn(),
      clearAlarm: vi.fn(async () => true),
      uuid: () => "unused",
      getTimeZone: () => "America/Los_Angeles",
      loadTimeZone: async () => "Asia/Shanghai",
      saveTimeZone,
      computeNextRunAt: () => 30_000,
    });
    await scheduler.reconcile();
    expect(putJob).toHaveBeenCalledWith(expect.objectContaining({ nextRunAt: 30_000 }));
    expect(saveTimeZone).toHaveBeenCalledWith("America/Los_Angeles");
  });
});
