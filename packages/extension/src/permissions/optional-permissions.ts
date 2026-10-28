import {
  PermissionRequiredError,
  type OptionalCapabilityPermission,
  type PermissionCapability,
} from "@aipagego/shared/optional-permissions";

export type PermissionRequestResult =
  | { granted: true }
  | { granted: false; reason: "user_denied" };

export const PENDING_PERMISSION_STORAGE_PREFIX = "aipagego.pendingPermission.";

export function pendingPermissionStorageKey(tabId: number, toolUseId: string): string {
  return `${PENDING_PERMISSION_STORAGE_PREFIX}${tabId}.${encodeURIComponent(toolUseId)}`;
}

export async function hasOptionalPermission(
  permission: OptionalCapabilityPermission,
): Promise<boolean> {
  if (!chrome.permissions?.contains) return false;
  return chrome.permissions.contains({ permissions: [permission] });
}

export async function requireOptionalPermission(
  permission: OptionalCapabilityPermission,
  capability: PermissionCapability,
): Promise<void> {
  if (await hasOptionalPermission(permission)) return;
  throw new PermissionRequiredError({
    code: "permission_required",
    permission,
    capability,
    requestable: true,
  });
}

/** Call only from a synchronous user-gesture path. */
export async function requestOptionalPermission(
  permission: OptionalCapabilityPermission,
): Promise<PermissionRequestResult> {
  if (!chrome.permissions?.request) {
    throw new Error(`chrome.permissions.request unavailable for ${permission}`);
  }
  const granted = await chrome.permissions.request({ permissions: [permission] });
  return granted ? { granted: true } : { granted: false, reason: "user_denied" };
}

export async function removeOptionalPermission(
  permission: OptionalCapabilityPermission,
): Promise<boolean> {
  if (!chrome.permissions?.remove) return false;
  return chrome.permissions.remove({ permissions: [permission] });
}
