import { useState } from "react";
import { rpc } from "@/sidepanel/rpc";
import { DevJsonModal } from "./dev-json-modal";

export function SectionAdvanced() {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [devOpen, setDevOpen] = useState(false);

  async function doExport() {
    setMsg(null);
    setErr(null);
    try {
      const bundle = await rpc.exportAll();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `aipagego-tools-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg(`导出 ${bundle.tools.length} 个工具`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function doImport(file: File) {
    setMsg(null);
    setErr(null);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const r = await rpc.importBundle(bundle);
      setMsg(`已导入 ${r.imported} 个，跳过 ${r.skipped} 个`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="bg-zinc-900 rounded p-3 space-y-3 text-xs">
      <h3 className="text-zinc-300">高级 / 调试</h3>

      <div className="space-y-1">
        <div className="text-zinc-400">备份</div>
        <div className="flex gap-2">
          <button onClick={doExport} className="px-3 py-1 bg-zinc-700 rounded">
            导出工具库 JSON
          </button>
          <label className="px-3 py-1 bg-zinc-700 rounded cursor-pointer">
            导入 JSON
            <input
              type="file"
              accept="application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void doImport(f);
              }}
            />
          </label>
        </div>
        <p className="text-zinc-500 text-[10px]">
          导出 / 导入只包含 tools。API Key、运行记录不在内。冲突默认 skip。
        </p>
      </div>

      <div className="space-y-1">
        <div className="text-zinc-400">调试</div>
        <button onClick={() => setDevOpen(true)} className="px-3 py-1 bg-zinc-700 rounded">
          DEV: 粘 Tool JSON 跑
        </button>
        <p className="text-zinc-500 text-[10px]">
          不走 LLM、不走审阅，直接执行 Tool 草案。验证 step 序列时用。
        </p>
      </div>

      {msg && <div className="text-emerald-400">{msg}</div>}
      {err && <div className="text-red-400">{err}</div>}

      {devOpen && <DevJsonModal onClose={() => setDevOpen(false)} />}
    </section>
  );
}
