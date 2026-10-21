import { useState } from "react";
import type { RunRecord } from "@aipagego/shared/types";
import { JsonEditor } from "@/sidepanel/components/json-editor";
import { ResultView } from "@/sidepanel/components/result-view";
import { currentTabId, rpc } from "@/sidepanel/rpc";

const SAMPLE = JSON.stringify(
  {
    name: "新工具",
    urlPatterns: ["https://*.example.com/**"],
    description: "",
    steps: [{ kind: "tool", tool: "snapshotDOM", args: { maxDepth: 3 } }],
    outputSchema: {},
  },
  null,
  2
);

type Props = { onClose: () => void };

export function DevJsonModal({ onClose }: Props) {
  const [text, setText] = useState(SAMPLE);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setErr(null);
    setRun(null);
    let draft: unknown;
    try {
      draft = JSON.parse(text);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return;
    }
    setBusy(true);
    try {
      const tabId = await currentTabId();
      const r = await rpc.runDraft(draft as Parameters<typeof rpc.runDraft>[0], tabId);
      setRun(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!run) return;
    let draft: Parameters<typeof rpc.saveTool>[0];
    try {
      draft = JSON.parse(text);
    } catch {
      return;
    }
    const tool = await rpc.saveTool(draft);
    alert(`已保存为工具: ${tool.name} (${tool.id.slice(0, 8)})`);
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg max-w-2xl w-[90%] max-h-[85%] overflow-y-auto flex flex-col">
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <div className="text-zinc-100 text-sm font-medium">DEV: 粘 Tool JSON 跑</div>
          <button className="text-zinc-400 text-lg" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="p-3 flex flex-col gap-3">
          <div className="text-xs text-zinc-400">
            把一个 Tool 草案 JSON 粘下面，按「运行」在当前页执行。每个 step 不会经过审阅。
          </div>
          <JsonEditor value={text} onChange={setText} placeholder="paste a Tool JSON…" />
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={go}
              className="px-3 py-1 rounded bg-emerald-700 disabled:opacity-50 text-xs"
            >
              {busy ? "执行中…" : "运行"}
            </button>
            <button
              disabled={!run || run.status !== "ok"}
              onClick={save}
              className="px-3 py-1 rounded bg-zinc-700 disabled:opacity-50 text-xs"
            >
              保存为工具
            </button>
          </div>
          {err && <div className="text-red-400 text-xs">{err}</div>}
          {run && <ResultView run={run} />}
        </div>
      </div>
    </div>
  );
}
