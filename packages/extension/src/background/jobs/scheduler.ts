import {
  computeNextJobRunAt,
  type Job,
  type JobRun,
  type JobRunCause,
} from "@aipagego/shared/jobs";

export const JOBS_DISPATCH_ALARM = "aipagego.jobs.dispatch";
const MISSED_AFTER_MS = 5 * 60_000;

export type JobSchedulerDeps = {
  now: () => number;
  uuid: () => string;
  listJobs: () => Promise<Job[]>;
  putJob: (job: Job) => Promise<Job>;
  putJobRun: (run: JobRun) => Promise<JobRun>;
  runDue: (jobId: string, cause: JobRunCause) => Promise<unknown>;
  onRunError?: (jobId: string, error: unknown) => void;
  createAlarm: (name: string, info: { when: number }) => void;
  clearAlarm: (name: string) => Promise<boolean>;
  getTimeZone?: () => string;
  loadTimeZone?: () => Promise<string | undefined>;
  saveTimeZone?: (timeZone: string) => Promise<void>;
  computeNextRunAt?: typeof computeNextJobRunAt;
  notifyTerminal?: (job: Job, run: JobRun) => Promise<void>;
};

function causeFor(job: Job): JobRunCause {
  if (job.trigger.kind === "manual") return "manual";
  return job.trigger.kind === "page_change" ? "page_change" : "schedule";
}

export class JobScheduler {
  private reconciling: Promise<void> | null = null;

  constructor(private readonly deps: JobSchedulerDeps) {}

  reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.doReconcile().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  private async doReconcile(): Promise<void> {
    const now = this.deps.now();
    await this.reconcileTimeZone(now);
    const due = (await this.deps.listJobs())
      .filter((job) =>
        (job.trigger.kind !== "manual" || job.lease != null) &&
        job.status === "active" &&
        job.nextRunAt != null &&
        job.nextRunAt <= now
      )
      .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));

    for (const job of due) {
      const scheduledAt = job.nextRunAt as number;
      if (!job.lease && now - scheduledAt > MISSED_AFTER_MS) {
        const finishedAt = this.deps.now();
        const missed = await this.deps.putJobRun({
          id: this.deps.uuid(),
          jobId: job.id,
          cause: causeFor(job),
          scheduledAt,
          startedAt: finishedAt,
          finishedAt,
          status: "missed",
          toolId: job.toolId,
          toolVersion: job.toolVersion,
          attempts: [],
          tab: { ownership: "existing" },
          errorCode: "browser_offline",
          error: "browser_offline",
        });
        await this.deps.putJob({
          ...job,
          lastRunAt: finishedAt,
          lastStatus: "missed",
          nextRunAt: computeNextJobRunAt(job.trigger, finishedAt),
          updatedAt: finishedAt,
        });
        await this.deps.notifyTerminal?.(job, missed).catch(() => undefined);
        continue;
      }
      try {
        await this.deps.runDue(job.id, causeFor(job));
      } catch (error) {
        this.deps.onRunError?.(job.id, error);
      }
    }

    const future = (await this.deps.listJobs())
      .filter((job) =>
        (job.trigger.kind !== "manual" || job.lease != null) &&
        job.status === "active" &&
        job.nextRunAt != null &&
        job.nextRunAt > now
      )
      .sort((a, b) => (a.nextRunAt as number) - (b.nextRunAt as number));
    if (future.length === 0) {
      await this.deps.clearAlarm(JOBS_DISPATCH_ALARM);
      return;
    }
    this.deps.createAlarm(JOBS_DISPATCH_ALARM, {
      when: future[0].nextRunAt as number,
    });
  }

  private async reconcileTimeZone(now: number): Promise<void> {
    const { getTimeZone, loadTimeZone, saveTimeZone } = this.deps;
    if (!getTimeZone || !loadTimeZone || !saveTimeZone) return;
    const current = getTimeZone();
    const previous = await loadTimeZone();
    if (previous === current) return;
    if (previous != null) {
      const compute = this.deps.computeNextRunAt ?? computeNextJobRunAt;
      const jobs = await this.deps.listJobs();
      for (const job of jobs) {
        if (
          job.status !== "active" ||
          job.lease ||
          job.trigger.kind !== "schedule" ||
          job.trigger.schedule.kind !== "daily"
        ) continue;
        await this.deps.putJob({
          ...job,
          nextRunAt: compute(job.trigger, now),
          updatedAt: now,
        });
      }
    }
    await saveTimeZone(current);
  }
}
