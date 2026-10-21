import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  loadLastPort,
  loadOrCreateIdentity,
  processInfo,
  saveLastPort
} from "../src/identity";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "aipagego-id-"));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadOrCreateIdentity", () => {
  it("creates a 0600 file with an install id and secret", () => {
    const d = tmp();
    const id = loadOrCreateIdentity(d);
    expect(id.installId).toMatch(/^inst_/);
    expect(id.secret.length).toBeGreaterThanOrEqual(24);
    expect(statSync(join(d, "identity.json")).mode & 0o777).toBe(0o600);
  });

  it("is stable across calls", () => {
    const d = tmp();
    expect(loadOrCreateIdentity(d)).toEqual(loadOrCreateIdentity(d));
  });

  it("replaces a corrupt file instead of throwing", () => {
    const d = tmp();
    writeFileSync(join(d, "identity.json"), "{not json");
    expect(loadOrCreateIdentity(d).installId).toMatch(/^inst_/);
  });

  it("replaces a file missing the required fields", () => {
    const d = tmp();
    writeFileSync(join(d, "identity.json"), JSON.stringify({ lastPort: 1 }));
    expect(loadOrCreateIdentity(d).secret).toBeTruthy();
  });

  it("gives different installs different secrets", () => {
    expect(loadOrCreateIdentity(tmp()).secret).not.toBe(loadOrCreateIdentity(tmp()).secret);
  });
});

describe("lastPort", () => {
  it("round-trips without disturbing the identity", () => {
    const d = tmp();
    const id = loadOrCreateIdentity(d);
    saveLastPort(51234, d);
    expect(loadLastPort(d)).toBe(51234);
    expect(loadOrCreateIdentity(d)).toEqual(id);
  });

  it("is undefined before anything is saved", () => {
    expect(loadLastPort(tmp())).toBeUndefined();
  });

  it("creates an identity when saving into an empty directory", () => {
    const d = tmp();
    saveLastPort(9999, d);
    expect(loadOrCreateIdentity(d).installId).toMatch(/^inst_/);
    expect(loadLastPort(d)).toBe(9999);
  });

  it("overwrites a previous port", () => {
    const d = tmp();
    saveLastPort(1111, d);
    saveLastPort(2222, d);
    expect(loadLastPort(d)).toBe(2222);
  });
});

describe("processInfo", () => {
  it("collapses the home prefix in the label", () => {
    const info = processInfo(join(homedir(), "code", "aipagego"));
    expect(info.label).toBe("~/code/aipagego");
  });

  it("leaves a path outside home alone", () => {
    expect(processInfo("/tmp/elsewhere").label).toBe("/tmp/elsewhere");
  });

  it("reports the real pid", () => {
    expect(processInfo().pid).toBe(process.pid);
  });

  it("gives each call a distinct session id", () => {
    expect(processInfo().sessionId).not.toBe(processInfo().sessionId);
  });
});
