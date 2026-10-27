export const FIRST_RUN_KEY = "aipagego.firstRun.v1";
export const FIRST_RUN_RESTART_EVENT = "aipagego:first-run-restart";

export type FirstRunDisposition = "task_completed" | "skipped" | "existing_user";

export type FirstRunStateV1 = {
  version: 1;
  disposition: FirstRunDisposition;
  updatedAt: string;
};

export type FirstRunStorage = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
};

export type FirstRunDecision = {
  show: boolean;
  state: FirstRunStateV1 | null;
  storageError?: string;
};

function defaultStorage(): FirstRunStorage {
  return {
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
    remove: (key) => chrome.storage.local.remove(key),
  };
}

function parseState(value: unknown): FirstRunStateV1 | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<FirstRunStateV1>;
  if (candidate.version !== 1 || typeof candidate.updatedAt !== "string") return null;
  if (
    candidate.disposition !== "task_completed" &&
    candidate.disposition !== "skipped" &&
    candidate.disposition !== "existing_user"
  ) {
    return null;
  }
  return candidate as FirstRunStateV1;
}

export async function saveFirstRunDisposition(
  disposition: FirstRunDisposition,
  storage: FirstRunStorage = defaultStorage(),
  now: () => string = () => new Date().toISOString(),
): Promise<FirstRunStateV1> {
  const state: FirstRunStateV1 = { version: 1, disposition, updatedAt: now() };
  await storage.set({ [FIRST_RUN_KEY]: state });
  return state;
}

export async function resetFirstRun(
  storage: FirstRunStorage = defaultStorage(),
): Promise<void> {
  await storage.remove(FIRST_RUN_KEY);
}

export async function restartFirstRun(
  storage: FirstRunStorage = defaultStorage(),
): Promise<void> {
  await resetFirstRun(storage);
  window.dispatchEvent(new Event(FIRST_RUN_RESTART_EVENT));
}

export async function decideFirstRun(
  apiKey: string,
  storage: FirstRunStorage = defaultStorage(),
  now: () => string = () => new Date().toISOString(),
): Promise<FirstRunDecision> {
  try {
    const values = await storage.get(FIRST_RUN_KEY);
    const state = parseState(values[FIRST_RUN_KEY]);
    if (state) return { show: false, state };
    if (apiKey.trim()) {
      const migrated = await saveFirstRunDisposition("existing_user", storage, now);
      return { show: false, state: migrated };
    }
    return { show: true, state: null };
  } catch (error) {
    return {
      show: !apiKey.trim(),
      state: null,
      storageError: error instanceof Error ? error.message : String(error),
    };
  }
}

