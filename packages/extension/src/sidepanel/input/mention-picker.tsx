import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, Wrench } from "lucide-react";

export type MentionTabOption = {
  tabId: number;
  title: string;
  url: string;
};

export type MentionToolOption = {
  id: string;
  name: string;
  description?: string;
  matchesCurrentUrl?: boolean;
};

export type MentionBookmarkOption = {
  id: string;
  title: string;
  url: string;
};

export type BookmarkPermissionState =
  | { state: "required" }
  | { state: "loading" }
  | { state: "granted" }
  | { state: "denied" }
  | { state: "error"; message: string };

type MentionCategory = "tabs" | "tools" | "bookmarks";

type Props = {
  tabs: MentionTabOption[];
  tools: MentionToolOption[];
  bookmarks: MentionBookmarkOption[];
  bookmarkPermission?: BookmarkPermissionState;
  onRequestBookmarkPermission?: () => void;
  onPickTab: (opt: MentionTabOption) => void;
  onPickTool: (opt: MentionToolOption) => void;
  onPickBookmark: (opt: MentionBookmarkOption) => void;
  onClose: () => void;
};

const ORDER: MentionCategory[] = ["tabs", "tools", "bookmarks"];

/**
 * Popover anchored above the input box. Tabs | Tools | Bookmarks segmented
 * switch. Keyboard: ←/→ or Tab toggles category, ↑/↓ moves within category,
 * Enter picks, Esc closes.
 */
export function MentionPicker({
  tabs,
  tools,
  bookmarks,
  bookmarkPermission = { state: "granted" },
  onRequestBookmarkPermission,
  onPickTab,
  onPickTool,
  onPickBookmark,
  onClose,
}: Props) {
  const [cat, setCat] = useState<MentionCategory>("tabs");
  const [idx, setIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const sortedTools = useMemo(() => {
    return tools.slice().sort((a, b) => {
      const av = a.matchesCurrentUrl ? 1 : 0;
      const bv = b.matchesCurrentUrl ? 1 : 0;
      if (av !== bv) return bv - av;
      return a.name.localeCompare(b.name);
    });
  }, [tools]);

  const items: Array<
    | { kind: "tab"; v: MentionTabOption }
    | { kind: "tool"; v: MentionToolOption }
    | { kind: "bookmark"; v: MentionBookmarkOption }
  > =
    cat === "tabs"
      ? tabs.map((v) => ({ kind: "tab" as const, v }))
      : cat === "tools"
        ? sortedTools.map((v) => ({ kind: "tool" as const, v }))
        : bookmarks.map((v) => ({ kind: "bookmark" as const, v }));

  useEffect(() => {
    setIdx(0);
  }, [cat]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        setCat((c) => ORDER[(ORDER.indexOf(c) + 1) % ORDER.length]);
        return;
      }
      if (e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        setCat((c) => ORDER[(ORDER.indexOf(c) + ORDER.length - 1) % ORDER.length]);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, Math.max(0, items.length - 1)));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        const it = items[idx];
        if (!it) return;
        e.preventDefault();
        if (it.kind === "tab") onPickTab(it.v);
        else if (it.kind === "tool") onPickTool(it.v);
        else onPickBookmark(it.v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, items, onClose, onPickTab, onPickTool, onPickBookmark]);

  return (
    <div
      ref={containerRef}
      role="listbox"
      className="absolute left-0 bottom-full mb-1 w-72 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-30"
    >
      <div className="flex border-b border-zinc-800 text-[10px]" role="tablist">
        <CatBtn active={cat === "tabs"} onClick={() => setCat("tabs")}>
          Tabs ({tabs.length})
        </CatBtn>
        <CatBtn active={cat === "tools"} onClick={() => setCat("tools")}>
          Tools ({tools.length})
        </CatBtn>
        <CatBtn active={cat === "bookmarks"} onClick={() => setCat("bookmarks")}>
          Bookmarks ({bookmarks.length})
        </CatBtn>
      </div>
      <div className="py-1 max-h-72 overflow-y-auto">
        {cat === "bookmarks" && bookmarkPermission.state !== "granted" ? (
          <div className="m-2 rounded border border-amber-900/70 bg-amber-950/40 p-3 text-[11px]">
            <div className="font-medium text-amber-200">允许访问书签</div>
            <p className="mt-1 text-zinc-400">仅用于在本机搜索并引用你的书签；拒绝不会影响网页聊天和其他功能。</p>
            {bookmarkPermission.state === "denied" ? (
              <p className="mt-1 text-amber-300">你尚未授权，可以稍后重试。</p>
            ) : null}
            {bookmarkPermission.state === "error" ? (
              <p role="alert" className="mt-1 text-rose-300">{bookmarkPermission.message}</p>
            ) : null}
            <button
              type="button"
              data-testid="grant-bookmarks"
              disabled={bookmarkPermission.state === "loading"}
              onClick={onRequestBookmarkPermission}
              className="mt-2 rounded bg-amber-700 px-2 py-1 text-white disabled:opacity-60"
            >
              {bookmarkPermission.state === "loading" ? "等待授权…" : "允许访问书签"}
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="text-zinc-500 text-[11px] px-3 py-2">
            {cat === "tabs" ? "没有可挂载的 tab" : cat === "tools" ? "没有可引用的工具" : "没有可引用的书签"}
          </div>
        ) : (
          items.map((it, i) => {
            const selected = i === idx;
            if (it.kind === "tab") {
              return (
                <button
                  key={`tab-${it.v.tabId}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-testid={`mention-opt-tab-${it.v.tabId}`}
                  className={`w-full text-left flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-zinc-800 ${selected ? "bg-zinc-800" : ""}`}
                  onClick={() => onPickTab(it.v)}
                  onMouseEnter={() => setIdx(i)}
                >
                  <span>📄</span>
                  <span className="flex-1 truncate text-zinc-100">{it.v.title || it.v.url}</span>
                  <span className="text-zinc-500 text-[10px]">#{it.v.tabId}</span>
                </button>
              );
            }
            if (it.kind === "tool") {
              return (
                <button
                  key={`tool-${it.v.id}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-testid={`mention-opt-tool-${it.v.id}`}
                  className={`w-full text-left flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-zinc-800 ${selected ? "bg-zinc-800" : ""}`}
                  onClick={() => onPickTool(it.v)}
                  onMouseEnter={() => setIdx(i)}
                >
                  <span>{it.v.matchesCurrentUrl ? <Sparkles size={12} /> : <Wrench size={12} />}</span>
                  <span
                    className={`flex-1 truncate ${it.v.matchesCurrentUrl ? "text-emerald-300" : "text-zinc-100"}`}
                  >
                    {it.v.name}
                  </span>
                </button>
              );
            }
            return (
              <button
                key={`bookmark-${it.v.id}`}
                type="button"
                role="option"
                aria-selected={selected}
                data-testid={`mention-opt-bookmark-${it.v.id}`}
                className={`w-full text-left flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-zinc-800 ${selected ? "bg-zinc-800" : ""}`}
                onClick={() => onPickBookmark(it.v)}
                onMouseEnter={() => setIdx(i)}
                title={it.v.url}
              >
                <span>📑</span>
                <span className="flex-1 truncate text-zinc-100">{it.v.title || it.v.url}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function CatBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-3 py-1.5 ${active ? "text-zinc-100 border-b border-blue-500" : "text-zinc-500 hover:text-zinc-300"}`}
    >
      {children}
    </button>
  );
}
