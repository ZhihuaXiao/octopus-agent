import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";

import type { RunRecord } from "./record.js";

/**
 * Persists Run Records outside the Notebook, as ADR-0005 requires.
 *
 * Each Run gets its own directory rather than a bare file, so that the Run's
 * Artifacts sit beside its record and the two travel together.
 */

const OCTO_DIRECTORY = ".octo";
const ARTIFACTS_DIRECTORY = "artifacts";

export function runDirectory(notebookPath: string, runId: string): string {
  const stem = basename(notebookPath, extname(notebookPath));
  return join(dirname(notebookPath), OCTO_DIRECTORY, "runs", stem, runId);
}

export function recordPath(notebookPath: string, runId: string): string {
  return join(runDirectory(notebookPath, runId), "record.json");
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
