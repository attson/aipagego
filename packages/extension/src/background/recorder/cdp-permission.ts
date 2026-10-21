/**
 * `debugger` is an optional permission, not a manifest permission. Putting it
 * in `permissions` would show every user a "debug your browser" warning at
 * install time even if they never turn the CDP backend on.
 */

const SETTING_KEY = "aipagego.recorder.cdpEnabled";

export async function hasDebuggerPermission(): Promise<boolean> {
  if (!chrome.permissions?.contains) return false;
  try {
    return await chrome.permissions.contains({ permissions: ["debugger"] });
  } catch {
    return false;
  }
}

/** Must be called from a user gesture; Chrome rejects it otherwise. */
export async function requestDebuggerPermission(): Promise<boolean> {
  if (!chrome.permissions?.request) return false;
  try {
    return await chrome.permissions.request({ permissions: ["debugger"] });
  } catch {
    return false;
  }
}

export async function removeDebuggerPermission(): Promise<void> {
  try {
    await chrome.permissions?.remove?.({ permissions: ["debugger"] });
  } catch {
    // Already absent, or the user declined — either way there is nothing to do.
  }
  await setCdpRecorderEnabled(false);
}

/**
 * The stored flag is only meaningful while the permission is held. If the user
 * revokes it from chrome://extensions the flag must read as false rather than
 * leaving the backend believing it can attach.
 */
export async function cdpRecorderEnabled(): Promise<boolean> {
  if (!(await hasDebuggerPermission())) return false;
  try {
    const got = await chrome.storage.local.get(SETTING_KEY);
    return got?.[SETTING_KEY] === true;
  } catch {
    return false;
  }
}

export async function setCdpRecorderEnabled(on: boolean): Promise<boolean> {
  if (on && !(await hasDebuggerPermission())) {
    const granted = await requestDebuggerPermission();
    if (!granted) {
      await chrome.storage.local.set({ [SETTING_KEY]: false });
      return false;
    }
  }
  await chrome.storage.local.set({ [SETTING_KEY]: on });
  return on;
}
