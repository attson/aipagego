import type { Coordinator, Worker, Clock } from "@aipagego/coordinator";
import { isCapability, type Capability } from "@aipagego/shared/capability";
import type { Hello } from "@aipagego/shared/protocol";
import type { LoopbackWSHub } from "./loopback-ws-hub";

export function helloToWorker(h: Hello, now: number): Worker {
  return {
    id: h.worker_id,
    fingerprint: h.fingerprint,
    capabilities: new Set<Capability>(h.capabilities.filter(isCapability)),
    supported_tools: h.supported_tools ? new Set(h.supported_tools) : undefined,
    attended: h.attended,
    labels: new Set(h.labels),
    available_tabs: h.available_tabs,
    saved_tools: h.saved_tools,
    protocol_version: h.protocol_version,
    connected_at: now,
    last_heartbeat_at: now
  };
}

export function installWire(
  hub: LoopbackWSHub,
  coordinator: Coordinator,
  clock: Clock,
  onWorkerReady?: (workerId: string) => void
): void {
  hub.onMessage((worker_id, msg) => {
    switch (msg.type) {
      case "HELLO":
        coordinator.unregisterWorker(msg.worker_id); // idempotent; clears prior registration on reconnect
        coordinator.registerWorker(helloToWorker(msg, clock.now()));
        onWorkerReady?.(msg.worker_id);
        break;
      case "PING": coordinator.heartbeatWorker(worker_id); break;
      case "TABS_UPDATE": {
        // available_tabs used to be frozen at HELLO time, so list_tabs
        // reported the browser as it stood when the extension connected.
        const w = coordinator.workers.get(worker_id);
        if (w) {
          w.available_tabs = msg.tabs.map((t) => ({ ...t }));
          coordinator.reconcileWorkerTabs(worker_id, new Set(msg.tabs.map((tab) => tab.tab_id)));
        }
        break;
      }
      default: break;
    }
  });
  hub.onDisconnect((worker_id) => coordinator.unregisterWorker(worker_id));
}
