import { readFile } from "node:fs/promises";

import { type Agent, emptyResult } from "../agent/agent.js";
import { parseNotebook } from "../notebook/notebook.js";
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
  const notebook = parseNotebook(await readFile(path, "utf8"));
  const startedAt = new Date().toISOString();
  const cells: CellRecord[] = [];

  for (const cell of notebook.cells) {
    try {
      cells.push({ id: cell.id, status: "ok", ...(await options.agent.prompt(cell.body)) });
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
