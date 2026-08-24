/**
 * The agent boundary.
 *
 * Every non-deterministic thing the system does passes through this interface,
 * which is what lets the runner be tested without ever reaching a real model.
 * Two implementations: one over pi's SDK, one scripted for tests.
 */

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

export interface Agent {
  /** Runs one Prompt Cell body and resolves with everything the turn produced. */
  prompt(body: string): Promise<CellResult>;
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
