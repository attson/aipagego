import type { PairPayload } from "@aipagego/shared/pairing";

/**
 * The pairing page is a *carrier*, not an authority. It hands the extension a
 * port the extension has no other way to discover, and nothing more — the
 * approve/deny UI is rendered by the extension itself. Letting the requesting
 * party draw its own approval button would be asking it to sign its own permit.
 */
export function renderPairPage(payload: PairPayload): string {
  // `</script>` inside the JSON would close the block early; escaping `<` is
  // enough to prevent that and any tag injection through the payload.
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html>
<meta charset="utf-8">
<title>AIPageGo 配对</title>
<body style="font:14px/1.6 system-ui,sans-serif;padding:2rem;max-width:32rem;margin:auto;color:#222">
<h1 style="font-size:1.1rem;margin:0 0 1rem">AIPageGo 配对</h1>
<p><span id="aipagego-status">正在联系扩展…</span> <span id="aipagego-elapsed" style="color:#666;font-variant-numeric:tabular-nums">（已等待 0.0 秒）</span></p>
<p style="color:#666;font-size:13px">会话：${escapeHtml(payload.label)} · pid ${payload.pid} · 端口 ${payload.port} · ${payload.mcpVersion ? `MCP v${escapeHtml(payload.mcpVersion)}` : "MCP 版本未知"}</p>
<p style="color:#666;font-size:13px">没有反应？请确认这个浏览器已安装并启用 AIPageGo 扩展，然后刷新本页。</p>
<script>
(function () {
  var payload = ${json};
  var done = false;
  var startedAt = Date.now();
  var elapsedEl = document.getElementById("aipagego-elapsed");
  var elapsedTimer;

  function elapsedSeconds() {
    return ((Date.now() - startedAt) / 1000).toFixed(1);
  }

  function updateElapsed() {
    elapsedEl.textContent = "（已等待 " + elapsedSeconds() + " 秒）";
  }

  function finishElapsed() {
    clearInterval(elapsedTimer);
    elapsedEl.textContent = "（配对耗时 " + elapsedSeconds() + " 秒）";
  }

  elapsedTimer = setInterval(updateElapsed, 100);

  function announce() {
    if (!done) window.postMessage({ source: "aipagego-pair", payload: payload }, "*");
  }

  window.addEventListener("message", function (e) {
    if (!e.data) return;
    // The extension's relay installs at document_idle, i.e. after this script
    // has already run. It says hello when it is ready; that is our cue.
    if (e.data.source === "aipagego-pair-ready") {
      document.getElementById("aipagego-status").textContent = "扩展已响应，等待授权…";
      announce();
      return;
    }
    if (e.data.source !== "aipagego-pair-result") return;
    done = true;
    finishElapsed();
    var el = document.getElementById("aipagego-status");
    if (e.data.ok) {
      if (typeof e.data.versionWarning === "string" && e.data.versionWarning) {
        el.textContent = "版本提醒：" + e.data.versionWarning + "。会话已连接，可以关闭本页。";
        el.style.color = "#b45309";
      } else {
        el.textContent = e.data.trusted ? "已信任，连接中…" : "已连接";
        setTimeout(function () { window.close(); }, 1200);
      }
    } else if (e.data.reason === "denied") {
      fetch("/pair/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          v: 1,
          decision: "denied",
          sessionId: payload.sessionId,
          installId: payload.installId,
          secret: payload.secret
        })
      }).catch(function () {});
      el.textContent = "已拒绝。可以关闭本页。";
    } else {
      el.textContent = "连接扩展失败。请刷新页面重试，或检查扩展是否已启用。";
    }
  });

  // Belt and braces: announce now in case the relay was already listening, and
  // keep announcing for a while in case the ready signal itself was missed.
  announce();
  var tries = 0;
  var timer = setInterval(function () {
    if (done || ++tries > 90) {
      clearInterval(timer);
      if (!done) {
        finishElapsed();
        document.getElementById("aipagego-status").textContent =
          "没有联系上扩展。请确认这个浏览器已安装并启用 AIPageGo 扩展，然后刷新本页。";
      }
      return;
    }
    announce();
  }, 500);
})();
</script>
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
