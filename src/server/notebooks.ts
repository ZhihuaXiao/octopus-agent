/**
 * Finding the Notebooks under the served directory.
 *
 * A Notebook is a Markdown file with at least one Cell in it: that is what the
 * glossary says a Notebook is — work described as a graph of Cells — and it is
 * what keeps a project's README, which has fenced snippets but no Cells, out of
 * the list. A file that does not parse is left out too, since nothing can be
 * done with it here: the browser edits what parses, so a file broken in
 * another editor is fixed there. Copying a Notebook, branching one through a
 * Cell, and making a new one live here too, being a matter of the files under
 * the directory rather than of any session. So does a file the sidebar
 * uploads or downloads: it has to be a real file the tree could list.
 */

import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import { formatDiagnostics } from "../notebook/diagnostic.js";
import {
  type EditResult,
  applyEdit,
  branchAt,
  notebookWithMode,
  notebookWithModel,
} from "../notebook/edit.js";
import { type Notebook, cellsOf, parseNotebook, titleOf } from "../notebook/notebook.js";
import { runsDirectory } from "../run/store.js";
import { within } from "../util/paths.js";
import { isTextFile } from "./text-files.js";

export interface NotebookEntry {
  /** Relative to the served directory, with forward slashes whatever the platform. */
  readonly path: string;
  /** The Notebook's declared title, or its file's name when it declares none. */
  readonly title: string;
  /** The model the Notebook names, when it names one. */
  readonly model?: string;
  /** The mode the Notebook names, when it names one. */
  readonly mode?: string;
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

function entryOf(directory: string, file: string, notebook: Notebook): NotebookEntry {
  const model = notebook.metadata.model;
  const mode = notebook.metadata.mode;
  return {
    path: pathWithin(directory, file),
    title: titleOf(notebook, file),
    ...(model !== undefined ? { model } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}

async function readEntry(directory: string, file: string): Promise<NotebookEntry | undefined> {
  const parsed = parseNotebook(await readFile(file, "utf8"));
  if (!parsed.ok || cellsOf(parsed.notebook).length === 0) return undefined;
  return entryOf(directory, file, parsed.notebook);
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
  return {
    kind: "copied",
    entry: {
      path: pathWithin(directory, target),
      title: entry.title,
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
    },
  };
}

/** How branching a Notebook through one of its Cells went. */
export type Branched =
  | { readonly kind: "branched"; readonly entry: NotebookEntry }
  /** No such Notebook under the served directory. */
  | { readonly kind: "absent" }
  /** The Notebook is there, and it has no Cell by that id. */
  | { readonly kind: "missing-cell" }
  /** The new name is not one a Notebook under the served directory can have. */
  | { readonly kind: "invalid"; readonly problem: string }
  /** A file is already there under the new name. */
  | { readonly kind: "exists" }
  /** Keeping the Notebook through that Cell would not leave a Notebook that can be opened. */
  | { readonly kind: "unreadable"; readonly problem: string };

/**
 * Writes a new Notebook at `to` that keeps the Notebook at `from` through the
 * Cell `cell` — the frontmatter, and every Prose and Cell up to and including
 * that one — and drops what follows. A Dependency on a Cell that was dropped
 * is dropped with it. The original is left as it is, and the branch has no
 * Runs until it is run: the original's are the original's history. Never over
 * a file that is already there; a directory the new name needs is made.
 */
export async function branchNotebook(
  directory: string,
  from: string,
  cell: string,
  to: string,
): Promise<Branched> {
  const source = fileWithin(directory, from);
  if (source === undefined) return { kind: "absent" };
  const named = notebookTarget(directory, to);
  if ("problem" in named) return { kind: "invalid", problem: named.problem };
  const target = named.file;

  let text: string;
  try {
    text = await readFile(source, "utf8");
  } catch (cause) {
    const { code } = cause as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return { kind: "absent" };
    throw cause;
  }
  const parsed = parseNotebook(text);
  if (!parsed.ok || cellsOf(parsed.notebook).length === 0) return { kind: "absent" };

  const edit = branchAt(parsed.notebook, cell);
  if (edit === undefined) return { kind: "missing-cell" };
  const made = applyEdit(parsed.notebook, edit);
  if (!made.ok) return { kind: "unreadable", problem: formatDiagnostics(made.errors) };

  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(target, made.source, { encoding: "utf8", flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return { kind: "exists" };
    throw cause;
  }
  return { kind: "branched", entry: entryOf(directory, target, made.notebook) };
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
 * is what opens as a Notebook. A text or source file — plain text, Markdown
 * that is not a Notebook, data such as CSV or JSON, or code such as Python,
 * JavaScript, TypeScript, or Java — opens in a subtab.
 * Anything else is a file, listed so a folder can be looked into, and not opened.
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
      /** The model the Notebook names, when it names one. */
      readonly model?: string;
      /** The mode the Notebook names, when it names one. */
      readonly mode?: string;
    }
  | { readonly kind: "text"; readonly name: string; readonly path: string }
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
          ? {
              kind: "notebook",
              name: dirent.name,
              path: relativePath,
              title: notebook.title,
              ...(notebook.model !== undefined ? { model: notebook.model } : {}),
              ...(notebook.mode !== undefined ? { mode: notebook.mode } : {}),
            }
          : isTextFile(dirent.name)
            ? { kind: "text", name: dirent.name, path: relativePath }
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
    entry: {
      path: pathWithin(directory, target),
      title: entry.title,
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
    },
  };
}

/** How renaming a file that is not a Notebook went. */
export type RenamedFile =
  | { readonly kind: "renamed"; readonly path: string }
  /** No such file under the served directory. */
  | { readonly kind: "absent" }
  /** The name is not one a file under the served directory can have. */
  | { readonly kind: "invalid"; readonly problem: string }
  /** A file is already there under the new name. */
  | { readonly kind: "exists" }
  /** The file is a Notebook, which is renamed on its own. */
  | { readonly kind: "notebook" };

/** A path the folder tree will not show: a tool's directory, or a dot-directory. */
const isHiddenPath = (name: string) =>
  name.split("/").some((part) => part === "node_modules" || part.startsWith("."));

/**
 * Renames the file at `from` to `to`, both relative to the served directory.
 * A Notebook is left for its own rename, which also moves its Runs. Never
 * over a file that is already there, and never out of the directory. A
 * directory the new name needs is made.
 */
export async function renameFile(
  directory: string,
  from: string,
  to: string,
): Promise<RenamedFile> {
  const source = fileWithin(directory, from);
  const target = fileWithin(directory, to);
  if (source === undefined || isHiddenPath(pathWithin(directory, source)))
    return { kind: "absent" };
  if (target === undefined || isHiddenPath(pathWithin(directory, target))) {
    return {
      kind: "invalid",
      problem: `The new name must be a file under ${directory}.`,
    };
  }

  let info;
  try {
    info = await lstat(source);
  } catch (cause) {
    const { code } = cause as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    throw cause;
  }
  // A link is not followed: it can name a file outside the directory.
  if (!info.isFile()) return { kind: "absent" };
  if (extname(source) === NOTEBOOK_EXTENSION) {
    const entry = await readEntry(directory, source);
    if (entry !== undefined) return { kind: "notebook" };
  }

  const path = pathWithin(directory, target);
  if (source === target) return { kind: "renamed", path };
  if (await isThere(target)) return { kind: "exists" };

  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(source, target);
  } catch (cause) {
    const { code } = cause as NodeJS.ErrnoException;
    if (code === "EEXIST") return { kind: "exists" };
    if (code === "ENOTDIR" || code === "EISDIR") {
      return { kind: "invalid", problem: `The new name must be a file under ${directory}.` };
    }
    throw cause;
  }
  return { kind: "renamed", path };
}

/**
 * As much as one upload may write. Larger than a text file the notebook opens,
 * so a picture or a data file still fits, and small enough that one request
 * cannot fill the disk by accident.
 */
export const LONGEST_UPLOAD = 8 * 1024 * 1024;

/** How reading a file the sidebar lists went. */
export type WorkspaceRead =
  | { readonly kind: "file"; readonly path: string; readonly name: string; readonly bytes: Buffer }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" };

/** How writing an uploaded file went. */
export type WorkspaceStored =
  | { readonly kind: "saved"; readonly path: string }
  | { readonly kind: "exists"; readonly path: string }
  | { readonly kind: "invalid"; readonly problem: string }
  | { readonly kind: "too-large" };

/**
 * A path the sidebar could show: under the served directory, and not in a
 * directory the tree skips. Nothing when it climbs out, names a hidden path,
 * or is not a path at all.
 */
function visibleFile(directory: string, name: string): string | undefined {
  const file = fileWithin(directory, name);
  if (file === undefined) return undefined;
  const path = pathWithin(directory, file);
  return isHiddenPath(path) ? undefined : file;
}

/**
 * Whether `file` is a real file reached without following a link. A link at
 * the file, or anywhere along the path, is absent: following it could read
 * something outside the served directory.
 */
async function walkFile(directory: string, file: string): Promise<"file" | "absent"> {
  const parts = pathWithin(directory, file).split("/");
  if (parts.length === 0 || parts.some((part) => part === "")) return "absent";
  let current = directory;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) return "absent";
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return "absent";
      throw cause;
    }
    if (info.isSymbolicLink()) return "absent";
    const last = index === parts.length - 1;
    if (last ? !info.isFile() : !info.isDirectory()) return "absent";
  }
  return "file";
}

const outside = (directory: string): WorkspaceStored => ({
  kind: "invalid",
  problem: `The file must be under ${directory}.`,
});

/**
 * Makes each missing parent of `file` as a real directory, and reports when
 * the file itself is already there. A link is not followed and not replaced:
 * one along the path can point outside the directory, and one at the file is
 * something already there.
 */
async function prepareUpload(
  directory: string,
  file: string,
): Promise<"ready" | "exists" | "invalid"> {
  const parts = pathWithin(directory, file).split("/");
  if (parts.length === 0 || parts.some((part) => part === "")) return "invalid";
  let current = directory;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) return "invalid";
    current = join(current, part);
    const last = index === parts.length - 1;
    let info;
    try {
      info = await lstat(current);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR") return "invalid";
      if (code !== "ENOENT") throw cause;
      if (last) return "ready";
      try {
        await mkdir(current);
      } catch (made) {
        const madeCode = (made as NodeJS.ErrnoException).code;
        if (madeCode === "ENOTDIR" || madeCode === "EISDIR") return "invalid";
        if (madeCode !== "EEXIST") throw made;
        const again = await lstat(current).catch(() => undefined);
        if (again === undefined || again.isSymbolicLink() || !again.isDirectory()) return "invalid";
      }
      continue;
    }
    if (info.isSymbolicLink()) return last ? "exists" : "invalid";
    if (!last) {
      if (!info.isDirectory()) return "invalid";
      continue;
    }
    return "exists";
  }
  return "invalid";
}

/**
 * The file `name` names under `directory`, when the sidebar could list it.
 * Read without following a link, so a link out of the directory is not a way
 * to fetch what it points at.
 */
export async function readWorkspaceFile(directory: string, name: string): Promise<WorkspaceRead> {
  const file = visibleFile(directory, name);
  if (file === undefined) return { kind: "invalid" };
  if ((await walkFile(directory, file)) !== "file") return { kind: "absent" };

  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR" || code === "ELOOP") {
      return { kind: "absent" };
    }
    throw cause;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { kind: "absent" };
    const path = pathWithin(directory, file);
    return {
      kind: "file",
      path,
      name: path.split("/").pop() ?? path,
      bytes: await handle.readFile(),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Writes `bytes` to `name` under `directory`. Never over a file already
 * there, and never through a link. A directory the name needs is made, when
 * that directory is itself under the served directory.
 */
export async function storeWorkspaceFile(
  directory: string,
  name: string,
  bytes: Buffer,
): Promise<WorkspaceStored> {
  if (bytes.length > LONGEST_UPLOAD) return { kind: "too-large" };
  const file = visibleFile(directory, name);
  if (file === undefined) return outside(directory);
  const path = pathWithin(directory, file);
  const prepared = await prepareUpload(directory, file);
  if (prepared === "invalid") return outside(directory);
  if (prepared === "exists") return { kind: "exists", path };

  let handle;
  try {
    handle = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    );
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ELOOP") return { kind: "exists", path };
    if (code === "ENOTDIR" || code === "EISDIR") return outside(directory);
    throw cause;
  }
  try {
    await handle.writeFile(bytes);
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await rm(file, { force: true }).catch(() => undefined);
    throw cause;
  }
  await handle.close();
  return { kind: "saved", path };
}

/** How removing a file the sidebar lists went. */
export type WorkspaceRemoved =
  | { readonly kind: "removed"; readonly path: string }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly problem: string };

/**
 * Removes the file `name` names under `directory`. A directory is left, and a
 * link is not removed and not followed: either could delete more than the
 * file the sidebar listed.
 */
export async function removeWorkspaceFile(
  directory: string,
  name: string,
): Promise<WorkspaceRemoved> {
  const file = visibleFile(directory, name);
  if (file === undefined) {
    return { kind: "invalid", problem: `The file must be under ${directory}.` };
  }
  if ((await walkFile(directory, file)) !== "file") return { kind: "absent" };
  try {
    await rm(file);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    if (code === "EISDIR" || code === "EPERM" || code === "ENOTEMPTY") {
      return { kind: "invalid", problem: `The file must be under ${directory}.` };
    }
    throw cause;
  }
  return { kind: "removed", path: pathWithin(directory, file) };
}

/** How naming a Notebook's model went. */
export type Assigned =
  | { readonly kind: "saved"; readonly entry: NotebookEntry }
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly problem: string };

/**
 * Writes one frontmatter field into the Notebook at `name`, or removes it when
 * `value` is absent. A Notebook that already has that value is left as it was.
 * One a session holds is not this function's to write: the session writes its
 * own file, so the two cannot pass each other.
 */
async function assignNotebookField(
  directory: string,
  name: string,
  field: "model" | "mode",
  value: string | undefined,
  rewrite: (notebook: Notebook, value: string | undefined) => EditResult,
): Promise<Assigned> {
  const file = fileWithin(directory, name);
  if (file === undefined) return { kind: "absent" };
  const relativePath = pathWithin(directory, file);

  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (cause) {
    const { code } = cause as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return { kind: "absent" };
    throw cause;
  }

  const parsed = parseNotebook(source);
  if (!parsed.ok) {
    return {
      kind: "refused",
      problem: `Cannot save ${relativePath}:\n${formatDiagnostics(parsed.errors)}`,
    };
  }
  if (cellsOf(parsed.notebook).length === 0) return { kind: "absent" };
  if (parsed.notebook.metadata[field] === value) {
    return { kind: "saved", entry: entryOf(directory, file, parsed.notebook) };
  }

  const made = rewrite(parsed.notebook, value);
  if (!made.ok) {
    return {
      kind: "refused",
      problem: `Cannot save ${relativePath}:\n${formatDiagnostics(made.errors)}`,
    };
  }
  if (cellsOf(made.notebook).length === 0) {
    return { kind: "refused", problem: `Cannot save ${relativePath}: it has no cells.` };
  }

  await writeFile(file, made.source, "utf8");
  return { kind: "saved", entry: entryOf(directory, file, made.notebook) };
}

/**
 * Writes `model` into the Notebook at `name`, or removes the field when
 * `model` is absent. A Notebook that already names that model is left as it
 * was. One a session holds is not this function's to write: the session writes
 * its own file, so the two cannot pass each other.
 */
export function assignNotebookModel(
  directory: string,
  name: string,
  model: string | undefined,
): Promise<Assigned> {
  return assignNotebookField(directory, name, "model", model, notebookWithModel);
}

/**
 * Writes `mode` into the Notebook at `name`, or removes the field when `mode`
 * is absent. A Notebook that already names that mode is left as it was. One a
 * session holds is not this function's to write: the session writes its own
 * file, so the two cannot pass each other.
 */
export function assignNotebookMode(
  directory: string,
  name: string,
  mode: string | undefined,
): Promise<Assigned> {
  return assignNotebookField(directory, name, "mode", mode, notebookWithMode);
}
