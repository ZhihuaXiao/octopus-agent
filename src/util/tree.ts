/**
 * Finding the Markdown files under a directory.
 *
 * One walk, because two places need the same answer and must agree about it:
 * the server listing the Notebooks it can serve, and the Run Records being
 * read to tell a Notebook's own Agent Session from a Chat. A directory either
 * of them looked in and the other skipped would be a session that reads as one
 * thing to the page and another to the record.
 */

import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const NOTEBOOK_EXTENSION = ".md";

/**
 * Directories no Notebook of the project lives in: what a package manager
 * installed, and the dot-directories — version control, run records (`.octo`),
 * an editor's settings — that are a tool's own rather than the author's.
 */
export const isSkipped = (name: string) => name === "node_modules" || name.startsWith(".");

/**
 * Every Markdown file under `directory`, not descending into a skipped
 * directory at all: a project's `node_modules` can hold more files than the
 * rest of it put together. A symbolic link is neither a file nor a directory
 * here, so a link that loops back is never followed.
 */
export async function markdownFiles(directory: string): Promise<string[]> {
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
