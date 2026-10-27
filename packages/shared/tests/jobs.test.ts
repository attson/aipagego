import { describe, expect, it } from "vitest";
import {
  JobAttentionReasonSchema,
  JobDraftSchema,
  JobRunSchema,
  JobSchema,
  stableJsonStringify,
  computeNextJobRunAt,
  normalizeWatchedText,
} from "../src/jobs";

const validJob = {
  id: "job-1",
  name: "价格日报",
  toolId: "tool-1",
  toolVersion: 2,
  toolVersionHash: "a".repeat(64),
  targetUrl: "https://shop.example.com/search?q=headphones",
  inputs: { keyword: "headphones", limit: 20 },
  trigger: { kind: "manual" as const },
  status: "active" as const,
  safety: { severity: "safe" as const },
  retry: { maxAttempts: 3, backoffMinutes: [1, 5] },
  notifications: { onChange: true, onSuccess: false, onFailure: true },
  createdAt: 100,
  updatedAt: 100,
};

describe("Job schemas", () => {
  it("defaults legacy Job connector bindings without rewriting the input", () => {
    expect(JobSchema.parse(validJob)).toEqual({
      ...validJob,
      connectorBindings: [],
    });
    expect(validJob).not.toHaveProperty("connectorBindings");
  });

  it("defaults legacy draft bindings and accepts up to five unique destinations", () => {
    const draft = {
      name: "监控",
      toolId: "tool-1",
      toolVersion: 2,
      targetUrl: "https://example.com/products",
      inputs: {},
      trigger: { kind: "manual" as const },
      retry: { maxAttempts: 1, backoffMinutes: [] },
      notifications: { onChange: false, onSuccess: false, onFailure: true },
    };
    expect(JobDraftSchema.parse(draft).connectorBindings).toEqual([]);
    expect(JobDraftSchema.safeParse({
      ...draft,
      connectorBindings: Array.from({ length: 5 }, (_, index) => ({
        connectorId: `connector-${index}`,
        connectorConfigHash: `${index}`.repeat(64),
      })),
    }).success).toBe(true);
  });

  it("rejects more than five or duplicate connector bindings", () => {
    const draft = {
      name: "监控",
      toolId: "tool-1",
      toolVersion: 2,
      targetUrl: "https://example.com/products",
      inputs: {},
      trigger: { kind: "manual" as const },
      retry: { maxAttempts: 1, backoffMinutes: [] },
      notifications: { onChange: false, onSuccess: false, onFailure: true },
    };
    const binding = {
      connectorId: "connector-1",
      connectorConfigHash: "a".repeat(64),
    };
    expect(JobDraftSchema.safeParse({
      ...draft,
      connectorBindings: Array.from({ length: 6 }, (_, index) => ({
        connectorId: `connector-${index}`,
        connectorConfigHash: "a".repeat(64),
      })),
    }).success).toBe(false);
    expect(JobDraftSchema.safeParse({
      ...draft,
      connectorBindings: [binding, binding],
    }).success).toBe(false);
  });

  it("accepts connector attention reasons", () => {
    for (const reason of [
      "connector_missing",
      "connector_credentials_missing",
      "connector_changed",
      "connector_delivery_failed",
    ]) {
      expect(JobAttentionReasonSchema.parse(reason)).toBe(reason);
    }
  });

  it.each([
    ["prompt-like missing version", { ...validJob, toolVersion: undefined }],
    ["non-http URL", { ...validJob, targetUrl: "chrome://settings" }],
    ["page-change below five minutes", {
      ...validJob,
      trigger: { kind: "page_change", everyMinutes: 4, watch: { selector: "#price" } },
    }],
    ["daily without weekdays", {
      ...validJob,
      trigger: {
        kind: "schedule",
        schedule: { kind: "daily", localTime: "09:00", daysOfWeek: [] },
      },
    }],
    ["too many attempts", {
      ...validJob,
      retry: { maxAttempts: 4, backoffMinutes: [1, 5, 10] },
    }],
    ["non-json input", {
      ...validJob,
      inputs: { callback: () => true },
    }],
  ])("rejects %s", (_label, value) => {
    expect(JobSchema.safeParse(value).success).toBe(false);
  });

  it("accepts interval, daily and page-change drafts", () => {
    const base = {
      name: "监控",
      toolId: "tool-1",
      toolVersion: 2,
      targetUrl: "https://example.com/products",
      inputs: {},
      retry: { maxAttempts: 3, backoffMinutes: [1, 5] },
      notifications: { onChange: true, onSuccess: false, onFailure: true },
    };
    const triggers = [
      { kind: "schedule", schedule: { kind: "interval", everyMinutes: 10 } },
      { kind: "schedule", schedule: { kind: "daily", localTime: "09:30", daysOfWeek: [1, 3, 5] } },
      { kind: "page_change", everyMinutes: 15, watch: { selector: ".price" } },
    ];
    for (const trigger of triggers) {
      expect(JobDraftSchema.safeParse({ ...base, trigger }).success).toBe(true);
    }
  });

  it("round-trips a JobRun with linked attempts", () => {
    const run = {
      id: "job-run-1",
      jobId: "job-1",
      cause: "manual",
      startedAt: 200,
      finishedAt: 240,
      status: "ok",
      toolId: "tool-1",
      toolVersion: 2,
      attempts: [{
        attempt: 1,
        startedAt: 200,
        finishedAt: 240,
        runId: "run-1",
        status: "ok",
      }],
      tab: { ownership: "created", tabId: 44 },
      output: {
        hash: "b".repeat(64),
        preview: { price: 849 },
        truncated: false,
        originalBytes: 13,
      },
    };
    expect(JobRunSchema.parse(run)).toEqual(run);
  });
});

describe("stableJsonStringify", () => {
  it("orders object keys recursively without changing array order", () => {
    expect(stableJsonStringify({ z: 1, a: { y: 2, x: 3 }, rows: [2, 1] }))
      .toBe('{"a":{"x":3,"y":2},"rows":[2,1],"z":1}');
  });
});

describe("normalizeWatchedText", () => {
  it("normalizes Unicode to NFC, collapses whitespace and trims", () => {
    expect(normalizeWatchedText("  A\u030A\n\t B  ")).toBe("Å B");
  });
});

describe("computeNextJobRunAt", () => {
  it("advances interval and page-change triggers from now", () => {
    expect(computeNextJobRunAt({
      kind: "schedule",
      schedule: { kind: "interval", everyMinutes: 10 },
    }, 1_000)).toBe(601_000);
    expect(computeNextJobRunAt({
      kind: "page_change",
      everyMinutes: 15,
      watch: { selector: "#price" },
    }, 1_000)).toBe(901_000);
  });

  it("finds the next selected local weekday and time", () => {
    const monday0850 = new Date(2026, 9, 26, 8, 50).getTime();
    const monday0910 = new Date(2026, 9, 26, 9, 10).getTime();
    const trigger = {
      kind: "schedule" as const,
      schedule: { kind: "daily" as const, localTime: "09:00", daysOfWeek: [1] },
    };
    expect(computeNextJobRunAt(trigger, monday0850))
      .toBe(new Date(2026, 9, 26, 9, 0).getTime());
    expect(computeNextJobRunAt(trigger, monday0910))
      .toBe(new Date(2026, 10, 2, 9, 0).getTime());
  });

  it("returns undefined for manual triggers", () => {
    expect(computeNextJobRunAt({ kind: "manual" }, 1_000)).toBeUndefined();
  });
});
