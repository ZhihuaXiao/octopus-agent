/**
 * Finding the Notebooks under the served directory.
 *
 * A Notebook is a Markdown file with at least one Cell in it: that is what the
 * glossary says a Notebook is — work described as a graph of Cells — and it is
 * what keeps a project's README, which has fenced snippets but no Cells, out of
 * the list. A file that does not parse is left out too, since nothing can be
 * done with it here yet; once the browser can edit, ticket 17 may want to show
 * it with its problems instead.
 */

import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";

import { type Notebook, cellsOf, parseNotebook } from "../notebook/notebook.js";

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

/** A Notebook's declared title, or its file's name when it declares none. */
export const titleOf = (notebook: Notebook, file: string) =>
  notebook.metadata.title ?? basename(file, NOTEBOOK_EXTENSION);

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
