import { z } from "zod";
import type { Json } from "./types";

export const JobStatusSchema = z.enum(["active", "paused", "needs_attention"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobSeveritySchema = z.enum(["safe", "caution", "dangerous"]);
export type JobSeverity = z.infer<typeof JobSeveritySchema>;

export const JobAttentionReasonSchema = z.enum([
  "tool_missing",
  "tool_version_changed",
  "invalid_inputs",
  "sensitive_input_required",
  "dangerous_auto_blocked",
  "site_permission_denied",
  "watch_selector_missing",
  "watch_selector_ambiguous",
  "tab_closed",
  "service_worker_interrupted",
  "retry_exhausted",
  "connector_missing",
  "connector_credentials_missing",
  "connector_changed",
  "connector_delivery_failed",
]);
export type JobAttentionReason = z.infer<typeof JobAttentionReasonSchema>;

const JsonValueSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

const HttpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "target URL must use http or https");

const DailyScheduleSchema = z.object({
  kind: z.literal("daily"),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7)
    .refine((values) => new Set(values).size === values.length, "duplicate weekday"),
}).strict();

export const JobTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({
    kind: z.literal("schedule"),
    schedule: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("interval"),
        everyMinutes: z.number().int().min(1).max(43_200),
      }).strict(),
      DailyScheduleSchema,
    ]),
  }).strict(),
  z.object({
    kind: z.literal("page_change"),
    everyMinutes: z.number().int().min(5).max(43_200),
    watch: z.object({
      selector: z.string().trim().min(1).max(2_048),
    }).strict(),
  }).strict(),
]);
export type JobTrigger = z.infer<typeof JobTriggerSchema>;

export const JobRetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(3),
  backoffMinutes: z.array(z.number().int().min(1).max(1_440)).max(2),
}).strict().superRefine((retry, ctx) => {
  if (retry.backoffMinutes.length < retry.maxAttempts - 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_small,
      type: "array",
      minimum: retry.maxAttempts - 1,
      inclusive: true,
      path: ["backoffMinutes"],
      message: "backoffMinutes must cover all retries",
    });
  }
});

export const JobNotificationsSchema = z.object({
  onChange: z.boolean(),
  onSuccess: z.boolean(),
  onFailure: z.boolean(),
}).strict();

export const JobConnectorBindingSchema = z.object({
  connectorId: z.string().min(1),
  connectorConfigHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type JobConnectorBinding = z.infer<typeof JobConnectorBindingSchema>;

const JobConnectorBindingsSchema = z.array(JobConnectorBindingSchema).max(5)
  .refine(
    (bindings) => new Set(bindings.map((binding) => binding.connectorId)).size === bindings.length,
    "duplicate connector binding",
  )
  .default([]);

const JobDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  toolId: z.string().min(1),
  toolVersion: z.number().int().positive(),
  targetUrl: HttpUrlSchema,
  inputs: z.record(JsonValueSchema),
  trigger: JobTriggerSchema,
  retry: JobRetrySchema,
  notifications: JobNotificationsSchema,
  connectorBindings: JobConnectorBindingsSchema,
});

export const JobDraftSchema = JobDefinitionSchema.strict();
export type JobDraft = z.infer<typeof JobDraftSchema>;

export const JobRunStatusSchema = z.enum([
  "queued",
  "running",
  "retry_wait",
  "ok",
  "error",
  "aborted",
  "missed",
]);
export type JobRunStatus = z.infer<typeof JobRunStatusSchema>;

export const JobSchema = JobDefinitionSchema.extend({
  id: z.string().min(1),
  toolVersionHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: JobStatusSchema,
  safety: z.object({
    severity: JobSeveritySchema,
    cautionAcknowledgedAt: z.number().optional(),
    acknowledgementHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict(),
  nextRunAt: z.number().optional(),
  lastRunAt: z.number().optional(),
  lastCheckAt: z.number().optional(),
  lastStatus: JobRunStatusSchema.optional(),
  changeBaseline: z.object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    capturedAt: z.number(),
  }).strict().optional(),
  attentionReason: JobAttentionReasonSchema.optional(),
  lease: z.object({
    jobRunId: z.string().min(1),
    expiresAt: z.number(),
  }).strict().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();
export type Job = z.infer<typeof JobSchema>;

export const JobRunCauseSchema = z.enum(["manual", "schedule", "page_change"]);
export type JobRunCause = z.infer<typeof JobRunCauseSchema>;

export const JobRunAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  runId: z.string().min(1).optional(),
  status: z.enum(["running", "ok", "error", "aborted"]),
  errorCode: z.string().max(120).optional(),
  error: z.string().max(4_096).optional(),
}).strict();
export type JobRunAttempt = z.infer<typeof JobRunAttemptSchema>;

export const JobOutputSnapshotSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  preview: JsonValueSchema,
  truncated: z.boolean(),
  originalBytes: z.number().int().nonnegative(),
}).strict();
export type JobOutputSnapshot = z.infer<typeof JobOutputSnapshotSchema>;

export const JobOutputDiffSchema = z.object({
  changes: z.array(z.object({
    path: z.string(),
    before: JsonValueSchema.optional(),
    after: JsonValueSchema.optional(),
  }).strict()).max(100),
  truncated: z.boolean(),
}).strict();
export type JobOutputDiff = z.infer<typeof JobOutputDiffSchema>;

export const JobRunSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  cause: JobRunCauseSchema,
  scheduledAt: z.number().optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  status: JobRunStatusSchema,
  toolId: z.string().min(1),
  toolVersion: z.number().int().positive(),
  attempts: z.array(JobRunAttemptSchema).max(3),
  dangerousApproved: z.boolean().optional(),
  tab: z.object({
    ownership: z.enum(["existing", "created"]),
    tabId: z.number().int().positive().optional(),
  }).strict(),
  output: JobOutputSnapshotSchema.optional(),
  diffFromJobRunId: z.string().min(1).optional(),
  diff: JobOutputDiffSchema.optional(),
  errorCode: z.string().max(120).optional(),
  error: z.string().max(4_096).optional(),
}).strict();
export type JobRun = z.infer<typeof JobRunSchema>;

function sortJson(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const result: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) result[key] = sortJson(value[key]);
    return result;
  }
  return value;
}

export function stableJsonStringify(value: Json): string {
  return JSON.stringify(sortJson(value));
}

export function normalizeWatchedText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function computeNextJobRunAt(
  trigger: JobTrigger,
  nowMs: number,
): number | undefined {
  if (trigger.kind === "manual") return undefined;
  if (trigger.kind === "page_change") {
    return nowMs + trigger.everyMinutes * 60_000;
  }
  if (trigger.schedule.kind === "interval") {
    return nowMs + trigger.schedule.everyMinutes * 60_000;
  }

  const [hourText, minuteText] = trigger.schedule.localTime.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const allowedDays = new Set(trigger.schedule.daysOfWeek);
  const start = new Date(nowMs);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + offset,
      hour,
      minute,
      0,
      0,
    );
    if (allowedDays.has(candidate.getDay()) && candidate.getTime() > nowMs) {
      return candidate.getTime();
    }
  }
  throw new Error("daily_schedule_has_no_next_run");
}
