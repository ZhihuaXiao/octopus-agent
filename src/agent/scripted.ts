import { type Agent, type CellResult, type ToolCall, type Usage, noUsage } from "./agent.js";

/** One scripted turn: what the agent yields, or what it fails with. */
export type ScriptedTurn =
  ({ text: string } & Partial<Omit<CellResult, "text">>) | { error: string };

export interface ScriptedAgent extends Agent {
  /** Every body the runner sent, in order, for asserting on what was asked. */
  readonly prompts: readonly string[];
  readonly disposed: boolean;
}

const isError = (turn: ScriptedTurn): turn is { error: string } => "error" in turn;

/**
 * An agent that yields pre-arranged turns instead of calling a model.
 *
 * Every test above the agent boundary uses this, so the engine's behaviour is
 * deterministic and no test outside the live suite reaches a real provider.
 */
export function createScriptedAgent(script: readonly ScriptedTurn[]): ScriptedAgent {
  const prompts: string[] = [];
  let next = 0;
  let disposed = false;

  return {
    prompts,
    get disposed() {
      return disposed;
    },

    async prompt(body: string): Promise<CellResult> {
      prompts.push(body);

      const turn = script[next];
      next += 1;
      if (turn === undefined) {
        throw new Error(`Scripted agent ran out of turns: no turn ${next} was scripted.`);
      }
      if (isError(turn)) throw new Error(turn.error);

      const toolCalls: ToolCall[] = turn.toolCalls ?? [];
      const usage: Usage = turn.usage ?? noUsage;
      return { text: turn.text, toolCalls, usage, model: turn.model ?? "scripted" };
    },

    async dispose(): Promise<void> {
      disposed = true;
    },
  };
}
