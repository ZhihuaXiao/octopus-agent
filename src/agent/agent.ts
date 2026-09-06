/**
 * The agent boundary.
 *
 * Every non-deterministic thing the system does passes through this interface,
 * which is what lets the runner be tested without ever reaching a real model.
 * Two implementations: one over pi's SDK, one scripted for tests.
 */

import type { Environment } from "./environment.js";

/** A tool the agent invoked during a turn, recorded so a run shows what it did. */
export interface ToolCall {
  name: string;
  input: unknown;
}

/** Token counts for one turn. Cost is derived later, in ticket 12. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * One attempt at a turn that the agent gave up on and made again.
 *
 * Only a transient provider or transport error is retried — an overloaded
 * provider, a dropped connection — because that is the one class of failure
 * a second attempt can be expected to get past. Pi decides which errors those
 * are and does the retrying; the Run records that it happened.
 */
export interface Retry {
  /** What the attempt failed with. */
  error: string;
}

export interface CellResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** The model that actually ran, which providers rotate under stable names. */
  model: string;
  /** The attempts this turn was retried past before it produced anything, in order. */
  retries: Retry[];
  /**
   * The Anchor the turn ended on: where the Agent Session now sits, so a later
   * Run can fork it here instead of replaying every turn up to this one.
   *
   * Absent when the turn produced no entry to point at, which is a turn that
   * failed before the agent said anything.
   */
  anchor?: string;
}

/**
 * How a Run asks for an agent: the Notebook's declared environment, as far as
 * it is the agent's to honour.
 *
 * Passed at creation rather than set afterwards, because a session that has
 * already loaded the wrong Workspace's skills cannot be talked out of them.
 */
export interface AgentSetup {
  /** The Workspace, which is the working directory of everything the agent does. */
  readonly workspace: string;
  /** The only tools the agent may use. Absent leaves pi's own default set. */
  readonly tools?: readonly string[];
  /** What the Run was told about trusting the Workspace, when it was told anything. */
  readonly trust?: boolean;
  /**
   * An existing Agent Session to reopen rather than start, named as the agent
   * itself reports one. How a Run carries on from an earlier one: an Anchor is
   * an entry inside a particular Agent Session, so it addresses nothing in one
   * that never held that entry.
   */
  readonly agentSession?: string;
}

/**
 * Makes the agent a Run needs. The Run owns the agent's lifetime, so it is
 * this rather than a ready-made agent that a Run is given: only the Run knows,
 * from the Notebook it has just parsed, what the agent should be set up with.
 */
export type AgentFactory = (setup: AgentSetup) => Promise<Agent>;

/**
 * A turn that ended in failure, with the attempts that were retried before it.
 *
 * Its own class rather than a bare `Error`, because a turn that failed after
 * three tries and one that failed at once should not read alike in the record
 * — and the retries happened inside the agent, so only the agent can say.
 */
export class TurnFailure extends Error {
  constructor(
    message: string,
    readonly retries: readonly Retry[] = [],
  ) {
    super(message);
    this.name = "TurnFailure";
  }
}

export interface Agent {
  /**
   * Runs one Prompt Cell body and resolves with everything the turn produced.
   *
   * Rejects with a `TurnFailure` when the turn ended in an error, and with
   * anything else when the agent itself could not take the turn.
   *
   * @param signal asks the agent to stop the turn where it is. A turn that is
   *   stopped this way rejects rather than resolving with half a reply, since
   *   whatever it had said so far was not what the Cell asked for.
   */
  prompt(body: string, signal?: AbortSignal): Promise<CellResult>;
  /**
   * Moves the Agent Session back to an Anchor, so the next turn continues from
   * there rather than from wherever the last one left it. `undefined` moves it
   * back before the first entry, which is where a Cell that ran first began.
   *
   * Forking rather than rewinding: what the session held past the Anchor stays
   * in it as an abandoned branch, because a turn that has already changed the
   * Workspace is not made not to have happened by discarding its record of it.
   */
  resumeFrom(anchor: string | undefined): Promise<void>;
  /** What the agent found around it, for the Notebook's declarations to be checked against. */
  readonly environment: Environment;
  /** Where this Agent Session is kept, for a later Run to carry on from it. */
  readonly agentSession: string | undefined;
  dispose(): Promise<void>;
}

export const noUsage: Usage = { inputTokens: 0, outputTokens: 0 };

/** What a Cell produced when it never got as far as producing anything. */
export const emptyResult: CellResult = {
  text: "",
  toolCalls: [],
  usage: noUsage,
  model: "",
  retries: [],
};
