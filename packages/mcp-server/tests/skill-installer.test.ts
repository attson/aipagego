import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { installCodexSkill, runSkillInstallCommand } from "../src/skill-installer";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "atwebpilot-skill-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("Codex Skill metadata", () => {
  it("declares precise live-page triggers and a pure-code boundary", async () => {
    const skillPath = fileURLToPath(new URL("../../../skill/SKILL.md", import.meta.url));
    const content = await readFile(skillPath, "utf8");

    expect(content).toMatch(/^---\nname: atwebpilot-browser\n/);
    expect(content).toMatch(/description:.*live web page/i);
    expect(content).toMatch(/localhost/i);
    expect(content).toMatch(/authenticated/i);
    expect(content).toMatch(/pure code/i);
    expect(content).toMatch(/\n---\n/);
  });
});

describe("installCodexSkill", () => {
  it("installs once and treats identical content as unchanged", async () => {
    const root = await temporaryDirectory();
    const sourceFile = join(root, "source.md");
    const skillsRoot = join(root, "skills");
    await writeFile(sourceFile, "---\nname: atwebpilot-browser\n---\nbody\n", "utf8");

    await expect(installCodexSkill({ sourceFile, skillsRoot })).resolves.toMatchObject({
      status: "installed"
    });
    await expect(installCodexSkill({ sourceFile, skillsRoot })).resolves.toMatchObject({
      status: "unchanged"
    });
    await expect(readFile(join(skillsRoot, "atwebpilot-browser", "SKILL.md"), "utf8"))
      .resolves.toBe("---\nname: atwebpilot-browser\n---\nbody\n");
  });

  it("refuses to overwrite a modified Skill unless force is explicit", async () => {
    const root = await temporaryDirectory();
    const sourceFile = join(root, "source.md");
    const skillsRoot = join(root, "skills");
    const targetDirectory = join(skillsRoot, "atwebpilot-browser");
    const targetFile = join(targetDirectory, "SKILL.md");
    await writeFile(sourceFile, "new version\n", "utf8");
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(targetFile, "user version\n", "utf8");

    await expect(installCodexSkill({ sourceFile, skillsRoot })).rejects.toThrow(
      /already exists with different content.*--force/i
    );
    await expect(readFile(targetFile, "utf8")).resolves.toBe("user version\n");

    await expect(installCodexSkill({ sourceFile, skillsRoot, force: true })).resolves.toMatchObject({
      status: "overwritten"
    });
    await expect(readFile(targetFile, "utf8")).resolves.toBe("new version\n");
  });

  it("fails clearly when the bundled Skill source is missing", async () => {
    const root = await temporaryDirectory();

    await expect(installCodexSkill({
      sourceFile: join(root, "missing.md"),
      skillsRoot: join(root, "skills")
    })).rejects.toThrow(/Skill source.*missing/i);
  });

  it("handles the explicit CLI mode without starting the MCP server", async () => {
    const root = await temporaryDirectory();
    const sourceFile = join(root, "source.md");
    const skillsRoot = join(root, "skills");
    await writeFile(sourceFile, "skill\n", "utf8");

    await expect(runSkillInstallCommand(
      ["--install-codex-skill"],
      { sourceFile, skillsRoot }
    )).resolves.toMatchObject({
      handled: true,
      result: { status: "installed" }
    });

    await writeFile(sourceFile, "updated\n", "utf8");
    await expect(runSkillInstallCommand(
      ["--install-codex-skill", "--force"],
      { sourceFile, skillsRoot }
    )).resolves.toMatchObject({
      handled: true,
      result: { status: "overwritten" }
    });
    await expect(runSkillInstallCommand([], { sourceFile, skillsRoot })).resolves.toEqual({
      handled: false
    });
  });

  it("rejects unsupported install-mode arguments", async () => {
    const root = await temporaryDirectory();
    await expect(runSkillInstallCommand(
      ["--install-codex-skill", "--unknown"],
      { sourceFile: join(root, "source.md"), skillsRoot: join(root, "skills") }
    )).rejects.toThrow(/Unknown option.*--unknown/);
  });
});
