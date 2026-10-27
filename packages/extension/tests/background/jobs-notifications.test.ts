import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job, JobRun } from "@aipagego/shared/jobs";
import {
  installJobNotificationClickHandler,
  notifyJobTerminal,
} from "@/background/jobs/notifications";

const job: Job = {
  id: "job-1",
  name: "Price monitor",
  toolId: "tool-1",
  toolVersion: 3,
  toolVersionHash: "a".repeat(64),
  targetUrl: "https://shop.example/search?token=secret-query",
  inputs: { apiToken: "secret-input" },
  trigger: { kind: "page_change", everyMinutes: 5, watch: { selector: "#price" } },
  status: "active",
  safety: { severity: "safe" },
  retry: { maxAttempts: 1, backoffMinutes: [] },
  notifications: { onChange: true, onSuccess: false, onFailure: true },
  connectorBindings: [],
  createdAt: 1,
  updatedAt: 1,
};

function run(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: "jr-1",
    jobId: job.id,
    cause: "page_change",
    startedAt: 1,
    finishedAt: 2,
    status: "ok",
    toolId: job.toolId,
    toolVersion: job.toolVersion,
    attempts: [],
    tab: { ownership: "existing", tabId: 7 },
    output: { hash: "b".repeat(64), preview: { secret: "secret-output" }, truncated: false, originalBytes: 1 },
    diff: { changes: [{ path: "$.price", before: 1, after: 2 }], truncated: false },
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Job notifications", () => {
  it("emits a bounded redacted terminal notification only when permission and policy allow", async () => {
    const create = vi.fn(async (_id: string, _options: chrome.notifications.NotificationOptions) => "notification-id");
    vi.stubGlobal("chrome", {
      permissions: { contains: vi.fn(async () => true) },
      notifications: { create },
      runtime: { getURL: (path: string) => `chrome-extension://id/${path}` },
    });
    await notifyJobTerminal(job, run());
    expect(create).toHaveBeenCalledTimes(1);
    const [id, options] = create.mock.calls[0];
    expect(id).toBe("aipagego.job.job-1.jr-1");
    expect(options).toMatchObject({ title: "Price monitor · 网页变化", message: "固定 v3 · 1 项变化" });
    const serialized = JSON.stringify(options);
    expect(serialized).not.toContain("secret-query");
    expect(serialized).not.toContain("secret-input");
    expect(serialized).not.toContain("secret-output");
  });

  it("does not notify retry_wait, disabled outcomes or denied permission", async () => {
    const create = vi.fn();
    const contains = vi.fn(async () => false);
    vi.stubGlobal("chrome", {
      permissions: { contains },
      notifications: { create },
      runtime: { getURL: (path: string) => path },
    });
    await notifyJobTerminal(job, run({ status: "retry_wait", finishedAt: undefined }));
    await notifyJobTerminal({ ...job, notifications: { ...job.notifications, onChange: false } }, run());
    await notifyJobTerminal(job, run());
    expect(create).not.toHaveBeenCalled();
  });

  it("replaces unknown failure text with a stable non-sensitive code", async () => {
    const create = vi.fn(async () => "id");
    vi.stubGlobal("chrome", {
      permissions: { contains: vi.fn(async () => true) }, notifications: { create },
      runtime: { getURL: (path: string) => path },
    });
    await notifyJobTerminal(job, run({ status: "error", errorCode: "page-secret-value" }));
    expect(JSON.stringify(create.mock.calls)).toContain("job_failed");
    expect(JSON.stringify(create.mock.calls)).not.toContain("page-secret-value");
  });

  it("opens the Jobs drawer for the clicked Job without running it", async () => {
    let listener: ((id: string) => void) | undefined;
    const storageSet = vi.fn(async () => undefined);
    const open = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      notifications: { onClicked: { addListener: (fn: (id: string) => void) => { listener = fn; }, removeListener: vi.fn() } },
      storage: { local: { set: storageSet } },
      tabs: { query: vi.fn(async () => [{ id: 9 }]), create: vi.fn() },
      sidePanel: { open },
      runtime: { sendMessage },
    });
    installJobNotificationClickHandler();
    listener?.("aipagego.job.job-1.jr-1");
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith({ tabId: 9 }));
    expect(storageSet).toHaveBeenCalledWith({ "aipagego.jobs.open": { jobId: "job-1" } });
    expect(sendMessage).toHaveBeenCalledWith({ type: "jobs.open", jobId: "job-1" });
  });
});
