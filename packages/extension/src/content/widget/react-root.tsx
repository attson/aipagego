import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { FAB } from "./fab";
import { Panel } from "./panel";
import { startWidgetStoreSync } from "./store";
import { installApprovalListener } from "@/sidepanel/chat/approval";
import { installPermissionDecisionListener } from "@/sidepanel/chat/permission-request";
import { useSettings, installSettingsSyncListener } from "@/sidepanel/chat/settings-store";

function WidgetApp() {
  const [open, setOpen] = useState(false);

  // Install cross-process approval relay: decisions from sidepanel are
  // forwarded into the widget's local approversByTab map (and vice-versa
  // via WidgetApprover.resolve → broadcastApprovalDecision).
  useEffect(() => {
    const disposeApproval = installApprovalListener();
    const disposePermission = installPermissionDecisionListener();
    return () => {
      disposePermission();
      disposeApproval();
    };
  }, []);

  return (
    <>
      <FAB onToggle={() => setOpen((v) => !v)} active={open} />
      {open && (
        <Panel onClose={() => setOpen(false)} onMinimize={() => setOpen(false)} />
      )}
    </>
  );
}

export function bootstrap(shadow: ShadowRoot): () => void {
  const container = document.createElement("div");
  shadow.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const dispose = startWidgetStoreSync();
  // Widget has its own zustand instance (independent bundle). Load LlmSettings
  // from chrome.storage.local so widget knows the API key + provider — without
  // this, runFromInput's `!settings.apiKey` guard triggers on every send.
  // Fire-and-forget; swallow errors so a partial chrome stub in tests (or
  // storage race on hot-reload) doesn't produce an unhandled rejection.
  useSettings.getState().load().catch(() => {});
  // Auto-refresh when sidepanel updates settings (they live in separate
  // zustand instances but share chrome.storage.local).
  const disposeSettingsSync = installSettingsSyncListener();
  root.render(
    <React.StrictMode>
      <WidgetApp />
    </React.StrictMode>
  );
  return () => {
    root.unmount();
    dispose();
    disposeSettingsSync();
    container.remove();
  };
}
