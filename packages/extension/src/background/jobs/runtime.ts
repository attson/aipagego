import { JOBS_DISPATCH_ALARM } from "./scheduler";

type Scheduler = { reconcile: () => Promise<void> };
type AlarmEvents = {
  addListener: (listener: (alarm: { name: string }) => void) => void;
  removeListener: (listener: (alarm: { name: string }) => void) => void;
};

let activeScheduler: Scheduler | null = null;

export function requestJobReconcile(): void {
  if (activeScheduler) void activeScheduler.reconcile().catch(() => undefined);
}

export function installJobSchedulerListener(
  scheduler: Scheduler,
  events: AlarmEvents = chrome.alarms.onAlarm,
  ready: Promise<unknown> = Promise.resolve(),
): () => void {
  const gatedScheduler: Scheduler = {
    reconcile: async () => {
      await ready;
      await scheduler.reconcile();
    },
  };
  const listener = (alarm: { name: string }) => {
    if (alarm.name === JOBS_DISPATCH_ALARM) {
      void gatedScheduler.reconcile().catch(() => undefined);
    }
  };
  activeScheduler = gatedScheduler;
  events.addListener(listener);
  void gatedScheduler.reconcile().catch(() => undefined);
  return () => {
    events.removeListener(listener);
    if (activeScheduler === gatedScheduler) activeScheduler = null;
  };
}
