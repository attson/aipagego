import { useEffect, useState } from "react";
import { useSettings } from "@/sidepanel/chat/settings-store";
import { DANGEROUS_TOOLS } from "@/sidepanel/lib/dangerous-tools";
import type { PermissionMode } from "@/sidepanel/chat/severity";
import {
  hasOptionalPermission,
  removeOptionalPermission,
} from "@/permissions/optional-permissions";
import type { OptionalCapabilityPermission } from "@aipagego/shared/optional-permissions";

const MODE_LABEL: Record<PermissionMode, string> = {
  read: "只读 — 全部询问",
  default: "默认 — caution 自动，dangerous 询问",
  trust: "信任白名单 — 白名单内 dangerous 自动",
  yolo: "全自动 — 所有工具自动（不推荐）",
};

const OPTIONAL_PERMISSIONS: Array<{
  permission: OptionalCapabilityPermission;
  label: string;
  description: string;
}> = [
  { permission: "bookmarks", label: "书签", description: "搜索和引用本机书签" },
  { permission: "history", label: "历史记录", description: "按关键词搜索浏览历史" },
  { permission: "downloads", label: "下载", description: "保存图片和 XLSX 文件" },
  { permission: "notifications", label: "通知", description: "显示本地 Job 的变化与终态" },
];

export function SectionPermissions() {
  const settings = useSettings();
  const [granted, setGranted] = useState<Partial<Record<OptionalCapabilityPermission, boolean>>>({});
  const [permissionError, setPermissionError] = useState<string>();

  useEffect(() => {
    let active = true;
    void Promise.all(
      OPTIONAL_PERMISSIONS.map(async ({ permission }) => [
        permission,
        await hasOptionalPermission(permission),
      ] as const)
    ).then((entries) => {
      if (active) setGranted(Object.fromEntries(entries));
    }).catch((error) => {
      if (active) setPermissionError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      active = false;
    };
  }, []);

  async function revoke(permission: OptionalCapabilityPermission) {
    setPermissionError(undefined);
    try {
      const removed = await removeOptionalPermission(permission);
      if (!removed) throw new Error(`无法撤销 ${permission} 权限`);
      setGranted((current) => ({ ...current, [permission]: false }));
    } catch (error) {
      setPermissionError(error instanceof Error ? error.message : String(error));
    }
  }

  function toggleTrusted(toolId: string) {
    const next = settings.trustedDangerTools.includes(toolId)
      ? settings.trustedDangerTools.filter((t) => t !== toolId)
      : [...settings.trustedDangerTools, toolId];
    void settings.save({ trustedDangerTools: next });
  }

  return (
    <section className="bg-zinc-900 rounded p-3 space-y-2 text-xs">
      <h3 className="text-zinc-300">权限默认值</h3>
      <div className="flex items-center gap-2">
        <span className="w-24 text-zinc-400">默认模式</span>
        <select
          value={settings.defaultPermissionMode}
          onChange={(e) =>
            void settings.save({ defaultPermissionMode: e.target.value as PermissionMode })
          }
          className="bg-zinc-800 px-2 py-1 rounded flex-1"
        >
          {(["read", "default", "trust", "yolo"] as PermissionMode[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ))}
        </select>
      </div>
      <p className="text-zinc-500 text-[10px]">新开的会话用这档模式启动。当前会话的模式在 input 工具栏切。</p>

      <div className="border-t border-zinc-800 pt-2">
        <div className="text-zinc-300">浏览器可选权限</div>
        <p className="mt-1 text-[10px] text-zinc-500">
          未授权的能力会在实际使用时询问；此处只查看状态或撤销权限。
        </p>
        {permissionError ? <p role="alert" className="mt-1 text-rose-300">{permissionError}</p> : null}
        <ul className="mt-2 space-y-2">
          {OPTIONAL_PERMISSIONS.map(({ permission, label, description }) => {
            const isGranted = granted[permission] === true;
            return (
              <li key={permission} className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-zinc-300">{label}</div>
                  <div className="text-[10px] text-zinc-500">{description}</div>
                </div>
                <div className="shrink-0 text-right">
                  <span
                    data-testid={`permission-state-${permission}`}
                    className={isGranted ? "text-emerald-300" : "text-zinc-500"}
                  >
                    {isGranted ? "已授权" : "使用时询问"}
                  </span>
                  {isGranted ? (
                    <button
                      type="button"
                      data-testid={`permission-revoke-${permission}`}
                      onClick={() => void revoke(permission)}
                      className="ml-2 text-amber-300 hover:text-amber-200"
                    >
                      撤销
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="pt-1">
        <div className="text-zinc-400 mb-1">「信任白名单」模式下放行的 dangerous 工具</div>
        <ul className="space-y-1">
          {DANGEROUS_TOOLS.map((t) => (
            <li key={t.id}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.trustedDangerTools.includes(t.id)}
                  onChange={() => toggleTrusted(t.id)}
                  className="accent-amber-500"
                />
                <span className="text-zinc-300">{t.label}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
