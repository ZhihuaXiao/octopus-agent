/**
 * The Modes a Notebook runs in, kept as files rather than as code.
 *
 * A Mode is data — a system prompt, a tool allowlist, a skill set and a
 * default model — so adding one is writing a file, and a user can add their
 * own without waiting for a release.
 */

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import { type Diagnostic, lineOffset } from "../notebook/diagnostic.js";
import { isName } from "../notebook/name.js";

export interface Mode {
  readonly name: string;
  /** The system prompt, in place of pi's own; absent when the file's body is empty. */
  readonly prompt?: string;
  /** The model a Cell takes its turn on when neither it nor its Notebook names one. */
  readonly model?: string;
  /** The only tools the agent may use, when the Notebook does not list its own. */
  readonly tools?: readonly string[];
  /**
   * The only Skills the agent is given, beside the ones its Notebook declares,
   * and each of them required as a declared one is. Absent gives the agent
   * every Skill pi loads.
   */
  readonly skills?: readonly string[];
}

/** Where a user's own Modes are found, one `<name>.md` each, beside octo's other files. */
export const userModesDirectory = (): string => join(homedir(), ".octo", "modes");

export type ModeResult =
  | { readonly ok: true; readonly mode: Mode }
  | { readonly ok: false; readonly problems: readonly string[] };

const scalarString = (node: unknown) =>
  isScalar(node) && typeof node.value === "string" ? node.value : undefined;

const FIELDS = ["model", "tools", "skills"];

const isDelimiter = (line: string) => line.trimEnd() === "---";

/**
 * Reads a Mode's file: YAML frontmatter for its fields, and the rest for its
 * system prompt. Every problem is reported against the line it is on, all at
 * once, as a Notebook's are — a Mode is read whole or not at all, and one read
 * in part is a Run in a Mode nobody wrote.
 */
function readMode(name: string, source: string, errors: Diagnostic[]): Mode {
  const lines = source.split("\n");
  let frontmatter = "";
  let body = source;
  if (lines[0] !== undefined && isDelimiter(lines[0])) {
    const close = lines.findIndex((line, at) => at > 0 && isDelimiter(line));
    if (close === -1) {
      errors.push({ line: 1, message: "Frontmatter is never closed" });
      return { name };
    }
    frontmatter = lines.slice(1, close).join("\n");
    body = lines.slice(close + 1).join("\n");
  }

  const mode: { -readonly [Field in keyof Mode]: Mode[Field] } = { name };
  const prompt = body.trim();
  if (prompt !== "") mode.prompt = prompt;

  const parsed = parseDocument(frontmatter, { prettyErrors: false });
  const lineOf = (offset: number) => 2 + lineOffset(frontmatter, offset);
  for (const error of parsed.errors) {
    errors.push({ line: lineOf(error.pos[0]), message: error.message });
  }
  if (parsed.errors.length > 0 || parsed.contents === null) return mode;
  if (!isMap(parsed.contents)) {
    errors.push({ line: 2, message: "Frontmatter must be a mapping of fields" });
    return mode;
  }

  for (const item of parsed.contents.items) {
    const key = scalarString(item.key);
    const line = lineOf(item.key.range[0]);

    if (key === "model") {
      const model = scalarString(item.value);
      if (model === undefined)
        errors.push({ line, message: `Mode field "model" must be a string` });
      else mode.model = model;
      continue;
    }

    if (key === "tools" || key === "skills") {
      if (!isSeq(item.value)) {
        errors.push({ line, message: `Mode field "${key}" must be a list of strings` });
        continue;
      }
      const values: string[] = [];
      for (const element of item.value.items) {
        const value = scalarString(element);
        if (value !== undefined) values.push(value);
        else {
          errors.push({
            line: lineOf(element.range[0]),
            message: `Every entry in "${key}" must be a string`,
          });
        }
      }
      mode[key] = values;
      continue;
    }

    errors.push({
      line,
      message: `Unknown mode field "${key ?? String(item.key)}". Expected one of ${FIELDS.join(", ")}`,
    });
  }

  return mode;
}

/** Where the Modes octo ships are, beside the program rather than inside it. */
const SHIPPED_MODES = fileURLToPath(new URL("../../modes/", import.meta.url));

/**
 * The Modes a directory defines, by name: each `<name>.md` in it whose name a
 * Notebook could write. A directory that is not there defines none, which is
 * what a user who has written no Mode of their own has.
 */
async function modesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory).catch(() => []);
  return entries
    .filter((entry) => extname(entry) === ".md")
    .map((entry) => basename(entry, ".md"))
    .filter(isName);
}

/**
 * The modes a notebook can be set to here: the ones octo ships, and the user's
 * own that do not reuse a shipped name. A name both directories have is left
 * out, since neither file can be the one a run would use. A directory that is
 * not there adds none. Sorted, so a menu drawn from this is the same each time.
 */
export async function availableModes(userDirectory: string): Promise<string[]> {
  const shipped = await modesIn(SHIPPED_MODES);
  const own = await modesIn(userDirectory);
  const collided = new Set(shipped.filter((name) => own.includes(name)));
  return [...shipped, ...own].filter((name) => !collided.has(name)).sort();
}

/** `a`, `a and b`, `a, b and c`: a list as a sentence says one. */
const inWords = (names: readonly string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The Mode a Notebook names, read from the file that defines it: one octo
 * ships, or one of the user's own.
 *
 * Found by listing both directories rather than by building a path from the
 * name, so a name that is not a Mode's — `../somewhere` — is simply one that is
 * not there.
 */
export async function resolveMode(name: string, userDirectory: string): Promise<ModeResult> {
  const shipped = await modesIn(SHIPPED_MODES);
  const own = await modesIn(userDirectory);

  // Refused rather than preferred either way: a Notebook in Code mode is meant
  // to behave alike for everyone who runs it, and neither file can say which
  // of the two its author had.
  if (shipped.includes(name) && own.includes(name)) {
    return {
      ok: false,
      problems: [
        `${join(userDirectory, `${name}.md`)} has the name of a mode octo ships, so "${name}" would not mean the same on every machine. Rename it.`,
      ],
    };
  }

  const directory = shipped.includes(name)
    ? SHIPPED_MODES
    : own.includes(name)
      ? userDirectory
      : undefined;
  if (directory === undefined) {
    const known = [...new Set([...shipped, ...own])].sort();
    return {
      ok: false,
      problems: [
        `This notebook declares the mode "${name}", which is not available here. The modes here are ${inWords(known)}; your own are ${join(userDirectory, "<name>.md")}.`,
      ],
    };
  }

  const file = join(directory, `${name}.md`);
  const errors: Diagnostic[] = [];
  const mode = readMode(name, await readFile(file, "utf8"), errors);
  if (errors.length > 0) {
    return {
      ok: false,
      problems: [...errors]
        .sort((a, b) => a.line - b.line)
        .map((error) => `${file}, line ${error.line}: ${error.message}`),
    };
  }
  return { ok: true, mode };
}
