import type { ContextPolicy } from "@aipagego/shared/types";
import { useSettings } from "@/sidepanel/chat/settings-store";
import { resolveContextBuildOptions } from "@/sidepanel/chat/context-manager";

const POLICY_OPTIONS: Array<{ value: ContextPolicy; label: string; hint: string }> = [
  { value: "auto", label: "自动", hint: "按模型名推断 128k / 200k / 1M 档位" },
  { value: "conservative", label: "保守", hint: "48k chars，适合小模型或代理不稳定时" },
  { value: "large", label: "长上下文", hint: "160k chars，适合 128k-256k 模型" },
  { value: "huge", label: "超长上下文", hint: "500k chars，适合 1M 模型" },
  { value: "custom", label: "自定义", hint: "手动设置阈值和保留窗口" },
];

export function SectionContext() {
  const settings = useSettings();
  const policy = settings.contextPolicy ?? "auto";
  const resolved = resolveContextBuildOptions(settings);

  return (
    <section className="bg-zinc-900 rounded p-3 space-y-3 text-xs">
      <h3 className="text-zinc-300">上下文策略</h3>

      <div className="flex items-start gap-2">
        <span className="w-20 text-zinc-400 mt-1">压缩策略</span>
        <div className="flex-1 space-y-1">
          <select
            aria-label="上下文策略"
            value={policy}
            onChange={(e) => void settings.save({ contextPolicy: e.target.value as ContextPolicy })}
            className="bg-zinc-800 px-2 py-1 rounded w-full"
          >
            {POLICY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <p className="text-zinc-500 text-[10px]">
            {POLICY_OPTIONS.find((opt) => opt.value === policy)?.hint}
          </p>
        </div>
      </div>

      <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-2 text-[11px] text-zinc-400 space-y-1">
        <div>当前生效: 触发阈值 {formatNumber(resolved.softCharBudget)} chars</div>
        <div>最近消息: {resolved.recentMessageLimit} 条原文 · 记忆摘要: {formatNumber(resolved.memoryCharLimit)} chars</div>
      </div>

      {policy === "custom" ? (
        <div className="space-y-2">
          <NumberRow
            label="触发阈值"
            ariaLabel="上下文触发阈值"
            value={settings.contextSoftCharBudget ?? resolved.softCharBudget}
            min={8_000}
            max={900_000}
            step={8_000}
            suffix="chars"
            onChange={(value) => void settings.save({ contextSoftCharBudget: value })}
          />
          <NumberRow
            label="最近消息"
            ariaLabel="保留最近消息数"
            value={settings.contextRecentMessageLimit ?? resolved.recentMessageLimit}
            min={2}
            max={80}
            step={1}
            suffix="条"
            onChange={(value) => void settings.save({ contextRecentMessageLimit: value })}
          />
          <NumberRow
            label="记忆上限"
            ariaLabel="记忆摘要上限"
            value={settings.contextMemoryCharLimit ?? resolved.memoryCharLimit}
            min={1_000}
            max={80_000}
            step={1_000}
            suffix="chars"
            onChange={(value) => void settings.save({ contextMemoryCharLimit: value })}
          />
        </div>
      ) : null}

      <p className="text-zinc-500 text-[10px]">
        图片和历史截图不会长期进入上下文；旧消息压缩时只保留文字摘要、工具结果片段和 indexId/blockId 等引用。
      </p>
    </section>
  );
}

function NumberRow(props: {
  label: string;
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-20 text-zinc-400">{props.label}</span>
      <input
        aria-label={props.ariaLabel}
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => {
          const value = Number(e.target.value);
          if (Number.isFinite(value)) props.onChange(value);
        }}
        className="bg-zinc-800 px-2 py-1 rounded w-32"
      />
      <span className="text-zinc-500">{props.suffix}</span>
    </label>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
