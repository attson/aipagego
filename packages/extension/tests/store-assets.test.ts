import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import manifest from "@/manifest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function pngSize(relativePath: string): { width: number; height: number } {
  const bytes = readFileSync(path.join(repoRoot, relativePath));
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("Chrome Web Store assets", () => {
  it("declares complete extension icons and ships every referenced PNG", () => {
    const expected = {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    };
    const staticManifest = manifest as {
      icons?: unknown;
      action?: { default_icon?: unknown };
    };
    expect(staticManifest.icons).toEqual(expected);
    expect(staticManifest.action?.default_icon).toEqual(expected);
    for (const [size, relative] of Object.entries(expected)) {
      expect(pngSize(`packages/extension/public/${relative}`)).toEqual({
        width: Number(size),
        height: Number(size),
      });
    }
    expect(pngSize("store-assets/icon-128.png")).toEqual({ width: 128, height: 128 });
  });

  it("ships 1280x800 screenshots for onboarding, page work, solidification, and approval", () => {
    for (const name of [
      "01-onboarding.png",
      "02-page-task.png",
      "03-solidify.png",
      "04-dangerous-approval.png",
    ]) {
      expect(pngSize(`store-assets/screenshots/${name}`), name).toEqual({
        width: 1280,
        height: 800,
      });
    }
  });

  it("keeps bilingual listing copy linked to privacy, permissions, and support", () => {
    for (const file of ["listing.zh-CN.md", "listing.en.md"]) {
      const content = readFileSync(path.join(repoRoot, "store-assets", file), "utf8");
      expect(content).toContain("https://attson.github.io/aipagego/");
      expect(content).toContain("privacy");
      expect(content).toContain("permissions");
      expect(content).toContain("https://github.com/attson/aipagego/issues");
    }
    for (const file of [
      "docs-site/privacy.md",
      "docs-site/permissions.md",
      "docs-site/en/privacy.md",
      "docs-site/en/permissions.md",
      "store-assets/submission-checklist.md",
    ]) {
      expect(() => readFileSync(path.join(repoRoot, file), "utf8")).not.toThrow();
    }
  });
});
