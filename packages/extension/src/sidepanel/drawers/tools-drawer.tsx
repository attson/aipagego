import { useEffect, useState } from "react";
import type { Tool } from "@aipagego/shared/types";
import { rpc } from "@/sidepanel/rpc";
import { useUi } from "@/sidepanel/chat/ui-store";
import { Drawer } from "@/sidepanel/shell/drawer";
import { ToolDetailPane } from "./tool-detail-pane";
import { clearWorkflowDraft } from "@/sidepanel/workflow-studio/draft-storage";
import { getActiveStepsVersion } from "@aipagego/shared/workflow";

function downloadJson(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function safeFilename(s: string): string {
  return s.replace(/[\s\\/:*?"<>|]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
}

async function exportOne(t: Tool) {
  const bundle = await rpc.exportToolSharePackage([t.id], t.name, t.description);
  downloadJson(bundle, `aipagego-${safeFilename(t.name)}-${new Date().toISOString().slice(0, 10)}.json`);
}

type Props = {
  onFixWithAi?: (opts: { initialPrompt: string; initialContext: string }) => void;
  onRunPromptTool?: (tool: Extract<Tool, { kind: "prompt" }>) => void;
};

export function ToolsDrawer({ onFixWithAi, onRunPromptTool }: Props) {
  const opened = useUi((s) => s.openedDrawer);
  const detailId = useUi((s) => s.drawerSubPath);
  const close = useUi((s) => s.close);
  const open = useUi((s) => s.open);
  const isOpen = opened === "tools";

  const [tools, setTools] = useState<Tool[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function reload() {
    try {
      setTools(await rpc.listTools());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen]);

  const inDetail = isOpen && !!detailId;

  return (
    <Drawer
      open={isOpen}
      title={inDetail ? "工具详情" : `工具库${tools ? ` (${tools.length})` : ""}`}
      onClose={close}
      onBack={inDetail ? () => open("tools") : undefined}
    >
      {inDetail ? (
        <ToolDetailPane id={detailId!} onFixWithAi={onFixWithAi} onRunPromptTool={onRunPromptTool} />
      ) : (
        <div className="p-3 flex flex-col gap-2 text-xs">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => open("connectors", "packages")}
              className="ml-auto rounded bg-zinc-700 px-2 py-0.5"
            >安全导入</button>
          </div>
          {err && <div className="text-red-400">{err}</div>}

          {!tools && <div className="text-zinc-400">加载中…</div>}
          {tools && tools.length === 0 && (
            <div className="text-zinc-400">
              还没有工具——在 chat 里让 AI 帮你做一次任务后保存，或从一份 JSON 导入。
            </div>
          )}

          <ul className="space-y-2">
            {tools?.map((t) => (
              <li key={t.id} className="bg-zinc-900 rounded p-2 flex items-start gap-2">
                <div className="flex-1">
                  <div className="font-medium flex items-center gap-1">
                    <span>{t.name}</span>
                    <span className="text-[10px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-400">
                      {t.kind === "prompt" ? "提示词" : "纯函数"}
                    </span>
                  </div>
                  <div className="text-zinc-400">{t.urlPatterns.join("  ·  ")}</div>
                  <div className="text-zinc-500">
                    v{t.kind === "steps" ? t.activeVersion : t.versions.at(-1)?.version} ·{" "}
                    {t.kind === "prompt" ? "prompt" : `${getActiveStepsVersion(t).steps.length} steps`} · runs {t.stats.runs}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => open("tools", t.id)}
                    className="px-2 py-0.5 bg-zinc-700 rounded"
                  >
                    详情
                  </button>
                  <button onClick={() => void exportOne(t).catch((cause) => setErr(cause instanceof Error ? cause.message : String(cause)))} className="px-2 py-0.5 bg-zinc-700 rounded">
                    导出
                  </button>
                  <button
                    onClick={async () => {
                      if (!confirm(`删除「${t.name}」？`)) return;
                      await rpc.deleteTool(t.id);
                      await clearWorkflowDraft(t.id);
                      void reload();
                    }}
                    className="px-2 py-0.5 bg-red-800 rounded"
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Drawer>
  );
}
