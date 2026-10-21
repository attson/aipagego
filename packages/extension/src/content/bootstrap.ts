import { readPolicyForHostname, SETTINGS_KEY } from "@/injection-policy";
import { activationForPolicy } from "./bootstrap-policy";
import { unmountWidget } from "./widget/lifecycle";

type Dispose = () => void;

let runnerDisposers: Dispose[] = [];
let breathingDispose: Dispose | null = null;
let pairingDispose: Dispose | null = null;
let reconciling: Promise<void> = Promise.resolve();

async function reconcile(): Promise<void> {
  const policy = await readPolicyForHostname(location.hostname);
  const activation = activationForPolicy(policy);
  const pairingPage = (location.hostname === "127.0.0.1" || location.hostname === "localhost") &&
    location.pathname === "/pair";

  if (pairingPage && !pairingDispose) {
    pairingDispose = (await import("./pairing-relay")).installPairingRelay();
  } else if (!pairingPage && pairingDispose) {
    pairingDispose();
    pairingDispose = null;
  }

  if (!activation.runner) {
    disposeRunner();
  } else if (runnerDisposers.length === 0) {
    const [runner, capture, replay] = await Promise.all([
      import("./index"),
      import("./element-capture"),
      import("./external-replay")
    ]);
    runnerDisposers = [
      runner.installContentRunner(),
      capture.installElementCapture(),
      replay.installExternalReplay()
    ];
  }

  if (activation.assistant) {
    await (await import("./widget/mount")).mountWidget();
    if (!breathingDispose) {
      breathingDispose = await (await import("./breathing-border")).installBreathingBorder();
    }
  } else {
    unmountWidget();
    breathingDispose?.();
    breathingDispose = null;
  }

  void chrome.runtime.sendMessage({
    type: "aipagego.recorderPolicy",
    enabled: activation.recorder
  }).catch(() => undefined);
}

function disposeRunner(): void {
  for (const dispose of runnerDisposers.splice(0)) dispose();
}

function scheduleReconcile(): void {
  reconciling = reconciling.then(reconcile, reconcile);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && SETTINGS_KEY in changes) scheduleReconcile();
});

scheduleReconcile();
