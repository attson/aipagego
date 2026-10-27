import { z } from "zod";
import { stableJsonStringify } from "./jobs";
import { CanonicalToolSchema } from "./messages";
import type { Json, PromptTool, StepsTool, Tool } from "./types";

export const ToolSharePackageV1Schema = z.object({
  schema: z.literal("aipagego.tool-package/v1"),
  exportedAt: z.number().finite().nonnegative(),
  package: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
  }).strict(),
  tools: z.array(CanonicalToolSchema).min(1),
}).strict();

export type ToolSharePackageV1 = z.infer<typeof ToolSharePackageV1Schema>;

export type PackageSecretFinding = {
  rule:
    | "sensitive-key-literal"
    | "sensitive-parameter-default"
    | "authorization-scheme"
    | "cookie-header"
    | "token-pattern"
    | "private-key"
    | "url-userinfo"
    | "url-sensitive-query";
  path: string;
};

export type ImportConflictAction = "copy" | "skip" | "overwrite";
export type ImportSeverity = "safe" | "caution" | "dangerous";
export type ImportErrorCode =
  | "invalid_tool"
  | "package_unknown_capability"
  | "package_secret_detected"
  | "package_dangerous_confirmation_required"
  | "import_write_failed";

export type ImportPreviewItem = {
  index: number;
  valid: boolean;
  toolId?: string;
  name?: string;
  kind?: Tool["kind"];
  activeVersion?: number;
  urlPatterns: string[];
  hosts: string[];
  capabilities: string[];
  severity: ImportSeverity;
  dangerousSteps: string[];
  conflict: boolean;
  dependentJobs: number;
  suggestedAction: ImportConflictAction;
  errorCode?: Extract<ImportErrorCode, "invalid_tool" | "package_unknown_capability">;
};

export type ImportPreview = {
  schema: "aipagego.tools/v2" | "aipagego.tools/v3" | "aipagego.tool-package/v1";
  digest: string;
  secretFindings: PackageSecretFinding[];
  items: ImportPreviewItem[];
};

export type ImportCommitResult = {
  items: Array<{
    index: number;
    status: "imported" | "skipped" | "rejected";
    id?: string;
    code?: ImportErrorCode;
  }>;
};

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "apikey",
  "token",
  "secret",
  "password",
]);

const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "key",
  "api_key",
  "signature",
  "secret",
  "password",
]);

function pathForKey(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return ["apikey", "token", "secret", "password"].some((suffix) =>
    normalized.endsWith(suffix)
  );
}

function parameterReference(value: string): string | undefined {
  return /^\$\{([A-Za-z_][A-Za-z0-9_.-]*)\}$/.exec(value.trim())?.[1];
}

function isAllowedSensitiveReference(value: string, sensitiveParameters: Set<string>): boolean {
  const direct = parameterReference(value);
  if (direct && sensitiveParameters.has(direct)) return true;
  const authorization = /^(?:Bearer|Basic)\s+(\$\{[A-Za-z_][A-Za-z0-9_.-]*\})$/i.exec(value.trim());
  const referenced = authorization ? parameterReference(authorization[1]) : undefined;
  return referenced !== undefined && sensitiveParameters.has(referenced);
}

function isAllowedUserInfoReference(value: string, sensitiveParameters: Set<string>): boolean {
  const parts = value.split(":");
  return parts.length > 0 && parts.every((part) => {
    const referenced = parameterReference(part);
    return referenced !== undefined && sensitiveParameters.has(referenced);
  });
}

function hasNonEmptyLiteral(value: unknown, sensitiveParameters: Set<string>): boolean {
  if (value == null || value === "") return false;
  if (typeof value === "string") {
    return value.trim() !== "" && !isAllowedSensitiveReference(value, sensitiveParameters);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasNonEmptyLiteral(item, sensitiveParameters));
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) =>
      hasNonEmptyLiteral(item, sensitiveParameters)
    );
  }
  return true;
}

function sensitiveParametersIn(value: Record<string, unknown>, inherited: Set<string>): Set<string> {
  if (!Array.isArray(value.parameters)) return inherited;
  const next = new Set(inherited);
  for (const candidate of value.parameters) {
    if (
      candidate !== null
      && typeof candidate === "object"
      && !Array.isArray(candidate)
      && (candidate as Record<string, unknown>).sensitive === true
      && typeof (candidate as Record<string, unknown>).key === "string"
    ) {
      next.add((candidate as Record<string, string>).key);
    }
  }
  return next;
}

export function scanLiteralSecrets(value: unknown): PackageSecretFinding[] {
  const findings: PackageSecretFinding[] = [];
  const seen = new Set<string>();
  const add = (rule: PackageSecretFinding["rule"], path: string): void => {
    const key = `${rule}\0${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, path });
  };

  const visitString = (text: string, path: string, sensitiveParameters: Set<string>): void => {
    const authorization = /\b(?:Bearer|Basic)\s+(\$\{[A-Za-z_][A-Za-z0-9_.-]*\}|[^\s"']+)/i.exec(text);
    if (authorization && !isAllowedSensitiveReference(authorization[0], sensitiveParameters)) {
      add("authorization-scheme", path);
    }
    const cookie = /["']?Cookie["']?\s*:\s*["']?(\$\{[A-Za-z_][A-Za-z0-9_.-]*\}|[^\s,;}"']+)/i.exec(text);
    if (cookie && !isAllowedSensitiveReference(cookie[1], sensitiveParameters)) {
      add("cookie-header", path);
    }
    if (
      /\bsk-[A-Za-z0-9_-]{16,}\b/.test(text)
      || /\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text)
      || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(text)
      || /\bglpat-[A-Za-z0-9_-]{20,}\b/.test(text)
    ) {
      add("token-pattern", path);
    }
    if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text)) {
      add("private-key", path);
    }

    const userInfo = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\s/?#@]+)@/.exec(text);
    if (userInfo && !isAllowedUserInfoReference(userInfo[1], sensitiveParameters)) {
      add("url-userinfo", path);
    }

    const queryPattern = /[?&]([^=&#]+)=([^&#]*)/g;
    let queryMatch: RegExpExecArray | null;
    while ((queryMatch = queryPattern.exec(text)) !== null) {
      let queryKey = queryMatch[1];
      try { queryKey = decodeURIComponent(queryKey); } catch { /* compare the raw key */ }
      if (
        SENSITIVE_QUERY_KEYS.has(queryKey.toLowerCase())
        && queryMatch[2] !== ""
        && !isAllowedSensitiveReference(queryMatch[2], sensitiveParameters)
      ) {
        add("url-sensitive-query", path);
      }
    }
  };

  const visit = (
    candidate: unknown,
    path: string,
    inherited: Set<string>,
    inJsonSchema = false,
    schemaPropertyMap = false,
  ): void => {
    if (typeof candidate === "string") {
      visitString(candidate, path, inherited);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(
        item,
        `${path}[${index}]`,
        inherited,
        inJsonSchema,
        schemaPropertyMap,
      ));
      return;
    }
    if (candidate == null || typeof candidate !== "object") return;

    const record = candidate as Record<string, unknown>;
    const sensitiveParameters = sensitiveParametersIn(record, inherited);
    if (
      record.sensitive === true
      && typeof record.key === "string"
      && Object.prototype.hasOwnProperty.call(record, "defaultValue")
    ) {
      add("sensitive-parameter-default", pathForKey(path, "defaultValue"));
    }

    for (const [key, child] of Object.entries(record)) {
      const childPath = pathForKey(path, key);
      if (
        !schemaPropertyMap
        && isSensitiveKey(key)
        && hasNonEmptyLiteral(child, sensitiveParameters)
      ) {
        add("sensitive-key-literal", childPath);
      }
      const childInJsonSchema = inJsonSchema || key === "outputSchema";
      visit(
        child,
        childPath,
        sensitiveParameters,
        childInJsonSchema,
        childInJsonSchema && ["properties", "patternProperties", "$defs", "definitions"].includes(key),
      );
    }
  };

  visit(value, "$", new Set());
  return findings;
}

export function assertNoLiteralSecrets(value: unknown): void {
  const findings = scanLiteralSecrets(value);
  if (findings.length > 0) {
    throw new Error(`package_secret_detected:${JSON.stringify(findings)}`);
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createPortableToolSnapshot(tool: Tool): Tool {
  const { origin: _origin, ...metadata } = cloneJson(tool);
  if (tool.kind === "steps") {
    const active = tool.versions.find((version) => version.version === tool.activeVersion);
    if (!active) throw new Error(`active_tool_version_not_found: ${tool.id}:${tool.activeVersion}`);
    const { basedOnVersion: _basedOnVersion, ...snapshot } = cloneJson(active);
    return {
      ...metadata,
      kind: "steps",
      activeVersion: 1,
      versions: [{ ...snapshot, version: 1 }],
      stats: { runs: 0 },
    } as StepsTool;
  }

  const current = tool.versions.reduce((latest, version) =>
    version.version > latest.version ? version : latest
  );
  return {
    ...metadata,
    kind: "prompt",
    prompt: tool.prompt,
    versions: [{
      ...cloneJson(current),
      version: 1,
      prompt: tool.prompt,
    }],
    stats: { runs: 0 },
  } as PromptTool;
}

type WebCrypto = {
  subtle: {
    digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  };
};

export async function computeCanonicalJsonDigest(value: unknown): Promise<string> {
  const json = JSON.parse(JSON.stringify(value)) as Json;
  const bytes = new TextEncoder().encode(stableJsonStringify(json));
  const digest = await (globalThis as unknown as { crypto: WebCrypto }).crypto.subtle.digest(
    "SHA-256",
    bytes,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function computeToolPackageDigest(bundle: ToolSharePackageV1): Promise<string> {
  return computeCanonicalJsonDigest(bundle);
}
