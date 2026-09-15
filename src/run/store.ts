import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { within } from "../util/paths.js";
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}
