/**
 * Persisted state for the coordinator-client. Lives in chrome.storage.local
 * so it survives SW restarts. The worker_id is generated exactly once per
 * extension install and stays forever (it's how the coordinator identifies
 * the worker across reconnects).
 */

const STORAGE_KEYS = {
  worker_id: "aipagego.coordinator.worker_id",
  token: "aipagego.coordinator.token",
  config: "aipagego.coordinator.config",
  connection_status: "aipagego.coordinator.connection_status"
} as const;

export const COORDINATOR_CONNECTION_STATUS_KEY = STORAGE_KEYS.connection_status;

export interface CoordinatorConfig {
  ws_url: string;
  enabled: boolean;
}

export type CoordinatorConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface CoordinatorConnectionState {
  status: CoordinatorConnectionStatus;
  ws_url: string;
  updated_at: number;
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

export async function getOrCreateWorkerId(): Promise<string> {
  const got = await chrome.storage.local.get([STORAGE_KEYS.worker_id]);
  const existing = got[STORAGE_KEYS.worker_id] as string | undefined;
  if (existing) return existing;
  const fresh = randomId("worker");
  await chrome.storage.local.set({ [STORAGE_KEYS.worker_id]: fresh });
  return fresh;
}

export async function loadConfig(): Promise<CoordinatorConfig | undefined> {
  const got = await chrome.storage.local.get([STORAGE_KEYS.config]);
  return got[STORAGE_KEYS.config] as CoordinatorConfig | undefined;
}

export async function saveConfig(config: CoordinatorConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.config]: config });
}

export async function loadConnectionStatus(): Promise<CoordinatorConnectionState | undefined> {
  const got = await chrome.storage.local.get([STORAGE_KEYS.connection_status]);
  return got[STORAGE_KEYS.connection_status] as CoordinatorConnectionState | undefined;
}

export async function saveConnectionStatus(state: CoordinatorConnectionState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.connection_status]: state });
}

export async function loadToken(): Promise<string | undefined> {
  const got = await chrome.storage.local.get([STORAGE_KEYS.token]);
  return got[STORAGE_KEYS.token] as string | undefined;
}

export async function saveToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.token]: token });
}

export async function clearToken(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.token);
}

const ALLOW_REMOTE_CHAT_KEY = "aipagego.coordinator.allow_remote_chat";

export async function loadAllowRemoteChat(): Promise<boolean> {
  const got = await chrome.storage.local.get([ALLOW_REMOTE_CHAT_KEY]);
  return got[ALLOW_REMOTE_CHAT_KEY] === true;
}

export async function saveAllowRemoteChat(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [ALLOW_REMOTE_CHAT_KEY]: value });
}
