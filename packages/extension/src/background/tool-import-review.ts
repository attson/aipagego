import { capabilityForRunJs, capabilityForTool, type Capability } from "@aipagego/shared/capability";
import { JobSchema, type Job } from "@aipagego/shared/jobs";
import { CanonicalToolSchema, ToolSchema } from "@aipagego/shared/messages";
import { PRESETS } from "@aipagego/shared/presets";
import { highestSeverity, runStaticScan } from "@aipagego/shared/static-scan";
import {
  computeCanonicalJsonDigest,
  scanLiteralSecrets,
  ToolSharePackageV1Schema,
  type ImportCommitResult,
  type ImportConflictAction,
  type ImportPreview,
  type ImportPreviewItem,
  type ImportSeverity,
  type PackageSecretFinding,
} from "@aipagego/shared/tool-package";
import type { BuiltinTool, Json, Step, Tool } from "@aipagego/shared/types";
import { getDB } from "./storage/db";
import { sha256Json } from "./jobs/hash";

export type CommitToolImportInput = {
  bundle: unknown;
  digest: string;
  decisions?: Array<{ index: number; action: ImportConflictAction }>;
  approveDangerous?: boolean;
};

type SupportedSchema = ImportPreview["schema"];
type ParsedItem = {
  index: number;
  raw: unknown;
  tool?: Tool;
  errorCode?: ImportPreviewItem["errorCode"];
};

const SAFE_TOOLS = new Set<string>([
  "snapshotDOM", "querySelector", "querySelectorAll", "extractText", "extractImages",
  "scroll", "waitFor", "hover", "focus", "getValue", "extractFormState", "askUser",
  "screenshot", "searchBookmarks", "searchHistory", "switchToTab", "closeTab",
  "takeSnapshot", "highlightElement", "highlightText", "getPageInfo", "createPageIndex",
  "searchPageIndex", "readPageBlock", "extractPageFields", "consoleMessages", "findElements",
  "inspectElement", "navigate",
]);
const CAUTION_TOOLS = new Set<string>([
  "click", "fillInput", "setCheckbox", "selectOption", "clickByUid", "fillByUid",
  "fillForm", "downloadImage", "downloadSpreadsheet", "collectStructuredData", "pressKey",
  "networkRequests", "recorderConfig", "handleDialog", "drag", "navigateBack",
  "navigateForward", "resize", "drop",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonRecord(value: Json): Record<string, Json> {
  return isRecord(value) ? value as Record<string, Json> : {};
}

function hostFromPattern(pattern: string): string {
  return /^[A-Za-z*][A-Za-z0-9+.*-]*:\/\/([^/]+)/.exec(pattern)?.[1] ?? pattern;
}

function classifyStep(step: Step): ImportSeverity {
  if (step.kind === "js") {
    return highestSeverity(runStaticScan(step.source)) === "dangerous" ? "dangerous" : "caution";
  }
  if (SAFE_TOOLS.has(step.tool)) {
    if (step.tool === "navigate") {
      return jsonRecord(step.args).action === "goto" ? "caution" : "safe";
    }
    return "safe";
  }
  if (CAUTION_TOOLS.has(step.tool)) {
    const files = jsonRecord(step.args).files;
    if (step.tool === "drop" && Array.isArray(files) && files.length > 0) return "dangerous";
    return "caution";
  }
  if (step.tool === "httpRequest") {
    return jsonRecord(step.args).withCredentials === true ? "dangerous" : "caution";
  }
  return "dangerous";
}

function capabilityForStep(step: Step): Capability {
  if (step.kind === "js") {
    return capabilityForRunJs(highestSeverity(runStaticScan(step.source)) === "dangerous");
  }
  const args = jsonRecord(step.args);
  return capabilityForTool(step.tool as BuiltinTool, {
    httpCookied: args.withCredentials === true,
    dropHasFiles: Array.isArray(args.files) && args.files.length > 0,
    recorderArmsBodies: args.captureBodies === true,
  });
}

function auditTool(tool: Tool): Pick<ImportPreviewItem, "hosts" | "capabilities" | "severity" | "dangerousSteps"> {
  const hosts = [...new Set(tool.urlPatterns.map(hostFromPattern))].sort();
  if (tool.kind === "prompt") {
    return {
      hosts,
      capabilities: ["prompt:dynamic"],
      severity: "dangerous",
      dangerousSteps: ["dynamic prompt"],
    };
  }

  const capabilities = new Set<string>();
  const dangerousSteps: string[] = [];
  let severity: ImportSeverity = "safe";
  for (const version of tool.versions) {
    version.steps.forEach((step, stepIndex) => {
      capabilities.add(capabilityForStep(step));
      const stepSeverity = classifyStep(step);
      if (stepSeverity === "dangerous") {
        severity = "dangerous";
        dangerousSteps.push(
          `v${version.version} step ${stepIndex + 1}: ${step.kind === "js" ? "runJS" : step.tool}`,
        );
      } else if (stepSeverity === "caution" && severity === "safe") {
        severity = "caution";
      }
    });
  }
  return { hosts, capabilities: [...capabilities].sort(), severity, dangerousSteps };
}

function supportedBundle(raw: unknown): { schema: SupportedSchema; tools: unknown[] } {
  if (!isRecord(raw) || !Array.isArray(raw.tools)) throw new Error("invalid_bundle");
  if (
    raw.schema !== "aipagego.tools/v2"
    && raw.schema !== "aipagego.tools/v3"
    && raw.schema !== "aipagego.tool-package/v1"
  ) {
    throw new Error("invalid_bundle");
  }
  if (typeof raw.exportedAt !== "number" || !Number.isFinite(raw.exportedAt) || raw.exportedAt < 0) {
    throw new Error("invalid_bundle");
  }
  if (raw.schema === "aipagego.tool-package/v1") {
    const allowedKeys = new Set(["schema", "exportedAt", "package", "tools"]);
    const envelope = ToolSharePackageV1Schema.pick({
      schema: true,
      exportedAt: true,
      package: true,
    }).safeParse({
      schema: raw.schema,
      exportedAt: raw.exportedAt,
      package: raw.package,
    });
    if (
      !envelope.success
      || raw.tools.length === 0
      || Object.keys(raw).some((key) => !allowedKeys.has(key))
    ) throw new Error("invalid_bundle");
  }
  return { schema: raw.schema, tools: raw.tools };
}

function sanitizeOrigin(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw.origin) || raw.origin.kind !== "preset") return raw;
  const validPresetIds = new Set(PRESETS.map((preset) => preset.id));
  return typeof raw.origin.presetId === "string" && validPresetIds.has(raw.origin.presetId)
    ? raw
    : { ...raw, origin: undefined };
}

function hasUnknownBuiltinTool(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const stepGroups: unknown[][] = [];
  if (Array.isArray(raw.steps)) stepGroups.push(raw.steps);
  if (Array.isArray(raw.versions)) {
    for (const version of raw.versions) {
      if (isRecord(version) && Array.isArray(version.steps)) stepGroups.push(version.steps);
    }
  }
  for (const steps of stepGroups) {
    for (const step of steps) {
      if (!isRecord(step) || step.kind !== "tool" || typeof step.tool !== "string") continue;
      try {
        capabilityForTool(step.tool as BuiltinTool);
      } catch {
        return true;
      }
    }
  }
  return false;
}

function parseItems(raw: unknown): { schema: SupportedSchema; items: ParsedItem[] } {
  const bundle = supportedBundle(raw);
  const schema = bundle.schema === "aipagego.tools/v2" ? ToolSchema : CanonicalToolSchema;
  return {
    schema: bundle.schema,
    items: bundle.tools.map((candidate, index) => {
      const parsed = schema.safeParse(sanitizeOrigin(candidate));
      if (parsed.success) return { index, raw: candidate, tool: parsed.data as Tool };
      const unknownCapability = hasUnknownBuiltinTool(candidate);
      return {
        index,
        raw: candidate,
        errorCode: unknownCapability ? "package_unknown_capability" : "invalid_tool",
      };
    }),
  };
}

function findingAppliesToIndex(finding: PackageSecretFinding, index: number): boolean {
  const match = /^\$\.tools\[(\d+)\]/.exec(finding.path);
  return match ? Number(match[1]) === index : true;
}

async function buildPreview(raw: unknown): Promise<{ preview: ImportPreview; parsed: ParsedItem[] }> {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(JSON.stringify(raw)) as unknown;
  } catch {
    throw new Error("invalid_bundle");
  }
  const { schema, items } = parseItems(snapshot);
  const db = await getDB();
  const secretFindings = scanLiteralSecrets(snapshot);
  const previews: ImportPreviewItem[] = [];
  for (const item of items) {
    if (!item.tool) {
      previews.push({
        index: item.index,
        valid: false,
        urlPatterns: [],
        hosts: [],
        capabilities: [],
        severity: "dangerous",
        dangerousSteps: [],
        conflict: false,
        dependentJobs: 0,
        suggestedAction: "copy",
        errorCode: item.errorCode,
      });
      continue;
    }
    const tool = item.tool;
    const existing = await db.get("tools", tool.id);
    const jobs = await db.getAllFromIndex("jobs", "byToolId", tool.id);
    previews.push({
      index: item.index,
      valid: true,
      toolId: tool.id,
      name: tool.name,
      kind: tool.kind,
      ...(tool.kind === "steps" ? { activeVersion: tool.activeVersion } : {}),
      urlPatterns: tool.urlPatterns,
      ...auditTool(tool),
      conflict: existing !== undefined,
      dependentJobs: jobs.length,
      suggestedAction: "copy",
    });
  }
  return {
    parsed: items,
    preview: {
      schema,
      digest: await computeCanonicalJsonDigest(snapshot),
      secretFindings,
      items: previews,
    },
  };
}

export async function previewToolImport(raw: unknown): Promise<ImportPreview> {
  return (await buildPreview(raw)).preview;
}

async function versionHashes(incoming: Tool): Promise<Map<number, string>> {
  const hashes = new Map<number, string>();
  if (incoming.kind === "steps") {
    for (const version of incoming.versions) hashes.set(version.version, await sha256Json(version));
  }
  return hashes;
}

async function markChangedJobs(
  jobs: Job[],
  hashes: Map<number, string>,
  put: (job: Job) => Promise<unknown>,
): Promise<void> {
  const writes: Array<Promise<unknown>> = [];
  for (const job of jobs) {
    if (hashes.get(job.toolVersion) === job.toolVersionHash) continue;
    const updated = JobSchema.parse({
      ...job,
      status: "needs_attention",
      attentionReason: "tool_version_changed",
      nextRunAt: undefined,
      updatedAt: Date.now(),
    }) as Job;
    writes.push(put(updated));
  }
  await Promise.all(writes);
}

async function writeImportedTool(tool: Tool, action: ImportConflictAction): Promise<string | undefined> {
  const db = await getDB();
  if (action === "skip") return undefined;
  if (action === "copy") {
    const tx = db.transaction("tools", "readwrite");
    const existing = await tx.store.get(tool.id);
    const id = existing === undefined ? tool.id : crypto.randomUUID();
    await tx.store.put(id === tool.id ? tool : { ...tool, id });
    await tx.done;
    return id;
  }

  // WebCrypto yields to the event loop and would make an IndexedDB transaction
  // inactive. Compute immutable incoming hashes first, then keep every read and
  // write that enforces the tool/Job invariant inside one IDB transaction.
  const hashes = await versionHashes(tool);
  const tx = db.transaction(["tools", "jobs"], "readwrite");
  try {
    const jobs = await tx.objectStore("jobs").index("byToolId").getAll(tool.id);
    await markChangedJobs(jobs, hashes, (job) => tx.objectStore("jobs").put(job));
    await tx.objectStore("tools").put(tool);
    await tx.done;
    return tool.id;
  } catch (error) {
    try { tx.abort(); } catch { /* transaction may already be closed */ }
    await tx.done.catch(() => undefined);
    throw error;
  }
}

export async function commitToolImport(input: CommitToolImportInput): Promise<ImportCommitResult> {
  const { preview, parsed } = await buildPreview(input.bundle);
  if (preview.digest !== input.digest) throw new Error("import_digest_changed");
  const decisionByIndex = new Map(input.decisions?.map((decision) => [decision.index, decision.action]));
  const items: ImportCommitResult["items"] = [];

  for (const parsedItem of parsed) {
    const item = preview.items[parsedItem.index];
    if (!parsedItem.tool || !item.valid) {
      items.push({ index: parsedItem.index, status: "rejected", code: item.errorCode ?? "invalid_tool" });
      continue;
    }
    if (preview.secretFindings.some((finding) => findingAppliesToIndex(finding, parsedItem.index))) {
      items.push({ index: parsedItem.index, status: "rejected", code: "package_secret_detected" });
      continue;
    }
    if (item.severity === "dangerous" && input.approveDangerous !== true) {
      items.push({
        index: parsedItem.index,
        status: "rejected",
        code: "package_dangerous_confirmation_required",
      });
      continue;
    }

    const action = decisionByIndex.get(parsedItem.index) ?? "copy";
    if (action === "skip") {
      items.push({ index: parsedItem.index, status: "skipped" });
      continue;
    }
    try {
      const id = await writeImportedTool(parsedItem.tool, action);
      items.push({ index: parsedItem.index, status: "imported", ...(id === undefined ? {} : { id }) });
    } catch {
      items.push({ index: parsedItem.index, status: "rejected", code: "import_write_failed" });
    }
  }
  return { items };
}
