import { useEffect, useState } from "react";
import {
  loadConfig,
  saveConfig,
  loadToken,
  saveToken,
  clearToken,
  loadAllowRemoteChat,
  saveAllowRemoteChat,
  loadConnectionStatus,
  COORDINATOR_CONNECTION_STATUS_KEY,
  type CoordinatorConnectionState,
  type CoordinatorConfig
} from "../../background/coordinator-state";
import {
  cdpRecorderEnabled,
  setCdpRecorderEnabled
} from "@/background/recorder/cdp-permission";
import { listTrusted, revokeTrust } from "@/background/pairing-host";
import { comparePairingVersions, type TrustRecord } from "@aipagego/shared/pairing";
import type { PoolEntry } from "@/background/coordinator-pool";

const DEFAULT_WS_URL = "ws://localhost:8787/worker";
const CONNECTION_STATUS_STALE_MS = 45_000;

function formatConnectionStatus(
  enabled: boolean,
  wsUrl: string,
  runtime: CoordinatorConnectionState | undefined,
  now = Date.now()
): { label: string; className: string } {
  if (!enabled) return { label: "未启用", className: "text-gray-500" };
  if (!runtime || runtime.ws_url !== wsUrl) {
    return { label: "等待后台连接", className: "text-gray-500" };
  }
  const isStale = now - runtime.updated_at > CONNECTION_STATUS_STALE_MS;
  if (isStale) {
    return { label: "状态未知（上次状态已过期）", className: "text-amber-600" };
  }
  switch (runtime.status) {
    case "connected":
      return { label: "已连接", className: "text-green-700" };
    case "connecting":
      return { label: "连接中", className: "text-blue-700" };
    case "error":
      return { label: "连接失败", className: "text-red-700" };
    case "disconnected":
      return { label: "未连接", className: "text-amber-600" };
  }
}

export function CoordinatorSettingsPage() {
  const [wsUrl, setWsUrl] = useState(DEFAULT_WS_URL);
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [allowRemoteChat, setAllowRemoteChat] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<
    CoordinatorConnectionState | undefined
  >(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [loaded, setLoaded] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cdpEnabled, setCdpEnabled] = useState(false);
  const [sessions, setSessions] = useState<PoolEntry[]>([]);
  const [trusted, setTrusted] = useState<TrustRecord[]>([]);
  const [cleaningGroups, setCleaningGroups] = useState(false);

  useEffect(() => {
    void (async () => {
      const cfg = await loadConfig();
      if (cfg) {
        setWsUrl(cfg.ws_url);
        setEnabled(cfg.enabled);
      }
      const t = await loadToken();
      if (t) setToken(t);
      const allow = await loadAllowRemoteChat();
      setAllowRemoteChat(allow);
      setConnectionStatus(await loadConnectionStatus());
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    void cdpRecorderEnabled().then(setCdpEnabled);
  }, []);

  useEffect(() => {
    const refresh = () => {
      void chrome.runtime
        ?.sendMessage({ type: "pairing.listSessions" })
        .then((r: { sessions?: PoolEntry[] } | undefined) => setSessions(r?.sessions ?? []))
        .catch(() => setSessions([]));
      void listTrusted().then(setTrusted);
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== "local") return;
      const change = changes[COORDINATOR_CONNECTION_STATUS_KEY];
      if (change) {
        const nextStatus = change.newValue as CoordinatorConnectionState | undefined;
        setConnectionStatus(nextStatus);
        if (nextStatus?.status === "connected") setSavedMsg(null);
        setNow(Date.now());
      }
    };
    chrome.storage.onChanged?.addListener(listener);
    return () => chrome.storage.onChanged?.removeListener(listener);
  }, []);

  async function handleConnect() {
    const cfg: CoordinatorConfig = { ws_url: wsUrl, enabled: true };
    await saveConfig(cfg);
    if (token) await saveToken(token);
    setEnabled(true);
    setConnectionStatus({ status: "connecting", ws_url: wsUrl, updated_at: Date.now() });
    setNow(Date.now());
    setSavedMsg("已启用，正在连接…");
  }

  async function handleDisconnect() {
    await saveConfig({ ws_url: wsUrl, enabled: false });
    setEnabled(false);
    setConnectionStatus({ status: "disconnected", ws_url: wsUrl, updated_at: Date.now() });
    setNow(Date.now());
    setSavedMsg("已关闭连接配置");
  }

  async function handleClearToken() {
    await clearToken();
    setToken("");
    setSavedMsg("Token 已清除");
  }

  async function handleCopyWsUrl() {
    if (!wsUrl) return;
    try {
      await navigator.clipboard.writeText(wsUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  if (!loaded) return <div className="p-4">载入中…</div>;

  const liveStatus = formatConnectionStatus(enabled, wsUrl, connectionStatus, now);
  const extensionVersion = chrome.runtime.getManifest().version;
  const versionWarnings = sessions.flatMap((session) => {
    if (session.source !== "mcp") return [];
    const warning = comparePairingVersions(session.mcpVersion, extensionVersion).warning;
    return warning ? [{ sessionId: session.sessionId, label: session.label, warning }] : [];
  });

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-lg font-semibold">Coordinator 连接</h2>

      <p className="text-sm text-gray-600">
        把扩展作为 worker 接到一个 coordinator（本地 daemon 或远程 server）。Token
        可选：本地 daemon 默认未启用鉴权时可留空；接远程 coordinator 时按对方要求填。
      </p>

      <label className="block">
        <span className="text-sm font-medium">WS URL</span>
        <div className="mt-1 flex gap-2">
          <input
            type="text"
            className="block w-full rounded border px-2 py-1 text-gray-900 placeholder-gray-400"
            placeholder={DEFAULT_WS_URL}
            value={wsUrl}
            onChange={(e) => setWsUrl(e.target.value)}
          />
          <button
            type="button"
            className="shrink-0 rounded bg-gray-200 px-3 py-1 text-sm text-gray-700 disabled:opacity-50"
            disabled={!wsUrl}
            onClick={handleCopyWsUrl}
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </label>

      <label className="block">
        <span className="text-sm font-medium">Token</span>
        <div className="mt-1 flex gap-2">
          <input
            type={showToken ? "text" : "password"}
            className="block w-full rounded border px-2 py-1 text-gray-900 placeholder-gray-400"
            placeholder="wpk_..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button
            type="button"
            className="shrink-0 rounded bg-gray-200 px-3 py-1 text-sm text-gray-700"
            onClick={() => setShowToken((v) => !v)}
          >
            {showToken ? "隐藏" : "显示"}
          </button>
        </div>
      </label>

      <div className="flex gap-2">
        {enabled ? (
          <button
            type="button"
            className="rounded bg-gray-200 px-3 py-1 text-sm"
            onClick={handleDisconnect}
          >
            断开
          </button>
        ) : (
          <button
            type="button"
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            disabled={!wsUrl}
            onClick={handleConnect}
          >
            连接
          </button>
        )}
        {token && (
          <button
            type="button"
            className="rounded bg-red-100 px-3 py-1 text-sm text-red-700"
            onClick={handleClearToken}
          >
            清 Token
          </button>
        )}
      </div>

      {savedMsg && <div className="text-sm text-green-700">{savedMsg}</div>}

      <label className="flex items-start gap-2 border-t pt-3">
        <input
          type="checkbox"
          className="mt-1"
          checked={allowRemoteChat}
          onChange={async (e) => {
            const v = e.target.checked;
            setAllowRemoteChat(v);
            await saveAllowRemoteChat(v);
          }}
        />
        <span className="text-sm">
          允许 coordinator 远程驱动 chat session 和危险工具
          <br />
          <span className="text-xs text-gray-500">
            开启后，连接的 coordinator 可以在你的浏览器里运行任意工具。仅在你信任该 coordinator 时勾选。
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2 border-t pt-3">
        <input
          type="checkbox"
          className="mt-1"
          checked={cdpEnabled}
          onChange={async (e) => {
            // chrome.permissions.request must run inside the user gesture, so
            // this is awaited directly in the handler rather than deferred.
            const applied = await setCdpRecorderEnabled(e.target.checked);
            setCdpEnabled(applied);
            if (e.target.checked && !applied) setSavedMsg("未授予 debugger 权限，CDP 录制未开启");
          }}
        />
        <span className="text-sm">
          用 chrome.debugger 做全保真页面录制（CDP）
          <br />
          <span className="text-xs text-gray-500">
            开启后 console / network / 弹窗的记录更完整：能拿到响应 body、脚本注入之前的日志、CORS 与
            CSP 报错，弹窗也能真正挂起等待应答；严格 CSP 页面阻止 unsafe-eval 时，runJS 也会按需通过
            CDP 执行。代价：浏览器顶部会常驻「AIPageGo 正在调试此浏览器」提示条，且与 DevTools、
            其它调试类扩展互斥——被抢占时会自动退回默认录制并在结果里标出 degradedReason。需要单独
            授予 debugger 权限。
          </span>
        </span>
      </label>

      <section className="border-t pt-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">已接入的会话</h3>
          <button
            type="button"
            className="text-xs text-gray-600 underline disabled:opacity-50"
            disabled={cleaningGroups}
            title="恢复或取消 AIPageGo 创建的 MCP 标签分组，不会关闭标签页"
            onClick={() => {
              setCleaningGroups(true);
              void chrome.runtime
                .sendMessage({ type: "pairing.cleanupGroups" })
                .then((result: { ok?: boolean; cleanedTabs?: number; error?: string } | undefined) => {
                  setSavedMsg(
                    result?.ok
                      ? `已取消 ${result.cleanedTabs ?? 0} 个标签页的 MCP 分组，标签页保持打开`
                      : result?.error ?? "清理失败"
                  );
                })
                .catch((error: unknown) => setSavedMsg(`清理失败：${String(error)}`))
                .finally(() => setCleaningGroups(false));
            }}
          >
            {cleaningGroups ? "清理中…" : "取消所有 MCP 分组"}
          </button>
        </div>
        {sessions.length === 0 ? (
          <p className="text-xs text-gray-500">
            还没有会话接入。在 Claude Code 里让 AI 操作网页时，会自动打开一个配对页请你确认。
          </p>
        ) : (
          <>
            {versionWarnings.length > 0 && (
              <div className="mb-2 space-y-1 text-xs text-amber-700" role="status">
                {versionWarnings.map(({ sessionId, label, warning }) => (
                  <p key={sessionId} className="break-words">
                    {label}：{warning}
                  </p>
                ))}
              </div>
            )}
            <ul className="space-y-2 text-xs">
              {sessions.map((s) => (
                <li key={s.sessionId} className="flex items-start gap-2">
                  <span className="min-w-0 flex-1" title={s.endpoint}>
                    <span className="block truncate">
                      {s.label}
                      {s.pid > 0 ? ` · pid ${s.pid}` : ""}
                      {s.port > 0 ? ` · :${s.port}` : ""}
                    </span>
                    {s.source === "mcp" && (
                      <span className="block text-gray-500">
                        {s.mcpVersion ? `MCP v${s.mcpVersion}` : "MCP 版本未知"}
                      </span>
                    )}
                  </span>
                  <span className={s.status === "connected" ? "text-green-600" : "text-gray-500"}>
                    {s.status}
                  </span>
                  {s.status === "dormant" ? (
                    <button
                      className="underline"
                      onClick={() => {
                        void chrome.runtime.sendMessage({
                          type: "pairing.wake",
                          sessionId: s.sessionId
                        });
                      }}
                    >
                      重连
                    </button>
                  ) : (
                    <button
                      className="underline"
                      onClick={() => {
                        void chrome.runtime.sendMessage({
                          type: "pairing.disconnect",
                          sessionId: s.sessionId
                        });
                      }}
                    >
                      断开
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="border-t pt-3">
        <h3 className="text-sm font-medium mb-1">已信任</h3>
        {trusted.length === 0 ? (
          <p className="text-xs text-gray-500">尚未授权任何本机安装。</p>
        ) : (
          <ul className="text-xs space-y-1">
            {trusted.map((t) => (
              <li key={t.installId} className="flex items-center gap-2">
                <span className="flex-1 truncate">
                  {t.installId} · 授权于 {new Date(t.approvedAt).toLocaleDateString()}
                </span>
                <button
                  className="underline text-red-600"
                  onClick={() => {
                    void revokeTrust(t.installId).then(() => void listTrusted().then(setTrusted));
                  }}
                >
                  撤销
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-gray-500 mt-1">
          断开只结束当前连接（会话会重连）；撤销才会清除凭据，此后每个会话都要重新确认。
        </p>
      </section>

      <div className="border-t pt-3 text-xs text-gray-500">
        <div>配置: {enabled ? "已启用" : "已关闭"}</div>
        <div>
          连接状态: <span className={liveStatus.className}>{liveStatus.label}</span>
        </div>
      </div>
    </div>
  );
}
