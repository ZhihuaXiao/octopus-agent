/**
 * The Skills installed for a user and for a Workspace, the ones a Prompt Cell
 * runs by beginning `/skill:name`.
 *
 * These are the places pi loads installed Skills from, and nothing else. A
 * Skill named in settings or shipped inside a package is pi's to discover when
 * a Run starts; it is not installed in the sense this list means. Local is
 * read before global and the first name wins, which is the order pi's package
 * manager hands the paths to its loader. A Workspace that has not been trusted
 * still has its Skills listed: they are installed. Whether a Run loads them is
 * the trust decision, made when the Run starts.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { CONFIG_DIR_NAME, type Skill, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

/** Where an installed Skill lives: the user's, or this Workspace's. */
export type SkillScope = "global" | "local";

/** One installed Skill, as the browser lists it. Enough to choose and to tell the two places apart. */
export interface InstalledSkill {
  readonly name: string;
  readonly description: string;
  readonly scope: SkillScope;
}

/**
 * The directories to read. A test names all three, so listing never reads the
 * machine it happens to run on.
 */
export interface SkillLocations {
  /** The Workspace a Notebook operates on. Its `.pi/skills` and `.agents/skills` are local. */
  readonly workspace: string;
  /** Pi's agent directory. Its `skills` folder is global. */
  readonly agentDir: string;
  /** The user's home. `~/.agents/skills` is global. */
  readonly home: string;
}

/** A name that can be the one token of `/skill:name`. */
const COMMAND_NAME = /^[^\s/]+$/;

const byName = (a: InstalledSkill, b: InstalledSkill): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** The git root at or above `start`, when there is one. A `.git` file counts, as a worktree's does. */
function gitRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * `.agents/skills` from the Workspace up to the git root, or the filesystem
 * root when the Workspace is not in a repo. The user's own `~/.agents/skills`
 * is left out: that one is global, and listing it here as well would show it twice.
 */
function ancestorAgentsDirs(workspace: string, userAgents: string): string[] {
  const root = gitRoot(workspace);
  const dirs: string[] = [];
  let dir = resolve(workspace);
  for (;;) {
    const skills = resolve(dir, ".agents", "skills");
    if (skills !== userAgents) dirs.push(skills);
    if (root !== undefined && dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * Skills in `dir`, as pi reads that kind of directory.
 *
 * `.pi/skills` takes a markdown file sitting in the directory itself. `.agents/skills`
 * does not: only a `SKILL.md`, including one that makes the directory a single Skill.
 */
function skillsFrom(dir: string, source: "user" | "project", rootMarkdown: boolean): Skill[] {
  const { skills } = loadSkillsFromDir({ dir, source });
  if (rootMarkdown) return skills;
  const root = resolve(dir);
  return skills.filter(
    (skill) => basename(skill.filePath) === "SKILL.md" || resolve(dirname(skill.filePath)) !== root,
  );
}

/** The path a Skill's file really is, so a symlink of one already listed is not a second Skill. */
function canonical(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return resolve(file);
  }
}

/**
 * The Skills installed for `locations`, local then global, each by name.
 * A name or a file already taken is skipped, so a Workspace Skill hides a user
 * Skill of the same name rather than the menu offering both.
 */
export function listInstalledSkills(locations: SkillLocations): InstalledSkill[] {
  const workspace = resolve(locations.workspace);
  const found: InstalledSkill[] = [];
  const names = new Set<string>();
  const paths = new Set<string>();

  const add = (
    dir: string,
    source: "user" | "project",
    scope: SkillScope,
    rootMarkdown: boolean,
  ): void => {
    for (const skill of skillsFrom(dir, source, rootMarkdown)) {
      if (!COMMAND_NAME.test(skill.name)) continue;
      const description = skill.description.replace(/\s+/g, " ").trim();
      if (description === "") continue;
      const path = canonical(skill.filePath);
      if (names.has(skill.name) || paths.has(path)) continue;
      names.add(skill.name);
      paths.add(path);
      found.push({ name: skill.name, description, scope });
    }
  };

  add(join(workspace, CONFIG_DIR_NAME, "skills"), "project", "local", true);
  const userAgents = resolve(locations.home, ".agents", "skills");
  for (const dir of ancestorAgentsDirs(workspace, userAgents)) add(dir, "project", "local", false);
  add(join(resolve(locations.agentDir), "skills"), "user", "global", true);
  add(userAgents, "user", "global", false);

  return [
    ...found.filter((skill) => skill.scope === "local").sort(byName),
    ...found.filter((skill) => skill.scope === "global").sort(byName),
  ];
}
