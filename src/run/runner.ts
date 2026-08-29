import { readFile } from "node:fs/promises";

import { type Agent, emptyResult, noUsage } from "../agent/agent.js";
import {
  type Cell,
  bodyOf,
  cellsOf,
  formatDiagnostics,
  parseNotebook,
  workspaceOf,
} from "../notebook/notebook.js";
import type { BashCellRecord, CellRecord, PromptCellRecord, RunRecord } from "./record.js";
import { type ShellResult, runShellCommand } from "./shell.js";
import { newRunId, writeRunRecord } from "./store.js";

export interface RunOptions {
  agent: Agent;
}

async function runPromptCell(cell: Cell, agent: Agent): Promise<PromptCellRecord> {
  try {
    return { id: cell.id, type: "prompt", status: "ok", ...(await agent.prompt(bodyOf(cell))) };
  } catch (cause) {
    return {
      id: cell.id,
      type: "prompt",
      status: "error",
      ...emptyResult,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** How a command failed, or undefined when it succeeded. */
function failureOf(result: ShellResult): string | undefined {
  if (result.startupError !== null) return `Command could not be run: ${result.startupError}`;
  if (result.signal !== null) return `Command was killed by ${result.signal}`;
  if (result.exitCode !== 0) return `Command exited with status ${result.exitCode}`;
  return undefined;
}

async function runBashCell(cell: Cell, workspace: string): Promise<BashCellRecord> {
  const result = await runShellCommand(bodyOf(cell), workspace);
  const error = failureOf(result);

  return {
    id: cell.id,
    type: "bash",
    status: error === undefined ? "ok" : "error",
    // No model ran, which is the whole reason to write a Bash Cell rather than
    // ask the agent to do the same deterministic thing.
    usage: noUsage,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    ...(error !== undefined ? { error } : {}),
  };
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

  const workspace = workspaceOf(parsed.notebook, path);
  const startedAt = new Date().toISOString();
  const cells: CellRecord[] = [];

  for (const cell of cellsOf(parsed.notebook)) {
    const recorded =
      cell.type === "bash"
        ? await runBashCell(cell, workspace)
        : await runPromptCell(cell, options.agent);
    cells.push(recorded);

    // Halt rather than carry on: a later cell built on a failed one would be
    // building on a partially-applied change. Ticket 11 adds retries and
    // timeouts around this.
    if (recorded.status === "error") break;
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
