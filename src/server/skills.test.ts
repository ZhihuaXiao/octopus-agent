import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { listInstalledSkills } from "./skills.js";

/** A directory of its own, with a workspace, an agent directory and a home, none of them the machine's. */
async function layout(): Promise<{ workspace: string; agentDir: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "octo-skills-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(home, { recursive: true });
  return { workspace, agentDir, home };
}

/** One Skill file, a `SKILL.md` when `directory` is set, otherwise a markdown file in `dir`. */
async function skillFile(
  dir: string,
  name: string,
  description: string,
  options: { directory?: boolean; extra?: string } = {},
): Promise<void> {
  const file = options.directory === true ? join(dir, name, "SKILL.md") : join(dir, `${name}.md`);
  await mkdir(dirname(file), { recursive: true });
  const extra = options.extra === undefined ? "" : `\n${options.extra}`;
  await writeFile(
    file,
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}${extra}\n---\n\nDo ${name}.\n`,
    "utf8",
  );
}

describe("installed skills", () => {
  it("lists the workspace's skills before the user's, and lets the workspace keep a shared name", async () => {
    const places = await layout();
    await skillFile(join(places.workspace, ".pi", "skills"), "zeta", "A local file");
    await skillFile(
      join(places.workspace, ".pi", "skills", "nested"),
      "alpha",
      "A local directory",
      {
        directory: true,
      },
    );
    await skillFile(join(places.agentDir, "skills"), "zeta", "The user's copy");
    await skillFile(join(places.agentDir, "skills"), "global-file", "From the agent directory");
    await skillFile(
      join(places.home, ".agents", "skills", "global-dir"),
      "global-dir",
      "From home",
      {
        directory: true,
      },
    );

    expect(listInstalledSkills(places)).toEqual([
      { name: "alpha", description: "A local directory", scope: "local" },
      { name: "zeta", description: "A local file", scope: "local" },
      { name: "global-dir", description: "From home", scope: "global" },
      { name: "global-file", description: "From the agent directory", scope: "global" },
    ]);
  });

  it("reads .agents/skills up to the git root, and not a loose file or the user's own directory twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "octo-skills-"));
    const repo = join(root, "repo");
    const workspace = join(repo, "child");
    const home = join(root, "home");
    const agentDir = join(root, "agent");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await skillFile(join(workspace, ".agents", "skills"), "loose", "Not a skill");
    await skillFile(join(workspace, ".agents", "skills", "inner"), "inner", "In the workspace", {
      directory: true,
    });
    await skillFile(join(repo, ".agents", "skills", "outer"), "outer", "In the repo", {
      directory: true,
    });
    await skillFile(join(root, ".agents", "skills", "above"), "above", "Above the repo", {
      directory: true,
    });
    await skillFile(join(home, ".agents", "skills", "mine"), "mine", "The user's", {
      directory: true,
    });

    expect(listInstalledSkills({ workspace, agentDir, home })).toEqual([
      { name: "inner", description: "In the workspace", scope: "local" },
      { name: "outer", description: "In the repo", scope: "local" },
      { name: "mine", description: "The user's", scope: "global" },
    ]);

    await mkdir(join(home, ".git"), { recursive: true });
    await skillFile(join(home, ".pi", "skills"), "home-local", "Only when home is the workspace");
    expect(listInstalledSkills({ workspace: home, agentDir, home })).toEqual([
      { name: "home-local", description: "Only when home is the workspace", scope: "local" },
      { name: "mine", description: "The user's", scope: "global" },
    ]);
  });

  it("keeps a skill the model may not invoke, and drops one that cannot be named or has nothing to say", async () => {
    const places = await layout();
    await skillFile(join(places.agentDir, "skills"), "hidden", "Ask for it", {
      extra: "disable-model-invocation: true",
    });
    await skillFile(join(places.agentDir, "skills"), "quiet", "   ");
    await mkdir(join(places.agentDir, "skills"), { recursive: true });
    await writeFile(
      join(places.agentDir, "skills", "spaced.md"),
      `---\nname: my skill\ndescription: "Has a space"\n---\n\nNo.\n`,
      "utf8",
    );

    expect(listInstalledSkills(places)).toEqual([
      { name: "hidden", description: "Ask for it", scope: "global" },
    ]);
  });
});
