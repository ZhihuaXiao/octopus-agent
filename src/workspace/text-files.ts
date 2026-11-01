/**
 * Text files the notebook can open: source and data a person reads as text,
 * beside the Notebook itself. Plain text, Markdown, CSV, JSON, YAML, and the
 * usual source extensions — Python, JavaScript, TypeScript, Java, and the
 * other languages named below. A Markdown file that has a Cell is still a
 * Notebook; one that does not is a text file, and so is every other name on
 * this list.
 *
 * A Run that creates or changes one of these leaves a review: the bytes to
 * put back, until somebody accepts the file as it stands or rejects it. The
 * comparison is against the served directory, which is the tree the notebook
 * shows. Dot-directories and `node_modules` are left out, as they are in that
 * tree — a Run's own records live under `.octo` and are not reviews.
 */

import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import { within } from "../util/paths.js";

/** Extensions opened as text, lowercase, with the leading dot `extname` returns. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".txt",
  ".text",
  ".log",
  ".md",
  ".markdown",
  ".rst",
  ".csv",
  ".tsv",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".svg",
  ".ini",
  ".cfg",
  ".conf",
  ".sql",
  ".graphql",
  ".gql",
  ".proto",
  ".py",
  ".pyi",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hh",
  ".hxx",
  ".cs",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".kts",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".lua",
  ".pl",
  ".r",
  ".dart",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".ml",
  ".mli",
  ".clj",
  ".cljs",
  ".vue",
  ".svelte",
  ".tf",
  ".gradle",
]);

/**
 * As much of one text file as a review keeps, and as much as a subtab will
 * open. A larger file is left on disk and out of the review: the whole of it
 * would be copied into the journal for as long as the review stood.
 */
export const LONGEST_TEXT = 1024 * 1024;

/** Whether `name` is one of the text files a notebook opens. The check is the extension alone. */
export const isTextFile = (name: string): boolean =>
  TEXT_EXTENSIONS.has(extname(name).toLowerCase());

/**
 * A text file a Run created or changed, still waiting. `before` is what to
 * write back on a rejection; a file that was created has none, and rejecting
 * it removes it.
 */
export interface TextReview {
  readonly path: string;
  readonly kind: "created" | "modified";
  readonly before?: string;
}

/** Directories that are a tool's, not the work: the same ones the folder tree skips. */
const isSkipped = (name: string) => name === "node_modules" || name.startsWith(".");

/**
 * The path a text-file name has under `directory`, or nothing when it is not
 * a text file there — a climb out, a null byte, or some other extension.
 */
export function textPath(directory: string, name: string): string | undefined {
  if (name.includes("\0") || !isTextFile(name)) return undefined;
  const file = resolve(directory, name);
  if (!within(directory, file)) return undefined;
  return relative(directory, file).split(sep).join("/");
}

/** How reading one text file went. */
export type ReadText =
  | { readonly kind: "text"; readonly path: string; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" };

/** The text file `name` names under `directory`, when it is one this view opens. */
export async function readTextFile(directory: string, name: string): Promise<ReadText> {
  const path = textPath(directory, name);
  if (path === undefined) return { kind: "invalid" };
  const file = resolve(directory, path);

  let info;
  try {
    info = await lstat(file);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    throw cause;
  }
  // A link is not followed: it can name a file outside the directory.
  if (!info.isFile()) return { kind: "absent" };
  if (info.size > LONGEST_TEXT) return { kind: "too-large" };

  const bytes = await readFile(file);
  if (bytes.includes(0)) return { kind: "invalid" };
  return { kind: "text", path, text: bytes.toString("utf8") };
}

/** How writing one text file went. */
export type WrittenText =
  | { readonly kind: "saved"; readonly path: string }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" };

/**
 * Replaces the text file `name` with `text`. The file must already be there,
 * and be a real file rather than a link: this is an edit of one the notebook
 * opened, not a way to create a file or to write somewhere else.
 */
export async function writeTextFile(
  directory: string,
  name: string,
  text: string,
): Promise<WrittenText> {
  const path = textPath(directory, name);
  if (path === undefined || text.includes("\0")) return { kind: "invalid" };
  if (Buffer.byteLength(text, "utf8") > LONGEST_TEXT) return { kind: "too-large" };
  const file = resolve(directory, path);

  let info;
  try {
    info = await lstat(file);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    throw cause;
  }
  if (!info.isFile()) return { kind: "absent" };

  await writeFile(file, text, "utf8");
  return { kind: "saved", path };
}

/**
 * Every text file under `directory`, as path to bytes. Skips the directories
 * the folder tree skips, links, files that are too long, and files that are
 * not text. One file at a time, as listing Notebooks does.
 */
export async function readTextFiles(directory: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  await walk(directory, directory, found);
  return found;
}

async function walk(directory: string, root: string, into: Map<string, string>): Promise<void> {
  const dirents = await readdir(directory, { withFileTypes: true });
  for (const dirent of dirents) {
    if (isSkipped(dirent.name)) continue;
    const path = join(directory, dirent.name);
    if (dirent.isDirectory()) await walk(path, root, into);
    else if (dirent.isFile() && isTextFile(dirent.name)) {
      const info = await lstat(path);
      if (!info.isFile() || info.size > LONGEST_TEXT) continue;
      const bytes = await readFile(path);
      if (bytes.includes(0)) continue;
      into.set(relative(root, path).split(sep).join("/"), bytes.toString("utf8"));
    }
  }
}

/**
 * Reviews for files `after` has that `before` did not, or has different
 * bytes for. A file that went away is not a review: nothing was generated,
 * and there is no new text to accept. Paths are in order, so two equal
 * results compare equal.
 */
export function reviewsBetween(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): TextReview[] {
  const reviews: TextReview[] = [];
  for (const [path, text] of after) {
    const prior = before.get(path);
    if (prior === undefined) reviews.push({ path, kind: "created" });
    else if (prior !== text) reviews.push({ path, kind: "modified", before: prior });
  }
  return reviews.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The snapshot a later comparison should use. A review still open keeps the
 * bytes from before that change, so a later Run does not treat an unaccepted
 * file as the starting point. Accepting updates the snapshot; until then the
 * original bytes stay the ones a rejection writes back.
 */
export function baselineUnder(
  disk: ReadonlyMap<string, string>,
  pending: readonly TextReview[],
): Map<string, string> {
  const baseline = new Map(disk);
  for (const review of pending) {
    if (review.kind === "created") baseline.delete(review.path);
    else if (review.before !== undefined) baseline.set(review.path, review.before);
  }
  return baseline;
}

/** Puts a rejected file back: the previous bytes, or nothing if it was new. */
export async function revertText(
  directory: string,
  review: TextReview,
): Promise<"reverted" | "invalid"> {
  const path = textPath(directory, review.path);
  if (path === undefined) return "invalid";
  const file = resolve(directory, path);
  if (review.kind === "created") {
    try {
      await rm(file, { force: true });
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "EISDIR" || code === "EPERM" || code === "ENOTEMPTY") return "invalid";
      throw cause;
    }
    return "reverted";
  }
  if (review.before === undefined) return "invalid";
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, review.before, "utf8");
  return "reverted";
}
