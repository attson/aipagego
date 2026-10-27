import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const auditScript = path.join(repoRoot, "scripts/audit-store-package.mjs");

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function put(root: string, relative: string, content: string | Buffer): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function makeFixture(): { root: string; dist: string; zip: string } {
  const root = mkdtempSync(path.join(tmpdir(), "aipagego-store-audit-"));
  const dist = path.join(root, "packages/extension/dist");
  mkdirSync(dist, { recursive: true });

  const manifest = {
    manifest_version: 3,
    name: "AIPageGo — AI 网页助手",
    version: "1.2.3",
    key: "public-extension-key",
    permissions: ["sidePanel", "storage", "scripting", "activeTab", "tabs", "tabGroups", "webNavigation", "contextMenus", "alarms"],
    optional_permissions: ["debugger", "bookmarks", "history", "downloads", "notifications"],
    host_permissions: ["<all_urls>", "ws://127.0.0.1/*", "ws://localhost/*"],
    icons: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" },
    action: { default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" } },
    background: { service_worker: "service-worker-loader.js" },
    side_panel: { default_path: "src/sidepanel/index.html" },
    content_scripts: [{ matches: ["<all_urls>"], js: ["assets/content.js"] }],
    web_accessible_resources: [{ matches: ["<all_urls>"], resources: ["assets/*.js"] }],
  };
  put(root, "packages/extension/dist/manifest.json", JSON.stringify(manifest));
  put(root, "packages/extension/dist/service-worker-loader.js", "export {};\n");
  put(root, "packages/extension/dist/src/sidepanel/index.html", "<!doctype html><title>AIPageGo</title>");
  put(root, "packages/extension/dist/assets/content.js", "export const ready = true;\n");
  for (const size of [16, 32, 48, 128]) {
    put(root, `packages/extension/dist/icons/icon-${size}.png`, png(size, size));
  }

  put(root, "package.json", JSON.stringify({ version: "1.2.3" }));
  put(root, "packages/extension/package.json", JSON.stringify({ version: "1.2.3" }));
  put(root, "packages/extension/src/manifest.ts", 'const extensionKey = "public-extension-key";\n');
  put(root, "store-assets/icon-128.png", png(128, 128));
  for (const name of [
    "01-onboarding.png",
    "02-page-task.png",
    "03-solidify.png",
    "04-dangerous-approval.png",
  ]) {
    put(root, `store-assets/screenshots/${name}`, png(1280, 800));
  }
  const links = [
    "https://attson.github.io/aipagego/privacy",
    "https://attson.github.io/aipagego/permissions",
    "https://github.com/attson/aipagego/issues",
  ].join("\n");
  put(root, "store-assets/listing.zh-CN.md", links);
  put(root, "store-assets/listing.en.md", links);
  put(root, "docs-site/privacy.md", "privacy");
  put(root, "docs-site/permissions.md", "permissions");
  put(root, "docs-site/en/privacy.md", "privacy");
  put(root, "docs-site/en/permissions.md", "permissions");
  put(
    root,
    "store-assets/submission-checklist.md",
    [
      "当前状态：`materials_ready`",
      "ZIP 文件名：`aipagego-<version>.zip`",
      "- [x] 128×128 商店图标",
      "- [x] 扩展图标",
      "- [x] 1280×800 截图",
      "- [x] 简体中文文案",
      "- [x] 英文文案",
      "- [x] 中文隐私政策",
      "- [x] English privacy policy",
      "- [x] 权限说明",
      "- [x] Permission explanations",
      "- [x] 支持地址",
      "- 提交人：未提交",
      "- 提交时间：未提交",
      "- 商店后台证据：未提交",
      "- 公开商店 URL：未发布",
    ].join("\n"),
  );

  const zip = path.join(root, "aipagego-1.2.3.zip");
  const packed = spawnSync("zip", ["-q", "-r", zip, "."], { cwd: dist });
  if (packed.status !== 0) throw new Error(String(packed.stderr));
  return { root, dist, zip };
}

function repack(dist: string, zip: string): void {
  const packed = spawnSync("zip", ["-q", "-r", "-FS", zip, "."], { cwd: dist });
  if (packed.status !== 0) throw new Error(String(packed.stderr));
}

function audit(fixture: { root: string; zip: string }, extra: string[] = []) {
  return spawnSync(
    process.execPath,
    [auditScript, "--repo", fixture.root, "--zip", fixture.zip, "--version", "1.2.3", "--tag", "v1.2.3", ...extra],
    { encoding: "utf8" },
  );
}

describe("Chrome Web Store package audit", () => {
  it("accepts a root-level, version-aligned package with complete materials", () => {
    const fixture = makeFixture();
    const result = audit(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, version: "1.2.3" });
  });

  it("derives local audit inputs from the repository when flags are omitted", () => {
    const fixture = makeFixture();
    const report = path.join(fixture.root, "audit-report.json");
    const result = spawnSync(process.execPath, [auditScript, "--", "--report", report], {
      cwd: fixture.root,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      zip: "aipagego-1.2.3.zip",
    });
    expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({ ok: true });
  });

  it("rejects a ZIP that wraps the extension in an extra directory", () => {
    const fixture = makeFixture();
    const nestedZip = path.join(fixture.root, "aipagego-1.2.3.zip");
    unlinkSync(nestedZip);
    const packed = spawnSync("zip", ["-q", "-r", nestedZip, "dist"], {
      cwd: path.dirname(fixture.dist),
    });
    expect(packed.status).toBe(0);
    const result = audit({ root: fixture.root, zip: nestedZip });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("zip.root_manifest");
  });

  it("rejects source maps and test fixtures", () => {
    const fixture = makeFixture();
    put(fixture.root, "packages/extension/dist/assets/app.js.map", "{}");
    put(fixture.root, "packages/extension/dist/tests/fixture.json", "{}");
    repack(fixture.dist, fixture.zip);
    const result = audit(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("archive.forbidden_path");
  });

  it("rejects common agent instruction and IDE configuration files", () => {
    const fixture = makeFixture();
    put(fixture.root, "packages/extension/dist/.cursor/rules/store.mdc", "local agent rule");
    put(fixture.root, "packages/extension/dist/AGENTS.md", "local agent instructions");
    repack(fixture.dist, fixture.zip);
    const result = audit(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("archive.forbidden_path");
  });

  it("rejects common credential patterns without printing the credential", () => {
    const fixture = makeFixture();
    const secret = `sk-ant-api03-${"A".repeat(48)}`;
    put(fixture.root, "packages/extension/dist/assets/leak.js", `const leaked = ${JSON.stringify(secret)};`);
    repack(fixture.dist, fixture.zip);
    const result = audit(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("archive.secret");
    expect(result.stderr).not.toContain(secret);
  });

  it("rejects legacy and service-account OpenAI keys without printing them", () => {
    const fixture = makeFixture();
    const legacyKey = `sk-${"B".repeat(48)}`;
    const serviceKey = `sk-svcacct-${"C".repeat(32)}`;
    put(
      fixture.root,
      "packages/extension/dist/assets/openai-leak.js",
      `export const keys = ${JSON.stringify([legacyKey, serviceKey])};`,
    );
    repack(fixture.dist, fixture.zip);
    const result = audit(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("archive.secret");
    expect(result.stderr).not.toContain(legacyKey);
    expect(result.stderr).not.toContain(serviceKey);
  });

  it("rejects missing manifest-referenced files", () => {
    const fixture = makeFixture();
    const manifestPath = path.join(fixture.dist, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.icons[128] = "icons/missing.png";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    repack(fixture.dist, fixture.zip);
    const result = audit(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("manifest.reference_missing");
  });

  it("requires manifest, package, tag, and ZIP filename versions to agree", () => {
    const fixture = makeFixture();
    const wrongName = path.join(fixture.root, "aipagego-9.9.9.zip");
    const packed = spawnSync("zip", ["-q", "-r", wrongName, "."], { cwd: fixture.dist });
    expect(packed.status).toBe(0);
    const result = audit({ root: fixture.root, zip: wrongName });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("version.zip_filename");
  });

  it("does not accept an external published state without evidence", () => {
    const fixture = makeFixture();
    const checklist = path.join(fixture.root, "store-assets/submission-checklist.md");
    writeFileSync(
      checklist,
      readFileSync(checklist, "utf8").replace("`materials_ready`", "`published`"),
    );
    const result = audit(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("materials.external_state_evidence");
  });
});
