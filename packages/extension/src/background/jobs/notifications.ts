import type { Job, JobRun } from "@aipagego/shared/jobs";

export const JOBS_OPEN_STORAGE_KEY = "aipagego.jobs.open";
const PREFIX = "aipagego.job.";
const SAFE_ERROR_CODES = new Set([
  "browser_offline", "tool_missing", "tool_version_changed", "sensitive_input_required",
  "dangerous_auto_blocked", "site_permission_denied", "watch_selector_missing",
  "watch_selector_ambiguous", "tab_closed", "service_worker_interrupted",
  "retry_exhausted", "tool_run_aborted", "tool_run_failed", "change_reverted",
]);

function shouldNotify(job: Job, run: JobRun): boolean {
  if (run.status === "retry_wait" || run.status === "running" || run.status === "queued") return false;
  if (run.status === "ok") {
    return run.cause === "page_change" ? job.notifications.onChange : job.notifications.onSuccess;
  }
  return job.notifications.onFailure;
}

function notificationText(job: Job, run: JobRun): { title: string; message: string } {
  if (run.status === "ok" && run.cause === "page_change") {
    return {
      title: `${job.name} · 网页变化`,
      message: `固定 v${job.toolVersion} · ${run.diff?.changes.length ?? 0} 项变化`,
    };
  }
  if (run.status === "ok") {
    return { title: `${job.name} · 运行成功`, message: `固定 v${job.toolVersion}` };
  }
  const state = run.status === "missed" ? "已错过" : "运行失败";
  const errorCode = run.errorCode && SAFE_ERROR_CODES.has(run.errorCode)
    ? run.errorCode
    : "job_failed";
  return {
    title: `${job.name} · ${state}`,
    message: `固定 v${job.toolVersion} · ${errorCode}`,
  };
}

export async function notifyJobTerminal(job: Job, run: JobRun): Promise<void> {
  if (!shouldNotify(job, run)) return;
  if (!await chrome.permissions.contains({ permissions: ["notifications"] })) return;
  const text = notificationText(job, run);
  await chrome.notifications.create(`${PREFIX}${job.id}.${run.id}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title: text.title.slice(0, 120),
    message: text.message,
  });
}

export function installJobNotificationClickHandler(): () => void {
  const listener = (notificationId: string) => {
    if (!notificationId.startsWith(PREFIX)) return;
    const jobId = notificationId.slice(PREFIX.length).split(".")[0];
    if (!jobId) return;
    void (async () => {
      await chrome.storage.local.set({ [JOBS_OPEN_STORAGE_KEY]: { jobId } });
      await Promise.resolve(chrome.runtime.sendMessage({ type: "jobs.open", jobId }))
        .catch(() => undefined);
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0] ?? await chrome.tabs.create({ active: true });
      if (tab.id != null) await chrome.sidePanel.open({ tabId: tab.id });
    })();
  };
  chrome.notifications.onClicked.addListener(listener);
  return () => chrome.notifications.onClicked.removeListener(listener);
}
