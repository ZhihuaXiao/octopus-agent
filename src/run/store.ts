import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { RunRecord } from "./record.js";

/**
 * Persists Run Records outside the Notebook, as ADR-0005 requires.
 *
 * Each Run gets its own directory rather than a bare file, so ticket 12 can put
 * that Run's Artifacts beside its record without moving anything.
 */

const OCTO_DIRECTORY = ".octo";

export function runDirectory(notebookPath: string, runId: string): string {
  const stem = basename(notebookPath, extname(notebookPath));
  return join(dirname(notebookPath), OCTO_DIRECTORY, "runs", stem, runId);
}

export function recordPath(notebookPath: string, runId: string): string {
  return join(runDirectory(notebookPath, runId), "record.json");
}

/** Sortable by name, so runs list in the order they happened. */
export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

export async function writeRunRecord(record: RunRecord): Promise<string> {
  const path = recordPath(record.notebook, record.id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}
