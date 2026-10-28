import { Loader2, ShieldCheck } from "lucide-react";
import type {
  OptionalCapabilityPermission,
  PermissionCapability,
} from "@aipagego/shared/optional-permissions";

type Props = {
  permission: OptionalCapabilityPermission;
  capability: PermissionCapability;
  busy: boolean;
  error?: string;
  onGrant: () => void;
  onDeny: () => void;
};

function title(capability: PermissionCapability): string {
  if (capability === "searchBookmarks" || capability === "bookmarkMention") {
    return "AI 想搜索你的书签";
  }
  if (capability === "searchHistory") return "AI 想搜索你的浏览历史";
  if (capability === "downloadImage") return "AI 想下载这张图片";
  if (capability === "downloadSpreadsheet") return "AI 想下载这份表格";
  return "此操作需要额外浏览器权限";
}

function description(capability: PermissionCapability): string {
  if (capability === "searchBookmarks" || capability === "bookmarkMention") {
    return "仅为当前功能读取本机书签；拒绝后本次操作不会执行。";
  }
  if (capability === "searchHistory") {
    return "仅为本次搜索读取浏览历史；拒绝后不会读取历史记录。";
  }
  return "仅为本次操作保存文件；拒绝后不会创建下载。";
}

export function PermissionRequestCard({
  permission,
  capability,
  busy,
  error,
  onGrant,
  onDeny,
}: Props) {
  return (
    <section className="rounded border border-amber-900/70 bg-amber-950/30 p-3 text-xs">
      <div className="flex items-start gap-2">
        <ShieldCheck size={16} className="mt-0.5 shrink-0 text-amber-300" />
        <div>
          <h3 className="font-semibold text-zinc-100">{title(capability)}</h3>
          <p className="mt-1 text-[11px] text-zinc-400">
            {description(capability)} 网页聊天和其他能力仍可使用。
          </p>
          <p className="mt-1 text-[10px] text-zinc-500">Chrome 权限：{permission}</p>
        </div>
      </div>
      {error ? <p role="alert" className="mt-2 text-[11px] text-rose-300">{error}</p> : null}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          data-testid="permission-deny"
          disabled={busy}
          onClick={onDeny}
          className="rounded px-2 py-1 text-zinc-400 hover:text-zinc-100 disabled:opacity-60"
        >
          暂不允许
        </button>
        <button
          type="button"
          data-testid="permission-grant"
          disabled={busy}
          onClick={onGrant}
          className="inline-flex items-center gap-1 rounded bg-amber-700 px-2 py-1 text-white hover:bg-amber-600 disabled:opacity-60"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : null}
          允许并继续
        </button>
      </div>
    </section>
  );
}
