import { useState } from "react";
import { rpc } from "@/sidepanel/rpc";
import { useUi } from "@/sidepanel/chat/ui-store";
import { DevJsonModal } from "./dev-json-modal";

export function SectionAdvanced() {
  const open = useUi((state) => state.open);
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

  return (
    <section className="bg-zinc-900 rounded p-3 space-y-3 text-xs">
      <h3 className="text-zinc-300">高级 / 调试</h3>

      <div className="space-y-1">
        <div className="text-zinc-400">备份</div>
        <div className="flex gap-2">
          <button onClick={doExport} className="px-3 py-1 bg-zinc-700 rounded">
            导出工具库 JSON
          </button>
          <button onClick={() => open("connectors", "packages")} className="px-3 py-1 bg-zinc-700 rounded">
            安全导入工具 JSON
          </button>
        </div>
        <p className="text-zinc-500 text-[10px]">
          导出只包含 tools；导入会先审查 secret、能力、危险级别与冲突。API Key、运行记录不在内。
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
