import { describe, expect, it, vi } from "vitest";
import { installJobSchedulerListener } from "@/background/jobs/runtime";
import { JOBS_DISPATCH_ALARM } from "@/background/jobs/scheduler";

describe("installJobSchedulerListener", () => {
  it("reconciles on install and only for the Jobs dispatch alarm", async () => {
    let listener: ((alarm: { name: string }) => void) | undefined;
    const reconcile = vi.fn(async () => undefined);
    const removeListener = vi.fn();
    const dispose = installJobSchedulerListener(
      { reconcile },
      {
        addListener: (next) => { listener = next; },
        removeListener,
      },
    );
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);
    listener?.({ name: "other" });
    listener?.({ name: JOBS_DISPATCH_ALARM });
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(2);
    dispose();
    expect(removeListener).toHaveBeenCalledWith(listener);
  });

  it("waits for delivery recovery/reconciliation before any scheduler reconcile", async () => {
    let listener: ((alarm: { name: string }) => void) | undefined;
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const reconcile = vi.fn(async () => undefined);
    installJobSchedulerListener(
      { reconcile },
      {
        addListener: (next) => { listener = next; },
        removeListener: vi.fn(),
      },
      ready,
    );

    listener?.({ name: JOBS_DISPATCH_ALARM });
    await Promise.resolve();
    expect(reconcile).not.toHaveBeenCalled();

    markReady();
    await ready;
    await Promise.resolve();
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
