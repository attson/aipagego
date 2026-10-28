type Props = {
  stepCount: number;
  onSave: () => void;
  onContinueCollection?: () => void;
};

/**
 * Inline end-of-conversation card prompting the user to save successful
 * steps as a reusable tool. Renders only when there are executed steps
 * and the session is idle (caller is responsible for that gating).
 */
export function SaveAsToolCard({ stepCount, onSave, onContinueCollection }: Props) {
  return (
    <div className="self-stretch flex items-center justify-between gap-3 rounded-xl border border-dashed border-emerald-900 bg-emerald-950/40 px-3 py-2.5">
      <div className="text-[11px] text-emerald-300">
        <div>✓ {stepCount} 步成功执行</div>
        <div className="text-[10px] text-zinc-500 mt-0.5">把这段对话固化成可重放工具</div>
      </div>
      <div className="flex flex-wrap justify-end gap-1.5">
        {onContinueCollection && (
          <button
            type="button"
            className="rounded-md border border-violet-700 bg-violet-950 px-3 py-1 text-[11px] text-violet-200 hover:bg-violet-900"
            onClick={onContinueCollection}
          >
            在采集工作台继续
          </button>
        )}
        <button
          type="button"
          className="px-3 py-1 rounded-md bg-emerald-900 text-emerald-100 text-[11px] border border-emerald-700 hover:bg-emerald-800"
          onClick={onSave}
        >
          保存为工具
        </button>
      </div>
    </div>
  );
}
