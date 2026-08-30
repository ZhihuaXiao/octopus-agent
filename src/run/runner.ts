import { readFile } from "node:fs/promises";

import { type Agent, emptyResult, noUsage } from "../agent/agent.js";
import {
  type Cell,
  bodyOf,
  cellsOf,
  formatDiagnostics,
  interpolate,
  parseNotebook,
  resolveInputs,
  workspaceOf,
} from "../notebook/notebook.js";
import type { BashCellRecord, CellRecord, PromptCellRecord, RunRecord } from "./record.js";
import { type ShellResult, runShellCommand } from "./shell.js";
import { newRunId, writeRunRecord } from "./store.js";

export interface RunOptions {
  agent: Agent;
  /**
   * Values for the Notebook's declared Inputs, as written rather than typed:
   * they arrive from a command line or a form, so reading them is this Run's
   * job. Anything the Notebook declares and this omits falls to its default.
   */
  inputs?: Readonly<Record<string, string>>;
}

async function runPromptCell(cell: Cell, body: string, agent: Agent): Promise<PromptCellRecord> {
  try {
    return { id: cell.id, type: "prompt", status: "ok", ...(await agent.prompt(body)) };
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

async function runBashCell(cell: Cell, body: string, workspace: string): Promise<BashCellRecord> {
  const result = await runShellCommand(body, workspace);
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

  // Before the first cell rather than as each one needs its values: a Notebook
  // that stops at its third cell for want of an input has already spent the
  // tokens of the first two, and half-applied its changes to the Workspace.
  const inputs = resolveInputs(parsed.notebook.metadata.inputs ?? [], options.inputs ?? {});
  if (!inputs.ok) {
    throw new Error(`Cannot run ${path}:\n${inputs.errors.join("\n")}`);
  }

  const workspace = workspaceOf(parsed.notebook, path);
  const startedAt = new Date().toISOString();
  const cells: CellRecord[] = [];

  for (const cell of cellsOf(parsed.notebook)) {
    const body = interpolate(bodyOf(cell), inputs.values);
    const recorded =
      cell.type === "bash"
        ? await runBashCell(cell, body, workspace)
        : await runPromptCell(cell, body, options.agent);
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
