/**
 * Finding the Notebooks under the served directory.
 *
 * A Notebook is a Markdown file with at least one Cell in it: that is what the
 * glossary says a Notebook is — work described as a graph of Cells — and it is
 * what keeps a project's README, which has fenced snippets but no Cells, out of
 * the list. A file that does not parse is left out too, since nothing can be
 * done with it here: the browser edits what parses, so a file broken in
 * another editor is fixed there. Copying a Notebook lives here too, being a
 * matter of the files under the directory rather than of any session.
 */

import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import { cellsOf, parseNotebook, titleOf } from "../notebook/notebook.js";
import { within } from "../util/paths.js";

export interface NotebookEntry {
  /** Relative to the served directory, with forward slashes whatever the platform. */
  readonly path: string;
  /** The Notebook's declared title, or its file's name when it declares none. */
  readonly title: string;
}

const NOTEBOOK_EXTENSION = ".md";

/**
 * Directories no Notebook of the project lives in: what a package manager
 * installed, and the dot-directories — version control, run records (`.octo`),
 * an editor's settings — that are a tool's own rather than the author's.
 */
const isSkipped = (name: string) => name === "node_modules" || name.startsWith(".");

/** A Notebook's path as the server names it: relative to the served directory, forward slashes. */
export const pathWithin = (directory: string, file: string) =>
  relative(directory, file).split(sep).join("/");

async function readEntry(directory: string, file: string): Promise<NotebookEntry | undefined> {
  const parsed = parseNotebook(await readFile(file, "utf8"));
  if (!parsed.ok || cellsOf(parsed.notebook).length === 0) return undefined;
  return { path: pathWithin(directory, file), title: titleOf(parsed.notebook, file) };
}

/**
 * Every Markdown file under `directory`, not descending into a skipped
 * directory at all: a project's `node_modules` can hold more files than the
 * rest of it put together. A symbolic link is neither a file nor a directory
 * here, so a link that loops back is never followed.
 */
async function markdownFiles(directory: string): Promise<string[]> {
  const dirents = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const dirent of dirents) {
    const path = join(directory, dirent.name);
    if (dirent.isDirectory()) {
      if (!isSkipped(dirent.name)) files.push(...(await markdownFiles(path)));
    } else if (dirent.isFile() && extname(dirent.name) === NOTEBOOK_EXTENSION) {
      files.push(path);
    }
  }

  return files;
}

/**
 * The Notebooks under `directory`, however deep, in the order of their paths.
 * Read one file at a time: a tree of thousands of Markdown files is a
 * documentation site, not an error, and opening them all at once would be.
 */
export async function listNotebooks(directory: string): Promise<NotebookEntry[]> {
  const found: NotebookEntry[] = [];
  for (const file of await markdownFiles(directory)) {
    const entry = await readEntry(directory, file);
    if (entry !== undefined) found.push(entry);
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The file a name under the served directory points at, or nothing when it leads out. */
export function fileWithin(directory: string, name: string): string | undefined {
  if (name.includes("\0")) return undefined;
  const file = resolve(directory, name);
  return within(directory, file) ? file : undefined;
}

/**
 * The file a new Notebook is to be written to, given the name asked for: a
 * Markdown file under the served directory, or the problem with the name.
 * What copying and promoting both check before they write anything.
 */
export function notebookTarget(
  directory: string,
  to: string,
): { readonly file: string } | { readonly problem: string } {
  const target = fileWithin(directory, to);
  if (target === undefined || extname(target) !== NOTEBOOK_EXTENSION) {
    return {
      problem: `The new name must be a Markdown file (${NOTEBOOK_EXTENSION}) under ${directory}.`,
    };
  }
  return { file: target };
}

/** How copying a Notebook went. */
export type Copied =
  | { readonly kind: "copied"; readonly entry: NotebookEntry }
  /** No such Notebook under the served directory to copy. */
  | { readonly kind: "absent" }
  /** The new name is not one a Notebook under the served directory can have. */
  | { readonly kind: "invalid"; readonly problem: string }
  /** A file is already there under the new name. */
  | { readonly kind: "exists" };

/**
 * Duplicates the Notebook at `from` under the name `to`, both relative to the
 * served directory, so that someone can adapt a Notebook that exists rather
 * than author one from nothing.
 *
 * The file is copied byte for byte — its title included, which is the author's
 * to change — and nothing else: the Runs of the original are the original's
 * history, and the copy has none until it is run. Never over a file that is
 * already there, since that would be a way to lose a Notebook by mistyping a
 * name; a directory the new name needs is made.
 */
export async function copyNotebook(directory: string, from: string, to: string): Promise<Copied> {
  const source = fileWithin(directory, from);
  if (source === undefined) return { kind: "absent" };
  const named = notebookTarget(directory, to);
  if ("problem" in named) return { kind: "invalid", problem: named.problem };
  const target = named.file;

  let entry: NotebookEntry | undefined;
  try {
    entry = await readEntry(directory, source);
  } catch (cause) {
    const { code } = cause as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return { kind: "absent" };
    throw cause;
  }
  if (entry === undefined) return { kind: "absent" };

  await mkdir(dirname(target), { recursive: true });
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return { kind: "exists" };
    throw cause;
  }
  return { kind: "copied", entry: { path: pathWithin(directory, target), title: entry.title } };
}
