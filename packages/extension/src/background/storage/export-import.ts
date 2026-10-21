import { ToolSchema } from "@aipagego/shared/messages";
import type { ExportBundle, Tool } from "@aipagego/shared/types";
import { PRESETS } from "@aipagego/shared/presets";
import { getDB } from "./db";

function parseTool(raw: unknown): Tool | undefined {
  const parsed = ToolSchema.safeParse(raw);
  return parsed.success ? (parsed.data as Tool) : undefined;
}

export async function exportAll(): Promise<ExportBundle> {
  const db = await getDB();
  const allTools = (await db.getAll("tools")).map(parseTool).filter((t): t is Tool => !!t);
  // Gap Fix T8.5: exclude unmodified preset copies (origin.kind === "preset" && only 1 version)
  const tools = allTools.filter(
    (t) => !(t.origin?.kind === "preset" && t.versions.length === 1)
  );
  return { schema: "aipagego.tools/v2", exportedAt: Date.now(), tools };
}

export type ConflictPolicy = "skip" | "overwrite" | "copy";

export type ImportResult = {
  imported: number;
  skipped: number;
};

export async function importBundle(
  raw: ExportBundle,
  opts: { onConflict: ConflictPolicy }
): Promise<ImportResult> {
  if (!raw || raw.schema !== "aipagego.tools/v2" || !Array.isArray(raw.tools)) {
    throw new Error("invalid bundle: schema mismatch");
  }
  // Gap Fix T8.5: strip origin when the referenced preset id is not in current PRESETS
  const validPresetIds = new Set(PRESETS.map((p) => p.id));
  const db = await getDB();
  let imported = 0;
  let skipped = 0;
  for (const rawCandidate of raw.tools) {
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
    const incoming = parseTool(candidate);
    if (!incoming) {
      skipped++;
      continue;
    }
    const existing = parseTool(await db.get("tools", incoming.id));
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
  return { imported, skipped };
}
