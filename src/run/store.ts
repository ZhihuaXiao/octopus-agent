import { randomUUID } from "node:crypto";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { OWNER_FILE, mkdirOwner, protectOwner } from "../util/owner.js";
import { within } from "../util/paths.js";
import { markdownFiles } from "../util/tree.js";
import type { RunRecord } from "./record.js";

/**
 * Persists Run Records outside the Notebook, as ADR-0005 requires.
 *
 * Each Run gets its own directory rather than a bare file, so that the Run's
 * Artifacts sit beside its record and the two travel together.
 */

const OCTO_DIRECTORY = ".octo";
const ARTIFACTS_DIRECTORY = "artifacts";

/** Where a Notebook's Runs are kept: one directory each, under the Notebook's own. */
export function runsDirectory(notebookPath: string): string {
  const stem = basename(notebookPath, extname(notebookPath));
  return join(dirname(notebookPath), OCTO_DIRECTORY, "runs", stem);
}

export function runDirectory(notebookPath: string, runId: string): string {
  return join(runsDirectory(notebookPath), runId);
}

export function recordPath(notebookPath: string, runId: string): string {
  return join(runDirectory(notebookPath, runId), "record.json");
}

/**
 * The file at `file` under the directory of the Notebook's Run `runId`, as it
 * really is on disk — an Artifact as a record names one, or the record itself
 * — or nothing when the pair names no file there.
 *
 * Nothing, in particular, for a run name or a file path that climbs out of the
 * directory it was given, however the climb is spelt, and for a link a Cell
 * left pointing out of its directory: the Run's directory is the only place the
 * Run answers for, so the path is followed to where it really leads before it
 * is said to be inside. What was asked for here came off a request.
 */
export async function runFile(
  notebookPath: string,
  runId: string,
  file: string,
): Promise<string | undefined> {
  if (runId.includes("\0") || file.includes("\0")) return undefined;
  const directory = resolve(runDirectory(notebookPath, runId));
  if (!within(resolve(runsDirectory(notebookPath)), directory)) return undefined;
  const named = resolve(directory, file);
  if (!within(directory, named)) return undefined;

  try {
    const real = await realpath(named);
    return within(await realpath(directory), real) ? real : undefined;
  } catch {
    return undefined; // Nothing there, or a directory on the way that is not one.
  }
}

/**
 * What a file a Run left is taken to be, by its name, wherever it is shown. An
 * image is an image, so it is drawn; plain text and the record are text, so
 * they are shown; anything else — HTML and SVG among it — is bytes to be
 * offered as a download and never a page, because nothing an agent wrote is
 * ever run by whatever shows it (ticket 16). One table, so the server and an
 * Export cannot disagree about what a file is.
 */
const RUN_FILE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** What a file of a Run is offered as when it is not to be shown at all. */
export const DOWNLOAD = "application/octet-stream";

/** The media type a file a Run left is shown as, `DOWNLOAD` when it is not shown. */
export const runFileType = (file: string): string =>
  RUN_FILE_TYPES[extname(file).toLowerCase()] ?? DOWNLOAD;

export const isImage = (type: string) => type.startsWith("image/");
export const isText = (type: string) => type !== DOWNLOAD && !isImage(type);

/**
 * Where one Cell of a Run puts its Artifacts: a directory of its own under the
 * Run's, so two Cells writing the same name cannot collide and nothing has to
 * work out afterwards which Cell left which file.
 */
export function artifactsDirectory(notebookPath: string, runId: string, cellId: string): string {
  return join(runDirectory(notebookPath, runId), ARTIFACTS_DIRECTORY, cellId);
}

/** Sortable by name, so runs list in the order they happened. */
export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * The Artifacts a Cell left in its directory, as paths relative to the Run's
 * directory — `artifacts/<cell>/chart.png` — so the record and the files it
 * names stay right relative to each other wherever the Run's directory goes.
 *
 * Every file however deep, in a fixed order, and none at all for a Cell that
 * was never given a directory: a Cell that did not refer to `{{artifacts}}`
 * has nowhere it could have left one.
 */
export async function listArtifacts(
  notebookPath: string,
  runId: string,
  cellId: string,
): Promise<string[]> {
  const run = runDirectory(notebookPath, runId);
  const directory = artifactsDirectory(notebookPath, runId, cellId);

  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    },
  );

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(run, join(entry.parentPath, entry.name)))
    .sort();
}

export async function writeRunRecord(record: RunRecord): Promise<string> {
  const path = recordPath(record.notebook, record.id);
  await mkdirOwner(dirname(path));
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: OWNER_FILE,
  });
  await protectOwner(path);
  return path;
}

/**
 * The record of the Notebook's Run `runId`, or nothing when there is none —
 * no such Run, one still under way, or a name that climbs out of the Runs'
 * directory, which is refused as `runFile` refuses it.
 */
export async function readRunRecord(
  notebookPath: string,
  runId: string,
): Promise<RunRecord | undefined> {
  const file = await runFile(notebookPath, runId, "record.json");
  if (file === undefined) return undefined;
  return JSON.parse(await readFile(file, "utf8")) as RunRecord;
}

/**
 * The id of the Notebook's latest Run to have written its record, or nothing
 * when none has. By name, since Run ids sort in the order the Runs began; a
 * Run under way has no record yet, and is passed over for the one before it.
 */
export async function latestRunId(notebookPath: string): Promise<string | undefined> {
  const entries = await readdir(runsDirectory(notebookPath), { withFileTypes: true }).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    },
  );
  const runs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const run of runs) {
    if ((await runFile(notebookPath, run, "record.json")) !== undefined) return run;
  }
  return undefined;
}

/**
 * Every Agent Session the Notebooks under `directory` have run in, by the path
 * a Run Record names one at.
 *
 * Read to tell a Chat from a Notebook's own Agent Session: both are pi session
 * files in the same place, and only the first is a Chat. The records are the
 * one thing that knows which is which, since a session the server runs is
 * named by the record of the Run that ran in it. Every Notebook under the
 * directory is read, however deep, skipping what `notebooks.ts` skips — a
 * record found under one is a session that belongs to a Notebook, and a file
 * that does not parse is passed over rather than failing the lot.
 */
export async function notebookAgentSessions(directory: string): Promise<Set<string>> {
  const sessions = new Set<string>();
  const addFromRecord = (record: RunRecord | undefined) => {
    if (!record) return;
    if (record.agentSession !== undefined) sessions.add(resolve(record.agentSession));
    if (record.cells !== undefined) {
      for (const cell of record.cells) {
        if ("agentSession" in cell && typeof cell.agentSession === "string") {
          sessions.add(resolve(cell.agentSession));
        }
      }
    }
  };

  for (const notebook of await markdownFiles(directory)) {
    for (const run of await runsOf(notebook)) {
      const record = await readRunRecord(notebook, run).catch(() => undefined);
      addFromRecord(record);
    }
  }
  const runsRoot = join(directory, OCTO_DIRECTORY, "runs");
  const notebookDirs = await readdir(runsRoot, { withFileTypes: true }).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    },
  );
  for (const dir of notebookDirs) {
    if (!dir.isDirectory()) continue;
    const runDirs = await readdir(join(runsRoot, dir.name), { withFileTypes: true }).catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return [];
        throw cause;
      },
    );
    for (const run of runDirs) {
      if (!run.isDirectory()) continue;
      const file = join(runsRoot, dir.name, run.name, "record.json");
      const record = await readFile(file, "utf8")
        .then((text) => JSON.parse(text) as RunRecord)
        .catch(() => undefined);
      addFromRecord(record);
    }
  }
  return sessions;
}

/** The names of a Notebook's Run directories, as they sort on disk. */
async function runsOf(notebookPath: string): Promise<string[]> {
  const entries = await readdir(runsDirectory(notebookPath), { withFileTypes: true }).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    },
  );
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}
