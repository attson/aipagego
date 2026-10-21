import { useEffect, useState } from "react";

import type { PersistedSession } from "@aipagego/shared/types";
import * as ss from "@/sidepanel/chat/persistence/sessions-storage";
import { setPersistIdFor } from "@/sidepanel/chat/persistence/auto-persist";
import { rehydrateFromPersisted, useStore } from "@/sidepanel/chat/session-store";
import { useUi } from "@/sidepanel/chat/ui-store";
import { Drawer } from "@/sidepanel/shell/drawer";

function firstUserText(s: PersistedSession): string {
  const m = s.data.messages.find((mm) => mm.role === "user" && typeof mm.content === "string");
  if (!m || typeof m.content !== "string") return "(无文本)";
  return m.content.slice(0, 30) + (m.content.length > 30 ? "…" : "");
}

function ago(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s 前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m 前`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h 前`;
  return `${Math.floor(sec / 86_400)}d 前`;
}

type Props = {
  /** Current Chrome tab URL; used when `byCurrentUrl` is on. */
  currentUrl: string;
};

export function HistoryDrawer({ currentUrl }: Props) {
  const opened = useUi((s) => s.openedDrawer);
  const close = useUi((s) => s.close);
  const open = opened === "history";

  const [rows, setRows] = useState<PersistedSession[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const list = await ss.listArchivedByUrl(currentUrl);
      if (!cancelled) setRows(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, currentUrl]);

  async function refresh() {
    const list = await ss.listArchivedByUrl(currentUrl);
    setRows(list);
  }

  async function onRestore(target: PersistedSession) {
    const tabId = useStore.getState().currentTabId;
    if (tabId == null) return;
    const curActive = await ss.getActiveByTabId(tabId);
    if (curActive && curActive.id !== target.id) {
      await ss.archiveActive(curActive.id);
    }
    await ss.restoreArchived(target.id, tabId);
    rehydrateFromPersisted(tabId, target.data);
    setPersistIdFor(tabId, target.id);
    await refresh();
    close();
  }

  async function onDelete(target: PersistedSession) {
    const runId = await ss.deleteOne(target.id);
    if (runId) await ss.cascadeDeleteRuns([runId]);
    await refresh();
  }

  async function onClearAll() {
    if (!confirm(`清空此 URL 的全部历史？（${rows.length} 条）`)) return;
    const runIds = await ss.clearAllForUrl(currentUrl);
    await ss.cascadeDeleteRuns(runIds);
    await refresh();
  }

  return (
    <Drawer open={open} title={`历史会话 (${rows.length})`} onClose={close}>
      <div className="p-3 text-xs">
        <div className="text-zinc-500 text-[10px] mb-2 truncate">{currentUrl}</div>
        {rows.length === 0 ? (
          <p className="text-zinc-500 text-center py-8">暂无历史会话</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li
                key={r.id}
                data-testid="history-item"
                className="border border-zinc-800 rounded p-2"
              >
                <div className="text-zinc-200 truncate">{firstUserText(r)}</div>
                <div className="text-zinc-500 flex justify-between mt-1">
                  <span>
                    {r.data.messages.length} 条 · {ago(r.updatedAt)}
                  </span>
                  <div className="flex gap-2">
                    <button onClick={() => void onRestore(r)} className="text-emerald-400">
                      恢复
                    </button>
                    <button onClick={() => void onDelete(r)} className="text-red-400">
                      删除
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {rows.length > 0 && (
          <button
            onClick={() => void onClearAll()}
            className="mt-3 w-full px-2 py-1 bg-red-900 hover:bg-red-800 rounded text-zinc-100 text-[11px]"
          >
            清空此 URL 历史
          </button>
        )}
      </div>
    </Drawer>
  );
}
