import { describe, expect, it, vi } from "vitest";
import { resolveDesktopOpenEnvironment } from "../src/ensure-hub";

function procReader(files: Record<string, string>) {
  return vi.fn(async (path: string) => {
    const value = files[path];
    if (value === undefined) throw new Error(`missing fixture: ${path}`);
    return value;
  });
}

describe("resolveDesktopOpenEnvironment", () => {
  it("recovers only desktop variables from a same-uid ancestor", async () => {
    const readTextFile = procReader({
      "/proc/30/status": "Name:\tnpx\nPPid:\t20\nUid:\t1000\t1000\t1000\t1000\n",
      "/proc/30/environ": "PATH=/bin\0SECRET=child-secret\0",
      "/proc/20/status": "Name:\tcodex\nPPid:\t1\nUid:\t1000\t1000\t1000\t1000\n",
      "/proc/20/environ": [
        "DISPLAY=:1",
        "WAYLAND_DISPLAY=wayland-1",
        "XDG_RUNTIME_DIR=/run/user/1000",
        "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
        "SECRET=ancestor-secret"
      ].join("\0")
    });

    const environment = await resolveDesktopOpenEnvironment({
      baseEnv: { PATH: "/filtered/bin" },
      platform: "linux",
      parentPid: 30,
      uid: 1000,
      readTextFile
    });

    expect(environment).toMatchObject({
      PATH: "/filtered/bin",
      DISPLAY: ":1",
      WAYLAND_DISPLAY: "wayland-1",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus"
    });
    expect(environment.SECRET).toBeUndefined();
  });

  it("preserves explicitly supplied desktop variables", async () => {
    const readTextFile = procReader({
      "/proc/20/status": "Name:\tcodex\nPPid:\t1\nUid:\t1000\t1000\t1000\t1000\n",
      "/proc/20/environ": "DISPLAY=:1\0XAUTHORITY=/ancestor/auth\0"
    });

    const environment = await resolveDesktopOpenEnvironment({
      baseEnv: { DISPLAY: ":9", XAUTHORITY: "/current/auth" },
      platform: "linux",
      parentPid: 20,
      uid: 1000,
      readTextFile
    });

    expect(environment.DISPLAY).toBe(":9");
    expect(environment.XAUTHORITY).toBe("/current/auth");
  });

  it("does not inspect an ancestor owned by another uid", async () => {
    const readTextFile = procReader({
      "/proc/20/status": "Name:\tlauncher\nPPid:\t1\nUid:\t2000\t2000\t2000\t2000\n"
    });

    const environment = await resolveDesktopOpenEnvironment({
      baseEnv: { PATH: "/bin" },
      platform: "linux",
      parentPid: 20,
      uid: 1000,
      readTextFile
    });

    expect(environment).toEqual({ PATH: "/bin" });
    expect(readTextFile).not.toHaveBeenCalledWith("/proc/20/environ");
  });

  it("does not read procfs on non-Linux platforms", async () => {
    const readTextFile = vi.fn();

    const environment = await resolveDesktopOpenEnvironment({
      baseEnv: { PATH: "/bin" },
      platform: "darwin",
      parentPid: 20,
      uid: 1000,
      readTextFile
    });

    expect(environment).toEqual({ PATH: "/bin" });
    expect(readTextFile).not.toHaveBeenCalled();
  });
});
