/**
 * Dangerous tool handoff: opens the sidepanel for the user to review
 * and approve a dangerous tool use that the widget cannot self-approve.
 */
import { rpc } from "@/sidepanel/rpc";
import { appendHealNote } from "@/sidepanel/chat/session-store";

export async function handOffToSidepanel(tabId: number, approvalId: string): Promise<void> {
  try {
    await rpc.widgetOpenSidepanel({ tabId, pendingApprovalId: approvalId });
  } catch {
    appendHealNote(
      tabId,
      "无法自动打开扩展面板;请手动点浏览器右上角的扩展图标。"
    );
  }
}

export async function handOffPermissionToSidepanel(
  tabId: number,
  pendingPermission: Parameters<typeof rpc.widgetOpenSidepanel>[0]["pendingPermission"],
): Promise<boolean> {
  try {
    await rpc.widgetOpenSidepanel({ tabId, pendingPermission });
    return true;
  } catch {
    appendHealNote(
      tabId,
      "无法自动打开扩展面板处理浏览器权限；本次操作已取消。"
    );
    return false;
  }
}
