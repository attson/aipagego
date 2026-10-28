import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@aipagego/shared/jobs";
import { JobsDrawer } from "@/sidepanel/drawers/jobs-drawer";
import { useUi } from "@/sidepanel/chat/ui-store";

const rpcMocks = vi.hoisted(() => ({
  listJobs: vi.fn(), listTools: vi.fn(), listJobRuns: vi.fn(), saveJob: vi.fn(),
  pauseJob: vi.fn(), resumeJob: vi.fn(), deleteJob: vi.fn(), runJobNow: vi.fn(), upgradeJob: vi.fn(),
  listConnectors: vi.fn(), listDeliveries: vi.fn(), retryDelivery: vi.fn(),
}));
const permissionMocks = vi.hoisted(() => ({ has: vi.fn(), request: vi.fn() }));
vi.mock("@/sidepanel/rpc", () => ({
  rpc: rpcMocks,
  currentTabInfo: vi.fn(async () => ({ tabId: 7, url: "https://example.com/page" })),
}));
vi.mock("@/permissions/optional-permissions", () => ({
  hasOptionalPermission: permissionMocks.has,
  requestOptionalPermission: permissionMocks.request,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function job(id = "job-1"): Job {
  return {
    id, name: `Job ${id}`, toolId: "tool-1", toolVersion: 1,
    toolVersionHash: "a".repeat(64), targetUrl: "https://example.com/page?secret=hidden",
    inputs: {}, trigger: { kind: "manual" }, status: "active", safety: { severity: "safe" },
    retry: { maxAttempts: 3, backoffMinutes: [1, 5] },
    notifications: { onChange: true, onSuccess: false, onFailure: true }, connectorBindings: [], createdAt: 1, updatedAt: 1,
  };
}

const tool = {
  kind: "steps" as const, id: "tool-1", name: "Read", description: "", urlPatterns: ["https://example.com/**"],
  activeVersion: 1, versions: [{ version: 1, kind: "steps" as const, parameters: [], steps: [], outputSchema: {}, createdAt: 1 }],
  stats: { runs: 0 }, createdAt: 1, updatedAt: 1,
};

describe("JobsDrawer", () => {
  let root: Root;
  let container: HTMLDivElement;
  let runtimeListeners: Array<(message: unknown) => void>;

  beforeEach(() => {
    runtimeListeners = [];
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: (message: unknown) => void) => runtimeListeners.push(listener)),
          removeListener: vi.fn((listener: (message: unknown) => void) => {
            runtimeListeners = runtimeListeners.filter((candidate) => candidate !== listener);
          }),
        },
      },
    });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    useUi.setState({ openedDrawer: "jobs", drawerSubPath: null });
    rpcMocks.listTools.mockResolvedValue([tool]);
    rpcMocks.listJobRuns.mockResolvedValue({ items: [] });
    rpcMocks.listConnectors.mockResolvedValue([]);
    rpcMocks.listDeliveries.mockResolvedValue([]);
    permissionMocks.has.mockResolvedValue(true);
    permissionMocks.request.mockResolvedValue({ granted: true });
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove(); vi.clearAllMocks();
    useUi.setState({ openedDrawer: null, drawerSubPath: null });
  });

  it("renders loading, empty, error, forbidden, default and large states", async () => {
    let resolveJobs!: (value: Job[]) => void;
    rpcMocks.listJobs.mockReturnValue(new Promise<Job[]>((resolve) => { resolveJobs = resolve; }));
    act(() => root.render(<JobsDrawer />));
    expect(container.querySelector('[data-state="loading"]')).toBeTruthy();
    await act(async () => resolveJobs([]));
    expect(container.querySelector('[data-state="empty"]')).toBeTruthy();

    rpcMocks.listJobs.mockResolvedValue([job()]); permissionMocks.has.mockResolvedValue(false);
    await act(async () => root.render(<JobsDrawer key="forbidden" />));
    await vi.waitFor(() => expect(container.querySelector('[data-state="forbidden"]')).toBeTruthy());

    permissionMocks.has.mockResolvedValue(true);
    await act(async () => root.render(<JobsDrawer key="default" />));
    await vi.waitFor(() => expect(container.querySelector('[data-state="default"]')).toBeTruthy());

    rpcMocks.listJobs.mockResolvedValue(Array.from({ length: 201 }, (_, i) => job(`job-${i}`)));
    await act(async () => root.render(<JobsDrawer key="large" />));
    await vi.waitFor(() => expect(container.querySelector('[data-state="large"]')).toBeTruthy());

    rpcMocks.listJobs.mockRejectedValue(new Error("offline"));
    await act(async () => root.render(<JobsDrawer key="error" />));
    await vi.waitFor(() => expect(container.querySelector('[data-state="error"]')).toBeTruthy());
  });

  it("shows pinned/active versions, history linkage and manual controls", async () => {
    rpcMocks.listJobs.mockResolvedValue([{ ...job(), upgradeAvailable: 2 }]);
    rpcMocks.listJobRuns.mockResolvedValue({ items: [{
      id: "jr-1", jobId: "job-1", cause: "manual", startedAt: 1, finishedAt: 2,
      status: "ok", toolId: "tool-1", toolVersion: 1,
      attempts: [{ attempt: 1, startedAt: 1, finishedAt: 2, status: "ok", runId: "run-1" }],
      tab: { ownership: "existing", tabId: 7 },
      diff: { changes: [{ path: "$.price", before: 1, after: 2 }], truncated: false },
    }] });
    await act(async () => root.render(<JobsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("固定 v1 · active v2"));
    expect(container.textContent).toContain("RunRecord: run-1");
    expect(container.textContent).not.toContain("secret=hidden");
    expect(container.textContent).toContain("立即运行");
    expect(container.textContent).toContain("暂停");
  });

  it("renders a single Job name field in the create form", async () => {
    rpcMocks.listJobs.mockResolvedValue([]);
    await act(async () => root.render(<JobsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("还没有 Job"));

    const create = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "新建");
    await act(async () => create?.click());

    expect(container.querySelectorAll('input[aria-label="Job 名称"]')).toHaveLength(1);
  });

  it("clears a one-run dangerous approval prompt when another Job is selected", async () => {
    rpcMocks.listJobs.mockResolvedValue([
      { ...job("job-1"), safety: { severity: "dangerous" as const } },
      job("job-2"),
    ]);
    rpcMocks.runJobNow.mockRejectedValue(new Error("dangerous_approval_required"));
    await act(async () => root.render(<JobsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("Job job-1"));

    const run = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "立即运行");
    await act(async () => run?.click());
    await vi.waitFor(() => expect(container.textContent).toContain("仅批准本次"));

    const secondJob = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Job job-2"));
    await act(async () => secondJob?.click());

    expect(container.textContent).not.toContain("仅批准本次");
  });

  it("turns notification settings off when optional permission is denied", async () => {
    rpcMocks.listJobs.mockResolvedValue([]);
    rpcMocks.saveJob.mockResolvedValue(job());
    permissionMocks.has.mockResolvedValue(false);
    permissionMocks.request.mockResolvedValue({ granted: false });
    await act(async () => root.render(<JobsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("还没有 Job"));

    const create = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "新建");
    await act(async () => create?.click());
    const target = container.querySelector<HTMLInputElement>('input[aria-label="目标 URL"]');
    await act(async () => {
      if (target) {
        target.value = "https://example.com/page";
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    const save = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "保存");
    await act(async () => save?.click());

    expect(rpcMocks.saveJob).toHaveBeenCalledWith(
      expect.objectContaining({
        notifications: { onChange: false, onSuccess: false, onFailure: false },
      }),
      { acknowledgeCaution: false },
    );
  });

  it("edits an existing Job without changing its pinned version", async () => {
    rpcMocks.listJobs.mockResolvedValue([job()]);
    rpcMocks.saveJob.mockResolvedValue(job());
    await act(async () => root.render(<JobsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("固定 v1"));

    const edit = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "编辑");
    await act(async () => edit?.click());
    expect(container.textContent).toContain("编辑 Job");

    const save = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "保存");
    await act(async () => save?.click());

    expect(rpcMocks.saveJob).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "tool-1", toolVersion: 1 }),
      { id: "job-1", acknowledgeCaution: false },
    );
  });

  it("locates a Job immediately when a notification is clicked while mounted", async () => {
    rpcMocks.listJobs.mockResolvedValue([job("job-1"), job("job-2")]);
    await act(async () => root.render(<JobsDrawer />));
    await vi.waitFor(() => expect(container.querySelector("section h3")?.textContent).toBe("Job job-1"));

    await act(async () => {
      for (const listener of runtimeListeners) listener({ type: "jobs.open", jobId: "job-2" });
    });

    await vi.waitFor(() => expect(container.querySelector("section h3")?.textContent).toBe("Job job-2"));
  });

  it("selects only ready persistent destinations and confirms automatic external sending", async () => {
    rpcMocks.listJobs.mockResolvedValue([]);
    rpcMocks.listConnectors.mockResolvedValue([
      {
        id: "connector-ready", name: "Operations", kind: "webhook",
        publicConfig: { kind: "webhook", method: "POST", endpointOrigin: "https://hooks.example.com", headerCount: 1 },
        credentialMode: "persistent", credentialConfigured: true, status: "ready",
        configHash: "b".repeat(64), createdAt: 1, updatedAt: 1,
      },
      {
        id: "connector-session", name: "Session only", kind: "webhook",
        publicConfig: { kind: "webhook", method: "POST", endpointOrigin: "https://temp.example.com", headerCount: 0 },
        credentialMode: "session", credentialConfigured: true, status: "ready",
        configHash: "c".repeat(64), createdAt: 1, updatedAt: 1,
      },
    ]);
    rpcMocks.saveJob
      .mockRejectedValueOnce(new Error("caution_acknowledgement_required"))
      .mockResolvedValueOnce({
        ...job(),
        connectorBindings: [{ connectorId: "connector-ready", connectorConfigHash: "b".repeat(64) }],
      });
    await act(async () => root.render(<JobsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("还没有 Job"));
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "新建")?.click());

    expect(container.textContent).toContain("Operations");
    expect(container.textContent).not.toContain("Session only");
    const destination = container.querySelector<HTMLInputElement>('input[aria-label="发送到 Operations"]');
    await act(async () => destination?.click());
    const target = container.querySelector<HTMLInputElement>('input[aria-label="目标 URL"]');
    await act(async () => {
      if (!target) return;
      target.value = "https://example.com/page";
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "保存")?.click());
    await vi.waitFor(() => expect(container.textContent).toContain("自动发送到外部服务"));

    expect(rpcMocks.saveJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectorBindings: [{
          connectorId: "connector-ready",
          connectorConfigHash: "b".repeat(64),
        }],
      }),
      { acknowledgeCaution: false },
    );
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "确认并保存")?.click());
    expect(rpcMocks.saveJob).toHaveBeenLastCalledWith(
      expect.anything(),
      { acknowledgeCaution: true },
    );
  });

  it("shows JobRun delivery status, retries only sending, then requires explicit resume", async () => {
    const boundJob = {
      ...job(),
      status: "needs_attention" as const,
      attentionReason: "connector_delivery_failed" as const,
      connectorBindings: [{ connectorId: "connector-1", connectorConfigHash: "b".repeat(64) }],
    };
    rpcMocks.listJobs.mockResolvedValue([boundJob]);
    rpcMocks.listConnectors.mockResolvedValue([{
      id: "connector-1", name: "Operations", kind: "webhook",
      publicConfig: { kind: "webhook", method: "POST", endpointOrigin: "https://hooks.example.com", headerCount: 0 },
      credentialMode: "persistent", credentialConfigured: true, status: "ready",
      configHash: "b".repeat(64), createdAt: 1, updatedAt: 1,
    }]);
    rpcMocks.listJobRuns.mockResolvedValue({ items: [{
      id: "jr-1", jobId: "job-1", cause: "schedule", startedAt: 1, finishedAt: 2,
      status: "ok", toolId: "tool-1", toolVersion: 1,
      attempts: [{ attempt: 1, startedAt: 1, finishedAt: 2, status: "ok", runId: "run-1" }],
      tab: { ownership: "created", tabId: 7 },
    }] });
    const failedDelivery = {
      id: "delivery-1", connectorId: "connector-1", connectorConfigHash: "b".repeat(64),
      source: { kind: "job_run" as const, jobRunId: "jr-1" }, status: "error" as const,
      attempt: 1, nextOffset: 0, createdAt: 1, finishedAt: 2, errorCode: "connector_http_error" as const,
    };
    rpcMocks.listDeliveries.mockResolvedValueOnce([failedDelivery]).mockResolvedValue([]);
    rpcMocks.retryDelivery.mockResolvedValue({ ...failedDelivery, status: "ok", attempt: 2 });
    rpcMocks.resumeJob.mockResolvedValue({ ...boundJob, status: "active", attentionReason: undefined });

    await act(async () => root.render(<JobsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("发送：error"));
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "仅重试发送")?.click());

    expect(rpcMocks.retryDelivery).toHaveBeenCalledWith("delivery-1", false);
    expect(rpcMocks.runJobNow).not.toHaveBeenCalled();
    expect(rpcMocks.resumeJob).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "恢复")?.click());
    expect(rpcMocks.resumeJob).toHaveBeenCalledWith("job-1");
  });

  it("requires duplicate-risk confirmation before retrying unknown commit", async () => {
    rpcMocks.listJobs.mockResolvedValue([job()]);
    rpcMocks.listJobRuns.mockResolvedValue({ items: [{
      id: "jr-unknown", jobId: "job-1", cause: "manual", startedAt: 1, finishedAt: 2,
      status: "ok", toolId: "tool-1", toolVersion: 1,
      attempts: [{ attempt: 1, startedAt: 1, finishedAt: 2, status: "ok", runId: "run-1" }],
      tab: { ownership: "existing", tabId: 7 },
    }] });
    const unknown = {
      id: "delivery-unknown", connectorId: "connector-1", connectorConfigHash: "b".repeat(64),
      source: { kind: "job_run" as const, jobRunId: "jr-unknown" }, status: "unknown_commit" as const,
      attempt: 1, nextOffset: 0, createdAt: 1, finishedAt: 2,
      errorCode: "connector_unknown_commit" as const,
    };
    rpcMocks.listDeliveries.mockResolvedValue([unknown]);
    rpcMocks.retryDelivery.mockResolvedValue({ ...unknown, status: "ok" });

    await act(async () => root.render(<JobsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("发送：unknown_commit"));
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "仅重试发送")?.click());
    expect(rpcMocks.retryDelivery).not.toHaveBeenCalled();
    expect(container.textContent).toContain("继续可能重复");

    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "确认仍要重试")?.click());
    expect(rpcMocks.retryDelivery).toHaveBeenCalledWith("delivery-unknown", true);
  });
});
