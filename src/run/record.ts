/**
 * The persisted result of a Run, kept outside the Notebook so the document
 * stays a program rather than a log (ADR-0005).
 *
 * Minimal by design: ticket 12 adds per-cell timings, cost, and artifacts.
 */

import type { CellResult, Usage } from "../agent/agent.js";

export type CellStatus = "ok" | "error";

/** What every Cell records, whichever kind of Cell it is. */
interface CellRecordBase {
  id: string;
  status: CellStatus;
  /** Tokens the Cell spent. Always zero for a Bash Cell, which runs no model. */
  usage: Usage;
  /** Why the cell failed, present only when the status is `error`. */
  error?: string;
}

/** What a Prompt Cell's turn produced. */
export interface PromptCellRecord extends CellRecordBase, CellResult {
  type: "prompt";
}

/** What a Bash Cell's command produced. */
export interface BashCellRecord extends CellRecordBase {
  type: "bash";
  stdout: string;
  stderr: string;
  /** Null when the command never got as far as exiting on its own. */
  exitCode: number | null;
}

/**
 * Discriminated by `type`, because the two kinds of Cell produce genuinely
 * different things: text and tool calls from a model, or output and an exit
 * status from a command. Nothing reading a record should have to guess which.
 */
export type CellRecord = PromptCellRecord | BashCellRecord;

export interface RunRecord {
  /** Identifies this Run among the Notebook's other Runs. */
  id: string;
  /** Path to the Notebook this Run executed. */
  notebook: string;
  startedAt: string;
  endedAt: string;
  cells: CellRecord[];
}
