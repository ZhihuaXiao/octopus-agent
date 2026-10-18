import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  type Agent,
  type AgentFactory,
  type AgentSetup,
  type ToolCall,
  TurnFailure,
  emptyResult,
  noUsage,
} from "../agent/agent.js";
import { checkEnvironment } from "../agent/environment.js";
import { type Mode, resolveMode, userModesDirectory } from "../mode/mode.js";
import {
  ARTIFACTS_REFERENCE,
  type Cell,
  type InputValues,
  type Notebook,
  type PromptMode,
  bodyOf,
  cellsOf,
  formatDiagnostics,
  formatDuration,
  interpolate,
  modelOf,
  parseNotebook,
  referencesIn,
  resolveInputs,
  runOrder,
  staleAfter,
  timeoutOf,
  workspaceOf,
} from "../notebook/notebook.js";
import { type CellAccess, cellAccess, cellAccessAllows } from "./access.js";
import { anchorBefore, anchorsAfter } from "./anchor.js";
import type {
  BashCellRecord,
  CellRecord,
  PromptCellRecord,
  RunEnvironment,
  RunRecord,
  Timing,
} from "./record.js";
import { runScheduled } from "./schedule.js";
import { type ShellResult, runShellCommand } from "./shell.js";
import { artifactsDirectory, listArtifacts, newRunId, writeRunRecord } from "./store.js";

/**
 * What a Run reports as it goes, for whoever is watching: a terminal printing
 * the reply as it streams, or a Notebook Session relaying it to a browser.
 *
 * The Run names itself first, once everything that could stop it has settled,
 * with the Cells it is about to run in their order: its id is what the Cells'
 * artifact directories sit under, so a watcher can place what a Cell leaves
 * before the record that names it arrives. It says then, too, what the record
 * will otherwise say only at the end — the Environment it found, and the Agent
 * Session it is speaking into — so a watcher that outlives the Run when the
 * process does not can conclude the Run it never got to. The Agent Session is
 * named as the Run is using it, which is before pi need have written it; the
 * Run Record names one only once an Anchor stands in it, which `concludeRun`
 * sees to for the Run and the watcher alike. A Cell's text, its thinking and
 * its tool calls arrive between its start and its end, and only a Prompt Cell
 * has any: a command's output is not spoken, so it arrives whole with the
 * record. The record in `cell-ended` is
 * the one the Run Record will carry, so a watcher that kept every event holds
 * the same account of the Run as the record does.
 */
export type RunEvent =
  | {
      readonly type: "run-started";
      readonly run: string;
      readonly cells: readonly string[];
      readonly environment: RunEnvironment;
      readonly agentSession?: string;
    }
  | { readonly type: "cell-started"; readonly cell: string }
  | { readonly type: "cell-text"; readonly cell: string; readonly text: string }
  | { readonly type: "cell-thinking"; readonly cell: string; readonly thinking: string }
  | { readonly type: "cell-tool-call"; readonly cell: string; readonly call: ToolCall }
  | { readonly type: "cell-ended"; readonly record: CellRecord };

export interface RunOptions {
  /**
   * Called with each event as the Run produces it. Absent when nobody is
   * watching, which is what a Run in a script or under test mostly is.
   */
  observe?: (event: RunEvent) => void;
  /**
   * Interrupts the Run where it is: the Cell in flight is stopped and recorded
   * as interrupted, and nothing further starts. What was already finished
   * stands, and the Run resolves with its record as any other does, since a
   * Run somebody stopped is still a Run that happened.
   */
  signal?: AbortSignal;
  /**
   * Filled, while a Bash Cell runs, with the way to stop that Cell's command
   * and the processes it started. The session removes nothing itself: the Cell
   * deletes its entry when the command has ended.
   */
  bashStops?: Map<string, () => void>;
  /**
   * Makes the agent this Run's Prompt Cells go to. A factory rather than an
   * agent, because how the agent is set up is the Notebook's to say and the
   * Notebook has not been read yet when a Run is asked for.
   */
  agent: AgentFactory;
  /**
   * Values for the Notebook's declared Inputs, as written rather than typed:
   * they arrive from a command line or a form, so reading them is this Run's
   * job. Anything the Notebook declares and this omits falls to its default.
   */
  inputs?: Readonly<Record<string, string>>;
  /**
   * Whether to trust the Workspace's own settings, skills and extensions. A
   * property of the Run rather than of the Notebook: a document cannot vouch
   * for the directory it is pointed at, only the person running it can.
   */
  trust?: boolean;
  /**
   * Where this run's cells may operate. Absent is `user`: any directory the
   * account can already reach, which is what a run has always done. `served`
   * keeps the workspace under `servedDirectory`, or under the notebook's own
   * directory when that is not set. `roots` keeps it under the directories
   * named. See `access.ts`.
   */
  access?: CellAccess;
  /** The directory `served` access is relative to. The notebook's directory when absent. */
  servedDirectory?: string;
  /**
   * The Cells this Run executes, by id. Absent runs the whole Notebook.
   *
   * A subset runs in the Graph's order like any other, and the Cells left out
   * simply do not run: nothing is inferred from their absence and no dependent
   * is pulled in, since a Cell downstream of a re-run one is marked Stale rather
   * than run again (ADR-0004). The record says which those are, so recovering a
   * Notebook is this option given the last Run's `stale`.
   *
   * Naming a subset is not by itself re-running it: without `continues` those
   * Cells run in a new Agent Session, which is a Notebook run partially rather
   * than a Notebook resumed.
   */
  cells?: readonly string[];
  /**
   * The Run this one carries on from, so the Cells it re-runs begin where they
   * began then rather than in an empty context. Its Agent Session is reopened
   * and forked at the Anchor its records name; see `anchor.ts`.
   */
  continues?: RunRecord;
  /**
   * Where the user's own Modes are found. `~/.octo/modes` unless said
   * otherwise, which only a test has reason to. Not a way to choose the Mode:
   * that is the Notebook's to say, and a Run that could say otherwise would run
   * a Notebook nobody reading it could predict.
   */
  userModesDirectory?: string;
}

/**
 * What a Cell produced, before the Run's own bookkeeping is added: when the
 * Cell ran, and what it left in its artifact directory. Both are stamped where
 * the Cell is started and finished with, so no path through a Cell — success,
 * failure, or a context that could not be made — has to remember either.
 */
type Outcome<Recorded extends CellRecord> = Recorded extends CellRecord
  ? Omit<Recorded, keyof Timing | "artifacts">
  : never;

/** What a Prompt Cell records when its turn produced nothing at all. */
function promptFailure(cell: Cell, cause: unknown): Outcome<PromptCellRecord> {
  return {
    id: cell.id,
    type: "prompt",
    status: "error",
    ...emptyResult,
    // The attempts before the one that failed, and what the turn had spent by
    // then, when the agent got as far as either: a turn that failed after three
    // tries and a long think should not read like one that failed at once.
    ...(cause instanceof TurnFailure ? { retries: [...cause.retries], usage: cause.usage } : {}),
    ...(cause instanceof TurnFailure && cause.systemPrompt !== ""
      ? { systemPrompt: cause.systemPrompt }
      : {}),
    ...(cause instanceof TurnFailure && cause.context !== undefined
      ? { context: cause.context }
      : {}),
    error: cause instanceof Error ? cause.message : String(cause),
  };
}

/**
 * What may stop a Cell before it is done: the Notebook's timeout on it, and the
 * Run's own interruption. Either fires `signal`, which is what the Cell's work
 * listens to; `timer` says afterwards whether it was the timeout, so the two
 * are recorded apart. Neither present leaves the Cell to run as long as it
 * takes, which is what every Notebook did before either could happen.
 *
 * Made where the Cell's own work begins — after an Isolated Cell's context is
 * made, after a continued Run's fork — rather than when the Cell is scheduled,
 * so the timeout is on the Cell's running and not on the Run's arrangements.
 */
interface Stops {
  /** The Cell's timeout and the signal that fires when it is outrun; absent when it has none. */
  readonly timeout?: { readonly after: number; readonly timer: AbortSignal };
  /** Fires on either, for the Cell's work to listen to; absent when there is neither. */
  readonly signal?: AbortSignal;
}

function stopsFor(after: number | undefined, interrupt: AbortSignal | undefined): Stops {
  const timeout = after === undefined ? undefined : { after, timer: AbortSignal.timeout(after) };
  const signals = [timeout?.timer, interrupt].filter((signal) => signal !== undefined);
  return {
    ...(timeout !== undefined ? { timeout } : {}),
    ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
  };
}

/**
 * What a Cell records when it was stopped, whichever of the two stopped it.
 * The timer's word decides, since a Cell whose timeout fired was stopped by it
 * whatever else fired after.
 */
const stopped = (stops: Stops) =>
  stops.timeout?.timer.aborted
    ? {
        status: "timeout" as const,
        error: `Timed out after ${formatDuration(stops.timeout.after)}`,
      }
    : { status: "interrupted" as const, error: "Interrupted" };

/**
 * What a Plan or Ask Cell is told before its own words. Agent is unsaid: that
 * Cell runs on the tools the Notebook already gave it.
 */
const MODE_NOTE: Record<Exclude<PromptMode, "agent">, string> = {
  plan: "Plan mode. You may read files to understand the work, but you must not edit files, write files, or run commands. Reply with a plan: the steps, in order, and what each one would change.",
  ask: "Ask mode. Answer the question. Do not use tools and do not change any files.",
};

/** The body a Prompt Cell sends, with its mode said first when it is not agent. */
function withMode(body: string, mode: PromptMode): string {
  if (mode === "agent") return body;
  return `${MODE_NOTE[mode]}\n\n${body}`;
}

/** A Prompt Cell's turn as the Run asks for it: what to say, and on what terms. */
interface Turn {
  /** The body, its Input References already replaced. */
  readonly body: string;
  /** The model the Cell or the Notebook names, when either does. */
  readonly model?: string;
  /** How the Cell runs. Absent, and agent, leave the session's tools alone. */
  readonly mode?: PromptMode;
  /** How long the turn may take, when the Notebook bounds it. */
  readonly timeout?: number;
  /** Hears the reply as it is produced. */
  readonly onText: (text: string) => void;
  /** Hears what the model thinks, as it thinks it. */
  readonly onThinking: (thinking: string) => void;
  /** Hears each tool the agent invokes, as it does. */
  readonly onToolCall: (call: ToolCall) => void;
  /** Fires when the Run is interrupted, when the Run can be. */
  readonly interrupt?: AbortSignal;
}

async function runPromptCell(
  cell: Cell,
  turn: Turn,
  agent: Agent,
): Promise<Outcome<PromptCellRecord>> {
  const stops = stopsFor(turn.timeout, turn.interrupt);
  try {
    const result = await agent.prompt(turn.body, {
      onText: turn.onText,
      onThinking: turn.onThinking,
      onToolCall: turn.onToolCall,
      ...(turn.model !== undefined ? { model: turn.model } : {}),
      ...(turn.mode !== undefined && turn.mode !== "agent" ? { mode: turn.mode } : {}),
      ...(stops.signal !== undefined ? { signal: stops.signal } : {}),
    });
    return { id: cell.id, type: "prompt", status: "ok", ...result };
  } catch (cause) {
    const failure = promptFailure(cell, cause);
    // Stopped by the Run rather than failed on its own. The agent's word rather
    // than the signal's, since a signal that fired as the turn was ending
    // stopped nothing, and the agent is the one that knows which it was.
    if (cause instanceof TurnFailure && cause.aborted) return { ...failure, ...stopped(stops) };
    return failure;
  }
}

/**
 * Runs an Isolated Cell in a context of its own: an Agent Session made for this
 * Cell, used for its one turn, and disposed with it (ADR-0016).
 *
 * A fresh session rather than a fork of the Notebook's, because a fork would
 * still be one message history and two Cells cannot append to one at the same
 * time — the parallelism is what the fresh session is for as much as the
 * reproducibility is.
 */
async function runIsolatedCell(
  cell: Cell,
  turn: Turn,
  isolate: () => Promise<Agent>,
): Promise<Outcome<PromptCellRecord>> {
  let agent: Agent;
  try {
    agent = await isolate();
  } catch (cause) {
    // The Cell's failure rather than the Run's refusal: the Run has already
    // started, so the other Cells' results are worth recording and a Cell that
    // could not be given a context is a Cell that did not run.
    return promptFailure(cell, cause);
  }

  try {
    // The Anchor is dropped rather than recorded. It names an entry inside the
    // session just made, which nothing keeps: a later Run re-running this Cell
    // makes another fresh context, which is what makes the Cell reproducible.
    const { anchor: _ended, ...recorded } = await runPromptCell(cell, turn, agent);
    return recorded;
  } finally {
    await agent.dispose();
  }
}

/** How a command failed, or undefined when it succeeded. */
function failureOf(result: ShellResult): string | undefined {
  if (result.startupError !== null) return `Command could not be run: ${result.startupError}`;
  if (result.signal !== null) return `Command was killed by ${result.signal}`;
  if (result.exitCode !== 0) return `Command exited with status ${result.exitCode}`;
  return undefined;
}

async function runBashCell(
  cell: Cell,
  body: string,
  workspace: string,
  stops: Stops,
): Promise<Outcome<BashCellRecord>> {
  const result = await runShellCommand(body, workspace, stops.signal);
  const error = failureOf(result);

  return {
    id: cell.id,
    type: "bash",
    status: error === undefined ? "ok" : "error",
    // No model ran, which is the whole reason to write a Bash Cell rather than
    // ask the agent to do the same deterministic thing.
    usage: noUsage,
    // What the command had written when it was stopped is kept: it is the only
    // account there is of how far the command got.
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    ...(result.servicePids !== undefined ? { servicePids: result.servicePids } : {}),
    ...(error !== undefined ? { error } : {}),
    // Stopped by the Run rather than ended on its own, which the shell says
    // more plainly than the signal the command died of.
    ...(result.stopped ? stopped(stops) : {}),
  };
}

const isDirectory = (path: string) =>
  stat(path).then(
    (entry) => entry.isDirectory(),
    () => false,
  );

/** A Notebook that has settled everything it needs, ready for its Cells to run. */
interface Cleared {
  readonly path: string;
  readonly workspace: string;
  readonly values: InputValues;
  /** The Mode the Notebook runs in, when it declares one. */
  readonly mode?: Mode;
  /** The Notebook's shared context, which every Cell not marked Isolated speaks into. */
  readonly shared: Agent;
  /** Makes the fresh context an Isolated Cell runs in, one per such Cell. */
  readonly isolate: () => Promise<Agent>;
  /**
   * The Cells to run, already ordered and already known to exist, which is what
   * leaves the loop below with no way to fail before it has run anything.
   */
  readonly order: readonly Cell[];
  /**
   * Every Cell of the Notebook, which is more than the Cells being run: what a
   * Run leaves Stale is a property of the whole Graph, including the Cells this
   * Run had nothing to say about.
   */
  readonly allCells: readonly Cell[];
  /** How long a Cell may run, when the Notebook bounds it. */
  readonly timeoutOf: (cell: Cell) => number | undefined;
  /** The model a Cell asks for, when the Cell or the Notebook names one. */
  readonly modelOf: (cell: Cell) => string | undefined;
  /** The Run being carried on from, when this Run carries on from one. */
  readonly continues?: RunRecord;
  /** Whoever is watching the Run, told of each event as it happens. */
  readonly observe: (event: RunEvent) => void;
  /** Fires when the Run is interrupted, when it can be. */
  readonly interrupt?: AbortSignal;
  /** Where a running Bash Cell registers the way to stop its command. */
  readonly bashStops?: Map<string, () => void>;
}

/** Runs the Cells of a Notebook that has already been cleared to run. */
async function runCells(cleared: Cleared): Promise<RunRecord> {
  const { path, workspace, mode, shared, continues, observe, interrupt } = cleared;
  // Named before the first Cell runs rather than when the record is written,
  // because the Cells' artifact directories are under this Run's own and a Cell
  // has to be told where that is before it can put anything there.
  const id = newRunId();
  const startedAt = new Date().toISOString();
  const environment: RunEnvironment = {
    workspace,
    trusted: shared.environment.trusted,
    piVersion: shared.environment.piVersion,
    tools: [...shared.environment.tools],
    ...(mode !== undefined ? { mode: mode.name } : {}),
  };
  observe({
    type: "run-started",
    run: id,
    cells: cleared.order.map((cell) => cell.id),
    environment,
    ...(shared.agentSession !== undefined ? { agentSession: shared.agentSession } : {}),
  });

  let forked = false;

  /**
   * Does one Cell's work. Called through `runCell` below by the scheduler, which
   * may have several of these in flight at once — but never two that touch the
   * shared context, which is what lets the fork below be a plain flag and the
   * turns be taken in order.
   */
  const produce = async (cell: Cell): Promise<Outcome<CellRecord>> => {
    // Absolute, whatever path the Notebook was named by: the Cell runs in the
    // Workspace, not where the Run was launched from, and a path relative to
    // the launch directory would point it somewhere else.
    const artifacts = resolve(artifactsDirectory(path, id, cell.id));
    const body = interpolate(bodyOf(cell), {
      ...cleared.values,
      [ARTIFACTS_REFERENCE]: artifacts,
    });
    // Made only for a Cell that refers to it, and made before the Cell runs so
    // the Cell can write straight into it. A Cell that never names it has
    // nowhere to leave an Artifact, and gets no empty directory to say so.
    if (referencesIn(bodyOf(cell)).some(({ name }) => name === ARTIFACTS_REFERENCE)) {
      await mkdir(artifacts, { recursive: true });
    }
    const timeout = cleared.timeoutOf(cell);

    // A command's work begins here, with no context to make first. Its own
    // signal, so this Cell's service can be stopped without stopping a Cell
    // running beside it; the Run's signal stops it too.
    if (cell.type === "bash") {
      const cellStop = new AbortController();
      const fromRun = () => cellStop.abort();
      if (interrupt?.aborted) cellStop.abort();
      else interrupt?.addEventListener("abort", fromRun, { once: true });
      cleared.bashStops?.set(cell.id, () => cellStop.abort());
      try {
        return await runBashCell(cell, body, workspace, stopsFor(timeout, cellStop.signal));
      } finally {
        cleared.bashStops?.delete(cell.id);
        interrupt?.removeEventListener("abort", fromRun);
      }
    }

    const model = cleared.modelOf(cell);
    const mode = cell.mode ?? "agent";
    const turn: Turn = {
      body: withMode(body, mode),
      ...(model !== undefined ? { model } : {}),
      ...(mode !== "agent" ? { mode } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(interrupt !== undefined ? { interrupt } : {}),
      onText: (text) => observe({ type: "cell-text", cell: cell.id, text }),
      onThinking: (thinking) => observe({ type: "cell-thinking", cell: cell.id, thinking }),
      onToolCall: (call) => observe({ type: "cell-tool-call", cell: cell.id, call }),
    };
    if (cell.isolated) return runIsolatedCell(cell, turn, cleared.isolate);

    // Once, before the first Cell that speaks into the shared context, and only
    // when this Run carries on from another — an Agent Session of its own
    // already sits where a first Cell begins. Every Cell after it follows the
    // one before, which is where the session now is; forking each of them back
    // to where it began last time would throw away the turn just taken. An
    // Isolated Cell is not one of them: it never enters this session, so it is
    // passed over here as it is passed over when an Anchor is looked for.
    if (continues !== undefined && !forked) {
      forked = true;
      await shared.resumeFrom(anchorBefore(continues.anchors, cleared.allCells, cell.id));
    }

    return runPromptCell(cell, turn, shared);
  };

  /** Runs one Cell and adds the Run's own bookkeeping to what it produced. */
  const runCell = async (cell: Cell): Promise<CellRecord> => {
    // From when the Run started on the Cell to when it was done with it. This
    // is a wider span than the timeout's, which begins only once the Cell's own
    // work does: the record accounts for what the Run spent on the Cell, which
    // includes making an Isolated Cell's context or forking a continued Run's
    // Agent Session, and a Cell that failed at either of those still has a span.
    const startedAt = new Date().toISOString();
    observe({ type: "cell-started", cell: cell.id });
    const produced = await produce(cell);
    const endedAt = new Date().toISOString();
    // Whatever the Cell left, whether or not it succeeded: a Cell that failed
    // halfway may have left half of what it was making, and that is still the
    // only account there is of how far it got.
    const artifacts = await listArtifacts(path, id, cell.id);
    const recorded: CellRecord = { ...produced, artifacts, startedAt, endedAt };
    observe({ type: "cell-ended", record: recorded });
    return recorded;
  };

  // Halt rather than carry on: a later cell built on a failed one would be
  // building on a partially-applied change — and a cell that timed out or was
  // interrupted may have half-applied one just the same.
  const cells = [
    ...(await runScheduled(cleared.order, {
      run: runCell,
      failed: (recorded) => recorded.status !== "ok",
      ...(interrupt !== undefined ? { signal: interrupt } : {}),
    })),
  ];

  return concludeRun({
    id,
    notebook: path,
    ...(continues !== undefined ? { continues } : {}),
    environment,
    ...(shared.agentSession !== undefined ? { agentSession: shared.agentSession } : {}),
    startedAt,
    cells,
    allCells: cleared.allCells,
  });
}

/** What a Run has to say for itself once its Cells are done, for its record to be worked out. */
export interface Concluded {
  readonly id: string;
  /** The Notebook's path, as the record names it. */
  readonly notebook: string;
  /** The Run this one carried on from, when it did. */
  readonly continues?: RunRecord;
  readonly environment: RunEnvironment;
  /** The Agent Session the Run spoke into, as the agent names it, when the agent names one. */
  readonly agentSession?: string;
  readonly startedAt: string;
  /** The Cells the Run ran, as recorded, in the order they ended. */
  readonly cells: readonly CellRecord[];
  /** Every Cell of the Notebook, since what a Run leaves Stale is a property of the whole Graph. */
  readonly allCells: readonly Cell[];
}

/**
 * Works out what a Run leaves standing and writes its record. Called whenever
 * the Cells a Run has are the Cells it will have: at the Run's own end, or —
 * for a Run the process died in — when a Notebook Session finds it left
 * unfinished in its Journal and ends it as far as it got (ADR-0021).
 */
export async function concludeRun(run: Concluded): Promise<RunRecord> {
  const { continues, cells } = run;
  // Read off the Graph rather than accumulated as the Cells ran, because the
  // Cells left Stale are mostly ones this Run never touched: the question is
  // what the Notebook now stands at, and only the whole Graph answers it.
  const stale = staleAfter({
    cells: run.allCells,
    ran: cells.map((recorded) => recorded.id),
    staleBefore: continues?.stale ?? [],
  });
  // Carried through the chain for the same reason: the Cells a later Run may
  // want to fork behind are mostly ones this Run never touched.
  const anchors = anchorsAfter({ anchorsBefore: continues?.anchors ?? {}, cells });
  const anchored = Object.keys(anchors).length > 0;

  const record: RunRecord = {
    id: run.id,
    notebook: run.notebook,
    // The Run whose results the untouched Cells still hold, and whose Stale set
    // this one's was worked out from.
    ...(continues !== undefined ? { continues: continues.id } : {}),
    environment: run.environment,
    // The shared Agent Session, and named only when an Anchor stands in it —
    // this Run's or an earlier one's, since a Run that reopened an Agent
    // Session and took no turn in it still leaves the earlier Anchors where
    // they were — because an Anchor is the only thing a later Run would reopen
    // one for. Nothing anchored a Notebook of Bash Cells, nor one of Isolated
    // Cells whose Agent Sessions are gone, nor one whose every turn failed —
    // and pi does not write a session file until an assistant message arrives,
    // so naming one on the strength of having merely tried would point a later
    // Run at nothing.
    ...(anchored && run.agentSession !== undefined ? { agentSession: run.agentSession } : {}),
    startedAt: run.startedAt,
    endedAt: new Date().toISOString(),
    cells: [...cells],
    stale: [...stale],
    anchors,
  };
  await writeRunRecord(record);
  return record;
}

/**
 * Which of the things a Run settles before its first Cell was not settled:
 * the Notebook could not be read; the Inputs had no value or the wrong kind;
 * the Cells named to run are not there; the Workspace is not a directory; the
 * agent could not be set up; or the Declared Environment is not the one here.
 * What a watcher says about a refusal turns on this — the Inputs are the
 * person at the form's to put right, the Environment is not — so it is named
 * rather than left to be read off the message.
 */
export type RefusalKind = "notebook" | "inputs" | "cells" | "workspace" | "agent" | "environment";

/**
 * A Run that never started. The message reads as it always has — "Cannot run
 * <path>:" and the problems, one to a line — for a terminal to print; the kind
 * and the problems apart are for whoever has to explain it.
 */
export class RunRefusal extends Error {
  readonly kind: RefusalKind;
  /** Everything wrong, each said once; a refusal reports all of it at once. */
  readonly problems: readonly string[];

  constructor(path: string, kind: RefusalKind, problems: readonly string[]) {
    super(`Cannot run ${path}:\n${problems.join("\n")}`);
    this.name = "RunRefusal";
    this.kind = kind;
    this.problems = problems;
  }
}

/**
 * The Cells this Run executes, in the Graph's order.
 *
 * The Graph's order rather than the document's, so a Cell that another one uses
 * runs first however the Notebook chose to lay the two of them out. Naming a
 * subset filters that order rather than replacing it, which is why the ids may
 * be given in any order at all.
 */
function orderToRun(notebook: Notebook, named: readonly string[] | undefined) {
  const order = runOrder(cellsOf(notebook));
  if (named === undefined) return { ok: true as const, order };

  const wanted = new Set(named);
  const absent = named.filter((id) => !order.some((cell) => cell.id === id));
  if (absent.length > 0) {
    return {
      ok: false as const,
      problems: absent.map((id) => `No cell named "${id}" in this notebook.`),
    };
  }

  return { ok: true as const, order: order.filter((cell) => wanted.has(cell.id)) };
}

/**
 * Executes a Notebook and returns a Run Record describing what happened.
 *
 * The primary public interface of the engine, and the seam the spec designates
 * for testing it: drive this with a scripted agent and assert on the record.
 *
 * Everything that could stop the Run settles before the first Cell — the
 * Inputs, the Workspace, and the declared environment — because a Notebook
 * that stops at its third Cell has already spent the tokens of the first two
 * and half-applied their changes to the Workspace.
 */
export async function runNotebook(path: string, options: RunOptions): Promise<RunRecord> {
  const refuse = (kind: RefusalKind, problems: string | readonly string[]) =>
    new RunRefusal(path, kind, typeof problems === "string" ? [problems] : problems);

  const parsed = parseNotebook(await readFile(path, "utf8"));
  if (!parsed.ok) throw refuse("notebook", formatDiagnostics(parsed.errors));

  const { metadata } = parsed.notebook;
  const inputs = resolveInputs(metadata.inputs ?? [], options.inputs ?? {});
  if (!inputs.ok) throw refuse("inputs", inputs.errors);

  const scheduled = orderToRun(parsed.notebook, options.cells);
  if (!scheduled.ok) throw refuse("cells", scheduled.problems);

  let mode: Mode | undefined;
  if (metadata.mode !== undefined) {
    const resolved = await resolveMode(
      metadata.mode,
      options.userModesDirectory ?? userModesDirectory(),
    );
    if (!resolved.ok) throw refuse("environment", resolved.problems);
    mode = resolved.mode;
  }

  const workspace = workspaceOf(parsed.notebook, path);
  if (!(await isDirectory(workspace))) {
    throw refuse("workspace", `Its workspace ${workspace} is not a directory.`);
  }
  const access = options.access ?? cellAccess("user");
  const served = options.servedDirectory ?? dirname(resolve(path));
  if (!cellAccessAllows(access, served, workspace)) {
    throw refuse(
      "workspace",
      `Its workspace ${workspace} is outside the directories cells may use.`,
    );
  }

  // What every agent this Run makes is set up with, the shared one and each
  // Isolated Cell's alike: the same Workspace and the same declared environment,
  // since isolation is about the shared context and not about running elsewhere.
  // The Notebook's own declarations stand in place of its Mode's, which are
  // only the defaults a Notebook written in that Mode starts from.
  // The Skills are the exception, being needs rather than a choice: a Skill the
  // Notebook declares is one it cannot run without, whatever its Mode offers.
  const tools = metadata.tools ?? mode?.tools;
  const skills =
    mode?.skills !== undefined
      ? [...new Set([...mode.skills, ...(metadata.skills ?? [])])]
      : undefined;
  const setup: AgentSetup = {
    workspace,
    ...(tools !== undefined ? { tools } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(mode?.bare === true
      ? { systemPrompt: "" }
      : mode?.prompt !== undefined
        ? { systemPrompt: mode.prompt }
        : {}),
    ...(options.trust !== undefined ? { trust: options.trust } : {}),
  };

  // The agent is set up before the environment is checked because setting it
  // up is what discovers the environment: pi finds the Workspace's skills and
  // packages while loading them, not by being asked separately.
  const shared = await options
    .agent({
      ...setup,
      // The Agent Session the Anchors belong to, so that forking at one of them
      // has somewhere to fork. A continued Run that anchored nothing named no
      // session, and this one opens its own.
      ...(options.continues?.agentSession !== undefined
        ? { agentSession: options.continues.agentSession }
        : {}),
    })
    // An agent that cannot be set up is one more reason this Notebook cannot
    // run, so it reads as one — an undecided Workspace should not arrive
    // looking different from a missing skill.
    .catch((cause: unknown) => {
      throw refuse("agent", cause instanceof Error ? cause.message : String(cause));
    });

  try {
    const problems = checkEnvironment(metadata, shared.environment, mode);
    if (problems.length > 0) throw refuse("environment", problems);

    return await runCells({
      path,
      workspace,
      values: inputs.values,
      ...(mode !== undefined ? { mode } : {}),
      shared,
      // No session named, which is what makes it fresh. The environment is not
      // checked a second time: it was checked against this same setup, and a
      // Workspace that changed underneath a running Notebook is a failure for
      // the Cell that meets it rather than a declaration to re-read.
      isolate: () => options.agent(setup),
      order: scheduled.order,
      allCells: cellsOf(parsed.notebook),
      timeoutOf: (cell) => timeoutOf(parsed.notebook, cell),
      modelOf: (cell) => modelOf(parsed.notebook, cell) ?? mode?.model,
      ...(options.continues !== undefined ? { continues: options.continues } : {}),
      observe: options.observe ?? (() => undefined),
      ...(options.signal !== undefined ? { interrupt: options.signal } : {}),
      ...(options.bashStops !== undefined ? { bashStops: options.bashStops } : {}),
    });
  } finally {
    await shared.dispose();
  }
}
