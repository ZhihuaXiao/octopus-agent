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

export interface CellResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** The model that actually ran, which providers rotate under stable names. */
  model: string;
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
}

/**
 * Makes the agent a Run needs. The Run owns the agent's lifetime, so it is
 * this rather than a ready-made agent that a Run is given: only the Run knows,
 * from the Notebook it has just parsed, what the agent should be set up with.
 */
export type AgentFactory = (setup: AgentSetup) => Promise<Agent>;

export interface Agent {
  /** Runs one Prompt Cell body and resolves with everything the turn produced. */
  prompt(body: string): Promise<CellResult>;
  /** What the agent found around it, for the Notebook's declarations to be checked against. */
  readonly environment: Environment;
  dispose(): Promise<void>;
}

export const noUsage: Usage = { inputTokens: 0, outputTokens: 0 };

/** What a Cell produced when it never got as far as producing anything. */
export const emptyResult: CellResult = {
  text: "",
  toolCalls: [],
  usage: noUsage,
  model: "",
};
