import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function read(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("P4 connector and secure-sharing documentation", () => {
  it("documents connector delivery and two-phase package review in both languages", () => {
    const zh = read("docs-site/advanced/connectors-sharing.md");
    for (const term of [
      "Webhook", "飞书/Lark Base", "persistent", "session", "unknown_commit",
      "tool-package/v1", "preview", "digest", "dangerous",
    ]) expect(zh).toContain(term);

    const en = read("docs-site/en/advanced/connectors-sharing.md");
    for (const term of [
      "Webhook", "Feishu/Lark Base", "persistent", "session", "unknown_commit",
      "tool-package/v1", "preview", "digest", "dangerous",
    ]) expect(en).toContain(term);

    expect(read("docs-site/.vitepress/config.ts")).toContain("connectors-sharing");
  });

  it("documents Job destinations and keeps delivery failure separate from tool success", () => {
    const zh = read("docs-site/advanced/jobs.md");
    expect(zh).toContain("connector destination");
    expect(zh).toContain("工具执行成功");
    expect(zh).toContain("needs_attention");

    const en = read("docs-site/en/advanced/jobs.md");
    expect(en).toContain("connector destination");
    expect(en).toContain("tool run remains successful");
    expect(en).toContain("needs_attention");
  });

  it("states the credential, permission, and user-configured external-system boundaries", () => {
    for (const file of ["docs-site/privacy.md", "docs-site/en/privacy.md"]) {
      const content = read(file);
      expect(content).toContain("aipagego.connectorSecrets");
      expect(content).toContain("IndexedDB");
      expect(content).toMatch(/分享包|share package/);
      expect(content).toMatch(/日志|logs/);
    }
    for (const file of ["docs-site/permissions.md", "docs-site/en/permissions.md"]) {
      const content = read(file);
      expect(content).toMatch(/无需新增 Chrome 权限|no additional Chrome permission/);
      expect(content).toMatch(/用户配置|user-configured/);
    }
  });
});
