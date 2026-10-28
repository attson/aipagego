import { useEffect, useState } from "react";
import type {
  Connector,
  ConnectorDraft,
  ConnectorDelivery,
  ConnectorSource,
  ConnectorCredentialMode,
} from "@aipagego/shared/connectors";
import { useUi } from "@/sidepanel/chat/ui-store";
import { rpc } from "@/sidepanel/rpc";
import { Drawer } from "@/sidepanel/shell/drawer";
import { ToolPackagesPane } from "./tool-packages-pane";

type Props = { access?: "sidepanel" | "forbidden" };

type FormState = {
  id?: string;
  kind: "webhook" | "feishu_base";
  name: string;
  credentialMode: ConnectorCredentialMode;
  secretAction: "keep" | "replace";
  url: string;
  headers: string;
  region: "feishu" | "lark";
  appToken: string;
  tableId: string;
  fieldMapping: string;
  appId: string;
  appSecret: string;
};

const EMPTY_FORM: FormState = {
  kind: "webhook",
  name: "",
  credentialMode: "persistent",
  secretAction: "replace",
  url: "",
  headers: "{}",
  region: "feishu",
  appToken: "",
  tableId: "",
  fieldMapping: "{}",
  appId: "",
  appSecret: "",
};

const EMPTY_BASE_FORM: FormState = { ...EMPTY_FORM, kind: "feishu_base" };

function statusLabel(connector: Connector): string {
  if (connector.status === "ready") return "可用";
  if (connector.status === "needs_credentials") return "需要凭据";
  return "需要处理";
}

export function ConnectorsDrawer({ access = "sidepanel" }: Props) {
  const opened = useUi((state) => state.openedDrawer);
  const drawerSubPath = useUi((state) => state.drawerSubPath);
  const close = useUi((state) => state.close);
  const isOpen = opened === "connectors";
  const [rows, setRows] = useState<Connector[] | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>();
  const [deliveries, setDeliveries] = useState<ConnectorDelivery[]>([]);
  const [deliveryFilter, setDeliveryFilter] = useState("all");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualConnectorId, setManualConnectorId] = useState("");
  const [manualSourceKind, setManualSourceKind] = useState<ConnectorSource["kind"]>("run");
  const [manualSourceId, setManualSourceId] = useState("");
  const [manualConfirmed, setManualConfirmed] = useState(false);
  const [unknownRetryId, setUnknownRetryId] = useState<string>();
  const [tab, setTab] = useState<"connectors" | "packages">("connectors");

  async function reload(): Promise<void> {
    setError(undefined);
    try {
      const [connectorRows, deliveryRows] = await Promise.all([
        rpc.listConnectors(), rpc.listDeliveries(),
      ]);
      setRows(connectorRows);
      setDeliveries(deliveryRows);
      setManualConnectorId((current) => current || connectorRows.find((row) => row.status === "ready" && row.credentialConfigured)?.id || "");
    } catch (cause) {
      setRows([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => {
    if (!isOpen || access === "forbidden") return;
    if (drawerSubPath === "packages") {
      setForm(undefined);
      setTab("packages");
      return;
    }
    setTab("connectors");
    void reload();
  }, [isOpen, access, drawerSubPath]);

  function edit(connector: Connector): void {
    setNotice(undefined);
    setForm({
      id: connector.id,
      kind: connector.kind,
      name: connector.name,
      credentialMode: connector.credentialMode,
      secretAction: "keep",
      url: "",
      headers: "{}",
      region: connector.publicConfig.kind === "feishu_base" ? connector.publicConfig.region : "feishu",
      appToken: connector.publicConfig.kind === "feishu_base" ? connector.publicConfig.appToken : "",
      tableId: connector.publicConfig.kind === "feishu_base" ? connector.publicConfig.tableId : "",
      fieldMapping: connector.publicConfig.kind === "feishu_base" ? JSON.stringify(connector.publicConfig.fieldMapping, null, 2) : "{}",
      appId: "",
      appSecret: "",
    });
  }

  async function save(): Promise<void> {
    if (!form) return;
    setBusy(true);
    setError(undefined);
    try {
      let draft: ConnectorDraft;
      if (form.kind === "webhook") {
        let secret: Extract<ConnectorDraft, { kind: "webhook" }>["secret"] = { action: "keep" };
        if (form.secretAction === "replace") {
        const parsed = JSON.parse(form.headers || "{}") as unknown;
        if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Webhook Headers 必须是 JSON 对象");
        }
        const entries = Object.entries(parsed);
        if (entries.some(([key, value]) => typeof key !== "string" || typeof value !== "string")) {
          throw new Error("Header 名称和值必须是字符串");
        }
        secret = {
          action: "replace",
          url: form.url,
          headers: Object.fromEntries(entries) as Record<string, string>,
        };
        }
        draft = { name: form.name, kind: "webhook", credentialMode: form.credentialMode, secret };
      } else {
        const mapping = JSON.parse(form.fieldMapping || "{}") as unknown;
        if (mapping == null || typeof mapping !== "object" || Array.isArray(mapping)
          || Object.values(mapping).some((value) => typeof value !== "string")) {
          throw new Error("字段映射必须是字符串到字符串的 JSON 对象");
        }
        const secret: Extract<ConnectorDraft, { kind: "feishu_base" }>["secret"] = form.secretAction === "keep"
          ? { action: "keep" }
          : { action: "replace", appId: form.appId, appSecret: form.appSecret };
        draft = {
          name: form.name,
          kind: "feishu_base",
          credentialMode: form.credentialMode,
          publicConfig: {
            region: form.region,
            appToken: form.appToken,
            tableId: form.tableId,
            fieldMapping: mapping as Record<string, string>,
          },
          secret,
        };
      }
      await rpc.saveConnector(draft, form.id);
      setForm(undefined);
      setNotice("连接器已保存");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function testConnector(id: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await rpc.testConnector(id);
      setNotice("连接成功");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await rpc.deleteConnector(id);
      setNotice("连接器已删除");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createManualDelivery(): Promise<void> {
    if (!manualConfirmed) { setError("请先确认数据将离开浏览器"); return; }
    setBusy(true); setError(undefined);
    try {
      const source: ConnectorSource = manualSourceKind === "collection_result"
        ? { kind: "collection_result", resultId: manualSourceId }
        : manualSourceKind === "run"
          ? { kind: "run", runId: manualSourceId }
          : { kind: "job_run", jobRunId: manualSourceId };
      await rpc.createDelivery(manualConnectorId, source);
      setManualOpen(false); setManualConfirmed(false); setManualSourceId("");
      setNotice("发送已完成；网页工具未重新运行");
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function retryDelivery(delivery: ConnectorDelivery, confirmUnknownCommit = false): Promise<void> {
    if (delivery.status === "unknown_commit" && !confirmUnknownCommit) {
      setUnknownRetryId(delivery.id); return;
    }
    setBusy(true); setError(undefined);
    try {
      await rpc.retryDelivery(delivery.id, confirmUnknownCommit);
      setUnknownRetryId(undefined); setNotice("仅重试了发送，未重新运行网页工具"); await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  let content: React.ReactNode;
  if (access === "forbidden") {
    content = (
      <div data-state="forbidden" className="m-3 rounded border border-amber-800 bg-amber-950/30 p-3 text-xs text-amber-200">
        凭据只能在原生 sidepanel 中管理。请打开扩展侧栏后继续。
      </div>
    );
  } else if (rows === null) {
    content = <div data-state="loading" className="p-4 text-xs text-zinc-500">正在加载连接器…</div>;
  } else if (error) {
    content = (
      <div data-state="error" className="m-3 rounded border border-red-900 p-3 text-xs text-red-300">
        <div>{error}</div>
        <button type="button" onClick={() => void reload()} className="mt-2 underline">重试</button>
      </div>
    );
  } else if (form) {
    content = (
      <form data-state="default" className="space-y-3 p-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="text-sm font-medium text-zinc-100">
          {form.id ? "编辑" : "新建"}{form.kind === "webhook" ? " Webhook" : " 飞书/Lark Base"}
        </div>
        <label className="block text-xs text-zinc-400">名称
          <input aria-label="连接器名称" value={form.name} maxLength={120}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100" />
        </label>
        <label className="block text-xs text-zinc-400">凭据生命周期
          <select aria-label="凭据生命周期" value={form.credentialMode}
            onChange={(event) => setForm({ ...form, credentialMode: event.target.value as ConnectorCredentialMode })}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100">
            <option value="persistent">持久（可用于持续任务）</option>
            <option value="session">仅本次浏览器会话</option>
          </select>
        </label>
        {form.id ? (
          <div className="flex gap-2 text-xs">
            <button type="button" onClick={() => setForm({ ...form, secretAction: "keep", url: "", headers: "{}", appId: "", appSecret: "" })}
              className={form.secretAction === "keep" ? "rounded bg-zinc-700 px-2 py-1 text-zinc-100" : "rounded px-2 py-1 text-zinc-400"}>
              保持现有凭据
            </button>
            <button type="button" onClick={() => setForm({ ...form, secretAction: "replace" })}
              className={form.secretAction === "replace" ? "rounded bg-zinc-700 px-2 py-1 text-zinc-100" : "rounded px-2 py-1 text-zinc-400"}>
              替换凭据
            </button>
          </div>
        ) : null}
        {form.kind === "webhook" ? <>
        <label className="block text-xs text-zinc-400">Webhook URL（保存后不回显）
          <input aria-label="Webhook URL" type="password" autoComplete="off" value={form.url}
            disabled={form.secretAction === "keep"}
            onChange={(event) => setForm({ ...form, url: event.target.value })}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100 disabled:opacity-50" />
        </label>
        </> : <>
        <label className="block text-xs text-zinc-400">区域
          <select aria-label="区域" value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value as "feishu" | "lark" })}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100">
            <option value="feishu">飞书</option><option value="lark">Lark</option>
          </select>
        </label>
        <label className="block text-xs text-zinc-400">App Token
          <input aria-label="App Token" value={form.appToken} onChange={(event) => setForm({ ...form, appToken: event.target.value })}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100" />
        </label>
        <label className="block text-xs text-zinc-400">Table ID
          <input aria-label="Table ID" value={form.tableId} onChange={(event) => setForm({ ...form, tableId: event.target.value })}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100" />
        </label>
        <label className="block text-xs text-zinc-400">字段映射 JSON
          <textarea aria-label="字段映射" value={form.fieldMapping} onChange={(event) => setForm({ ...form, fieldMapping: event.target.value })}
            className="mt-1 min-h-20 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-100" />
        </label>
        <label className="block text-xs text-zinc-400">App ID（保存后不回显）
          <input aria-label="App ID" type="password" autoComplete="off" value={form.appId} disabled={form.secretAction === "keep"}
            onChange={(event) => setForm({ ...form, appId: event.target.value })}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100 disabled:opacity-50" />
        </label>
        <label className="block text-xs text-zinc-400">App Secret（保存后不回显）
          <input aria-label="App Secret" type="password" autoComplete="off" value={form.appSecret} disabled={form.secretAction === "keep"}
            onChange={(event) => setForm({ ...form, appSecret: event.target.value })}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100 disabled:opacity-50" />
        </label>
        </>}
        <label className="block text-xs text-zinc-400">Headers JSON（名称和值都不回显）
          <textarea aria-label="Webhook Headers" value={form.headers} autoComplete="off"
            disabled={form.secretAction === "keep"}
            onChange={(event) => setForm({ ...form, headers: event.target.value })}
            className="mt-1 min-h-20 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-100 disabled:opacity-50" />
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white">保存</button>
          <button type="button" onClick={() => setForm(undefined)} className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300">取消</button>
        </div>
      </form>
    );
  } else if (rows.length === 0) {
    content = (
      <div data-state="empty" className="p-4 text-center text-xs text-zinc-500">
        <p>还没有连接器</p>
        <div className="mt-3 flex justify-center gap-2">
          <button type="button" onClick={() => setForm({ ...EMPTY_FORM })} className="rounded bg-blue-600 px-3 py-1.5 text-white">新建 Webhook</button>
          <button type="button" onClick={() => setForm({ ...EMPTY_BASE_FORM })} className="rounded border border-zinc-700 px-3 py-1.5 text-zinc-300">新建飞书/Lark Base</button>
        </div>
      </div>
    );
  } else {
    const large = rows.length > 200;
    content = (
      <div data-state={large ? "large" : "default"} className="space-y-2 p-3">
        {large ? <div className="rounded bg-amber-950/30 p-2 text-xs text-amber-300">连接器较多，仅展示前 200 项。</div> : null}
        {rows.slice(0, 200).map((connector) => (
          <section key={connector.id} className="rounded border border-zinc-800 bg-zinc-900 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate text-sm text-zinc-100">{connector.name}</h3>
                <div className="truncate text-xs text-zinc-500">{connector.publicConfig.kind === "webhook"
                  ? connector.publicConfig.endpointOrigin
                  : `${connector.publicConfig.region === "feishu" ? "飞书" : "Lark"} · ${connector.publicConfig.appToken} / ${connector.publicConfig.tableId}`}</div>
              </div>
              <span className="text-[11px] text-zinc-400">{statusLabel(connector)}</span>
            </div>
            <div className="mt-2 text-[11px] text-zinc-500">
              {connector.credentialMode === "persistent" ? "持久凭据" : "会话凭据"} · {connector.publicConfig.kind === "webhook" ? `${connector.publicConfig.headerCount} 个 Header` : ""}
            </div>
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={busy || !connector.credentialConfigured} onClick={() => void testConnector(connector.id)} className="text-xs text-blue-400">测试</button>
              <button type="button" disabled={busy} onClick={() => edit(connector)} className="text-xs text-zinc-300">编辑</button>
              <button type="button" disabled={busy} onClick={() => void remove(connector.id)} className="text-xs text-red-400">删除</button>
            </div>
          </section>
        ))}
      </div>
    );
  }

  return (
    <Drawer open={isOpen} title="连接与安全分享" onClose={close}>
      <div className="flex border-b border-zinc-800 px-3 text-xs">
        <button type="button" onClick={() => { setTab("connectors"); if (rows === null) void reload(); }} className={tab === "connectors" ? "border-b-2 border-blue-500 px-3 py-2 text-zinc-100" : "px-3 py-2 text-zinc-400"}>连接器</button>
        <button type="button" disabled={access !== "sidepanel"} onClick={() => { setForm(undefined); setTab("packages"); }} className={tab === "packages" ? "border-b-2 border-blue-500 px-3 py-2 text-zinc-100" : "px-3 py-2 text-zinc-400 disabled:text-zinc-700"}>安全工具包</button>
        {tab === "connectors" && !form && access === "sidepanel" ? <div className="ml-auto flex gap-2">
          <button type="button" onClick={() => setForm({ ...EMPTY_FORM })} className="text-blue-400">Webhook</button>
          <button type="button" onClick={() => setForm({ ...EMPTY_BASE_FORM })} className="text-blue-400">飞书 Base</button>
        </div> : null}
      </div>
      {tab === "connectors" && notice ? <div className="mx-3 mt-3 rounded bg-emerald-950/40 p-2 text-xs text-emerald-300">{notice}</div> : null}
      {tab === "packages" && access === "sidepanel" ? <ToolPackagesPane /> : content}
      {tab === "connectors" && !form && access === "sidepanel" && rows !== null && !error ? (
        <div className="space-y-3 border-t border-zinc-800 p-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-zinc-100">发送历史</div>
            <button type="button" onClick={() => setManualOpen((value) => !value)} className="text-xs text-blue-400">发送已有结果</button>
          </div>
          {manualOpen ? <div className="space-y-2 rounded border border-zinc-800 p-2 text-xs">
            <select aria-label="发送连接器" value={manualConnectorId} onChange={(event) => { setManualConnectorId(event.target.value); setManualConfirmed(false); }} className="w-full rounded bg-zinc-900 p-1">
              {(rows ?? []).filter((row) => row.status === "ready" && row.credentialConfigured).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
            <select aria-label="来源类型" value={manualSourceKind} onChange={(event) => { setManualSourceKind(event.target.value as ConnectorSource["kind"]); setManualConfirmed(false); }} className="w-full rounded bg-zinc-900 p-1">
              <option value="collection_result">Collection resultId</option><option value="run">RunRecord</option><option value="job_run">JobRun</option>
            </select>
            <input aria-label="来源 ID" value={manualSourceId} onChange={(event) => { setManualSourceId(event.target.value); setManualConfirmed(false); }} placeholder="输入本地 source ID" className="w-full rounded bg-zinc-900 p-1" />
            <label className="flex gap-2 text-amber-200"><input type="checkbox" checked={manualConfirmed} onChange={(event) => setManualConfirmed(event.target.checked)} />我确认此结果将发送到所选外部目标</label>
            <button type="button" disabled={busy || !manualConnectorId || !manualSourceId} onClick={() => void createManualDelivery()} className="rounded bg-blue-600 px-2 py-1 text-white disabled:opacity-40">确认发送</button>
          </div> : null}
          <select aria-label="发送状态筛选" value={deliveryFilter} onChange={(event) => setDeliveryFilter(event.target.value)} className="rounded bg-zinc-900 p-1 text-xs">
            <option value="all">全部状态</option>{["ok", "error", "partial", "unknown_commit", "running", "queued"].map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
          <div className="space-y-2">
            {deliveries.filter((item) => deliveryFilter === "all" || item.status === deliveryFilter).map((delivery) => (
              <div key={delivery.id} className="rounded border border-zinc-800 p-2 text-[11px] text-zinc-400">
                <div className="flex justify-between"><span>{delivery.source.kind} · {delivery.status}</span><span>{new Date(delivery.createdAt).toLocaleString()}</span></div>
                <div>attempt {delivery.attempt} · sent {delivery.sentCount ?? 0} · offset {delivery.nextOffset}{delivery.errorCode ? ` · ${delivery.errorCode}` : ""}</div>
                {(delivery.status === "error" || delivery.status === "partial" || delivery.status === "unknown_commit") ? (
                  unknownRetryId === delivery.id
                    ? <button type="button" onClick={() => void retryDelivery(delivery, true)} className="mt-1 text-amber-300">确认可能重复并重试</button>
                    : <button type="button" onClick={() => void retryDelivery(delivery)} className="mt-1 text-blue-400">仅重试发送</button>
                ) : null}
              </div>
            ))}
            {deliveries.length === 0 ? <div className="text-xs text-zinc-600">还没有发送记录</div> : null}
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
