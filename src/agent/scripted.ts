import {
  type Agent,
  type AgentFactory,
  type AgentSetup,
  type CellResult,
  type Retry,
  type ToolCall,
  TurnFailure,
  type TurnOptions,
  type Usage,
  noUsage,
} from "./agent.js";
import type { Environment } from "./environment.js";

/**
 * One scripted turn: what the agent yields, what it fails with, what the
 * provider transiently failed with — after which the agent tries again, as pi
 * does, and the next scripted turn is what that attempt gets — or a turn that
 * never comes back until the Run tells it to stop. A turn that fails or hangs
 * may say what it had spent by then, as a real one had; a turn that hangs may
 * have said something or invoked a tool first, as a real one that went quiet
 * halfway had.
 */
export type ScriptedTurn =
  | ({ text: string } & Partial<Omit<CellResult, "text" | "retries">>)
  | { error: string; usage?: Usage }
  | { transient: string }
  | { hangs: true; text?: string; toolCalls?: ToolCall[]; usage?: Usage };

/** One turn as it arrived: what was asked, where, and what was already there. */
export interface ScriptedTurnRecord {
  /** The Cell body the Run sent. */
  readonly body: string;
  /** The Agent Session it ran in. */
  readonly session: string;
  /**
   * The bodies that session had already been asked when this turn began, which
   * is the context the turn saw. Empty for a Cell that spoke into a fresh one.
   */
  readonly context: readonly string[];
  /** The model the Run asked for, when it asked for one. */
  readonly model?: string;
}

/**
 * The agent boundary, scripted: the factory a Run is given, and a log of
 * everything the Run did with the agents it made.
 *
 * Not itself an Agent, because a Run makes more than one — the Notebook's
 * shared Agent Session, and a fresh one per Isolated Cell — and the log spans
 * all of them.
 */
export interface ScriptedAgent {
  /** Hands out the agents a Run asks for, recording how it asked. */
  readonly create: AgentFactory;
  /** How the Run set up the first agent it asked for, which is the shared one. */
  readonly setup: AgentSetup | undefined;
  /** How the Run set up each agent it asked for, in the order it asked. */
  readonly setups: readonly AgentSetup[];
  /** How many times a Run asked for an agent. One, unless a Cell is Isolated. */
  readonly creations: number;
  /**
   * The name the Notebook's shared Agent Session takes, it being the first one
   * a Run asks for. Fixed, so a test may name it before the Run has begun.
   */
  readonly agentSession: string;
  /** The Agent Session each agent ran in, in the order they were made. */
  readonly sessions: readonly string[];
  /** Every body the Run sent, in the order the Cells started. */
  readonly prompts: readonly string[];
  /** Every turn with the context it saw, for asserting on what a Cell was given. */
  readonly turns: readonly ScriptedTurnRecord[];
  /** The Anchor each turn ended on, in order, for asserting on what was recorded. */
  readonly anchors: readonly string[];
  /** Every Anchor a Run asked an agent to resume from, in order. */
  readonly resumptions: readonly (string | undefined)[];
  /** The bodies of the turns a Run told an agent to stop, in order. */
  readonly aborted: readonly string[];
  /**
   * The most turns that were ever in flight at the same time: one when every
   * turn waited for the turn before it, which is what a shared context requires.
   */
  readonly overlap: number;
  /** Whether every agent the Run made has been disposed. */
  readonly disposed: boolean;
}

const isError = (turn: ScriptedTurn): turn is { error: string; usage?: Usage } => "error" in turn;
const isTransient = (turn: ScriptedTurn): turn is { transient: string } => "transient" in turn;
const hangs = (
  turn: ScriptedTurn,
): turn is { hangs: true; text?: string; toolCalls?: ToolCall[]; usage?: Usage } => "hangs" in turn;

/** Rejects when the signal fires, and never otherwise: a provider that has gone quiet. */
const untilAborted = (signal: AbortSignal | undefined, cause: () => Error) =>
  new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(cause());
    else signal?.addEventListener("abort", () => reject(cause()), { once: true });
  });

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
 * Fixed names rather than real paths: what a Run does with one is carry it into
 * the record and hand it back when it continues that session, and both work the
 * same whether or not anything is on disk. Numbered from the second, so the
 * shared session of a Notebook with no Isolated Cell is named as it always was.
 */
const nameSession = (made: number) =>
  made === 0 ? "scripted-session" : `scripted-session-${made + 1}`;

/**
 * Agents that yield pre-arranged turns instead of calling a model.
 *
 * Every test above the agent boundary uses this, so the engine's behaviour is
 * deterministic and no test outside the live suite reaches a real provider.
 *
 * The turns are one script shared by every agent a Run makes, consumed in the
 * order the Cells start. Which agent took which turn is in `turns`.
 *
 * @param provided what the Notebook under test may declare and be given
 */
export function createScriptedAgent(
  script: readonly ScriptedTurn[],
  provided: Partial<Environment> = {},
): ScriptedAgent {
  const setups: AgentSetup[] = [];
  const sessions: string[] = [];
  const prompts: string[] = [];
  const turns: ScriptedTurnRecord[] = [];
  const anchors: string[] = [];
  const resumptions: (string | undefined)[] = [];
  const aborted: string[] = [];
  const environment: Environment = { ...barren, ...provided };

  let next = 0;
  let inFlight = 0;
  let overlap = 0;
  let disposals = 0;

  /** The next scripted turn, consumed; a script that has run out is the test's mistake. */
  const takeTurn = (): ScriptedTurn => {
    const turn = script[next];
    next += 1;
    if (turn === undefined) {
      throw new Error(`Scripted agent ran out of turns: no turn ${next} was scripted.`);
    }
    return turn;
  };

  const create = async (asked: AgentSetup): Promise<Agent> => {
    // A Run reopening a session names it; one starting a session gets a name of
    // its own, so an Isolated Cell's context is visibly not the shared one.
    const session = asked.agentSession ?? nameSession(setups.length);
    setups.push(asked);
    sessions.push(session);

    /** What this session holds, which is the context its next turn is given. */
    const held: { body: string; anchor: string }[] = [];

    return {
      environment,
      agentSession: session,

      async prompt(body: string, options: TurnOptions = {}): Promise<CellResult> {
        const { signal, model, onText, onToolCall } = options;
        prompts.push(body);
        turns.push({
          body,
          session,
          context: held.map((turn) => turn.body),
          ...(model !== undefined ? { model } : {}),
        });

        inFlight += 1;
        overlap = Math.max(overlap, inFlight);
        try {
          // A real turn waits on a provider, and one that returned without ever
          // yielding could not be seen to run beside another however the
          // scheduler started them. So this one yields, once, like the real one.
          await Promise.resolve();

          // A transient failure is retried by taking the next scripted turn,
          // which is what pi does with the next attempt at the provider. The
          // script says how many times, so no retry budget is modelled here.
          const retries: Retry[] = [];
          let turn = takeTurn();
          while (isTransient(turn)) {
            retries.push({ error: turn.transient });
            turn = takeTurn();
          }
          if (isError(turn)) throw new TurnFailure(turn.error, retries, false, turn.usage);

          // Nothing comes back until the Run gives up waiting, as pi's turn
          // resolves only once `abort` has brought the agent to rest. What the
          // turn did and said before going quiet is announced, and is all it
          // ever does or says.
          if (hangs(turn)) {
            for (const call of turn.toolCalls ?? []) onToolCall?.(call);
            if (turn.text !== undefined) onText?.(turn.text);
            const spent = turn.usage;
            return await untilAborted(signal, () => {
              aborted.push(body);
              return TurnFailure.aborted(retries, spent);
            });
          }

          // Announced one at a time and then spoken in one piece, all before the
          // turn resolves, which is the least a real turn streams: everything
          // above the boundary hears the calls and the text before it holds the
          // result, as it would from pi — whose tools run before its reply.
          const toolCalls: ToolCall[] = turn.toolCalls ?? [];
          for (const call of toolCalls) onToolCall?.(call);
          onText?.(turn.text);

          const usage: Usage = turn.usage ?? noUsage;
          // Anchors are opaque to everything above the boundary, so a counter is
          // as faithful a stand-in as pi's entry ids: all a Run may assume of one
          // is that turns end on different ones.
          const anchor = turn.anchor ?? `entry-${anchors.length + 1}`;
          anchors.push(anchor);
          held.push({ body, anchor });

          return {
            text: turn.text,
            toolCalls,
            usage,
            // What served the turn: the script's word when it has one, else the
            // model asked for, as a provider that serves exactly what is named.
            // A real provider may serve a dated version under a stable name,
            // which is what the script's word is there to stand in for.
            model: turn.model ?? model ?? "scripted",
            retries,
            ...(turn.systemPrompt !== undefined && turn.systemPrompt !== ""
              ? { systemPrompt: turn.systemPrompt }
              : {}),
            anchor,
          };
        } finally {
          inFlight -= 1;
        }
      },

      async resumeFrom(anchor: string | undefined): Promise<void> {
        resumptions.push(anchor);

        // What the session holds past the Anchor stays in it as an abandoned
        // branch, but it is no longer what the next turn is given. An Anchor
        // this agent never wrote leaves it holding nothing, which is what a
        // session reopened from an earlier Run holds here.
        const found = held.findIndex((turn) => turn.anchor === anchor);
        held.length = anchor === undefined || found === -1 ? 0 : found + 1;
      },

      async dispose(): Promise<void> {
        disposals += 1;
      },
    };
  };

  return {
    create,
    setups,
    sessions,
    prompts,
    turns,
    anchors,
    resumptions,
    aborted,

    get setup() {
      return setups[0];
    },
    get creations() {
      return setups.length;
    },
    get agentSession() {
      return sessions[0] ?? nameSession(0);
    },
    get overlap() {
      return overlap;
    },
    get disposed() {
      return setups.length > 0 && disposals === setups.length;
    },
  };
}
