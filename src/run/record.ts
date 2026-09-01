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

/**
 * What a Prompt Cell's turn produced, its Anchor included.
 *
 * Only a Prompt Cell has one. A Bash Cell never enters the Agent Session, so
 * there is no entry in it for the Cell to point at — which is also why a Cell
 * looking for the Anchor it should begin at has to look past one.
 */
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

/**
 * The Environment a Run actually had.
 *
 * Recorded because a result nobody can account for is a result nobody can
 * trust: the same Notebook run against a Workspace pi was not told to trust
 * saw none of that Workspace's skills, and this is the only place that says
 * so. Its own shape rather than the agent boundary's, because this one is
 * written to disk and read back by later versions of the program.
 */
export interface RunEnvironment {
  /** The Workspace the Cells ran in. */
  workspace: string;
  /** Whether pi loaded the Workspace's own settings, skills and extensions. */
  trusted: boolean;
  /** The version of pi that ran. */
  piVersion: string;
  /** The tools the agent was given. */
  tools: string[];
}

export interface RunRecord {
  /** Identifies this Run among the Notebook's other Runs. */
  id: string;
  /** Path to the Notebook this Run executed. */
  notebook: string;
  environment: RunEnvironment;
  /**
   * The Agent Session the Prompt Cells ran in, which is what makes the Anchors
   * below addressable: they name entries inside this Agent Session and no other.
   *
   * Absent when no Cell left an Anchor in it, since there is then nothing for a
   * later Run to carry on from.
   */
  agentSession?: string;
  startedAt: string;
  endedAt: string;
  cells: CellRecord[];
}
