import { CanonicalToolSchema, ToolSchema } from "@aipagego/shared/messages";
import type { ExportBundle, Tool } from "@aipagego/shared/types";
import { PRESETS } from "@aipagego/shared/presets";
import { assertNoLiteralSecrets } from "@aipagego/shared/tool-package";
import { getDB } from "./db";

function parseTool(raw: unknown, canonicalOnly = false): { tool?: Tool; error?: string } {
  const parsed = (canonicalOnly ? CanonicalToolSchema : ToolSchema).safeParse(raw);
  return parsed.success
    ? { tool: parsed.data as Tool }
    : { error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
}

export async function exportAll(): Promise<ExportBundle> {
  const db = await getDB();
  const allTools = (await db.getAll("tools"))
    .map((raw) => parseTool(raw).tool)
    .filter((tool): tool is Tool => !!tool);
  // Gap Fix T8.5: exclude unmodified preset copies (origin.kind === "preset" && only 1 version)
  const tools = allTools.filter(
    (t) => !(t.origin?.kind === "preset" && t.versions.length === 1)
  );
  const bundle: ExportBundle = { schema: "aipagego.tools/v3", exportedAt: Date.now(), tools };
  assertNoLiteralSecrets(bundle);
  return bundle;
}

export type ConflictPolicy = "skip" | "overwrite" | "copy";

export type ImportResult = {
  imported: number;
  skipped: number;
  errors: Array<{ index: number; code: "invalid_tool"; message: string }>;
};

export async function importBundle(
  raw: unknown,
  opts: { onConflict: ConflictPolicy }
): Promise<ImportResult> {
  if (!raw || typeof raw !== "object") {
    throw new Error("invalid bundle: schema mismatch");
  }
  const bundle = raw as { schema?: unknown; tools?: unknown };
  if (
    (bundle.schema !== "aipagego.tools/v2" && bundle.schema !== "aipagego.tools/v3") ||
    !Array.isArray(bundle.tools)
  ) throw new Error("invalid bundle: schema mismatch");
  const canonicalOnly = bundle.schema === "aipagego.tools/v3";
  // Gap Fix T8.5: strip origin when the referenced preset id is not in current PRESETS
  const validPresetIds = new Set(PRESETS.map((p) => p.id));
  const db = await getDB();
  let imported = 0;
  let skipped = 0;
  const errors: ImportResult["errors"] = [];
  for (let index = 0; index < bundle.tools.length; index++) {
    const rawCandidate = bundle.tools[index];
    // Sanitize unknown preset origins before parsing
    const candidate =
      rawCandidate &&
      typeof rawCandidate === "object" &&
      (rawCandidate as Record<string, unknown>).origin &&
      typeof (rawCandidate as Record<string, unknown>).origin === "object" &&
      ((rawCandidate as Record<string, unknown>).origin as Record<string, unknown>).kind === "preset" &&
      !validPresetIds.has(
        ((rawCandidate as Record<string, unknown>).origin as Record<string, unknown>).presetId as string
      )
        ? { ...(rawCandidate as Record<string, unknown>), origin: undefined }
        : rawCandidate;
    const parsed = parseTool(candidate, canonicalOnly);
    const incoming = parsed.tool;
    if (!incoming) {
      skipped++;
      errors.push({ index, code: "invalid_tool", message: parsed.error ?? "invalid tool" });
      continue;
    }
    const existing = parseTool(await db.get("tools", incoming.id)).tool;
    if (!existing) {
      await db.put("tools", incoming);
      imported++;
      continue;
    }
    if (opts.onConflict === "skip") {
      skipped++;
    } else if (opts.onConflict === "overwrite") {
      await db.put("tools", incoming);
      imported++;
    } else if (opts.onConflict === "copy") {
      await db.put("tools", { ...incoming, id: crypto.randomUUID() });
      imported++;
    }
  }
  return { imported, skipped, errors };
}
