import type { AttachedTab } from "@aipagego/shared/types";

type Props = {
  currentTabUrl: string;
  attachedTabs: AttachedTab[];
  onDetach: (tabId: number) => void;
  onAddTab: () => void;
};

function shortTitle(t: AttachedTab): string {
  const raw = t.lastSeenTitle || t.lastSeenUrl || `tab ${t.tabId}`;
  return raw.length > 24 ? raw.slice(0, 24) + "…" : raw;
}

/**
 * Compact chip row immediately above the input box showing which tabs are
 * currently mounted in the conversation. Replaces the older TabChipsBar.
 */
export function AboveInputTabs({ currentTabUrl: _url, attachedTabs, onDetach, onAddTab }: Props) {
  return (
    <div className="border-t border-zinc-800 bg-zinc-900 px-3 py-1.5 flex items-center gap-1.5 overflow-x-auto whitespace-nowrap">
      <span className="text-zinc-500 text-[10px] shrink-0">挂载:</span>

      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-900 text-[10px] shrink-0">
        🏠 当前
      </span>

      {attachedTabs.map((t) => (
        <span
          key={t.tabId}
          data-testid={`above-chip-${t.tabId}`}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-200 text-[10px] shrink-0"
        >
          <span>📄</span>
          <span className="max-w-[120px] truncate">{shortTitle(t)}</span>
          <button
            type="button"
            aria-label={`卸载 tab ${t.tabId}`}
            className="text-zinc-500 hover:text-zinc-200 text-[9px] ml-0.5"
            onClick={() => onDetach(t.tabId)}
          >
            ×
          </button>
        </span>
      ))}

      <button
        type="button"
        className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full border border-dashed border-zinc-700 text-zinc-500 hover:text-zinc-200 hover:border-zinc-500 text-[10px] shrink-0"
        onClick={onAddTab}
      >
        + tab
      </button>
    </div>
  );
}
