#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const EXPECTED_NAME = "AIPageGo — AI 网页助手";
const REQUIRED_PERMISSIONS = [
  "sidePanel",
  "storage",
  "scripting",
  "activeTab",
  "tabs",
  "tabGroups",
  "webNavigation",
  "contextMenus",
  "alarms",
];
const OPTIONAL_PERMISSIONS = ["debugger", "bookmarks", "history", "downloads", "notifications"];
const EXPECTED_HOST_PERMISSIONS = [
  "<all_urls>",
  "ws://127.0.0.1/*",
  "ws://localhost/*",
];
const REQUIRED_CHECKLIST_ITEMS = [
  "128×128 商店图标",
  "扩展图标",
  "1280×800 截图",
  "简体中文文案",
  "英文文案",
  "中文隐私政策",
  "English privacy policy",
  "权限说明",
  "Permission explanations",
  "支持地址",
];
const REQUIRED_SCREENSHOTS = [
  "01-onboarding.png",
  "02-page-task.png",
  "03-solidify.png",
  "04-dangerous-approval.png",
];
const MATERIAL_FILES = [
  "store-assets/icon-128.png",
  "store-assets/listing.zh-CN.md",
  "store-assets/listing.en.md",
  "store-assets/submission-checklist.md",
  "docs-site/privacy.md",
  "docs-site/permissions.md",
  "docs-site/en/privacy.md",
  "docs-site/en/permissions.md",
  ...REQUIRED_SCREENSHOTS.map((name) => `store-assets/screenshots/${name}`),
];

const FORBIDDEN_PATHS = [
  { id: "source-map", re: /\.map$/i },
  { id: "tests", re: /(^|\/)(tests?|__tests__)(\/|$)/i },
  { id: "fixtures", re: /(^|\/)(fixtures?|testdata)(\/|$)/i },
  { id: "workflow-drafts", re: /(^|\/)docs\/tasks(\/|$)/i },
  { id: "dependencies", re: /(^|\/)node_modules(\/|$)/i },
  { id: "coverage", re: /(^|\/)coverage(\/|$)/i },
  { id: "repository-metadata", re: /(^|\/)(\.git|\.github)(\/|$)/i },
  { id: "local-agent-config", re: /(^|\/)(\.claude|\.codex|\.agents?|\.cursor|\.windsurf|\.idea|\.vscode|\.zed|\.fleet|\.workflow-plan)(\/|$)/i },
  { id: "agent-instructions", re: /(^|\/)((AGENTS|CLAUDE|GEMINI|CURSOR)\.md|\.cursorrules)$/i },
  { id: "dotenv", re: /(^|\/)\.env($|\.)/i },
  { id: "local-config", re: /(^|\/)[^/]*\.local($|\.)/i },
];

const SECRET_PATTERNS = [
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { id: "github-token", re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { id: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
  { id: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{24,}/ },
  { id: "openai-key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/ },
  { id: "bearer-token", re: /Authorization["']?\s*[:=]\s*["']Bearer\s+[A-Za-z0-9._~-]{24,}/i },
];

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".otf",
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--") continue;
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    out[key.slice(2)] = value;
  }
  return out;
}

function jsonFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function normalizedSet(values) {
  return [...new Set(Array.isArray(values) ? values : [])].sort();
}

function sameSet(actual, expected) {
  return JSON.stringify(normalizedSet(actual)) === JSON.stringify(normalizedSet(expected));
}

function globRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function pngSize(bytes) {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function collectManifestReferences(manifest) {
  const refs = new Set();
  for (const value of Object.values(manifest.icons ?? {})) refs.add(value);
  for (const value of Object.values(manifest.action?.default_icon ?? {})) refs.add(value);
  if (manifest.background?.service_worker) refs.add(manifest.background.service_worker);
  if (manifest.side_panel?.default_path) refs.add(manifest.side_panel.default_path);
  for (const entry of manifest.content_scripts ?? []) {
    for (const value of entry.js ?? []) refs.add(value);
    for (const value of entry.css ?? []) refs.add(value);
  }
  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const value of entry.resources ?? []) refs.add(value);
  }
  return [...refs];
}

function checklistField(checklist, label) {
  const line = checklist.split(/\r?\n/).find((candidate) => candidate.includes(`${label}：`));
  return line?.slice(line.indexOf("：") + 1).trim() ?? "";
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sourceExtensionKey(repo) {
  const sourcePath = path.join(repo, "packages/extension/src/manifest.ts");
  if (!existsSync(sourcePath)) return null;
  const match = readFileSync(sourcePath, "utf8").match(/const\s+extensionKey\s*=\s*["']([^"']+)["']/);
  return match?.[1] ?? null;
}

function fail(errors, code, message) {
  errors.push({ code, message });
}

function zipEntries(zip) {
  return execFileSync("unzip", ["-Z1", zip], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split(/\r?\n/)
    .map((entry) => entry.replace(/^\.\//, ""))
    .filter(Boolean);
}

function zipRead(zip, entry) {
  return execFileSync("unzip", ["-p", zip, entry], {
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
  });
}

export function auditStorePackage(options) {
  const repo = path.resolve(options.repo);
  const zip = path.resolve(options.zip);
  const expectedVersion = options.version;
  const tag = options.tag;
  const errors = [];

  if (!existsSync(zip)) {
    fail(errors, "zip.missing", "package ZIP does not exist");
    return { ok: false, version: expectedVersion, zip, errors };
  }

  let entries;
  try {
    entries = zipEntries(zip);
  } catch {
    fail(errors, "zip.unreadable", "unable to list package ZIP");
    return { ok: false, version: expectedVersion, zip, errors };
  }
  const files = entries.filter((entry) => !entry.endsWith("/"));
  const fileSet = new Set(files);

  if (!fileSet.has("manifest.json")) {
    fail(errors, "zip.root_manifest", "manifest.json must be at the ZIP root");
  }
  if (files.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) {
    fail(errors, "zip.unsafe_path", "ZIP contains an unsafe path");
  }
  if (fileSet.size !== files.length) {
    fail(errors, "zip.duplicate_entry", "ZIP contains duplicate file entries");
  }

  for (const entry of files) {
    const rule = FORBIDDEN_PATHS.find(({ re }) => re.test(entry));
    if (rule) fail(errors, "archive.forbidden_path", `${entry} matches ${rule.id}`);
  }

  let manifest = null;
  if (fileSet.has("manifest.json")) {
    try {
      manifest = JSON.parse(zipRead(zip, "manifest.json").toString("utf8"));
    } catch {
      fail(errors, "manifest.invalid", "manifest.json is not valid JSON");
    }
  }

  if (manifest) {
    if (manifest.manifest_version !== 3) fail(errors, "manifest.version", "manifest_version must be 3");
    if (manifest.name !== EXPECTED_NAME) fail(errors, "manifest.name", "extension name does not match the store listing");
    if (manifest.version !== expectedVersion) fail(errors, "version.manifest", "manifest version does not match expected version");
    const expectedKey = sourceExtensionKey(repo);
    if (!expectedKey || manifest.key !== expectedKey) fail(errors, "manifest.key", "built extension key differs from the committed key");
    if (!sameSet(manifest.permissions, REQUIRED_PERMISSIONS)) fail(errors, "manifest.permissions", "required permission set changed");
    if (!sameSet(manifest.optional_permissions, OPTIONAL_PERMISSIONS)) fail(errors, "manifest.optional_permissions", "optional permission set changed");
    if (!sameSet(manifest.host_permissions, EXPECTED_HOST_PERMISSIONS)) fail(errors, "manifest.host_permissions", "host permission set changed");

    for (const reference of collectManifestReferences(manifest)) {
      const found = reference.includes("*") || reference.includes("?")
        ? files.some((entry) => globRegex(reference).test(entry))
        : fileSet.has(reference);
      if (!found) fail(errors, "manifest.reference_missing", `manifest reference is missing: ${reference}`);
    }
  }

  const extensionPackage = path.join(repo, "packages/extension/package.json");
  const rootPackage = path.join(repo, "package.json");
  try {
    if (jsonFile(extensionPackage).version !== expectedVersion) {
      fail(errors, "version.extension_package", "extension package version does not match expected version");
    }
    if (tag && jsonFile(rootPackage).version !== expectedVersion) {
      fail(errors, "version.root_package", "tag builds require the root package version to match");
    }
  } catch {
    fail(errors, "version.package_json", "unable to read package versions");
  }
  if (path.basename(zip) !== `aipagego-${expectedVersion}.zip`) {
    fail(errors, "version.zip_filename", "ZIP filename does not match expected version");
  }
  if (tag && tag.replace(/^v/, "") !== expectedVersion) {
    fail(errors, "version.tag", "tag does not match expected version");
  }

  for (const entry of files) {
    if (BINARY_EXTENSIONS.has(path.extname(entry).toLowerCase())) continue;
    let content;
    try {
      content = zipRead(zip, entry).toString("utf8");
    } catch {
      fail(errors, "archive.read_failed", `unable to inspect ${entry}`);
      continue;
    }
    const match = SECRET_PATTERNS.find(({ re }) => re.test(content));
    if (match) fail(errors, "archive.secret", `${entry} matches secret rule ${match.id}`);
  }

  for (const relative of MATERIAL_FILES) {
    if (!existsSync(path.join(repo, relative))) fail(errors, "materials.missing", `required material is missing: ${relative}`);
  }
  const storeIcon = path.join(repo, "store-assets/icon-128.png");
  if (existsSync(storeIcon)) {
    const size = pngSize(readFileSync(storeIcon));
    if (!size || size.width !== 128 || size.height !== 128) fail(errors, "materials.icon_size", "store icon must be 128x128 PNG");
  }
  for (const name of REQUIRED_SCREENSHOTS) {
    const screenshot = path.join(repo, "store-assets/screenshots", name);
    if (!existsSync(screenshot)) continue;
    const size = pngSize(readFileSync(screenshot));
    if (!size || size.width !== 1280 || size.height !== 800) {
      fail(errors, "materials.screenshot_size", `${name} must be 1280x800 PNG`);
    }
  }

  for (const listing of ["store-assets/listing.zh-CN.md", "store-assets/listing.en.md"]) {
    const file = path.join(repo, listing);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const required of ["https://attson.github.io/aipagego/", "privacy", "permissions", "https://github.com/attson/aipagego/issues"]) {
      if (!text.includes(required)) fail(errors, "materials.listing_link", `${listing} is missing a required link`);
    }
  }

  const checklistPath = path.join(repo, "store-assets/submission-checklist.md");
  if (existsSync(checklistPath)) {
    const checklist = readFileSync(checklistPath, "utf8");
    for (const item of REQUIRED_CHECKLIST_ITEMS) {
      if (!checklist.split(/\r?\n/).some((line) => /^- \[x\]/i.test(line) && line.includes(item))) {
        fail(errors, "materials.checklist", `required checklist item is not complete: ${item}`);
      }
    }
    const status = checklist.match(/当前状态：`([^`]+)`/)?.[1];
    const allowed = new Set(["materials_ready", "submitted", "in_review", "published"]);
    if (!status || !allowed.has(status)) {
      fail(errors, "materials.status", "submission status is missing or invalid");
    } else if (status !== "materials_ready") {
      const submitter = checklistField(checklist, "提交人");
      const submittedAt = checklistField(checklist, "提交时间");
      const evidence = checklistField(checklist, "商店后台证据");
      if (!submitter || submitter === "未提交" || !submittedAt || submittedAt === "未提交" || !evidence || evidence === "未提交") {
        fail(errors, "materials.external_state_evidence", `${status} requires human submission evidence`);
      }
      if (status === "published") {
        const publicUrl = checklistField(checklist, "公开商店 URL");
        if (!/^https:\/\//.test(publicUrl)) fail(errors, "materials.external_state_evidence", "published requires a public HTTPS store URL");
      }
    }
    if (!checklist.includes("aipagego-<version>.zip")) {
      fail(errors, "materials.zip_template", "checklist ZIP template is missing or stale");
    }
  }

  return {
    ok: errors.length === 0,
    version: expectedVersion,
    tag: tag ?? null,
    zip: path.basename(zip),
    sha256: sha256(zip),
    entries: files.length,
    status: existsSync(checklistPath)
      ? readFileSync(checklistPath, "utf8").match(/当前状态：`([^`]+)`/)?.[1] ?? null
      : null,
    errors,
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    const repo = path.resolve(args.repo ?? process.cwd());
    const version = args.version ?? jsonFile(path.join(repo, "packages/extension/package.json")).version;
    const zip = path.resolve(args.zip ?? path.join(repo, `aipagego-${version}.zip`));
    const tag = args.tag ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);
    args = { ...args, repo, version, zip, tag };
  } catch (error) {
    process.stderr.write(`[args.invalid] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }

  const result = auditStorePackage(args);
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.report) writeFileSync(path.resolve(args.report), output);
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`[${error.code}] ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(output);
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(new URL(import.meta.url).pathname)) main();
