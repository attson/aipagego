import type { PermissionRequestResult } from "@/permissions/optional-permissions";

type Pending = {
  resolve: (result: PermissionRequestResult) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export type PermissionDecisionMessage = {
  type: "permission.decision";
  tabId: number;
  toolUseId: string;
  result: PermissionRequestResult;
};

export class PermissionRequester {
  private readonly pending = new Map<string, Pending>();

  request(toolUseId: string, signal?: AbortSignal): Promise<PermissionRequestResult> {
    if (signal?.aborted) {
      return Promise.resolve({ granted: false, reason: "user_denied" });
    }
    return new Promise((resolve) => {
      const entry: Pending = { resolve, signal };
      if (signal) {
        entry.onAbort = () => this.resolve(toolUseId, { granted: false, reason: "user_denied" });
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(toolUseId, entry);
    });
  }

  resolve(toolUseId: string, result: PermissionRequestResult): void {
    const entry = this.pending.get(toolUseId);
    if (!entry) return;
    this.pending.delete(toolUseId);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    entry.resolve(result);
  }

  resolveAllPending(result: PermissionRequestResult): void {
    for (const toolUseId of [...this.pending.keys()]) this.resolve(toolUseId, result);
  }

  has(toolUseId: string): boolean {
    return this.pending.has(toolUseId);
  }
}

const requestersByTab = new Map<number, PermissionRequester>();

export function registerPermissionRequesterForTab(
  tabId: number,
  requester: PermissionRequester,
): void {
  const previous = requestersByTab.get(tabId);
  if (previous && previous !== requester) {
    previous.resolveAllPending({ granted: false, reason: "user_denied" });
  }
  requestersByTab.set(tabId, requester);
}

export function disposePermissionRequesterForTab(tabId: number): void {
  const requester = requestersByTab.get(tabId);
  if (!requester) return;
  requester.resolveAllPending({ granted: false, reason: "user_denied" });
  requestersByTab.delete(tabId);
}

export function broadcastPermissionDecision(
  tabId: number,
  toolUseId: string,
  result: PermissionRequestResult,
): void {
  const message: PermissionDecisionMessage = {
    type: "permission.decision",
    tabId,
    toolUseId,
    result,
  };
  void Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => undefined);
}

export function installPermissionDecisionListener(): () => void {
  function onMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const candidate = message as Partial<PermissionDecisionMessage>;
    if (
      candidate.type !== "permission.decision" ||
      candidate.tabId == null ||
      !candidate.toolUseId ||
      !candidate.result
    ) return;
    const requester = requestersByTab.get(candidate.tabId);
    if (!requester?.has(candidate.toolUseId)) return;
    requester.resolve(candidate.toolUseId, candidate.result);
  }
  chrome.runtime.onMessage.addListener(onMessage);
  return () => chrome.runtime.onMessage.removeListener(onMessage);
}
