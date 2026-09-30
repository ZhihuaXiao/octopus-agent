/**
 * Finding the Notebooks under the served directory.
 *
 * A Notebook is a Markdown file with at least one Cell in it: that is what the
 * glossary says a Notebook is — work described as a graph of Cells — and it is
 * what keeps a project's README, which has fenced snippets but no Cells, out of
 * the list. A file that does not parse is left out too, since nothing can be
 * done with it here: the browser edits what parses, so a file broken in
 * another editor is fixed there. Copying a Notebook, and making a new one,
 * live here too, being a matter of the files under the directory rather than
 * of any session.
 */

import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import { applyEdit } from "../notebook/edit.js";
import { cellsOf, parseNotebook, titleOf } from "../notebook/notebook.js";
import { runsDirectory } from "../run/store.js";
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

/** How making a new Notebook went. */
export type Created =
  | { readonly kind: "created"; readonly entry: NotebookEntry }
  /** The name is not one a Notebook under the served directory can have. */
  | { readonly kind: "invalid"; readonly problem: string }
  /** A file is already there under the name. */
  | { readonly kind: "exists" };

/**
 * Writes a new Notebook at `to`, relative to the served directory, holding
 * one empty Prompt Cell and nothing else: a Notebook is a file with a Cell in
 * it, so one with none could be neither listed nor opened, and the author
 * would have nowhere to begin. Never over a file that is already there; a
 * directory the name needs is made.
 */
export async function createNotebook(directory: string, to: string): Promise<Created> {
  const named = notebookTarget(directory, to);
  if ("problem" in named) return { kind: "invalid", problem: named.problem };
  const target = named.file;

  const empty = parseNotebook("");
  if (!empty.ok) throw new Error("An empty file is not a notebook");
  const made = applyEdit(empty.notebook, {
    segments: [{ kind: "cell", id: "cell-1", type: "prompt", body: "", uses: [], isolated: false }],
  });
  if (!made.ok) throw new Error("A new notebook does not parse");

  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(target, made.source, { encoding: "utf8", flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return { kind: "exists" };
    throw cause;
  }
  return {
    kind: "created",
    entry: { path: pathWithin(directory, target), title: titleOf(made.notebook, target) },
  };
}

/**
 * One entry of the served directory, as the sidebar draws it. A directory
 * holds its children; a Notebook is a Markdown file with a Cell in it, which
 * is what opens; anything else is a file, listed so a folder can be looked
 * into, and not opened.
 */
export type TreeEntry =
  | {
      readonly kind: "directory";
      readonly name: string;
      readonly path: string;
      readonly children: readonly TreeEntry[];
    }
  | {
      readonly kind: "notebook";
      readonly name: string;
      readonly path: string;
      readonly title: string;
    }
  | { readonly kind: "file"; readonly name: string; readonly path: string };

/** Whether a path is on disk. A missing one is the absence, not an error. */
const isThere = (path: string) =>
  stat(path).then(
    () => true,
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return false;
      throw cause;
    },
  );

/**
 * The served directory as folders and files, for the sidebar to open one
 * folder at a time. The same directories a Notebook search skips —
 * `node_modules`, and anything named with a leading dot — are skipped here,
 * and a symbolic link is neither, so a link that loops is never followed.
 */
export async function listTree(directory: string): Promise<TreeEntry[]> {
  return readTree(directory, directory);
}

async function readTree(directory: string, root: string): Promise<TreeEntry[]> {
  const dirents = await readdir(directory, { withFileTypes: true });
  const entries: TreeEntry[] = [];

  for (const dirent of dirents) {
    if (isSkipped(dirent.name)) continue;
    const path = join(directory, dirent.name);
    const relativePath = pathWithin(root, path);
    if (dirent.isDirectory()) {
      entries.push({
        kind: "directory",
        name: dirent.name,
        path: relativePath,
        children: await readTree(path, root),
      });
    } else if (dirent.isFile()) {
      const notebook =
        extname(dirent.name) === NOTEBOOK_EXTENSION ? await readEntry(root, path) : undefined;
      entries.push(
        notebook !== undefined
          ? { kind: "notebook", name: dirent.name, path: relativePath, title: notebook.title }
          : { kind: "file", name: dirent.name, path: relativePath },
      );
    }
  }

  return entries.sort((a, b) => {
    if (a.kind === "directory" && b.kind !== "directory") return -1;
    if (a.kind !== "directory" && b.kind === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
}

/** How renaming a Notebook went. */
export type Renamed =
  | { readonly kind: "renamed"; readonly entry: NotebookEntry }
  /** No such Notebook under the served directory. */
  | { readonly kind: "absent" }
  /** The new name is not one a Notebook under the served directory can have. */
  | { readonly kind: "invalid"; readonly problem: string }
  /** A file is already there under the new name. */
  | { readonly kind: "exists" }
  /** The new name would land on Runs another Notebook already has. */
  | { readonly kind: "runs" };

/**
 * Renames the Notebook at `from` to `to`, both relative to the served
 * directory, and moves the Runs stored beside it so they stay that
 * Notebook's. Never over a file that is already there, and never over a Runs
 * directory that is: either would be a way to lose work by mistyping a name.
 * A directory the new name needs is made.
 */
export async function renameNotebook(
  directory: string,
  from: string,
  to: string,
): Promise<Renamed> {
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
  if (source === target) return { kind: "renamed", entry };

  // `rename` replaces a file that is already there, which would lose it.
  if (await isThere(target)) return { kind: "exists" };
  const fromRuns = runsDirectory(source);
  const toRuns = runsDirectory(target);
  const moveRuns = fromRuns !== toRuns && (await isThere(fromRuns));
  if (moveRuns && (await isThere(toRuns))) return { kind: "runs" };

  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(source, target);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return { kind: "exists" };
    throw cause;
  }

  if (moveRuns) {
    await mkdir(dirname(toRuns), { recursive: true });
    try {
      await rename(fromRuns, toRuns);
    } catch (cause) {
      await rename(target, source).catch(() => undefined);
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") return { kind: "runs" };
      throw cause;
    }
  }

  return {
    kind: "renamed",
    entry: { path: pathWithin(directory, target), title: entry.title },
  };
}
