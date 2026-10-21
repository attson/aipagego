import { useState } from "react";
import type { Preset } from "@aipagego/shared/preset";

export type SuggestedTool = {
  id: string;
  name: string;
  description?: string;
  runCount?: number;
};

const VISIBLE = 3;

type Props = {
  matchedTools: SuggestedTool[];
  onRun: (id: string) => void;
  onDetail: (id: string) => void;
  presets?: Preset[];
  onPresetPick?: (preset: Preset) => void;
};

/**
 * Renders in the empty messages area before any conversation has started.
 * If the current URL has matched tools, shows up to 3 cards plus a
 * "+N more" expander.
 */
export function EmptySuggestions({ matchedTools, onRun, onDetail, presets = [], onPresetPick }: Props) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? matchedTools : matchedTools.slice(0, VISIBLE);
  const overflow = Math.max(0, matchedTools.length - VISIBLE);

  return (
    <div className="text-center">
      {matchedTools.length > 0 && (
        <>
          <h3 className="text-zinc-100 text-[13px] font-semibold mb-1">
            此页有 {matchedTools.length} 个匹配工具
          </h3>
          <p className="text-zinc-500 text-[11px] mb-3">运行已有工具，或下方告诉 AI 做什么</p>
          <div className="space-y-2 text-left">
            {visible.map((t) => (
              <div
                key={t.id}
                className="rounded-lg border border-emerald-900 bg-gradient-to-br from-emerald-950 to-emerald-900/40 px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="flex-1 text-left text-zinc-100 font-medium text-[12px] hover:underline"
                    onClick={() => onDetail(t.id)}
                  >
                    {t.name}
                  </button>
                  <button
                    type="button"
                    className="px-2 py-0.5 rounded bg-emerald-900 text-emerald-100 text-[11px] border border-emerald-700 hover:bg-emerald-800"
                    onClick={() => onRun(t.id)}
                  >
                    运行
                  </button>
                </div>
                {(t.runCount != null || t.description) && (
                  <div className="text-emerald-300/80 text-[10px] mt-1">
                    {t.runCount != null && <span>已运行 {t.runCount} 次</span>}
                    {t.runCount != null && t.description ? " · " : ""}
                    {t.description}
                  </div>
                )}
              </div>
            ))}
            {!expanded && overflow > 0 && (
              <button
                type="button"
                className="w-full text-[11px] text-zinc-400 hover:text-zinc-200 py-1"
                onClick={() => setExpanded(true)}
              >
                + 展开剩余 {overflow} 个
              </button>
            )}
          </div>
        </>
      )}
      {presets.length > 0 && (
        <>
          <h3 className="text-zinc-100 text-[13px] font-semibold mt-4 mb-1">推荐场景</h3>
          <p className="text-zinc-500 text-[11px] mb-3">适合此页的快捷操作</p>
          <div className="space-y-2 text-left">
            {presets.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-sky-900 bg-gradient-to-br from-sky-950 to-sky-900/40 px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex-1 text-left text-zinc-100 font-medium text-[12px]">
                    {p.icon ? `${p.icon} ` : ""}{p.name}
                  </span>
                  <button
                    type="button"
                    className="px-2 py-0.5 rounded bg-sky-900 text-sky-100 text-[11px] border border-sky-700 hover:bg-sky-800"
                    onClick={() => onPresetPick?.(p)}
                  >
                    {p.kind === "tool" ? "运行" : "使用"}
                  </button>
                </div>
                {p.description && (
                  <div className="text-sky-300/80 text-[10px] mt-1">{p.description}</div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <p className={`text-zinc-500 text-[10px] mt-4 ${matchedTools.length === 0 && presets.length === 0 ? "mt-0" : ""}`}>
        {matchedTools.length === 0 && presets.length === 0
          ? "告诉 AI 你要做什么"
          : "或用 @ 引用其他 tab"}
      </p>
    </div>
  );
}
