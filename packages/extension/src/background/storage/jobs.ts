import { JobRunSchema, JobSchema, type Job, type JobRun } from "@aipagego/shared/jobs";
import { getDB } from "./db";

export async function putJob(job: Job): Promise<Job> {
  const parsed = JobSchema.parse(job) as Job;
  const db = await getDB();
  await db.put("jobs", parsed);
  return parsed;
}

export async function getJob(id: string): Promise<Job | undefined> {
  const db = await getDB();
  const raw = await db.get("jobs", id);
  const parsed = JobSchema.safeParse(raw);
  return parsed.success ? parsed.data as Job : undefined;
}

export async function listJobs(): Promise<Job[]> {
  const db = await getDB();
  const rows = await db.getAll("jobs");
  return rows
    .map((row) => JobSchema.safeParse(row))
    .filter((result): result is { success: true; data: Job } => result.success)
    .map((result) => result.data)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function putJobRun(run: JobRun): Promise<JobRun> {
  const parsed = JobRunSchema.parse(run) as JobRun;
  const db = await getDB();
  await db.put("job_runs", parsed);
  if (["ok", "error", "aborted", "missed"].includes(parsed.status)) {
    await pruneJobRuns();
  }
  return parsed;
}

export async function getJobRun(id: string): Promise<JobRun | undefined> {
  const db = await getDB();
  const raw = await db.get("job_runs", id);
  const parsed = JobRunSchema.safeParse(raw);
  return parsed.success ? parsed.data as JobRun : undefined;
}

export async function listJobRuns(jobId: string, limit = 50): Promise<JobRun[]> {
  const db = await getDB();
  const rows = await db.getAll("job_runs");
  return rows
    .map((row) => JobRunSchema.safeParse(row))
    .filter((result): result is { success: true; data: JobRun } => result.success)
    .map((result) => result.data)
    .filter((run) => run.jobId === jobId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, Math.max(0, Math.min(limit, 200)));
}

function cursorFor(run: JobRun): string {
  return `${run.startedAt}:${encodeURIComponent(run.id)}`;
}

export async function listJobRunsPage(
  jobId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<{ items: JobRun[]; nextCursor?: string }> {
  const all = await listJobRuns(jobId, 200);
  const cursorIndex = options.cursor == null
    ? -1
    : all.findIndex((run) => cursorFor(run) === options.cursor);
  if (options.cursor != null && cursorIndex < 0) throw new Error("invalid_job_run_cursor");
  const start = cursorIndex + 1;
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const items = all.slice(start, start + limit);
  return start + items.length < all.length && items.length > 0
    ? { items, nextCursor: cursorFor(items.at(-1)!) }
    : { items };
}

async function cascadeDeleteJobRun(run: JobRun): Promise<void> {
  const db = await getDB();
  for (const attempt of run.attempts) {
    if (!attempt.runId) continue;
    const collection = await db.getFromIndex("collection_results", "by_runId", attempt.runId);
    if (collection) await db.delete("collection_results", collection.resultId);
    await db.delete("runs", attempt.runId);
  }
  await db.delete("job_runs", run.id);
}

export async function pruneJobRuns(options: { perJob?: number; global?: number } = {}): Promise<string[]> {
  const perJob = options.perJob ?? 200;
  const global = options.global ?? 2_000;
  const db = await getDB();
  const all = (await db.getAll("job_runs"))
    .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
  const selected = new Map<string, JobRun>();
  const byJob = new Map<string, JobRun[]>();
  for (const run of all) byJob.set(run.jobId, [...(byJob.get(run.jobId) ?? []), run]);
  for (const runs of byJob.values()) {
    for (const run of runs.slice(perJob)) {
      if (run.status !== "running" && run.status !== "retry_wait") selected.set(run.id, run);
    }
  }
  const remaining = all.filter((run) => !selected.has(run.id));
  for (const run of remaining.slice(global)) {
    if (run.status !== "running" && run.status !== "retry_wait") selected.set(run.id, run);
  }
  const evicted = [...selected.values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  for (const run of evicted) await cascadeDeleteJobRun(run);
  return evicted.map((run) => run.id);
}

export async function deleteJob(id: string): Promise<void> {
  const db = await getDB();
  const jobRuns = (await db.getAll("job_runs")).filter((run) => run.jobId === id);
  for (const run of jobRuns) await cascadeDeleteJobRun(run);
  await db.delete("jobs", id);
}
