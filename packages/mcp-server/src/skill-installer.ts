import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIRECTORY_NAME = "atwebpilot-browser";

export type SkillInstallStatus = "installed" | "unchanged" | "overwritten";

export type InstallCodexSkillOptions = {
  sourceFile: string;
  skillsRoot: string;
  force?: boolean;
};

export type SkillInstallResult = {
  status: SkillInstallStatus;
  targetFile: string;
};

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function atomicWrite(targetFile: string, content: string): Promise<void> {
  const temporaryFile = `${targetFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryFile, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await rename(temporaryFile, targetFile);
  } catch (error) {
    await unlink(temporaryFile).catch(() => undefined);
    throw error;
  }
}

export async function installCodexSkill(
  options: InstallCodexSkillOptions
): Promise<SkillInstallResult> {
  let source: string;
  try {
    source = await readFile(options.sourceFile, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(`Skill source is missing: ${options.sourceFile}`);
    }
    throw error;
  }

  const targetDirectory = join(options.skillsRoot, SKILL_DIRECTORY_NAME);
  const targetFile = join(targetDirectory, "SKILL.md");
  let existing: string | undefined;
  try {
    existing = await readFile(targetFile, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  if (existing === source) return { status: "unchanged", targetFile };
  if (existing !== undefined && !options.force) {
    throw new Error(
      `Codex Skill already exists with different content at ${targetFile}; rerun with --force to overwrite it.`
    );
  }

  await mkdir(targetDirectory, { recursive: true });
  await atomicWrite(targetFile, source);
  return {
    status: existing === undefined ? "installed" : "overwritten",
    targetFile
  };
}

export function defaultCodexSkillsRoot(
  env: Record<string, string | undefined> = process.env,
  homeDirectory = homedir()
): string {
  return env.ATWEBPILOT_CODEX_SKILLS_DIR || join(homeDirectory, ".agents", "skills");
}

export async function resolveBundledSkillFile(moduleUrl = import.meta.url): Promise<string> {
  const here = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    join(here, "skill", "SKILL.md"),
    join(here, "../../../skill/SKILL.md")
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the development-tree fallback after the bundled path.
    }
  }
  throw new Error(`Skill source is missing; checked: ${candidates.join(", ")}`);
}

export type SkillInstallCommandResult =
  | { handled: false }
  | { handled: true; result: SkillInstallResult };

export async function runSkillInstallCommand(
  args: string[],
  overrides: { sourceFile?: string; skillsRoot?: string } = {}
): Promise<SkillInstallCommandResult> {
  if (!args.includes("--install-codex-skill")) return { handled: false };

  const supported = new Set(["--install-codex-skill", "--force"]);
  const unknown = args.filter((arg) => !supported.has(arg));
  if (unknown.length > 0) {
    throw new Error(`Unknown option for Skill installation: ${unknown.join(", ")}`);
  }

  const sourceFile = overrides.sourceFile ?? await resolveBundledSkillFile();
  const skillsRoot = overrides.skillsRoot ?? defaultCodexSkillsRoot();
  const result = await installCodexSkill({
    sourceFile,
    skillsRoot,
    force: args.includes("--force")
  });
  return { handled: true, result };
}

