import { useEffect, useState } from "react";
import type { Preset } from "@aipagego/shared/preset";
import type { Tool } from "@aipagego/shared/types";
import { matchesAny } from "@aipagego/shared/url-pattern";
import { rpc, currentTabInfo } from "@/sidepanel/rpc";
import { useUi } from "@/sidepanel/chat/ui-store";

const CAT_LABEL: Record<string, string> = {
  ecommerce: "商品采集",
  content: "内容站",
};

type Filter = "all" | "ecommerce" | "content";

export function ScenariosPage() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [currentUrl, setCurrentUrl] = useState<string>("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const openDrawer = useUi((s) => s.open);

  useEffect(() => {
    rpc.listPresets().then(setPresets).catch(() => {});
    rpc.listTools().then(setTools).catch(() => {});
    currentTabInfo()
      .then((i) => setCurrentUrl(i.url))
      .catch(() => {});
  }, []);

  const filtered = presets.filter((p) => {
    if (filter !== "all" && p.category !== filter) return false;
    if (query) {
      const q = query.toLowerCase();
      if (
        !p.name.toLowerCase().includes(q) &&
        !p.description.toLowerCase().includes(q)
      )
        return false;
    }
    return true;
  });

  const grouped: Record<string, Preset[]> = {};
  for (const p of filtered) (grouped[p.category] ??= []).push(p);

  async function onCopy(p: Preset) {
    if (p.kind !== "tool") return;
    setBusyId(p.id);
    try {
      const tool = await rpc.materializePreset(p.id);
      setTools([...tools.filter((t) => t.id !== tool.id), tool]);
    } finally {
      setBusyId(null);
    }
  }

  async function onRunHere(p: Preset) {
    if (p.kind !== "tool") return;
    setBusyId(p.id);
    try {
      const tool = await rpc.materializePreset(p.id);
      // Open the tools drawer at the specific tool detail pane.
      // This reuses the existing drawer/pane wiring (ui.open("tools", id))
      // instead of hash navigation, which doesn't exist in this sidepanel.
      openDrawer("tools", tool.id);
    } finally {
      setBusyId(null);
    }
  }

  function statusBadge(p: Preset): string {
    const t = tools.find((t) => t.origin?.presetId === p.id);
    if (!t) return "NEW";
    const v = t.versions.at(-1)?.version ?? 1;
    if (v >= 2) return `已升级 v${v}`;
    return "已复制";
  }

  function urlMatches(p: Preset): boolean {
    if (!currentUrl) return false;
    return matchesAny(currentUrl, p.urlPatterns);
  }

  return (
    <div className="h-full overflow-auto p-3 flex flex-col gap-3 text-xs">
      <div className="flex gap-2 items-center">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索 preset…"
          className="flex-1 px-2 py-1 bg-zinc-900 border border-zinc-700 rounded"
        />
        {(["all", "ecommerce", "content"] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2 py-1 rounded ${
              filter === f
                ? "bg-emerald-700 text-white"
                : "bg-zinc-800 text-zinc-300"
            }`}
          >
            {f === "all" ? "全部" : CAT_LABEL[f]}
          </button>
        ))}
      </div>
      {Object.entries(grouped).map(([cat, list]) => (
        <section key={cat} className="flex flex-col gap-2">
          <h3 className="text-zinc-400 mt-2">
            ── {CAT_LABEL[cat] ?? cat} ──
          </h3>
          {list.map((p) => {
            const matches = urlMatches(p);
            return (
              <div
                key={p.id}
                className="bg-zinc-900 rounded p-2 border border-zinc-800 flex flex-col gap-1"
              >
                <div className="flex justify-between items-baseline">
                  <b className="text-sm">{p.name}</b>
                  <span className="text-[10px] text-zinc-500">
                    {statusBadge(p)}
                  </span>
                </div>
                <div className="text-zinc-400 text-[11px]">{p.description}</div>
                <div className="text-zinc-500 text-[10px] truncate">
                  {p.urlPatterns.join(", ")}
                </div>
                <div className="flex gap-2 mt-1">
                  {p.kind === "tool" && matches && (
                    <button
                      disabled={busyId === p.id}
                      onClick={() => onRunHere(p)}
                      className="px-2 py-0.5 bg-emerald-700 rounded disabled:opacity-50"
                    >
                      在当前 tab 运行
                    </button>
                  )}
                  {p.kind === "tool" && (
                    <button
                      disabled={busyId === p.id}
                      onClick={() => onCopy(p)}
                      className="px-2 py-0.5 bg-zinc-800 rounded disabled:opacity-50"
                    >
                      复制成我的工具
                    </button>
                  )}
                  {p.sampleUrl && (
                    <a
                      href={p.sampleUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="px-2 py-0.5 bg-zinc-800 rounded"
                    >
                      示例页
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
