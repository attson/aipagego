import { useEffect, useMemo, useState } from "react";
import type { Job, JobDraft, JobRun } from "@aipagego/shared/jobs";
import type { Connector, ConnectorDelivery } from "@aipagego/shared/connectors";
import type { Json, Tool } from "@aipagego/shared/types";
import { hasOptionalPermission, requestOptionalPermission } from "@/permissions/optional-permissions";
import { useUi } from "@/sidepanel/chat/ui-store";
import { currentTabInfo, rpc } from "@/sidepanel/rpc";
import { Drawer } from "@/sidepanel/shell/drawer";
import { classifyJobWorkflow } from "@/background/jobs/safety";

type JobItem = Job & { upgradeAvailable?: number };
type TriggerKind = "manual" | "interval" | "daily" | "page_change";

function triggerLabel(job: Job): string {
  if (job.trigger.kind === "manual") return "手动";
  if (job.trigger.kind === "page_change") return `变化 · ${job.trigger.everyMinutes} 分钟`;
  return job.trigger.schedule.kind === "interval"
    ? `每 ${job.trigger.schedule.everyMinutes} 分钟`
    : `${job.trigger.schedule.localTime} 定时`;
}

function safeDisplayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.slice(0, 100);
  } catch {
    return raw.slice(0, 100);
  }
}

function connectorTarget(connector: Connector): string {
  if (connector.publicConfig.kind === "webhook") return connector.publicConfig.endpointOrigin;
  return `${connector.publicConfig.region} · ${connector.publicConfig.appToken}/${connector.publicConfig.tableId}`;
}

export function JobsDrawer() {
  const opened = useUi((state) => state.openedDrawer);
  const handoffToolId = useUi((state) => state.drawerSubPath);
  const close = useUi((state) => state.close);
  const isOpen = opened === "jobs";
  const [jobs, setJobs] = useState<JobItem[] | null>(null);
  const [tools, setTools] = useState<Array<Extract<Tool, { kind: "steps" }>>>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [deliveries, setDeliveries] = useState<ConnectorDelivery[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [triggerFilter, setTriggerFilter] = useState("all");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [cautionPending, setCautionPending] = useState<JobDraft>();
  const [dangerPending, setDangerPending] = useState<JobItem>();
  const [upgradePending, setUpgradePending] = useState<number>();
  const [runtimeInputs, setRuntimeInputs] = useState<Record<string, string>>({});
  const [notificationGranted, setNotificationGranted] = useState<boolean | null>(null);
  const [capturePending, setCapturePending] = useState(false);
  const [unknownRetryId, setUnknownRetryId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [form, setForm] = useState({
    toolId: "", toolVersion: 0, name: "", targetUrl: "", trigger: "manual" as TriggerKind,
    everyMinutes: "15", localTime: "09:00", days: [1, 2, 3, 4, 5], selector: "",
    maxAttempts: "3", inputs: {} as Record<string, string>,
    onChange: true, onSuccess: false, onFailure: true,
    connectorIds: [] as string[],
  });

  const selected = jobs?.find((job) => job.id === selectedId);
  const selectedTool = tools.find((tool) => tool.id === form.toolId);
  const selectedSnapshot = selectedTool?.versions.find((version) => version.version === form.toolVersion);
  const readyConnectors = connectors.filter((connector) =>
    connector.credentialMode === "persistent" &&
    connector.credentialConfigured &&
    connector.status === "ready");
  const visible = useMemo(() => (jobs ?? []).filter((job) => {
    const textMatch = `${job.name} ${job.toolId}`.toLowerCase().includes(query.toLowerCase());
    const statusMatch = statusFilter === "all" || job.status === statusFilter;
    const kind = job.trigger.kind === "schedule" ? "schedule" : job.trigger.kind;
    return textMatch && statusMatch && (triggerFilter === "all" || kind === triggerFilter);
  }), [jobs, query, statusFilter, triggerFilter]);

  async function reload(preselect?: string) {
    setError(undefined);
    try {
      const [jobRows, toolRows, connectorRows, deliveryRows, permission] = await Promise.all([
        rpc.listJobs(), rpc.listTools(), rpc.listConnectors(), rpc.listDeliveries(),
        hasOptionalPermission("notifications"),
      ]);
      setJobs(jobRows);
      setTools(toolRows.filter((tool): tool is Extract<Tool, { kind: "steps" }> => tool.kind === "steps"));
      setConnectors(connectorRows);
      setDeliveries(deliveryRows);
      setNotificationGranted(permission);
      const requested = preselect ?? handoffToolId;
      const next = (requested && jobRows.some((job) => job.id === requested))
        ? requested
        : selectedId ?? jobRows[0]?.id;
      setSelectedId(next);
      if (next) setRuns((await rpc.listJobRuns(next, undefined, 50)).items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setJobs([]);
    }
  }

  useEffect(() => {
    if (!isOpen) return;
    void reload();
  }, [isOpen]);

  useEffect(() => {
    setCautionPending(undefined);
  }, [form]);

  useEffect(() => {
    setDangerPending(undefined);
    setUpgradePending(undefined);
    setRuntimeInputs({});
  }, [selectedId]);

  useEffect(() => {
    const listener = (message: unknown) => {
      const open = message as { type?: string; jobId?: string };
      if (open.type !== "jobs.open" || !open.jobId) return;
      useUi.getState().open("jobs", open.jobId);
      setSelectedId(open.jobId);
      void rpc.listJobRuns(open.jobId, undefined, 50)
        .then((page) => setRuns(page.items))
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const listener = (message: unknown) => {
      const capture = message as { type?: string; selector?: string };
      if (!capturePending || capture.type !== "aipagego.captureResult" || !capture.selector) return;
      setForm((current) => ({ ...current, selector: capture.selector! }));
      setCapturePending(false);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [isOpen, capturePending]);

  useEffect(() => {
    if (!isOpen || !handoffToolId || tools.length === 0) return;
    const tool = tools.find((candidate) => candidate.id === handoffToolId);
    if (!tool) return;
    void currentTabInfo().then(({ url }) => {
      setForm((current) => ({ ...current, toolId: tool.id, toolVersion: tool.activeVersion, name: `${tool.name} Job`, targetUrl: url }));
      setEditingId(undefined);
      setEditing(true);
    }).catch(() => {
      setForm((current) => ({ ...current, toolId: tool.id, toolVersion: tool.activeVersion, name: `${tool.name} Job` }));
      setEditingId(undefined);
      setEditing(true);
    });
  }, [isOpen, handoffToolId, tools]);

  function draftFromForm(): JobDraft {
    if (!selectedTool || !selectedSnapshot) throw new Error("请选择有效的 steps 工具版本");
    const snapshot = selectedSnapshot;
    const inputs: Record<string, Json> = {};
    for (const parameter of snapshot.parameters) {
      if (parameter.sensitive) continue;
      const raw = form.inputs[parameter.key] ?? "";
      if (!raw && !parameter.required) continue;
      inputs[parameter.key] = parameter.type === "number"
        ? Number(raw)
        : parameter.type === "boolean" ? raw === "true" : raw;
    }
    const trigger: JobDraft["trigger"] = form.trigger === "manual"
      ? { kind: "manual" }
      : form.trigger === "page_change"
        ? { kind: "page_change", everyMinutes: Number(form.everyMinutes), watch: { selector: form.selector } }
        : form.trigger === "daily"
          ? { kind: "schedule", schedule: { kind: "daily", localTime: form.localTime, daysOfWeek: form.days } }
          : { kind: "schedule", schedule: { kind: "interval", everyMinutes: Number(form.everyMinutes) } };
    return {
      name: form.name,
      toolId: selectedTool.id,
      toolVersion: snapshot.version,
      targetUrl: form.targetUrl,
      inputs,
      trigger,
      retry: { maxAttempts: Number(form.maxAttempts), backoffMinutes: [1, 5].slice(0, Number(form.maxAttempts) - 1) },
      notifications: { onChange: form.onChange, onSuccess: form.onSuccess, onFailure: form.onFailure },
      connectorBindings: form.connectorIds.map((connectorId) => {
        const connector = readyConnectors.find((candidate) => candidate.id === connectorId);
        if (!connector) throw new Error("所选连接器已不可用，请重新选择");
        return { connectorId, connectorConfigHash: connector.configHash };
      }),
    };
  }

  const formSeverity = useMemo(() => {
    if (!selectedTool || !selectedSnapshot) return undefined;
    try {
      const draft = draftFromForm();
      return classifyJobWorkflow(selectedSnapshot, draft.inputs);
    } catch {
      return undefined;
    }
  }, [selectedTool, selectedSnapshot, form.inputs, form.connectorIds, connectors]);

  async function save(acknowledgeCaution = false) {
    setBusy(true);
    setError(undefined);
    let attemptedDraft: JobDraft | undefined;
    try {
      let draft = cautionPending ?? draftFromForm();
      if ((draft.notifications.onChange || draft.notifications.onSuccess || draft.notifications.onFailure) && !notificationGranted) {
        const permission = await requestOptionalPermission("notifications");
        setNotificationGranted(permission.granted);
        if (!permission.granted) {
          const notifications = { onChange: false, onSuccess: false, onFailure: false };
          draft = { ...draft, notifications };
          setForm((current) => ({ ...current, ...notifications }));
        }
      }
      attemptedDraft = draft;
      const saved = await rpc.saveJob(draft, {
        ...(editingId == null ? {} : { id: editingId }),
        acknowledgeCaution,
      });
      setCautionPending(undefined);
      setEditing(false);
      setEditingId(undefined);
      await reload(saved.id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("caution_acknowledgement_required")) {
        setCautionPending(attemptedDraft ?? draftFromForm());
      }
      else setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function mutate(action: () => Promise<unknown>) {
    setBusy(true); setError(undefined);
    try { await action(); await reload(selectedId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function reviewUpgrade(version: number) {
    if (!selected) return;
    setBusy(true); setError(undefined);
    try {
      await rpc.upgradeJob(selected.id, version, false);
      setUpgradePending(undefined);
      await reload(selected.id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("caution_acknowledgement_required")) setUpgradePending(version);
      else { setUpgradePending(undefined); setError(message); }
    } finally { setBusy(false); }
  }

  async function runNow(approve = false) {
    if (!selected) return;
    setBusy(true); setError(undefined);
    try {
      const tool = tools.find((candidate) => candidate.id === selected.toolId);
      const snapshot = tool?.versions.find((version) => version.version === selected.toolVersion);
      const inputs: Record<string, Json> = {};
      for (const parameter of snapshot?.parameters ?? []) {
        if (!parameter.sensitive) continue;
        const raw = runtimeInputs[parameter.key] ?? "";
        if (raw) inputs[parameter.key] = parameter.type === "number" ? Number(raw) : parameter.type === "boolean" ? raw === "true" : raw;
      }
      await rpc.runJobNow(selected.id, { inputs, approveDangerousOnce: approve });
      setDangerPending(undefined);
      await reload(selected.id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("dangerous_approval_required")) setDangerPending(selected);
      else setError(message);
    } finally { setBusy(false); }
  }

  async function retryDelivery(delivery: ConnectorDelivery, confirmUnknownCommit = false) {
    if (delivery.status === "unknown_commit" && !confirmUnknownCommit) {
      setUnknownRetryId(delivery.id);
      return;
    }
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await rpc.retryDelivery(delivery.id, confirmUnknownCommit);
      setUnknownRetryId(undefined);
      setNotice("仅重试了发送，未重新运行网页工具；确认全部送达后请显式恢复 Job");
      await reload(selectedId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function beginCreate() {
    const tool = tools[0];
    setForm({
      toolId: tool?.id ?? "", toolVersion: tool?.activeVersion ?? 0, name: tool ? `${tool.name} Job` : "", targetUrl: "",
      trigger: "manual", everyMinutes: "15", localTime: "09:00", days: [1, 2, 3, 4, 5],
      selector: "", maxAttempts: "3", inputs: {}, onChange: true, onSuccess: false, onFailure: true,
      connectorIds: [],
    });
    setEditingId(undefined);
    setEditing(true);
  }

  function beginEdit(job: JobItem) {
    const trigger: TriggerKind = job.trigger.kind === "manual"
      ? "manual"
      : job.trigger.kind === "page_change"
        ? "page_change"
        : job.trigger.schedule.kind === "daily" ? "daily" : "interval";
    const everyMinutes = job.trigger.kind === "page_change"
      ? job.trigger.everyMinutes
      : job.trigger.kind === "schedule" && job.trigger.schedule.kind === "interval"
        ? job.trigger.schedule.everyMinutes
        : 15;
    const localTime = job.trigger.kind === "schedule" && job.trigger.schedule.kind === "daily"
      ? job.trigger.schedule.localTime
      : "09:00";
    const days = job.trigger.kind === "schedule" && job.trigger.schedule.kind === "daily"
      ? job.trigger.schedule.daysOfWeek
      : [1, 2, 3, 4, 5];
    const selector = job.trigger.kind === "page_change" ? job.trigger.watch.selector : "";
    setForm({
      toolId: job.toolId,
      toolVersion: job.toolVersion,
      name: job.name,
      targetUrl: job.targetUrl,
      trigger,
      everyMinutes: String(everyMinutes),
      localTime,
      days,
      selector,
      maxAttempts: String(job.retry.maxAttempts),
      inputs: Object.fromEntries(Object.entries(job.inputs).map(([key, value]) => [key, String(value ?? "")])),
      onChange: job.notifications.onChange,
      onSuccess: job.notifications.onSuccess,
      onFailure: job.notifications.onFailure,
      connectorIds: job.connectorBindings.map((binding) => binding.connectorId),
    });
    setEditingId(job.id);
    setEditing(true);
  }

  return (
    <Drawer open={isOpen} title="Jobs 与监控" onClose={close}>
      <div className="h-full overflow-auto p-3 text-xs" data-testid="jobs-drawer" data-state={error ? "error" : jobs == null ? "loading" : jobs.length === 0 ? "empty" : jobs.length > 200 ? "large" : notificationGranted === false ? "forbidden" : "default"}>
        <div className="mb-3 rounded border border-amber-900/50 bg-amber-950/20 p-2 text-amber-200">
          本地 Job 仅在 Chrome 运行且扩展启用时工作。Coordinator/MCP 也要求浏览器在线并已配对。
        </div>
        <div className="flex gap-2 mb-3">
          <input aria-label="搜索 Job" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索" className="min-w-0 flex-1 rounded bg-zinc-800 px-2 py-1" />
          <select aria-label="状态筛选" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded bg-zinc-800"><option value="all">全部状态</option><option value="active">运行中</option><option value="paused">已暂停</option><option value="needs_attention">需处理</option></select>
          <select aria-label="触发筛选" value={triggerFilter} onChange={(e) => setTriggerFilter(e.target.value)} className="rounded bg-zinc-800"><option value="all">全部触发</option><option value="manual">手动</option><option value="schedule">定时</option><option value="page_change">网页变化</option></select>
          <button onClick={beginCreate} className="rounded bg-violet-700 px-2">新建</button>
        </div>
        {jobs == null && <div>加载中…</div>}
        {error && <div role="alert" className="mb-2 text-rose-300">{error}</div>}
        {notice && <div role="status" className="mb-2 text-emerald-300">{notice}</div>}
        {jobs?.length === 0 && !editing && <div className="rounded bg-zinc-900 p-6 text-center text-zinc-400">还没有 Job。请从 steps 工具创建。</div>}
        {notificationGranted === false && <div className="mb-2 rounded bg-zinc-900 p-2 text-amber-300">通知未开启；Job 仍会正常运行，保存时可再次授权。</div>}

        {editing ? (
          <section className="space-y-2 rounded bg-zinc-900 p-3">
            <h3 className="font-medium">{editingId ? "编辑 Job" : "创建 Job"}</h3>
            <label className="block">工具<select aria-label="Job 工具" disabled={editingId != null} value={form.toolId} onChange={(e) => {
              const tool = tools.find((candidate) => candidate.id === e.target.value);
              setForm({ ...form, toolId: e.target.value, toolVersion: tool?.activeVersion ?? 0, inputs: {} });
            }} className="ml-2 bg-zinc-800">{tools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name} · active v{tool.activeVersion}</option>)}</select></label>
            {selectedSnapshot && <div className="text-zinc-400">固定 v{selectedSnapshot.version}</div>}
            <label className="block">名称<input aria-label="Job 名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="ml-2 bg-zinc-800 px-1" /></label>
            <label className="block">目标 URL<input aria-label="目标 URL" value={form.targetUrl} onChange={(e) => setForm({ ...form, targetUrl: e.target.value })} className="ml-2 w-3/4 bg-zinc-800 px-1" /></label>
            {selectedSnapshot?.parameters.filter((p) => !p.sensitive).map((parameter) => <label className="block" key={parameter.key}>{parameter.label}<input value={form.inputs[parameter.key] ?? ""} onChange={(e) => setForm({ ...form, inputs: { ...form.inputs, [parameter.key]: e.target.value } })} className="ml-2 bg-zinc-800 px-1" /></label>)}
            <label className="block">触发<select aria-label="Job 触发" value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value as TriggerKind })} className="ml-2 bg-zinc-800"><option value="manual">手动</option><option value="interval" disabled={formSeverity === "dangerous"}>间隔</option><option value="daily" disabled={formSeverity === "dangerous"}>每天/每周</option><option value="page_change" disabled={formSeverity === "dangerous"}>网页变化</option></select></label>
            {formSeverity === "dangerous" && <div className="text-rose-300">该版本含 dangerous/无法判定操作，只能保存为手动 Job，且每次运行都需批准。</div>}
            {(form.trigger === "interval" || form.trigger === "page_change") && <label className="block">间隔分钟<input aria-label="间隔分钟" type="number" min={form.trigger === "page_change" ? 5 : 1} value={form.everyMinutes} onChange={(e) => setForm({ ...form, everyMinutes: e.target.value })} className="ml-2 w-20 bg-zinc-800" /></label>}
            {form.trigger === "daily" && <div><label className="block">本地时间<input aria-label="本地时间" type="time" value={form.localTime} onChange={(e) => setForm({ ...form, localTime: e.target.value })} className="ml-2 bg-zinc-800" /></label><div className="mt-1 flex gap-1">{[0, 1, 2, 3, 4, 5, 6].map((day) => <label key={day}><input type="checkbox" checked={form.days.includes(day)} onChange={(e) => setForm({ ...form, days: e.target.checked ? [...form.days, day].sort() : form.days.filter((value) => value !== day) })} />{["日", "一", "二", "三", "四", "五", "六"][day]}</label>)}</div></div>}
            {form.trigger === "page_change" && <label className="block">唯一 selector<input aria-label="监控 selector" value={form.selector} onChange={(e) => setForm({ ...form, selector: e.target.value })} className="ml-2 bg-zinc-800 px-1" /><button type="button" className="ml-2 bg-zinc-700 px-2 py-1" onClick={() => { setCapturePending(true); void currentTabInfo().then(({ tabId }) => rpc.startElementCapture(tabId)).catch((cause) => { setCapturePending(false); setError(cause instanceof Error ? cause.message : String(cause)); }); }}>{capturePending ? "请在页面点选…" : "圈选"}</button></label>}
            <label className="block">最多尝试<select value={form.maxAttempts} onChange={(e) => setForm({ ...form, maxAttempts: e.target.value })} className="ml-2 bg-zinc-800"><option>1</option><option>2</option><option>3</option></select>（退避 1/5 分钟）</label>
            <div className="flex gap-3"><label><input type="checkbox" checked={form.onChange} onChange={(e) => setForm({ ...form, onChange: e.target.checked })} />变化通知</label><label><input type="checkbox" checked={form.onSuccess} onChange={(e) => setForm({ ...form, onSuccess: e.target.checked })} />成功通知</label><label><input type="checkbox" checked={form.onFailure} onChange={(e) => setForm({ ...form, onFailure: e.target.checked })} />失败通知</label></div>
            <fieldset className="rounded border border-zinc-700 p-2">
              <legend className="px-1 text-zinc-300">自动发送 destinations（最多 5 个）</legend>
              {readyConnectors.length === 0
                ? <div className="text-zinc-500">暂无可用于持续任务的 persistent + ready 连接器</div>
                : readyConnectors.map((connector) => <label key={connector.id} className="block py-1">
                  <input
                    type="checkbox"
                    aria-label={`发送到 ${connector.name}`}
                    checked={form.connectorIds.includes(connector.id)}
                    disabled={!form.connectorIds.includes(connector.id) && form.connectorIds.length >= 5}
                    onChange={(event) => setForm({
                      ...form,
                      connectorIds: event.target.checked
                        ? [...form.connectorIds, connector.id]
                        : form.connectorIds.filter((id) => id !== connector.id),
                    })}
                  />
                  <span className="ml-1">{connector.name}</span>
                  <span className="ml-1 text-zinc-500">{connectorTarget(connector)}</span>
                </label>)}
            </fieldset>
            {cautionPending && <div className="rounded border border-amber-700 p-2">{cautionPending.connectorBindings.length > 0 ? "该 Job 成功后会自动发送到外部服务；请确认 destinations、固定版本与参数。" : "该工作流含 caution 操作。确认固定版本与参数后允许后台执行。"}<button onClick={() => void save(true)} className="ml-2 bg-amber-700 px-2 py-1">确认并保存</button></div>}
            <div className="flex gap-2"><button disabled={busy} onClick={() => void save()} className="rounded bg-emerald-700 px-3 py-1">保存</button><button onClick={() => { setEditing(false); setEditingId(undefined); }}>取消</button></div>
          </section>
        ) : (
          <div className="grid grid-cols-1 gap-3 min-[620px]:grid-cols-[minmax(180px,0.8fr)_minmax(260px,1.2fr)]">
            <ul className="space-y-1">{visible.slice(0, 200).map((job) => <li key={job.id}><button onClick={() => { setSelectedId(job.id); void rpc.listJobRuns(job.id).then((page) => setRuns(page.items)); }} className={`w-full rounded p-2 text-left ${selectedId === job.id ? "bg-violet-950" : "bg-zinc-900"}`}><div>{job.name}</div><div className="text-zinc-500">{triggerLabel(job)} · {job.status}</div></button></li>)}</ul>
            {selected && <section className="space-y-2 rounded bg-zinc-900 p-3">
              <div className="flex items-center justify-between"><h3 className="font-medium">{selected.name}</h3><span>{selected.status}</span></div>
              <div>固定 v{selected.toolVersion}{selected.upgradeAvailable ? ` · active v${selected.upgradeAvailable}` : " · 已是 active"}</div>
              <div title={selected.targetUrl}>{safeDisplayUrl(selected.targetUrl)}</div>
              {selected.connectorBindings.length > 0 && <div>Destinations：{selected.connectorBindings.map((binding) => connectors.find((connector) => connector.id === binding.connectorId)?.name ?? "已失效连接器").join("、")}</div>}
              {(() => {
                const tool = tools.find((candidate) => candidate.id === selected.toolId);
                const snapshot = tool?.versions.find((version) => version.version === selected.toolVersion);
                return snapshot?.parameters.filter((parameter) => parameter.sensitive).map((parameter) => <label className="block" key={parameter.key}>本次 {parameter.label}<input type="password" value={runtimeInputs[parameter.key] ?? ""} onChange={(e) => setRuntimeInputs({ ...runtimeInputs, [parameter.key]: e.target.value })} className="ml-2 bg-zinc-800 px-1" /></label>);
              })()}
              <div className="flex flex-wrap gap-2"><button disabled={busy} onClick={() => void runNow()} className="bg-emerald-700 px-2 py-1">立即运行</button><button disabled={busy} onClick={() => beginEdit(selected)}>编辑</button>{selected.status !== "active" ? <button onClick={() => void mutate(() => rpc.resumeJob(selected.id))}>恢复</button> : <button onClick={() => void mutate(() => rpc.pauseJob(selected.id))}>暂停</button>}{selected.upgradeAvailable && <button onClick={() => void reviewUpgrade(selected.upgradeAvailable!)} className="bg-sky-700 px-2 py-1">审核升级到 v{selected.upgradeAvailable}</button>}<button onClick={() => { if (window.confirm("删除 Job 及其历史？不会删除工具。")) void mutate(() => rpc.deleteJob(selected.id)); }} className="text-rose-300">删除</button></div>
              {upgradePending && <div className="rounded border border-amber-700 p-2">新版本需要 caution 确认。<button onClick={() => void mutate(() => rpc.upgradeJob(selected.id, upgradePending, true).then((value) => { setUpgradePending(undefined); return value; }))} className="ml-2 bg-amber-700 px-2 py-1">确认升级</button></div>}
              {dangerPending && <div className="rounded border border-rose-700 p-2">此手动 Job 含 dangerous 操作，本次是否批准？<button onClick={() => void runNow(true)} className="ml-2 bg-rose-700 px-2 py-1">仅批准本次</button><button onClick={() => setDangerPending(undefined)} className="ml-2">拒绝</button></div>}
              <h4 className="pt-2 text-zinc-300">运行历史</h4>
              <ul className="space-y-2">{runs.map((run) => {
                const runDeliveries = deliveries.filter((delivery) =>
                  delivery.source.kind === "job_run" && delivery.source.jobRunId === run.id);
                return <li key={run.id} className="rounded bg-zinc-950 p-2"><div>{run.cause} · v{run.toolVersion} · {run.status} · {run.attempts.length} attempts</div><div className="text-zinc-500">RunRecord: {run.attempts.map((attempt) => attempt.runId).filter(Boolean).join(", ") || "—"}</div>{runDeliveries.map((delivery) => <div key={delivery.id} className="mt-1 rounded border border-zinc-800 p-1"><span>发送：{delivery.status}</span><span className="ml-1 text-zinc-500">{connectors.find((connector) => connector.id === delivery.connectorId)?.name ?? "已失效连接器"}</span>{["error", "partial", "unknown_commit"].includes(delivery.status) && <button disabled={busy} onClick={() => void retryDelivery(delivery)} className="ml-2 text-sky-300">仅重试发送</button>}{unknownRetryId === delivery.id && <span className="ml-2 text-amber-300">可能已提交，继续可能重复。<button onClick={() => void retryDelivery(delivery, true)} className="ml-1 bg-amber-700 px-1">确认仍要重试</button></span>}</div>)}{run.diff && <details><summary>{run.diff.changes.length} 项差异{run.diff.truncated ? "+" : ""}</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(run.diff.changes, null, 2)}</pre></details>}</li>;
              })}</ul>
            </section>}
          </div>
        )}
      </div>
    </Drawer>
  );
}
