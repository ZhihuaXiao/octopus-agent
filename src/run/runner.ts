import { readFile } from "node:fs/promises";

import { type Agent, emptyResult } from "../agent/agent.js";
import { bodyOf, cellsOf, formatDiagnostics, parseNotebook } from "../notebook/notebook.js";
import type { CellRecord, RunRecord } from "./record.js";
import { newRunId, writeRunRecord } from "./store.js";

export interface RunOptions {
  agent: Agent;
}

/**
 * Executes a Notebook and returns a Run Record describing what happened.
 *
 * The primary public interface of the engine, and the seam the spec designates
 * for testing it: drive this with a scripted agent and assert on the record.
 */
export async function runNotebook(path: string, options: RunOptions): Promise<RunRecord> {
  const parsed = parseNotebook(await readFile(path, "utf8"));
  if (!parsed.ok) {
    throw new Error(`Cannot run ${path}:\n${formatDiagnostics(parsed.errors)}`);
  }

  const notebookCells = cellsOf(parsed.notebook);
  // Refused before anything runs, so a Notebook is never left half-executed on
  // the way to discovering a Cell this runner cannot execute.
  const bashCell = notebookCells.find((cell) => cell.type === "bash");
  if (bashCell) {
    throw new Error(`Bash cells are not supported yet (ticket 04): cell "${bashCell.id}"`);
  }

  const startedAt = new Date().toISOString();
  const cells: CellRecord[] = [];

  for (const cell of notebookCells) {
    try {
      cells.push({ id: cell.id, status: "ok", ...(await options.agent.prompt(bodyOf(cell))) });
    } catch (cause) {
      // Halt rather than carry on: a later cell built on a failed one would be
      // building on a partially-applied change. Ticket 11 adds retries and
      // timeouts around this.
      cells.push({
        id: cell.id,
        status: "error",
        ...emptyResult,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      break;
    }
  }

  const record: RunRecord = {
    id: newRunId(),
    notebook: path,
    startedAt,
    endedAt: new Date().toISOString(),
    cells,
  };
  await writeRunRecord(record);
  return record;
}
