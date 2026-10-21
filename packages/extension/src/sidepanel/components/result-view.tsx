import type { RunRecord } from "@aipagego/shared/types";

export function ResultView(props: { run: RunRecord }) {
  const { run } = props;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-center gap-2">
        <StatusPill status={run.status} />
        <span className="text-zinc-400">{run.url}</span>
      </div>

      <details className="bg-zinc-900 rounded p-2">
        <summary className="cursor-pointer text-zinc-300">步骤日志（{run.stepLog.length}）</summary>
        <ol className="mt-2 space-y-2">
          {run.stepLog.map((s) => (
            <li key={s.stepIndex} className="border-l-2 border-zinc-700 pl-2">
              <div className="text-zinc-400">
                #{s.stepIndex} · {s.ms}ms {s.error && <span className="text-red-400">{s.error}</span>}
              </div>
              <pre className="text-[10px] text-zinc-300 overflow-auto">
                {JSON.stringify({ in: s.input, out: s.output }, null, 2)}
              </pre>
            </li>
          ))}
        </ol>
      </details>

      <details open className="bg-zinc-900 rounded p-2">
        <summary className="cursor-pointer text-zinc-300">最终输出</summary>
        <pre className="mt-2 text-[10px] text-zinc-300 overflow-auto">
          {JSON.stringify(run.output, null, 2)}
        </pre>
      </details>

      <button
        onClick={() => downloadJson(run.output, `aipagego-output-${run.id.slice(0, 8)}.json`)}
        className="self-start px-3 py-1 bg-emerald-700 rounded"
      >
        导出 output JSON
      </button>
    </div>
  );
}

function StatusPill({ status }: { status: RunRecord["status"] }) {
  const cls =
    status === "ok"
      ? "bg-emerald-700"
      : status === "error"
      ? "bg-red-700"
      : status === "running"
      ? "bg-amber-700"
      : "bg-zinc-700";
  return <span className={`px-2 py-0.5 rounded text-[10px] ${cls}`}>{status}</span>;
}

function downloadJson(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
