/**
 * The persisted result of a Run, kept outside the Notebook so the document
 * stays a program rather than a log (ADR-0005).
 *
 * Written to disk and read back by later versions of the program, so every
 * field here is a commitment: what a Cell was, what it produced, what it cost,
 * when it ran, and where whatever it left can be found.
 */

import type { CellResult, Usage } from "../agent/agent.js";

/**
 * A Cell that timed out is told apart from one that errored, because what to
 * do about them differs: a timed-out Cell may want a longer timeout, an
 * errored one wants whatever went wrong put right. A Cell that was interrupted
 * is told apart from both for the same reason: somebody stopped it, and
 * nothing about it wants putting right. None of the three is `ok`, and any of
 * them halts the Run.
 */
export type CellStatus = "ok" | "error" | "timeout" | "interrupted";

/** When something began and ended, as ISO-8601 instants. */
export interface Timing {
  startedAt: string;
  endedAt: string;
}

/** What every Cell records, whichever kind of Cell it is. */
interface CellRecordBase extends Timing {
  id: string;
  status: CellStatus;
  /** Tokens the Cell spent and what they cost. Always zero for a Bash Cell, which runs no model. */
  usage: Usage;
  /**
   * The files the Cell left in its artifact directory, as paths relative to
   * the Run's directory. Referenced rather than embedded (ADR-0005): the record
   * says where each is, and the bytes stay beside it on disk. Empty rather than
   * absent when there are none, so a reader can tell none from not recorded.
   */
  artifacts: string[];
  /** Why the cell did not succeed, present only when the status is not `ok`. */
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
  /**
   * Processes the command left running, when it started a service that did not
   * exit with it. Absent when it left none. They are this machine's, and may
   * already be gone by the time someone asks to stop them.
   */
  servicePids?: readonly number[];
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
  /**
   * Whether pi loaded the Workspace's own settings, skills and extensions.
   * False for an imported Run, whose Chat's file does not say.
   */
  trusted: boolean;
  /** The version of pi that ran. Empty for an imported Run, whose Chat's file does not say. */
  piVersion: string;
  /** The tools the agent was given — or, for an imported Run, the tools its Chat is seen to have called. */
  tools: string[];
  /** The Mode the Notebook declared and the Run resolved, absent when it declared none. */
  mode?: string;
}

export interface RunRecord {
  /** Identifies this Run among the Notebook's other Runs. */
  id: string;
  /** Path to the Notebook this Run executed. */
  notebook: string;
  /**
   * The id of the Run this one carried on from, absent when it carried on from
   * none.
   *
   * What makes a partial Run's record legible: it accounts only for the Cells it
   * ran, so the results of the rest of the Notebook — and the Stale set this
   * one's is relative to — are found by following this back through the chain.
   */
  continues?: string;
  /**
   * The pi session file this Run was read from rather than run — a Chat had at
   * the terminal, imported as a Notebook with this record of what it did
   * (ADR-0022). Absent for a Run that ran. Named for the reader's account of
   * where the results came from; the file itself is pi's, and `agentSession`
   * names the copy the import took, which is the one a later Run may carry on
   * from.
   */
  imported?: string;
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
  /**
   * The Anchor each Prompt Cell's turn last ended on, by the Cell's id, across
   * this Run and the Runs it continues — not only the Cells this Run ran. All
   * inside `agentSession`, which is named whenever this is not empty.
   *
   * What a Run continuing this one forks at: a re-run Cell begins at the Anchor
   * of the nearest Cell before it in the Run order that has one (ADR-0014). A
   * Run of some Cells has nothing to say about the rest, so like `stale` this
   * is carried through the chain rather than read off one Run's `cells`. A
   * Cell whose last turn failed or was stopped has none, its earlier one being
   * on a branch that turn abandoned; an Isolated Cell never has one; a Bash
   * Cell never enters the Agent Session.
   */
  anchors: Record<string, string>;
  /**
   * The Cells this Run left Stale, in the order they would run — every Cell of
   * the Notebook whose last result no longer reflects the Cells it depends on,
   * not only those this Run disturbed.
   *
   * What the next Run's Cells should be: running this list is what returns a
   * Notebook to fully valid (ADR-0004), and it comes back empty when there is
   * nothing left to recover.
   *
   * Empty is not the same as every Cell holding a good result, though. A Cell
   * that errored is Errored rather than Stale, and a Cell that never ran has no
   * result to have gone out of date, so neither is named here: both are read
   * off the `cells` of this Run and the Runs it continues.
   */
  stale: string[];
}
