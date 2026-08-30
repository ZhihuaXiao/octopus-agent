import {
  type Agent,
  type AgentFactory,
  type AgentSetup,
  type CellResult,
  type ToolCall,
  type Usage,
  noUsage,
} from "./agent.js";
import type { Environment } from "./environment.js";

/** One scripted turn: what the agent yields, or what it fails with. */
export type ScriptedTurn =
  ({ text: string } & Partial<Omit<CellResult, "text">>) | { error: string };

export interface ScriptedAgent extends Agent {
  /** Hands this agent to a Run, recording the setup the Run asked for. */
  readonly create: AgentFactory;
  /** How the Run set this agent up, once it has. */
  readonly setup: AgentSetup | undefined;
  /** Every body the runner sent, in order, for asserting on what was asked. */
  readonly prompts: readonly string[];
  readonly disposed: boolean;
}

const isError = (turn: ScriptedTurn): turn is { error: string } => "error" in turn;

/**
 * An environment providing nothing, so a Notebook declaring anything at all
 * has to be given it by the test that declares it.
 */
const barren: Environment = {
  piVersion: "0.0.0",
  tools: [],
  skills: [],
  packages: [],
  trusted: true,
};

/**
 * An agent that yields pre-arranged turns instead of calling a model.
 *
 * Every test above the agent boundary uses this, so the engine's behaviour is
 * deterministic and no test outside the live suite reaches a real provider.
 *
 * @param provided what the Notebook under test may declare and be given
 */
export function createScriptedAgent(
  script: readonly ScriptedTurn[],
  provided: Partial<Environment> = {},
): ScriptedAgent {
  const prompts: string[] = [];
  let setup: AgentSetup | undefined;
  let next = 0;
  let disposed = false;

  const agent: ScriptedAgent = {
    prompts,
    environment: { ...barren, ...provided },

    get setup() {
      return setup;
    },
    get disposed() {
      return disposed;
    },

    async create(asked: AgentSetup): Promise<Agent> {
      setup = asked;
      return agent;
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

  return agent;
}
