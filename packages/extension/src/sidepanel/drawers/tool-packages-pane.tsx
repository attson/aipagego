import { useEffect, useMemo, useState } from "react";
import { capabilityForRunJs, capabilityForTool, type Capability } from "@aipagego/shared/capability";
import { highestSeverity, runStaticScan } from "@aipagego/shared/static-scan";
import {
  computeToolPackageDigest,
  type ImportCommitResult,
  type ImportConflictAction,
  type ImportPreview,
  type ToolSharePackageV1,
} from "@aipagego/shared/tool-package";
import type { Json, Tool } from "@aipagego/shared/types";
import { getActiveStepsVersion } from "@aipagego/shared/workflow";
import { rpc } from "@/sidepanel/rpc";
import { classifyTool, type ToolSeverity } from "@/sidepanel/chat/severity";

type Review = { bundle: ToolSharePackageV1; digest: string };
type ToolAudit = {
  capabilities: string[];
  hosts: string[];
  severity: ToolSeverity;
};

function isRecord(value: Json): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hostFromPattern(pattern: string): string {
  return /^[A-Za-z*][A-Za-z0-9+.*-]*:\/\/([^/]+)/.exec(pattern)?.[1] ?? pattern;
}

function highestToolSeverity(values: ToolSeverity[]): ToolSeverity {
  if (values.includes("dangerous")) return "dangerous";
  if (values.includes("caution")) return "caution";
  return "safe";
}

function auditTool(tool: Tool): ToolAudit {
  const hosts = [...new Set(tool.urlPatterns.map(hostFromPattern))].sort();
  if (tool.kind === "prompt") {
    return { capabilities: ["prompt:dynamic"], hosts, severity: "dangerous" };
  }

  const capabilities = new Set<Capability>();
  const severities: ToolSeverity[] = [];
  for (const step of getActiveStepsVersion(tool).steps) {
    if (step.kind === "js") {
      const unsafe = highestSeverity(runStaticScan(step.source)) === "dangerous";
      capabilities.add(capabilityForRunJs(unsafe));
      severities.push(classifyTool("runJS", { source: step.source }));
      continue;
    }
    const args = isRecord(step.args) ? step.args : {};
    capabilities.add(capabilityForTool(step.tool, {
      httpCookied: args.withCredentials === true,
      dropHasFiles: Array.isArray(args.files) && args.files.length > 0,
      recorderArmsBodies: args.captureBodies === true,
    }));
    severities.push(classifyTool(step.tool, step.args));
  }
  return {
    capabilities: [...capabilities].sort(),
    hosts,
    severity: highestToolSeverity(severities),
  };
}

function safeFilename(value: string): string {
  return value.replace(/[\s\\/:*?"<>|]+/g, "_").replace(/^_+|_+$/g, "") || "tools";
}

function downloadPackage(bundle: ToolSharePackageV1): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `aipagego-${safeFilename(bundle.package.name)}-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ToolPackagesPane() {
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [review, setReview] = useState<Review>();
  const [importBundle, setImportBundle] = useState<unknown>();
  const [importPreview, setImportPreview] = useState<ImportPreview>();
  const [importActions, setImportActions] = useState<Record<number, ImportConflictAction>>({});
  const [approveDangerous, setApproveDangerous] = useState(false);
  const [importResult, setImportResult] = useState<ImportCommitResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void rpc.listTools().then(
      (loaded) => { if (active) setTools(loaded); },
      (cause) => { if (active) { setTools([]); setError(cause instanceof Error ? cause.message : String(cause)); } },
    );
    return () => { active = false; };
  }, []);

  const audits = useMemo(
    () => new Map((tools ?? []).map((tool) => [tool.id, auditTool(tool)])),
    [tools],
  );

  function toggle(id: string): void {
    setReview(undefined);
    setSelectedIds((current) => current.includes(id)
      ? current.filter((candidate) => candidate !== id)
      : [...current, id]);
  }

  async function buildReview(): Promise<void> {
    if (selectedIds.length === 0) { setError("请至少选择一个工具"); return; }
    if (name.length === 0) { setError("请输入工具包名称"); return; }
    setBusy(true);
    setError(undefined);
    try {
      const bundle = await rpc.exportToolSharePackage(
        selectedIds,
        name,
        description || undefined,
      );
      setReview({ bundle, digest: await computeToolPackageDigest(bundle) });
    } catch (cause) {
      setReview(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function previewImport(file: File): Promise<void> {
    setBusy(true);
    setError(undefined);
    setImportPreview(undefined);
    setImportResult(undefined);
    setApproveDangerous(false);
    try {
      const bundle = JSON.parse(await file.text()) as unknown;
      const preview = await rpc.previewToolImport(bundle);
      setImportBundle(bundle);
      setImportPreview(preview);
      setImportActions(Object.fromEntries(
        preview.items.map((item) => [item.index, item.suggestedAction]),
      ));
    } catch (cause) {
      setImportBundle(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function commitImport(): Promise<void> {
    if (importBundle === undefined || importPreview === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await rpc.commitToolImport({
        bundle: importBundle,
        digest: importPreview.digest,
        decisions: importPreview.items.map((item) => ({
          index: item.index,
          action: importActions[item.index] ?? item.suggestedAction,
        })),
        approveDangerous,
      });
      setImportResult(result);
      try {
        setTools(await rpc.listTools());
      } catch (cause) {
        setError(`导入已完成，但工具列表刷新失败：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    } catch (cause) {
      setImportResult(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const importHasDangerous = importPreview?.items.some(
    (item) => item.valid && item.severity === "dangerous",
  ) ?? false;
  const resultCounts = importResult == null ? undefined : {
    imported: importResult.items.filter((item) => item.status === "imported").length,
    skipped: importResult.items.filter((item) => item.status === "skipped").length,
    rejected: importResult.items.filter((item) => item.status === "rejected").length,
  };

  if (tools === null) {
    return <div data-state="loading" className="p-4 text-xs text-zinc-500">正在读取可分享工具…</div>;
  }

  return (
    <div className="space-y-3 p-3 text-xs">
      <section className="space-y-2 rounded border border-zinc-800 bg-zinc-950/40 p-3">
        <div>
          <h3 className="text-sm font-medium text-zinc-100">安全导入</h3>
          <p className="mt-1 text-zinc-500">先只读审查文件；确认后以同一 digest 逐项导入。</p>
        </div>
        <label className="inline-block cursor-pointer rounded bg-zinc-700 px-3 py-1.5 text-zinc-100">
          选择 JSON 文件
          <input
            aria-label="导入工具 JSON"
            type="file"
            accept="application/json"
            hidden
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void previewImport(file);
              event.target.value = "";
            }}
          />
        </label>
        {importPreview ? (
          <div className="space-y-2">
            <div className="break-all font-mono text-[10px] text-zinc-500">
              {importPreview.schema} · digest {importPreview.digest.slice(0, 12)}
            </div>
            {importPreview.secretFindings.length > 0 ? (
              <div className="rounded border border-red-900 bg-red-950/20 p-2 text-red-300">
                {importPreview.secretFindings.map((finding) => (
                  <div key={`${finding.rule}:${finding.path}`}>{finding.rule} · {finding.path}</div>
                ))}
              </div>
            ) : <div className="text-emerald-400">未发现 literal secret</div>}
            {importPreview.items.map((item) => (
              <details key={item.index} open className="rounded border border-zinc-800 bg-zinc-900 p-2">
                <summary className="cursor-pointer text-zinc-100">
                  {item.name ?? `工具 #${item.index + 1}`} · {item.valid ? item.severity : item.errorCode}
                </summary>
                {item.valid ? (
                  <div className="mt-2 space-y-1 text-[11px] text-zinc-400">
                    <div>{item.kind}{item.activeVersion == null ? "" : ` · v${item.activeVersion}`}</div>
                    <div className="break-all">hosts: {item.hosts.join(" · ") || "—"}</div>
                    <div className="break-all">capabilities: {item.capabilities.join(" · ") || "—"}</div>
                    {item.dangerousSteps.map((step) => <div key={step} className="text-red-300">{step}</div>)}
                    <div>{item.conflict ? `ID 冲突 · ${item.dependentJobs} 个依赖 Job` : "新工具"}</div>
                    {item.conflict ? (
                      <label className="block">冲突策略
                        <select
                          aria-label={`导入策略 ${item.index}`}
                          value={importActions[item.index] ?? item.suggestedAction}
                          onChange={(event) => setImportActions((current) => ({
                            ...current,
                            [item.index]: event.target.value as ImportConflictAction,
                          }))}
                          className="ml-2 rounded bg-zinc-800 px-1 py-0.5"
                        >
                          <option value="copy">复制为新工具</option>
                          <option value="skip">跳过</option>
                          <option value="overwrite">覆盖现有工具</option>
                        </select>
                      </label>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-2 text-red-300">{item.errorCode ?? "invalid_tool"}</div>
                )}
              </details>
            ))}
            {importHasDangerous ? (
              <label className="flex gap-2 text-amber-200">
                <input
                  aria-label="确认导入危险工具"
                  type="checkbox"
                  checked={approveDangerous}
                  onChange={(event) => setApproveDangerous(event.target.checked)}
                />
                我已审查 dangerous / 动态 prompt；导入不会运行工具，运行时仍需原审批
              </label>
            ) : null}
            <button
              type="button"
              disabled={busy || importResult !== undefined || (importHasDangerous && !approveDangerous)}
              onClick={() => void commitImport()}
              className="rounded bg-blue-600 px-3 py-1.5 text-white disabled:opacity-40"
            >确认导入</button>
            {resultCounts ? (
              <div className="rounded bg-zinc-900 p-2 text-zinc-300">
                {[`已导入 ${resultCounts.imported} 个`,
                  ...(resultCounts.skipped > 0 ? [`跳过 ${resultCounts.skipped} 个`] : []),
                  ...(resultCounts.rejected > 0 ? [`拒绝 ${resultCounts.rejected} 个`] : []),
                ].join("，")}
                {importResult?.items.filter((item) => item.status === "rejected").map((item) => (
                  <div key={item.index} className="text-red-300">#{item.index + 1}: {item.code}</div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
      <div>
        <h3 className="text-sm font-medium text-zinc-100">安全分享</h3>
        <p className="mt-1 text-zinc-500">只导出当前启用定义；生成前由 background 扫描 literal credential。</p>
      </div>
      {error ? <div data-state="error" className="rounded border border-red-900 p-2 text-red-300">{error}</div> : null}
      {tools.length === 0 ? <div data-state="empty" className="text-zinc-500">还没有可分享的工具。</div> : (
        <div className="space-y-2">
          {tools.slice(0, 200).map((tool) => {
            const audit = audits.get(tool.id)!;
            return (
              <label key={tool.id} className="flex gap-2 rounded border border-zinc-800 bg-zinc-900 p-2">
                <input type="checkbox" checked={selectedIds.includes(tool.id)} onChange={() => toggle(tool.id)} />
                <span className="min-w-0">
                  <span className="block text-zinc-100">{tool.name}</span>
                  <span className="block break-all text-[11px] text-zinc-500">{audit.hosts.join(" · ")}</span>
                  <span className="block break-all text-[11px] text-zinc-400">{audit.capabilities.join(" · ")} · {audit.severity}</span>
                </span>
              </label>
            );
          })}
          {tools.length > 200 ? <div data-state="large" className="text-amber-300">工具较多，仅展示前 200 项。</div> : null}
        </div>
      )}
      <label className="block text-zinc-400">工具包名称
        <input aria-label="工具包名称" value={name} onChange={(event) => { setName(event.target.value); setReview(undefined); }} className="mt-1 w-full rounded bg-zinc-900 px-2 py-1" />
      </label>
      <label className="block text-zinc-400">描述（可选）
        <textarea aria-label="工具包描述" value={description} onChange={(event) => { setDescription(event.target.value); setReview(undefined); }} className="mt-1 min-h-16 w-full rounded bg-zinc-900 px-2 py-1" />
      </label>
      <button type="button" disabled={busy || selectedIds.length === 0 || name.length === 0} onClick={() => void buildReview()} className="rounded bg-blue-600 px-3 py-1.5 text-white disabled:opacity-40">审查并生成</button>
      {review ? (
        <section className="space-y-2 rounded border border-emerald-900 bg-emerald-950/20 p-3 text-zinc-300">
          <div>{review.bundle.tools.length} 个工具 · 未发现 literal secret</div>
          <div>不包含 Job、历史、结果、connector、凭据或原使用统计</div>
          <div className="break-all font-mono text-[10px] text-zinc-500">package digest: {review.digest.slice(0, 12)}</div>
          <button type="button" onClick={() => downloadPackage(review.bundle)} className="rounded bg-emerald-700 px-3 py-1.5 text-white">下载安全工具包</button>
        </section>
      ) : null}
    </div>
  );
}
