import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { normalizeHostPattern, resolveInjectionPolicy } from "@aipagego/shared";
import type { InjectionMode, SiteInjectionRule } from "@aipagego/shared/types";
import { useSettings } from "@/sidepanel/chat/settings-store";

const MODES: Array<{ value: InjectionMode; label: string }> = [
  { value: "disabled", label: "禁用" },
  { value: "read", label: "只读" },
  { value: "operate", label: "操作" },
  { value: "diagnostic", label: "诊断" }
];

const MODE_LABEL: Record<InjectionMode, string> = Object.fromEntries(
  MODES.map((item) => [item.value, item.label])
) as Record<InjectionMode, string>;

export function SectionMounting() {
  const settings = useSettings();
  const rules = settings.siteInjectionRules ?? [];
  const [currentHost, setCurrentHost] = useState<string | null>(null);

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.url) return;
      try { setCurrentHost(new URL(tab.url).hostname); } catch { setCurrentHost(null); }
    }).catch(() => undefined);
  }, []);

  const resolved = useMemo(() => currentHost ? resolveInjectionPolicy({
    hostname: currentHost,
    defaultInjectionMode: settings.defaultInjectionMode ?? "operate",
    defaultAssistantEnabled: settings.defaultAssistantEnabled !== false,
    rules
  }) : null, [currentHost, rules, settings.defaultAssistantEnabled, settings.defaultInjectionMode]);

  function saveRules(next: SiteInjectionRule[]): void {
    void settings.save({ siteInjectionRules: next });
  }

  function patchRule(index: number, patch: Partial<SiteInjectionRule>): void {
    saveRules(rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule));
  }

  function moveRule(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[index], next[target]] = [next[target], next[index]];
    saveRules(next);
  }

  return (
    <div className="space-y-3 text-xs">
      <section className="space-y-3 rounded bg-zinc-900 p-3">
        <h3 className="text-zinc-300">默认策略</h3>
        <label className="flex items-center gap-2">
          <span className="w-24 text-zinc-400">注入模式</span>
          <select
            aria-label="默认注入模式"
            value={settings.defaultInjectionMode ?? "operate"}
            onChange={(event) => void settings.save({ defaultInjectionMode: event.target.value as InjectionMode })}
            className="rounded bg-zinc-800 px-2 py-1 text-zinc-200"
          >
            {MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.defaultAssistantEnabled !== false}
            onChange={(event) => void settings.save({ defaultAssistantEnabled: event.target.checked })}
          />
          <span className="text-zinc-300">默认启用网页助手（浮窗与运行边框）</span>
        </label>
        {resolved && currentHost ? (
          <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-[11px] text-zinc-400">
            当前站点 <span className="font-mono text-zinc-300">{currentHost}</span>：
            {MODE_LABEL[resolved.injectionMode]} · 网页助手{resolved.assistantEnabled ? "开启" : "关闭"}
            {resolved.matchedPattern ? <span> · 命中 {resolved.matchedPattern}</span> : null}
          </div>
        ) : null}
      </section>

      <section className="space-y-2 rounded bg-zinc-900 p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-zinc-300">站点覆盖规则</h3>
          <button
            type="button"
            title="添加站点规则"
            aria-label="添加站点规则"
            onClick={() => saveRules([...rules, { pattern: "", injectionMode: "inherit", assistant: "inherit" }])}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Plus size={15} />
          </button>
        </div>
        <p className="text-[11px] text-zinc-500">精确 hostname 优先；同等规则中靠后的优先。</p>

        {rules.length === 0 ? (
          <div className="py-3 text-center text-[11px] text-zinc-600">暂无站点覆盖规则</div>
        ) : rules.map((rule, index) => {
          const validation = normalizeHostPattern(rule.pattern);
          return (
            <div key={index} className="space-y-2 border-t border-zinc-800 pt-2 first:border-t-0 first:pt-0">
              <div className="flex items-center gap-1">
                <input
                  aria-label={`站点规则 ${index + 1}`}
                  value={rule.pattern}
                  onChange={(event) => patchRule(index, { pattern: event.target.value })}
                  onBlur={() => {
                    if (validation.ok && validation.pattern !== rule.pattern) patchRule(index, { pattern: validation.pattern });
                  }}
                  placeholder="example.com 或 *.example.com"
                  className="min-w-0 flex-1 rounded bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none ring-1 ring-zinc-700 focus:ring-blue-500"
                />
                <button type="button" title="上移" aria-label="上移规则" disabled={index === 0}
                  onClick={() => moveRule(index, -1)} className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-25"><ChevronUp size={14} /></button>
                <button type="button" title="下移" aria-label="下移规则" disabled={index === rules.length - 1}
                  onClick={() => moveRule(index, 1)} className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-25"><ChevronDown size={14} /></button>
                <button type="button" title="删除" aria-label="删除规则"
                  onClick={() => saveRules(rules.filter((_, i) => i !== index))} className="p-1 text-zinc-500 hover:text-rose-400"><Trash2 size={14} /></button>
              </div>
              {!validation.ok && rule.pattern ? <p className="text-[11px] text-rose-400">{validation.error}</p> : null}
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-zinc-500">
                  <span className="block">注入模式</span>
                  <select value={rule.injectionMode} onChange={(event) => patchRule(index, { injectionMode: event.target.value as SiteInjectionRule["injectionMode"] })}
                    className="w-full rounded bg-zinc-950 px-2 py-1 text-zinc-300">
                    <option value="inherit">继承默认</option>
                    {MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-zinc-500">
                  <span className="block">网页助手</span>
                  <select value={rule.assistant} onChange={(event) => patchRule(index, { assistant: event.target.value as SiteInjectionRule["assistant"] })}
                    className="w-full rounded bg-zinc-950 px-2 py-1 text-zinc-300">
                    <option value="inherit">继承默认</option>
                    <option value="enabled">开启</option>
                    <option value="disabled">关闭</option>
                  </select>
                </label>
              </div>
            </div>
          );
        })}
      </section>

      <section className="space-y-1 rounded bg-zinc-900 p-3">
        <h3 className="text-zinc-300">模式说明</h3>
        <p className="text-[11px] text-zinc-500">禁用：仅 tab 信息与截图；只读：DOM 读取；操作：读取与交互；诊断：额外启用 MAIN-world console / 网络 / 弹窗录制。</p>
      </section>
    </div>
  );
}
