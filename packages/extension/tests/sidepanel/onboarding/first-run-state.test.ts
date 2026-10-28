import { describe, expect, it, vi } from "vitest";

import {
  FIRST_RUN_KEY,
  FIRST_RUN_RESTART_EVENT,
  decideFirstRun,
  restartFirstRun,
  resetFirstRun,
  saveFirstRunDisposition,
  type FirstRunStorage,
} from "@/sidepanel/onboarding/first-run-state";

function memoryStorage(initial?: unknown): FirstRunStorage & { value: unknown } {
  const storage = {
    value: initial,
    get: vi.fn(async () => ({ [FIRST_RUN_KEY]: storage.value })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      storage.value = items[FIRST_RUN_KEY];
    }),
    remove: vi.fn(async () => {
      storage.value = undefined;
    }),
  };
  return storage;
}

describe("first-run state", () => {
  it("shows onboarding for a user without a saved disposition or API key", async () => {
    const result = await decideFirstRun("", memoryStorage());

    expect(result).toEqual({ show: true, state: null });
  });

  it("migrates an existing configured user without showing onboarding", async () => {
    const storage = memoryStorage();

    const result = await decideFirstRun("sk-existing", storage, () => "2026-10-23T01:00:00.000Z");

    expect(result).toEqual({
      show: false,
      state: {
        version: 1,
        disposition: "existing_user",
        updatedAt: "2026-10-23T01:00:00.000Z",
      },
    });
    expect(storage.value).toEqual(result.state);
  });

  it("persists completion and can reset onboarding without touching other storage", async () => {
    const storage = memoryStorage();

    const completed = await saveFirstRunDisposition(
      "task_completed",
      storage,
      () => "2026-10-23T02:00:00.000Z",
    );
    expect(completed.disposition).toBe("task_completed");
    expect((await decideFirstRun("", storage)).show).toBe(false);

    await resetFirstRun(storage);
    expect(storage.remove).toHaveBeenCalledWith(FIRST_RUN_KEY);
    expect((await decideFirstRun("", storage)).show).toBe(true);
  });

  it("does not block an already configured user when storage cannot be read", async () => {
    const storage: FirstRunStorage = {
      get: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };

    await expect(decideFirstRun("sk-existing", storage)).resolves.toEqual({
      show: false,
      state: null,
      storageError: "storage unavailable",
    });
  });

  it("does not force the full guide again after a session-only key has expired", async () => {
    const storage = memoryStorage({
      version: 1,
      disposition: "task_completed",
      updatedAt: "2026-10-23T02:00:00.000Z",
    });

    await expect(decideFirstRun("", storage)).resolves.toMatchObject({
      show: false,
      state: { disposition: "task_completed" },
    });
  });

  it("restarts onboarding by clearing only first-run state and notifying the sidepanel", async () => {
    const storage = memoryStorage({
      version: 1,
      disposition: "task_completed",
      updatedAt: "2026-10-23T02:00:00.000Z",
    });
    const listener = vi.fn();
    window.addEventListener(FIRST_RUN_RESTART_EVENT, listener);

    await restartFirstRun(storage);

    expect(storage.value).toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(FIRST_RUN_RESTART_EVENT, listener);
  });
});

