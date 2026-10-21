import {
  PAIR_PAGE_SOURCE,
  PAIR_READY_SOURCE,
  PAIR_RESULT_SOURCE,
  comparePairingVersions,
  type PairPayload,
  type PairingDecision
} from "@aipagego/shared/pairing";

/**
 * Relays the pairing page's postMessage to the service worker, and renders the
 * approval UI when the worker asks for one.
 *
 * The approval UI lives here rather than on the served page on purpose: the
 * page is provided by the process requesting access, and letting it draw its
 * own Allow button would be asking it to sign its own permit. Anything the page
 * renders is cosmetic; only this overlay's outcome reaches the worker.
 */

type WorkerReply = { decision: PairingDecision } | { error: string };

export function installPairingRelay(): () => void {
  const listener = (ev: MessageEvent) => {
    // Only same-window messages: a cross-origin iframe posting up must not be
    // able to start a pairing on the top frame's behalf.
    if (ev.source !== window) return;
    const data = ev.data as { source?: unknown; payload?: unknown } | null;
    if (!data || data.source !== PAIR_PAGE_SOURCE) return;

    const payload = parsePayload(data.payload);
    // Any page can post anything; a malformed payload is ignored rather than
    // forwarded to the worker.
    if (!payload) return;

    void handle(payload);
  };
  window.addEventListener("message", listener);

  // The page's inline script runs while the document is parsing; this content
  // script runs at document_idle. Whoever speaks first would otherwise be
  // talking to nobody, so the relay announces itself and the page answers.
  window.postMessage({ source: PAIR_READY_SOURCE }, "*");
  return () => window.removeEventListener("message", listener);
}

async function handle(payload: PairPayload): Promise<void> {
  const extensionVersion = chrome.runtime.getManifest().version;
  const { warning: versionWarning } = comparePairingVersions(
    payload.mcpVersion,
    extensionVersion
  );
  const reply = (await chrome.runtime.sendMessage({
    type: "pairing.request",
    payload
  })) as WorkerReply | undefined;

  if (!reply || "error" in reply) {
    post({ ok: false, reason: "connection_error" });
    return;
  }

  if (reply.decision === "trusted") {
    post({ ok: true, trusted: true, extensionVersion, versionWarning });
    return;
  }

  const approved = await askUser(payload, extensionVersion, versionWarning);
  await chrome.runtime.sendMessage({
    type: "pairing.decision",
    sessionId: payload.sessionId,
    approved,
    payload
  });
  post({
    ok: approved,
    trusted: false,
    reason: approved ? undefined : "denied",
    extensionVersion,
    versionWarning
  });
}

function post(result: {
  ok: boolean;
  trusted?: boolean;
  reason?: "denied" | "connection_error";
  extensionVersion?: string;
  versionWarning?: string | null;
}): void {
  window.postMessage({ source: PAIR_RESULT_SOURCE, ...result }, "*");
}

/** Defensive shape check — this crosses a trust boundary. */
function parsePayload(raw: unknown): PairPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (p.v !== 1) return null;
  const strings = ["installId", "secret", "sessionId", "label"] as const;
  for (const k of strings) if (typeof p[k] !== "string" || !p[k]) return null;
  if (typeof p.pid !== "number" || typeof p.port !== "number") return null;
  if (p.mcpVersion !== undefined && (typeof p.mcpVersion !== "string" || !p.mcpVersion)) {
    return null;
  }
  return {
    v: 1,
    installId: p.installId as string,
    secret: p.secret as string,
    sessionId: p.sessionId as string,
    label: p.label as string,
    pid: p.pid,
    port: p.port,
    ...(p.mcpVersion ? { mcpVersion: p.mcpVersion as string } : {})
  };
}

/**
 * Rendered into a closed shadow root so the page cannot restyle it into
 * something misleading or read its contents.
 */
export function askUser(
  payload: PairPayload,
  extensionVersion = chrome.runtime.getManifest().version,
  versionWarning = comparePairingVersions(payload.mcpVersion, extensionVersion).warning
): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.setAttribute("data-aipagego-pairing", "");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647";
    const root = host.attachShadow({ mode: "closed" });

    root.innerHTML = `
      <style>
        .backdrop { position:fixed; inset:0; background:rgba(0,0,0,.45);
                    display:flex; align-items:center; justify-content:center;
                    font:14px/1.6 system-ui,sans-serif; }
        .card { background:#fff; color:#222; border-radius:10px; padding:20px 22px;
                max-width:26rem; box-shadow:0 10px 40px rgba(0,0,0,.3); }
        h2 { font-size:15px; margin:0 0 8px; }
        .meta { color:#666; font-size:13px; margin:0 0 14px; word-break:break-all; }
        .warning { color:#b45309; font-size:13px; margin:0 0 14px; }
        .row { display:flex; gap:8px; justify-content:flex-end; }
        button { font:inherit; padding:6px 14px; border-radius:6px; cursor:pointer;
                 border:1px solid #ccc; background:#f6f6f6; }
        button.allow { background:#1a7f37; border-color:#1a7f37; color:#fff; }
      </style>
      <div class="backdrop">
        <div class="card">
          <h2>允许该会话控制此浏览器？</h2>
          <p class="meta">
            会话目录：${escapeHtml(payload.label)}<br>
            pid ${payload.pid} · 端口 ${payload.port}<br>
            ${payload.mcpVersion ? `MCP v${escapeHtml(payload.mcpVersion)}` : "MCP 版本未知"} · 扩展 v${escapeHtml(extensionVersion)}
          </p>
          ${versionWarning ? `<p class="warning">${escapeHtml(versionWarning)}</p>` : ""}
          <p class="meta">允许后，本机上的 AIPageGo MCP 会话都可以直接连接，无需再次确认。可在扩展设置里撤销。</p>
          <div class="row">
            <button class="deny">拒绝</button>
            <button class="allow">允许</button>
          </div>
        </div>
      </div>`;

    const done = (ok: boolean) => {
      host.remove();
      resolve(ok);
    };
    root.querySelector(".allow")!.addEventListener("click", () => done(true));
    root.querySelector(".deny")!.addEventListener("click", () => done(false));
    document.documentElement.appendChild(host);
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
