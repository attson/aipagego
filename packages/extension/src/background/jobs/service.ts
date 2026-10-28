import {
  JobDraftSchema,
  computeNextJobRunAt,
  normalizeWatchedText,
  type Job,
  type JobDraft,
  type JobRun,
  type JobRunCause,
} from "@aipagego/shared/jobs";
import type { Connector } from "@aipagego/shared/connectors";
import type { ConnectorDelivery, ConnectorSource } from "@aipagego/shared/connectors";
import type { Json, RunRecord, StepsToolVersion, Tool, ToolParameter } from "@aipagego/shared/types";
import { matchesAny } from "@aipagego/shared/url-pattern";
import { analyzeWorkflow, prepareWorkflowInputs } from "@aipagego/shared/workflow";
import {
  deleteJob,
  getJob,
  getJobRun,
  listJobRuns,
  listJobs,
  putJob,
  putJobRun,
} from "../storage/jobs";
import { getTool } from "../storage/tools";
import { sha256Json, sha256Text } from "./hash";
import { acquireJobTab, releaseJobTab, type AcquiredJobTab } from "./tab-manager";
import { classifyJobWorkflow } from "./safety";
import { buildJobOutputSnapshot, diffJobOutputs } from "./history";
import { connectorService } from "../connectors/service";
import { deliveryService } from "../connectors/delivery-service";
import { getDelivery } from "../storage/connector-deliveries";

export type JobListItem = Job & { upgradeAvailable?: number };

type RunPinned = (input: {
  toolId: string;
  toolVersion: number;
  tabId: number;
  inputs: Record<string, Json>;
}) => Promise<RunRecord>;

type EnsureDelivery = (
  id: string,
  connectorId: string,
  source: ConnectorSource,
  expectedConfigHash: string,
) => Promise<ConnectorDelivery>;

export function jobDeliveryId(jobRunId: string, connectorId: string): string {
  return `job:${encodeURIComponent(jobRunId)}:${encodeURIComponent(connectorId)}`;
}

export type JobServiceDeps = {
  now: () => number;
  uuid: () => string;
  getTool: (id: string) => Promise<Tool | undefined>;
  getConnector: (id: string) => Promise<Connector | null | undefined>;
  getJob: typeof getJob;
  listJobs: typeof listJobs;
  putJob: typeof putJob;
  deleteJob: typeof deleteJob;
  getJobRun: typeof getJobRun;
  listJobRuns: typeof listJobRuns;
  putJobRun: typeof putJobRun;
  acquireTab: (url: string) => Promise<AcquiredJobTab>;
  releaseTab: (tab: AcquiredJobTab) => Promise<void>;
  runPinned: RunPinned;
  readWatchText: (tabId: number, selector: string) => Promise<string[]>;
  notifyTerminal: (job: Job, run: JobRun) => Promise<void>;
  ensureDelivery: EnsureDelivery;
  getDelivery: typeof getDelivery;
};

const defaultDeps = (runPinned: RunPinned): JobServiceDeps => ({
  now: Date.now,
  uuid: () => crypto.randomUUID(),
  getTool,
  getConnector: (id) => connectorService.get(id),
  getJob,
  listJobs,
  putJob,
  deleteJob,
  getJobRun,
  listJobRuns,
  putJobRun,
  acquireTab: acquireJobTab,
  releaseTab: releaseJobTab,
  runPinned,
  readWatchText: async () => {
    throw new Error("watch_reader_unavailable");
  },
  notifyTerminal: async () => undefined,
  ensureDelivery: (id, connectorId, source, expectedConfigHash) =>
    deliveryService.ensure(id, connectorId, source, expectedConfigHash),
  getDelivery,
});

function sensitivePlaceholder(parameter: ToolParameter): Json {
  if (parameter.type === "string") return "";
  if (parameter.type === "number") return 0;
  if (parameter.type === "boolean") return false;
  return null;
}

function validateStoredInputs(
  parameters: ToolParameter[],
  inputs: Record<string, Json>,
  allowMissingSensitive: boolean,
): void {
  const byKey = new Map(parameters.map((parameter) => [parameter.key, parameter]));
  for (const key of Object.keys(inputs)) {
    if (byKey.get(key)?.sensitive) throw new Error("sensitive_inputs_not_persisted");
  }
  const validationInputs: Record<string, Json> = { ...inputs };
  if (allowMissingSensitive) {
    for (const parameter of parameters) {
      if (parameter.sensitive && parameter.required) {
        validationInputs[parameter.key] = sensitivePlaceholder(parameter);
      }
    }
  }
  prepareWorkflowInputs(parameters, validationInputs);
}

function prepareInputsForClassification(
  parameters: ToolParameter[],
  inputs: Record<string, Json>,
): Record<string, Json> {
  const result = { ...inputs };
  for (const parameter of parameters) {
    if (parameter.sensitive && parameter.required && !(parameter.key in result)) {
      result[parameter.key] = sensitivePlaceholder(parameter);
    }
  }
  return result;
}

async function resolvePinned(
  tool: Tool | undefined,
  version: number,
): Promise<{ tool: Extract<Tool, { kind: "steps" }>; snapshot: StepsToolVersion; hash: string }> {
  if (!tool) throw new Error("tool_missing");
  if (tool.kind !== "steps") throw new Error("jobs_require_steps_tool");
  const snapshot = tool.versions.find((candidate) => candidate.version === version);
  if (!snapshot) throw new Error("workflow_version_not_found");
  const analysis = analyzeWorkflow(snapshot);
  if (analysis.issues.length > 0) throw new Error("invalid_workflow");
  return { tool, snapshot, hash: await sha256Json(snapshot) };
}

function sortedConnectorBindings(bindings: JobDraft["connectorBindings"]) {
  return [...bindings].sort((left, right) =>
    left.connectorId.localeCompare(right.connectorId) ||
    left.connectorConfigHash.localeCompare(right.connectorConfigHash));
}

function maxJobSeverity(
  workflowSeverity: Job["safety"]["severity"],
  hasConnectorBindings: boolean,
): Job["safety"]["severity"] {
  if (workflowSeverity === "dangerous") return "dangerous";
  return hasConnectorBindings ? "caution" : workflowSeverity;
}

async function connectorBindingError(
  bindings: JobDraft["connectorBindings"],
  getConnector: JobServiceDeps["getConnector"],
): Promise<Job["attentionReason"] | undefined> {
  for (const binding of bindings) {
    const connector = await getConnector(binding.connectorId);
    if (!connector) return "connector_missing";
    if (connector.configHash !== binding.connectorConfigHash) return "connector_changed";
    if (
      connector.credentialMode !== "persistent" ||
      !connector.credentialConfigured ||
      connector.status !== "ready"
    ) {
      return "connector_credentials_missing";
    }
  }
  return undefined;
}

async function acknowledgementHashFor(
  toolVersionHash: string,
  inputs: Record<string, Json>,
  connectorBindings: JobDraft["connectorBindings"],
): Promise<string> {
  return sha256Json({
    toolVersionHash,
    inputs,
    connectorBindings: sortedConnectorBindings(connectorBindings),
  });
}

export class JobService {
  private readonly deps: JobServiceDeps;
  private readonly executingJobs = new Set<string>();

  constructor(runPinned: RunPinned, deps?: Partial<JobServiceDeps>) {
    this.deps = { ...defaultDeps(runPinned), ...deps };
  }

  async save(
    draftInput: JobDraft,
    id?: string,
    acknowledgeCaution = false,
  ): Promise<Job> {
    if (id && this.executingJobs.has(id)) throw new Error("job_already_running");
    const draft = JobDraftSchema.parse(draftInput) as JobDraft;
    const resolved = await resolvePinned(await this.deps.getTool(draft.toolId), draft.toolVersion);
    if (!matchesAny(draft.targetUrl, resolved.tool.urlPatterns)) {
      throw new Error("job_target_url_mismatch");
    }
    validateStoredInputs(
      resolved.snapshot.parameters,
      draft.inputs,
      draft.trigger.kind === "manual",
    );
    const connectorError = await connectorBindingError(
      draft.connectorBindings,
      this.deps.getConnector,
    );
    if (connectorError) throw new Error(connectorError);
    const workflowSeverity = classifyJobWorkflow(
      resolved.snapshot,
      prepareInputsForClassification(resolved.snapshot.parameters, draft.inputs),
    );
    const severity = maxJobSeverity(workflowSeverity, draft.connectorBindings.length > 0);
    const requiresCautionAcknowledgement =
      workflowSeverity === "caution" || draft.connectorBindings.length > 0;
    if (severity === "dangerous" && draft.trigger.kind !== "manual") {
      throw new Error("dangerous_auto_blocked");
    }
    const acknowledgementHash = await acknowledgementHashFor(
      resolved.hash,
      draft.inputs,
      draft.connectorBindings,
    );
    if (requiresCautionAcknowledgement && !acknowledgeCaution) {
      throw new Error("caution_acknowledgement_required");
    }
    const existing = id ? await this.deps.getJob(id) : undefined;
    if (id && !existing) throw new Error("job_not_found");
    if (existing) await this.assertNoBlockingLease(existing);
    const now = this.deps.now();
    const status = existing?.status === "paused"
      ? "paused"
      : existing?.status === "needs_attention" ? "needs_attention" : "active";
    const nextRunAt = status === "active"
      ? computeNextJobRunAt(draft.trigger, now)
      : undefined;
    const job: Job = {
      ...draft,
      id: existing?.id ?? this.deps.uuid(),
      toolVersionHash: resolved.hash,
      status,
      safety: requiresCautionAcknowledgement
        ? {
            severity,
            cautionAcknowledgedAt: now,
            acknowledgementHash,
          }
        : { severity },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(status === "needs_attention" && existing?.attentionReason
        ? { attentionReason: existing.attentionReason }
        : {}),
      ...(nextRunAt == null ? {} : { nextRunAt }),
    };
    return this.deps.putJob(job);
  }

  async list(): Promise<JobListItem[]> {
    const jobs = await this.deps.listJobs();
    return Promise.all(jobs.map(async (job) => {
      const tool = await this.deps.getTool(job.toolId);
      const upgradeAvailable = tool?.kind === "steps" && tool.activeVersion !== job.toolVersion
        ? tool.activeVersion
        : undefined;
      return upgradeAvailable == null ? job : { ...job, upgradeAvailable };
    }));
  }

  async reconcileDeliveries(): Promise<void> {
    const jobs = await this.deps.listJobs();
    for (const job of jobs) {
      await this.reconcileJobDeliveries(job);
    }
  }

  get(id: string): Promise<Job | undefined> {
    return this.deps.getJob(id);
  }

  async delete(id: string): Promise<void> {
    if (this.executingJobs.has(id)) throw new Error("job_already_running");
    const job = await this.requireJob(id);
    await this.assertNoBlockingLease(job);
    return this.deps.deleteJob(id);
  }

  getRun(id: string): Promise<JobRun | undefined> {
    return this.deps.getJobRun(id);
  }

  async listRuns(
    jobId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: JobRun[]; nextCursor?: string }> {
    const all = await this.deps.listJobRuns(jobId, 200);
    const cursorFor = (run: JobRun) => `${run.startedAt}:${encodeURIComponent(run.id)}`;
    const cursorIndex = cursor == null
      ? -1
      : all.findIndex((run) => cursorFor(run) === cursor);
    if (cursor != null && cursorIndex < 0) throw new Error("invalid_job_run_cursor");
    const start = cursorIndex + 1;
    const items = all.slice(start, start + limit);
    return start + items.length < all.length && items.length > 0
      ? { items, nextCursor: cursorFor(items.at(-1)!) }
      : { items };
  }

  async runNow(
    id: string,
    runtimeInputs: Record<string, Json> = {},
    approveDangerousOnce = false,
  ): Promise<JobRun> {
    return this.withExecutionLock(id, async () => {
      const job = await this.requireJob(id);
      await this.assertNoBlockingLease(job);
      return this.execute(id, "manual", runtimeInputs, approveDangerousOnce);
    });
  }

  async runAutomatic(id: string, cause: "schedule"): Promise<JobRun>;
  async runAutomatic(id: string, cause: "page_change"): Promise<JobRun | undefined>;
  async runAutomatic(id: string, cause: "manual"): Promise<JobRun>;
  async runAutomatic(
    id: string,
    cause: JobRunCause,
  ): Promise<JobRun | undefined>;
  async runAutomatic(
    id: string,
    cause: JobRunCause,
  ): Promise<JobRun | undefined> {
    return this.withExecutionLock(id, async () => {
      const job = await this.requireJob(id);
      let existing = job.lease
        ? await this.deps.getJobRun(job.lease.jobRunId)
        : undefined;
      if (existing?.status === "running") {
        const interruptedAt = this.deps.now();
        const last = existing.attempts.at(-1);
        if (last?.status === "running") {
          existing = {
            ...existing,
            status: "retry_wait",
            attempts: [
              ...existing.attempts.slice(0, -1),
              {
                ...last,
                status: "error",
                finishedAt: interruptedAt,
                errorCode: "service_worker_interrupted",
                error: "service_worker_interrupted",
              },
            ],
          };
          await this.deps.putJobRun(existing);
        }
      }
      if (cause === "page_change" && job.trigger.kind === "page_change") {
        await this.validateConnectorDestinations(job);
        return this.runPageChange(job, existing);
      }
      return this.execute(id, cause, {}, existing?.dangerousApproved === true, existing);
    });
  }

  private async runPageChange(job: Job, existingRun?: JobRun): Promise<JobRun | undefined> {
    let acquired: AcquiredJobTab | undefined;
    let delegated = false;
    try {
      await this.validatePinnedJob(job);
      acquired = await this.deps.acquireTab(job.targetUrl);
      const selector = job.trigger.kind === "page_change" ? job.trigger.watch.selector.trim() : "";
      if (selector.length === 0 || selector.length > 2_048) {
        throw new Error("watch_selector_missing");
      }
      const values = await this.deps.readWatchText(acquired.tabId, selector);
      if (values.length === 0) throw new Error("watch_selector_missing");
      if (values.length !== 1) throw new Error("watch_selector_ambiguous");
      const checkedAt = this.deps.now();
      const hash = await sha256Text(normalizeWatchedText(values[0]));
      if (!job.changeBaseline || job.changeBaseline.hash === hash) {
        if (existingRun) {
          const finishedAt = checkedAt;
          const baselineWasMissing = job.changeBaseline == null;
          const completed: JobRun = {
            ...existingRun,
            status: "aborted",
            finishedAt,
            errorCode: baselineWasMissing ? "baseline_initialized" : "change_reverted",
            error: baselineWasMissing ? "baseline_initialized" : "change_reverted",
          };
          await this.deps.putJobRun(completed);
          await this.deps.putJob({
            ...job,
            lastCheckAt: checkedAt,
            changeBaseline: job.changeBaseline ?? { hash, capturedAt: checkedAt },
            lastRunAt: finishedAt,
            lastStatus: "aborted",
            nextRunAt: computeNextJobRunAt(job.trigger, checkedAt),
            lease: undefined,
            updatedAt: checkedAt,
          });
          return completed;
        }
        await this.deps.putJob({
          ...job,
          lastCheckAt: checkedAt,
          changeBaseline: job.changeBaseline ?? { hash, capturedAt: checkedAt },
          nextRunAt: computeNextJobRunAt(job.trigger, checkedAt),
          lease: undefined,
          updatedAt: checkedAt,
        });
        return undefined;
      }
      delegated = true;
      return this.execute(job.id, "page_change", {}, false, existingRun, {
        acquired,
        candidateBaseline: { hash, capturedAt: checkedAt },
      });
    } catch (error) {
      const errorCode = this.watchErrorCode(error);
      return this.recordWatchFailure(job, existingRun, acquired, errorCode, error);
    } finally {
      if (acquired && !delegated) await this.deps.releaseTab(acquired);
    }
  }

  private watchErrorCode(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "watch_selector_missing" || message === "watch_selector_ambiguous") {
      return message;
    }
    if (/tab|closed/i.test(message)) return "tab_closed";
    if (/permission|注入|restricted|受限/i.test(message)) return "site_permission_denied";
    return message.split(":")[0].slice(0, 120);
  }

  private async recordWatchFailure(
    job: Job,
    existingRun: JobRun | undefined,
    acquired: AcquiredJobTab | undefined,
    errorCode: string,
    error: unknown,
  ): Promise<JobRun> {
    const now = this.deps.now();
    const attemptNumber = (existingRun?.attempts.length ?? 0) + 1;
    const attempt = { attempt: attemptNumber, startedAt: now, status: "running" as const };
    const run: JobRun = existingRun
      ? { ...existingRun, status: "running", attempts: [...existingRun.attempts, attempt] }
      : {
          id: this.deps.uuid(),
          jobId: job.id,
          cause: "page_change",
          ...(job.nextRunAt == null ? {} : { scheduledAt: job.nextRunAt }),
          startedAt: now,
          status: "running",
          toolId: job.toolId,
          toolVersion: job.toolVersion,
          attempts: [attempt],
          tab: acquired ?? { ownership: "existing" },
        };
    await this.deps.putJobRun(run);
    return this.finishFailedAttempt(job, run, attemptNumber, {
      errorCode,
      error: error instanceof Error ? error.message.slice(0, 4_096) : String(error).slice(0, 4_096),
    });
  }

  private async execute(
    id: string,
    cause: JobRunCause,
    runtimeInputs: Record<string, Json>,
    approveDangerousOnce: boolean,
    existingRun?: JobRun,
    pageChange?: {
      acquired: AcquiredJobTab;
      candidateBaseline: { hash: string; capturedAt: number };
    },
  ): Promise<JobRun> {
    const job = await this.requireJob(id);
    let resolved: Awaited<ReturnType<typeof resolvePinned>>;
    try {
      resolved = await resolvePinned(
        await this.deps.getTool(job.toolId),
        job.toolVersion,
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      if (code === "tool_missing") await this.markAttention(job, "tool_missing");
      else if (code === "workflow_version_not_found") {
        await this.markAttention(job, "tool_version_changed");
      }
      throw error;
    }
    if (resolved.hash !== job.toolVersionHash) {
      await this.markAttention(job, "tool_version_changed");
      throw new Error("tool_version_changed");
    }
    const inputs = { ...job.inputs, ...runtimeInputs };
    prepareWorkflowInputs(resolved.snapshot.parameters, inputs);
    await this.validateConnectorDestinations(job);
    const workflowSeverity = classifyJobWorkflow(resolved.snapshot, inputs);
    const severity = maxJobSeverity(workflowSeverity, job.connectorBindings.length > 0);
    const requiresCautionAcknowledgement =
      workflowSeverity === "caution" || job.connectorBindings.length > 0;
    const acknowledgementHash = await acknowledgementHashFor(
      resolved.hash,
      job.inputs,
      job.connectorBindings,
    );
    if (
      requiresCautionAcknowledgement &&
      job.safety.acknowledgementHash !== acknowledgementHash
    ) {
      throw new Error("caution_acknowledgement_required");
    }
    if (severity === "dangerous" && !approveDangerousOnce) {
      throw new Error("dangerous_approval_required");
    }

    const now = this.deps.now();
    const attemptNumber = (existingRun?.attempts.length ?? 0) + 1;
    const attempt = { attempt: attemptNumber, startedAt: now, status: "running" as const };
    const jobRun: JobRun = existingRun
      ? {
          ...existingRun,
          status: "running",
          attempts: [...existingRun.attempts, attempt],
        }
      : {
          id: this.deps.uuid(),
          jobId: job.id,
          cause,
          ...(cause === "manual" || job.nextRunAt == null
            ? {}
            : { scheduledAt: job.nextRunAt }),
          startedAt: now,
          status: "running",
          toolId: job.toolId,
          toolVersion: job.toolVersion,
          attempts: [attempt],
          ...(severity === "dangerous" && approveDangerousOnce ? { dangerousApproved: true } : {}),
          tab: { ownership: "existing" },
        };
    await this.deps.putJobRun(jobRun);
    await this.deps.putJob({
      ...job,
      nextRunAt: now + 15 * 60_000,
      lease: { jobRunId: jobRun.id, expiresAt: now + 15 * 60_000 },
      updatedAt: now,
    });
    let acquired: AcquiredJobTab | undefined = pageChange?.acquired;
    let toolSucceeded = false;
    try {
      acquired ??= await this.deps.acquireTab(job.targetUrl);
      jobRun.tab = acquired;
      const run = await this.deps.runPinned({
        toolId: job.toolId,
        toolVersion: job.toolVersion,
        tabId: acquired.tabId,
        inputs,
      });
      const status = run.status === "ok"
        ? "ok"
        : run.status === "aborted" ? "aborted" : "error";
      if (status !== "ok") {
        return this.finishFailedAttempt(job, jobRun, attemptNumber, {
          runId: run.id,
          errorCode: status === "aborted" ? "tool_run_aborted" : "tool_run_failed",
        });
      }
      toolSucceeded = true;
      const finishedAt = this.deps.now();
      jobRun.status = "ok";
      jobRun.finishedAt = finishedAt;
      jobRun.attempts[jobRun.attempts.length - 1] = {
        ...jobRun.attempts.at(-1)!,
        runId: run.id,
        status: "ok",
        finishedAt,
      };
      const outputValue = run.output ?? null;
      jobRun.output = await buildJobOutputSnapshot(outputValue);
      const previous = (await this.deps.listJobRuns(job.id, 200))
        .filter((candidate) =>
          candidate.id !== jobRun.id &&
          candidate.status === "ok" &&
          candidate.output != null
        )
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      if (previous?.output) {
        jobRun.diffFromJobRunId = previous.id;
        jobRun.diff = diffJobOutputs(previous.output.preview, jobRun.output.preview);
      }
      const storedRun = await this.deps.putJobRun(jobRun);
      const latest = await this.deps.getJob(job.id);
      const remainsPaused = latest?.status === "paused";
      const pendingDeliveryJob = await this.deps.putJob({
        ...job,
        lastRunAt: finishedAt,
        lastStatus: "ok",
        status: remainsPaused ? "paused" : "active",
        attentionReason: undefined,
        lease: latest?.lease,
        ...(pageChange == null
          ? {}
          : { lastCheckAt: finishedAt, changeBaseline: pageChange.candidateBaseline }),
        nextRunAt: undefined,
        updatedAt: finishedAt,
      });
      const deliveryOutcome = await this.ensureJobDeliveries(job, storedRun);
      await this.deps.putJob({
        ...pendingDeliveryJob,
        status: deliveryOutcome.failed || deliveryOutcome.incomplete
          ? "needs_attention"
          : remainsPaused ? "paused" : "active",
        attentionReason: deliveryOutcome.failed || deliveryOutcome.incomplete
          ? "connector_delivery_failed"
          : undefined,
        lease: deliveryOutcome.incomplete ? pendingDeliveryJob.lease : undefined,
        nextRunAt: deliveryOutcome.failed || deliveryOutcome.incomplete || remainsPaused
          ? undefined
          : computeNextJobRunAt(job.trigger, finishedAt),
      });
      await this.deps.notifyTerminal(job, storedRun).catch(() => undefined);
      return storedRun;
    } catch (error) {
      if (toolSucceeded) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return this.finishFailedAttempt(job, jobRun, attemptNumber, {
        errorCode: message.split(":")[0].slice(0, 120),
        error: message.slice(0, 4_096),
      });
    } finally {
      if (acquired) await this.deps.releaseTab(acquired);
    }
  }

  private async finishFailedAttempt(
    job: Job,
    jobRun: JobRun,
    attemptNumber: number,
    failure: { runId?: string; errorCode: string; error?: string },
  ): Promise<JobRun> {
    const finishedAt = this.deps.now();
    jobRun.attempts[jobRun.attempts.length - 1] = {
      ...jobRun.attempts.at(-1)!,
      ...(failure.runId == null ? {} : { runId: failure.runId }),
      status: failure.errorCode === "tool_run_aborted" ? "aborted" : "error",
      finishedAt,
      errorCode: failure.errorCode,
      ...(failure.error == null ? {} : { error: failure.error }),
    };

    const latest = await this.deps.getJob(job.id);
    if (latest?.status === "paused") {
      jobRun.status = failure.errorCode === "tool_run_aborted" ? "aborted" : "error";
      jobRun.finishedAt = finishedAt;
      jobRun.errorCode = failure.errorCode;
      jobRun.error = failure.error;
      await this.deps.putJob({
        ...latest,
        lease: undefined,
        nextRunAt: undefined,
        lastRunAt: finishedAt,
        lastStatus: jobRun.status,
        updatedAt: finishedAt,
      });
      return this.deps.putJobRun(jobRun);
    }

    if (attemptNumber < job.retry.maxAttempts) {
      const backoff = job.retry.backoffMinutes[attemptNumber - 1] * 60_000;
      const retryAt = finishedAt + backoff;
      jobRun.status = "retry_wait";
      jobRun.errorCode = failure.errorCode;
      jobRun.error = failure.error;
      await this.deps.putJob({
        ...job,
        status: "active",
        nextRunAt: retryAt,
        lease: { jobRunId: jobRun.id, expiresAt: retryAt },
        lastRunAt: finishedAt,
        lastStatus: "retry_wait",
        updatedAt: finishedAt,
      });
      return this.deps.putJobRun(jobRun);
    }

    jobRun.status = failure.errorCode === "tool_run_aborted" ? "aborted" : "error";
    jobRun.finishedAt = finishedAt;
    jobRun.errorCode = failure.errorCode;
    jobRun.error = failure.error;
    await this.deps.putJob({
      ...job,
      status: "needs_attention",
      attentionReason:
        failure.errorCode === "watch_selector_missing" ||
        failure.errorCode === "watch_selector_ambiguous" ||
        failure.errorCode === "site_permission_denied" ||
        failure.errorCode === "tab_closed" ||
        failure.errorCode === "tool_missing" ||
        failure.errorCode === "tool_version_changed"
          ? failure.errorCode
          : "retry_exhausted",
      nextRunAt: undefined,
      lease: undefined,
      lastRunAt: finishedAt,
      lastStatus: jobRun.status,
      updatedAt: finishedAt,
    });
    const storedRun = await this.deps.putJobRun(jobRun);
    await this.deps.notifyTerminal(job, storedRun).catch(() => undefined);
    return storedRun;
  }

  async pause(id: string): Promise<Job> {
    const job = await this.requireJob(id);
    let keepLease = false;
    if (job.lease) {
      const run = await this.deps.getJobRun(job.lease.jobRunId);
      if (run?.status === "running") {
        keepLease = true;
      } else if (run?.status === "ok") {
        keepLease = true;
      } else if (run?.status === "retry_wait") {
        const finishedAt = this.deps.now();
        const attempts = [...run.attempts];
        const last = attempts.at(-1);
        if (last?.status === "running") {
          attempts[attempts.length - 1] = { ...last, status: "aborted", finishedAt };
        }
        await this.deps.putJobRun({ ...run, status: "aborted", finishedAt, attempts });
      }
    }
    return this.deps.putJob({
      ...job,
      status: "paused",
      nextRunAt: undefined,
      lease: keepLease ? job.lease : undefined,
      updatedAt: this.deps.now(),
    });
  }

  async resume(id: string): Promise<Job> {
    let job = await this.requireJob(id);
    if (job.lease && job.lastStatus === "ok") {
      job = await this.reconcileJobDeliveries(job);
    }
    await this.validatePinnedJob(job);
    await this.validateConnectorDestinations(job);
    if (job.attentionReason === "connector_delivery_failed") {
      const latestSuccessfulRun = (await this.deps.listJobRuns(job.id, 200))
        .filter((run) => run.status === "ok")
        .sort((left, right) =>
          (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt))[0];
      if (!latestSuccessfulRun) throw new Error("connector_delivery_unresolved");
      for (const binding of job.connectorBindings) {
        const delivery = await this.deps.getDelivery(
          jobDeliveryId(latestSuccessfulRun.id, binding.connectorId),
        );
        if (delivery?.status !== "ok") throw new Error("connector_delivery_unresolved");
      }
    }
    const now = this.deps.now();
    return this.deps.putJob({
      ...job,
      status: "active",
      attentionReason: undefined,
      nextRunAt: computeNextJobRunAt(job.trigger, now),
      updatedAt: now,
    });
  }

  async upgrade(
    id: string,
    toolVersion: number,
    acknowledgeCaution = false,
  ): Promise<Job> {
    if (this.executingJobs.has(id)) throw new Error("job_already_running");
    const job = await this.requireJob(id);
    return this.save({
      name: job.name,
      toolId: job.toolId,
      toolVersion,
      targetUrl: job.targetUrl,
      inputs: job.inputs,
      trigger: job.trigger,
      retry: job.retry,
      notifications: job.notifications,
      connectorBindings: job.connectorBindings,
    }, id, acknowledgeCaution);
  }

  private async requireJob(id: string): Promise<Job> {
    const job = await this.deps.getJob(id);
    if (!job) throw new Error("job_not_found");
    return job;
  }

  private async assertNoBlockingLease(job: Job): Promise<void> {
    if (!job.lease) return;
    const run = await this.deps.getJobRun(job.lease.jobRunId);
    if (run?.status === "running" || run?.status === "retry_wait") {
      throw new Error("job_already_running");
    }
    if (run?.status === "ok") throw new Error("job_delivery_pending");
  }

  private async withExecutionLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    if (this.executingJobs.has(id)) throw new Error("job_already_running");
    this.executingJobs.add(id);
    try {
      return await task();
    } finally {
      this.executingJobs.delete(id);
    }
  }

  private async validatePinnedJob(job: Job): Promise<void> {
    const resolved = await resolvePinned(
      await this.deps.getTool(job.toolId),
      job.toolVersion,
    );
    if (resolved.hash !== job.toolVersionHash) throw new Error("tool_version_changed");
  }

  private async ensureJobDeliveries(
    job: Job,
    run: JobRun,
  ): Promise<{ failed: boolean; incomplete: boolean }> {
    const deliveries = await Promise.all(job.connectorBindings.map(async (binding) => {
      try {
        return await this.deps.ensureDelivery(
          jobDeliveryId(run.id, binding.connectorId),
          binding.connectorId,
          { kind: "job_run", jobRunId: run.id },
          binding.connectorConfigHash,
        );
      } catch {
        return undefined;
      }
    }));
    return {
      failed: deliveries.some((delivery) =>
        delivery != null && ["error", "partial", "unknown_commit"].includes(delivery.status)),
      incomplete: deliveries.some((delivery) =>
        delivery == null || delivery.status === "queued" || delivery.status === "running"),
    };
  }

  private async reconcileJobDeliveries(job: Job): Promise<Job> {
    if (!job.lease || job.lastStatus !== "ok") return job;
    const run = await this.deps.getJobRun(job.lease.jobRunId);
    if (
      !run ||
      run.status !== "ok" ||
      run.finishedAt == null ||
      job.lastRunAt !== run.finishedAt
    ) return job;
    const deliveryOutcome = await this.ensureJobDeliveries(job, run);
    const latest = await this.deps.getJob(job.id);
    if (!latest || latest.lease?.jobRunId !== run.id) return latest ?? job;
    const remainsPaused = latest.status === "paused";
    return this.deps.putJob({
      ...latest,
      status: deliveryOutcome.failed || deliveryOutcome.incomplete
        ? "needs_attention"
        : remainsPaused ? "paused" : "active",
      attentionReason: deliveryOutcome.failed || deliveryOutcome.incomplete
        ? "connector_delivery_failed"
        : undefined,
      lease: deliveryOutcome.incomplete ? latest.lease : undefined,
      nextRunAt: deliveryOutcome.failed || deliveryOutcome.incomplete || remainsPaused
        ? undefined
        : computeNextJobRunAt(latest.trigger, run.finishedAt),
      updatedAt: Math.max(latest.updatedAt, this.deps.now()),
    });
  }

  private async validateConnectorDestinations(job: Job): Promise<void> {
    const reason = await connectorBindingError(
      job.connectorBindings,
      this.deps.getConnector,
    );
    if (!reason) return;
    await this.markAttention(job, reason);
    throw new Error(reason);
  }

  private async markAttention(
    job: Job,
    reason: Job["attentionReason"],
  ): Promise<void> {
    const leasedRun = job.lease
      ? await this.deps.getJobRun(job.lease.jobRunId)
      : undefined;
    await this.deps.putJob({
      ...job,
      status: "needs_attention",
      attentionReason: reason,
      nextRunAt: undefined,
      lease: leasedRun?.status === "ok" ? job.lease : undefined,
      updatedAt: this.deps.now(),
    });
  }
}
