/**
 * The Workspace: manages files, notebooks, directories, and run lifecycle cleanup
 * under a workspace root directory.
 *
 * Encapsulates path security boundaries, file read/write limits, directory tree
 * walks, notebook CRUD operations, and automatic pruning or migration of associated
 * .octo/runs and chat sessions.
 */

import { constants, existsSync } from "node:fs";
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
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { formatDiagnostics } from "../notebook/diagnostic.js";
import {
  type EditResult,
  type Notebook,
  NotebookDocument,
  applyEdit,
  branchAt,
  cellsOf,
  notebookWithMode,
  notebookWithModel,
  parseNotebook,
  titleOf,
} from "../notebook/notebook.js";
import type { RunRecord } from "../run/record.js";
import { runsDirectory } from "../run/store.js";
import { within } from "../util/paths.js";
import { isSkipped, markdownFiles } from "../util/tree.js";
import {
  type ReadText,
  type WrittenText,
  isTextFile,
  readTextFile,
  writeTextFile,
} from "./text-files.js";

export const NOTEBOOK_EXTENSION = ".md";

/** A Notebook's path as the workspace names it: relative to the root directory, forward slashes. */
export const pathWithin = (directory: string, file: string): string =>
  relative(directory, file).split(sep).join("/");

/** The file a name under the root directory points at, or nothing when it leads out. */
export function fileWithin(directory: string, name: string): string | undefined {
  if (name.includes("\0")) return undefined;
  const file = resolve(directory, name);
  return within(directory, file) ? file : undefined;
}

/**
 * The file a new Notebook is to be written to, given the name asked for: a
 * Markdown file under the directory, or the problem with the name.
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

export interface NotebookEntry {
  /** Relative to the root directory, with forward slashes whatever the platform. */
  readonly path: string;
  /** The Notebook's declared title, or its file's name when it declares none. */
  readonly title: string;
  /** The model the Notebook names, when it names one. */
  readonly model?: string;
  /** The mode the Notebook names, when it names one. */
  readonly mode?: string;
}

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
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseNotebook(source);
  if (!parsed.ok || cellsOf(parsed.notebook).length === 0) return undefined;
  return entryOf(directory, file, parsed.notebook);
}

/** Whether a path is on disk. A missing one is the absence, not an error. */
const isThere = (path: string) =>
  stat(path).then(
    () => true,
    (cause: NodeJS.ErrnoException) => {
      if (
        cause.code === "ENOENT" ||
        cause.code === "ENOTDIR" ||
        cause.code === "EACCES" ||
        cause.code === "EPERM"
      )
        return false;
      throw cause;
    },
  );

/** One entry of the directory, as the sidebar draws it. */
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
      readonly model?: string;
      readonly mode?: string;
    }
  | { readonly kind: "text"; readonly name: string; readonly path: string }
  | { readonly kind: "file"; readonly name: string; readonly path: string };

/** How copying a Notebook went. */
export type Copied =
  | { readonly kind: "copied"; readonly entry: NotebookEntry }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly problem: string }
  | { readonly kind: "exists" };

/** How branching a Notebook through one of its Cells went. */
export type Branched =
  | { readonly kind: "branched"; readonly entry: NotebookEntry }
  | { readonly kind: "absent" }
  | { readonly kind: "missing-cell" }
  | { readonly kind: "invalid"; readonly problem: string }
  | { readonly kind: "exists" }
  | { readonly kind: "unreadable"; readonly problem: string };

/** How making a new Notebook went. */
export type Created =
  | { readonly kind: "created"; readonly entry: NotebookEntry }
  | { readonly kind: "invalid"; readonly problem: string }
  | { readonly kind: "exists" };

/** How renaming a Notebook went. */
export type Renamed =
  | { readonly kind: "renamed"; readonly entry: NotebookEntry }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly problem: string }
  | { readonly kind: "exists" }
  | { readonly kind: "runs" };

/** How renaming a file that is not a Notebook went. */
export type RenamedFile =
  | { readonly kind: "renamed"; readonly path: string }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly problem: string }
  | { readonly kind: "exists" }
  | { readonly kind: "notebook" };

export const LONGEST_UPLOAD = 8 * 1024 * 1024;

export type WorkspaceRead =
  | { readonly kind: "file"; readonly path: string; readonly name: string; readonly bytes: Buffer }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" };

export type WorkspaceStored =
  | { readonly kind: "saved"; readonly path: string }
  | { readonly kind: "exists"; readonly path: string }
  | { readonly kind: "invalid"; readonly problem: string }
  | { readonly kind: "too-large" };

export type WorkspaceRemoved =
  | { readonly kind: "removed"; readonly path: string }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly problem: string };

export type Assigned =
  | { readonly kind: "saved"; readonly entry: NotebookEntry }
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly problem: string };

const isHiddenPath = (name: string) =>
  name.split("/").some((part) => part === "node_modules" || part.startsWith("."));

function visibleFile(directory: string, name: string): string | undefined {
  if (name.includes("\0")) return undefined;
  const file = resolve(directory, name);
  if (!within(directory, file)) return undefined;
  return isHiddenPath(pathWithin(directory, file)) ? undefined : file;
}

async function walkFile(directory: string, file: string): Promise<"file" | "folder" | "missing"> {
  let current = file;
  while (current !== directory) {
    let info;
    try {
      info = await lstat(current);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM")
        return "missing";
      throw cause;
    }
    if (info.isSymbolicLink()) return "missing";
    if (current === file && info.isDirectory()) return "folder";
    if (current !== file && !info.isDirectory()) return "missing";
    current = dirname(current);
  }
  return "file";
}

const outside = (directory: string): WorkspaceStored => ({
  kind: "invalid",
  problem: `The file must be under ${directory}.`,
});

async function prepareUpload(
  directory: string,
  file: string,
): Promise<"ready" | "exists" | "invalid"> {
  const parent = dirname(file);
  let current = parent;
  const missing: string[] = [];
  while (current !== directory) {
    let info;
    try {
      info = await lstat(current);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        missing.push(current);
        current = dirname(current);
        continue;
      }
      if (code === "ENOTDIR") return "invalid";
      throw cause;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return "invalid";
    break;
  }

  for (let i = missing.length - 1; i >= 0; i--) {
    const dir = missing[i]!;
    try {
      await mkdir(dir);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        const info = await lstat(dir).catch(() => undefined);
        if (!info || info.isSymbolicLink() || !info.isDirectory()) return "invalid";
      } else {
        throw cause;
      }
    }
  }

  try {
    const info = await lstat(file);
    return info ? "exists" : "ready";
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "ready";
    return "invalid";
  }
}

/** Updates run records and renames associated session files when a notebook is renamed. */
export async function renameNotebookRunsAndSessions(
  source: string,
  target: string,
  fromRuns: string,
  toRuns: string,
  directory: string,
  chatDirectory?: string,
): Promise<void> {
  const fromStem = basename(source, extname(source));
  const toStem = basename(target, extname(target));

  if (await isThere(toRuns)) {
    const runDirs = await readdir(toRuns, { withFileTypes: true }).catch(() => []);
    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      const recFile = join(toRuns, runDir.name, "record.json");
      let record: RunRecord | undefined;
      try {
        record = JSON.parse(await readFile(recFile, "utf8")) as RunRecord;
      } catch {
        continue;
      }
      if (!record) continue;

      let changed = false;
      const updatedRecord: any = { ...record };
      if (record.notebook !== undefined) {
        updatedRecord.notebook = target;
        changed = true;
      }

      if (record.agentSession !== undefined) {
        let sessionFile = resolve(record.agentSession);
        if (sessionFile.startsWith(resolve(fromRuns))) {
          sessionFile = sessionFile.replace(resolve(fromRuns), resolve(toRuns));
          updatedRecord.agentSession = sessionFile;
          changed = true;
        } else if (fromStem !== toStem) {
          const newSessionFile = sessionFile.endsWith(`_${fromStem}.jsonl`)
            ? sessionFile.replace(new RegExp(`_${fromStem}\\.jsonl$`), `_${toStem}.jsonl`)
            : sessionFile.replace(/\.jsonl$/, `_${toStem}.jsonl`);
          if (newSessionFile !== sessionFile) {
            if (existsSync(sessionFile)) {
              await rename(sessionFile, newSessionFile).catch(() => undefined);
            }
            updatedRecord.agentSession = newSessionFile;
            changed = true;
          }
        }
      }

      if (record.cells !== undefined) {
        const updatedCells = [];
        for (const cell of record.cells) {
          if ("agentSession" in cell && typeof cell.agentSession === "string") {
            let sessionFile = resolve(cell.agentSession);
            if (sessionFile.startsWith(resolve(fromRuns))) {
              sessionFile = sessionFile.replace(resolve(fromRuns), resolve(toRuns));
              updatedCells.push({ ...cell, agentSession: sessionFile });
              changed = true;
            } else if (fromStem !== toStem) {
              const newSessionFile = sessionFile.endsWith(`_${fromStem}.jsonl`)
                ? sessionFile.replace(new RegExp(`_${fromStem}\\.jsonl$`), `_${toStem}.jsonl`)
                : sessionFile.replace(/\.jsonl$/, `_${toStem}.jsonl`);
              if (newSessionFile !== sessionFile) {
                if (existsSync(sessionFile)) {
                  await rename(sessionFile, newSessionFile).catch(() => undefined);
                }
                updatedCells.push({ ...cell, agentSession: newSessionFile });
                changed = true;
              } else {
                updatedCells.push(cell);
              }
            } else {
              updatedCells.push(cell);
            }
          } else {
            updatedCells.push(cell);
          }
        }
        if (changed) {
          updatedRecord.cells = updatedCells;
        }
      }

      if (changed) {
        await writeFile(recFile, JSON.stringify(updatedRecord, null, 2), "utf8").catch(
          () => undefined,
        );
      }
    }
  }

  let sessionDir = chatDirectory;
  if (sessionDir === undefined) {
    try {
      sessionDir = SessionManager.create(directory).getSessionDir();
    } catch {
      sessionDir = undefined;
    }
  }
  if (sessionDir !== undefined && existsSync(sessionDir) && fromStem !== toStem) {
    const files = await readdir(sessionDir).catch(() => []);
    for (const file of files) {
      if (file.endsWith(`_${fromStem}.jsonl`)) {
        const oldPath = join(sessionDir, file);
        const newPath = join(
          sessionDir,
          file.replace(new RegExp(`_${fromStem}\\.jsonl$`), `_${toStem}.jsonl`),
        );
        await rename(oldPath, newPath).catch(() => undefined);
      }
    }
  }

  const fromRelPath = pathWithin(directory, source);
  const toRelPath = pathWithin(directory, target);
  const journalDir = join(directory, ".octo", "journals");
  if (existsSync(journalDir)) {
    const journals = await readdir(journalDir, { withFileTypes: true }).catch(() => []);
    for (const entry of journals) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const jFile = join(journalDir, entry.name);
        try {
          const content = await readFile(jFile, "utf8");
          if (content.includes(`"notebook":"${fromRelPath}"`)) {
            const updated = content.replaceAll(
              `"notebook":"${fromRelPath}"`,
              `"notebook":"${toRelPath}"`,
            );
            await writeFile(jFile, updated, "utf8");
          }
        } catch {
          // Journal update best effort
        }
      }
    }
  }
}

/** Removes all run records, journals, and session files belonging to a deleted notebook. */
export async function cleanNotebookRunsAndSessions(
  directory: string,
  notebookFile: string,
  chatDirectory?: string,
): Promise<void> {
  const fromRuns = runsDirectory(notebookFile);
  const stem = basename(notebookFile, extname(notebookFile));

  if (await isThere(fromRuns)) {
    const runDirs = await readdir(fromRuns, { withFileTypes: true }).catch(() => []);
    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      const recFile = join(fromRuns, runDir.name, "record.json");
      const record = await readFile(recFile, "utf8")
        .then((text) => JSON.parse(text) as RunRecord)
        .catch(() => undefined);
      if (record?.agentSession !== undefined) {
        await unlink(resolve(record.agentSession)).catch(() => undefined);
      }
      if (record?.cells !== undefined) {
        for (const cell of record.cells) {
          if ("agentSession" in cell && typeof cell.agentSession === "string") {
            await unlink(resolve(cell.agentSession)).catch(() => undefined);
          }
        }
      }
    }
    await rm(fromRuns, { recursive: true, force: true }).catch(() => undefined);
  }

  let sessionDir = chatDirectory;
  if (sessionDir === undefined) {
    try {
      sessionDir = SessionManager.create(directory).getSessionDir();
    } catch {
      sessionDir = undefined;
    }
  }
  if (sessionDir !== undefined && existsSync(sessionDir)) {
    const files = await readdir(sessionDir).catch(() => []);
    for (const file of files) {
      if (file.endsWith(`_${stem}.jsonl`)) {
        await unlink(join(sessionDir, file)).catch(() => undefined);
      }
    }
  }

  const relPath = pathWithin(directory, notebookFile);
  const journalDir = join(directory, ".octo", "journals");
  if (existsSync(journalDir)) {
    const journals = await readdir(journalDir, { withFileTypes: true }).catch(() => []);
    for (const entry of journals) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const jFile = join(journalDir, entry.name);
        const content = await readFile(jFile, "utf8").catch(() => "");
        if (
          content.includes(`"notebook":"${relPath}"`) ||
          content.includes(`"notebook":"${notebookFile}"`)
        ) {
          await unlink(jFile).catch(() => undefined);
        }
      }
    }
  }
}

async function readTree(directory: string, root: string): Promise<TreeEntry[]> {
  const dirents = await readdir(directory, { withFileTypes: true }).catch(() => []);
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

async function assignField(
  directory: string,
  name: string,
  field: "model" | "mode",
  value: string | undefined,
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

  const parsed = NotebookDocument.parse(source);
  if (!parsed.ok) {
    return {
      kind: "refused",
      problem: `Cannot save ${relativePath}:\n${formatDiagnostics(parsed.errors)}`,
    };
  }
  const doc = parsed.document;
  if (doc.cells.length === 0) return { kind: "absent" };
  if (doc.metadata[field] === value) {
    return { kind: "saved", entry: entryOf(directory, file, doc.notebook) };
  }

  const made = field === "model" ? doc.setModel(value) : doc.setMode(value);
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

export interface WorkspaceOptions {
  readonly directory: string;
  readonly chatDirectory?: string | undefined;
}

export interface Workspace {
  readonly directory: string;
  readonly chatDirectory?: string | undefined;

  fileWithin(name: string): string | undefined;
  pathWithin(file: string): string;

  listTree(): Promise<TreeEntry[]>;
  listNotebooks(): Promise<NotebookEntry[]>;

  readFile(name: string): Promise<WorkspaceRead>;
  storeFile(name: string, bytes: Buffer): Promise<WorkspaceStored>;
  removeFile(name: string): Promise<WorkspaceRemoved>;
  renameFile(from: string, to: string): Promise<RenamedFile>;

  readText(name: string): Promise<ReadText>;
  writeText(name: string, text: string): Promise<WrittenText>;

  createNotebook(to: string): Promise<Created>;
  copyNotebook(from: string, to: string): Promise<Copied>;
  branchNotebook(from: string, cell: string, to: string): Promise<Branched>;
  renameNotebook(from: string, to: string): Promise<Renamed>;
  removeNotebook(name: string): Promise<WorkspaceRemoved>;

  assignNotebookModel(name: string, model: string | undefined): Promise<Assigned>;
  assignNotebookMode(name: string, mode: string | undefined): Promise<Assigned>;
}

export function createWorkspace(options: WorkspaceOptions): Workspace {
  const directory = resolve(options.directory);
  const chatDirectory = options.chatDirectory;

  return {
    directory,
    chatDirectory,

    fileWithin(name: string): string | undefined {
      return fileWithin(directory, name);
    },

    pathWithin(file: string): string {
      return pathWithin(directory, file);
    },

    listTree(): Promise<TreeEntry[]> {
      return readTree(directory, directory);
    },

    async listNotebooks(): Promise<NotebookEntry[]> {
      const found: NotebookEntry[] = [];
      for (const file of await markdownFiles(directory)) {
        const entry = await readEntry(directory, file);
        if (entry !== undefined) found.push(entry);
      }
      return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },

    readFile(name: string): Promise<WorkspaceRead> {
      return (async () => {
        const file = visibleFile(directory, name);
        if (file === undefined) return { kind: "invalid" as const };
        if ((await walkFile(directory, file)) !== "file") return { kind: "absent" as const };

        let handle;
        try {
          handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR" || code === "ELOOP") {
            return { kind: "absent" as const };
          }
          throw cause;
        }
        try {
          const info = await handle.stat();
          if (!info.isFile()) return { kind: "absent" as const };
          const path = pathWithin(directory, file);
          return {
            kind: "file" as const,
            path,
            name: path.split("/").pop() ?? path,
            bytes: await handle.readFile(),
          };
        } finally {
          await handle.close();
        }
      })();
    },

    storeFile(name: string, bytes: Buffer): Promise<WorkspaceStored> {
      return (async () => {
        if (bytes.length > LONGEST_UPLOAD) return { kind: "too-large" as const };
        const file = visibleFile(directory, name);
        if (file === undefined) return outside(directory);
        const path = pathWithin(directory, file);
        const prepared = await prepareUpload(directory, file);
        if (prepared === "invalid") return outside(directory);
        if (prepared === "exists") return { kind: "exists" as const, path };

        let handle;
        try {
          handle = await open(
            file,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          );
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException).code;
          if (code === "EEXIST" || code === "ELOOP") return { kind: "exists" as const, path };
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
        return { kind: "saved" as const, path };
      })();
    },

    async removeFile(name: string): Promise<WorkspaceRemoved> {
      const file = visibleFile(directory, name);
      if (file === undefined) {
        return { kind: "invalid", problem: `The file must be under ${directory}.` };
      }
      if ((await walkFile(directory, file)) !== "file") return { kind: "absent" };
      const ext = extname(file).toLowerCase();
      const isNotebook = ext === ".md" || ext === ".markdown";
      try {
        await rm(file);
        if (isNotebook) {
          await cleanNotebookRunsAndSessions(directory, file, chatDirectory);
        }
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
        if (code === "EISDIR" || code === "EPERM" || code === "ENOTEMPTY") {
          return { kind: "invalid", problem: `The file must be under ${directory}.` };
        }
        throw cause;
      }
      return { kind: "removed", path: pathWithin(directory, file) };
    },

    async renameFile(from: string, to: string): Promise<RenamedFile> {
      const source = fileWithin(directory, from);
      const target = fileWithin(directory, to);
      if (source === undefined || isHiddenPath(pathWithin(directory, source))) {
        return { kind: "absent" };
      }
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
    },

    readText(name: string): Promise<ReadText> {
      return readTextFile(directory, name);
    },

    writeText(name: string, text: string): Promise<WrittenText> {
      return writeTextFile(directory, name, text);
    },

    async createNotebook(to: string): Promise<Created> {
      const named = notebookTarget(directory, to);
      if ("problem" in named) return { kind: "invalid", problem: named.problem };
      const target = named.file;

      const doc = NotebookDocument.empty();
      await mkdir(dirname(target), { recursive: true });
      try {
        await writeFile(target, doc.serialize(), { encoding: "utf8", flag: "wx" });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") return { kind: "exists" };
        throw cause;
      }
      return {
        kind: "created",
        entry: { path: pathWithin(directory, target), title: doc.title(target) },
      };
    },

    async copyNotebook(from: string, to: string): Promise<Copied> {
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
    },

    async branchNotebook(from: string, cell: string, to: string): Promise<Branched> {
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
      const docRes = NotebookDocument.parse(text);
      if (!docRes.ok || docRes.document === undefined || docRes.document.cells.length === 0) {
        return { kind: "absent" };
      }

      const branched = docRes.document.branchAt(cell);
      if (branched === undefined) return { kind: "missing-cell" };

      await mkdir(dirname(target), { recursive: true });
      try {
        await writeFile(target, branched.serialize(), { encoding: "utf8", flag: "wx" });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") return { kind: "exists" };
        throw cause;
      }
      return { kind: "branched", entry: entryOf(directory, target, branched.notebook) };
    },

    async renameNotebook(from: string, to: string): Promise<Renamed> {
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

      await renameNotebookRunsAndSessions(
        source,
        target,
        fromRuns,
        toRuns,
        directory,
        chatDirectory,
      );

      return {
        kind: "renamed",
        entry: {
          path: pathWithin(directory, target),
          title: entry.title,
          ...(entry.model !== undefined ? { model: entry.model } : {}),
          ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
        },
      };
    },

    async removeNotebook(name: string): Promise<WorkspaceRemoved> {
      return this.removeFile(name);
    },

    assignNotebookModel(name: string, model: string | undefined): Promise<Assigned> {
      return assignField(directory, name, "model", model);
    },

    assignNotebookMode(name: string, mode: string | undefined): Promise<Assigned> {
      return assignField(directory, name, "mode", mode);
    },
  };
}

export const listNotebooks = (directory: string) => createWorkspace({ directory }).listNotebooks();
export const listTree = (directory: string) => createWorkspace({ directory }).listTree();
export const copyNotebook = (directory: string, from: string, to: string) =>
  createWorkspace({ directory }).copyNotebook(from, to);
export const branchNotebook = (directory: string, from: string, cell: string, to: string) =>
  createWorkspace({ directory }).branchNotebook(from, cell, to);
export const createNotebook = (directory: string, to: string) =>
  createWorkspace({ directory }).createNotebook(to);
export const renameNotebook = (
  directory: string,
  from: string,
  to: string,
  chatDirectory?: string,
) => createWorkspace({ directory, chatDirectory }).renameNotebook(from, to);
export const renameFile = (directory: string, from: string, to: string) =>
  createWorkspace({ directory }).renameFile(from, to);
export const readWorkspaceFile = (directory: string, name: string) =>
  createWorkspace({ directory }).readFile(name);
export const storeWorkspaceFile = (directory: string, name: string, bytes: Buffer) =>
  createWorkspace({ directory }).storeFile(name, bytes);
export const removeWorkspaceFile = (directory: string, name: string, chatDirectory?: string) =>
  createWorkspace({ directory, chatDirectory }).removeFile(name);
export const assignNotebookModel = (directory: string, name: string, model: string | undefined) =>
  createWorkspace({ directory }).assignNotebookModel(name, model);
export const assignNotebookMode = (directory: string, name: string, mode: string | undefined) =>
  createWorkspace({ directory }).assignNotebookMode(name, mode);
