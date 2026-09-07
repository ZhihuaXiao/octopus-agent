import { mkdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type Agent,
  type AgentFactory,
  type AgentSetup,
  TurnFailure,
  emptyResult,
  noUsage,
} from "../agent/agent.js";
import { checkEnvironment } from "../agent/environment.js";
import {
  ARTIFACTS_REFERENCE,
  type Cell,
  type InputValues,
  type Notebook,
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
import { anchorBefore } from "./anchor.js";
import type { BashCellRecord, CellRecord, PromptCellRecord, RunRecord, Timing } from "./record.js";
import { runScheduled } from "./schedule.js";
import { type ShellResult, runShellCommand } from "./shell.js";
import { artifactsDirectory, listArtifacts, newRunId, writeRunRecord } from "./store.js";

export interface RunOptions {
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
    error: cause instanceof Error ? cause.message : String(cause),
  };
}

/** What a Cell records when the Run stopped waiting for it. */
const timedOut = (bound: Bound) => ({
  status: "timeout" as const,
  error: `Timed out after ${formatDuration(bound.timeout)}`,
});

/**
 * How long a Cell may take, and the signal that fires when it has taken longer.
 * Absent when the Notebook set no timeout: the Cell then runs as long as it
 * takes, which is what every Notebook did before timeouts could be declared.
 *
 * Made where the Cell's own work begins — after an Isolated Cell's context is
 * made, after a continued Run's fork — rather than when the Cell is scheduled,
 * so the timeout is on the Cell's running and not on the Run's arrangements.
 */
interface Bound {
  readonly timeout: number;
  readonly signal: AbortSignal;
}

const boundOf = (timeout: number | undefined): Bound | undefined =>
  timeout === undefined ? undefined : { timeout, signal: AbortSignal.timeout(timeout) };

/** A Prompt Cell's turn as the Run asks for it: what to say, and on what terms. */
interface Turn {
  /** The body, its Input References already replaced. */
  readonly body: string;
  /** The model the Cell or the Notebook names, when either does. */
  readonly model?: string;
  /** How long the turn may take, when the Notebook bounds it. */
  readonly timeout?: number;
}

async function runPromptCell(
  cell: Cell,
  turn: Turn,
  agent: Agent,
): Promise<Outcome<PromptCellRecord>> {
  const bound = boundOf(turn.timeout);
  try {
    const result = await agent.prompt(turn.body, {
      ...(turn.model !== undefined ? { model: turn.model } : {}),
      ...(bound !== undefined ? { signal: bound.signal } : {}),
    });
    return { id: cell.id, type: "prompt", status: "ok", ...result };
  } catch (cause) {
    const failure = promptFailure(cell, cause);
    // Stopped by the Run rather than failed on its own. The agent's word rather
    // than the signal's, since a signal that fired as the turn was ending
    // stopped nothing, and the agent is the one that knows which it was.
    if (bound !== undefined && cause instanceof TurnFailure && cause.aborted) {
      return { ...failure, ...timedOut(bound) };
    }
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
  timeout: number | undefined,
): Promise<Outcome<BashCellRecord>> {
  const bound = boundOf(timeout);
  const result = await runShellCommand(body, workspace, bound?.signal);
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
    ...(error !== undefined ? { error } : {}),
    // Stopped by the Run rather than ended on its own, which the shell says
    // more plainly than the signal the command died of.
    ...(bound !== undefined && result.stopped ? timedOut(bound) : {}),
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
}

/** Runs the Cells of a Notebook that has already been cleared to run. */
async function runCells(cleared: Cleared): Promise<RunRecord> {
  const { path, workspace, shared, continues } = cleared;
  // Named before the first Cell runs rather than when the record is written,
  // because the Cells' artifact directories are under this Run's own and a Cell
  // has to be told where that is before it can put anything there.
  const id = newRunId();
  const startedAt = new Date().toISOString();

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

    if (cell.type === "bash") return runBashCell(cell, body, workspace, timeout);

    const model = cleared.modelOf(cell);
    const turn: Turn = {
      body,
      ...(model !== undefined ? { model } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
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
      await shared.resumeFrom(anchorBefore(continues, cell.id));
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
    const produced = await produce(cell);
    const endedAt = new Date().toISOString();
    // Whatever the Cell left, whether or not it succeeded: a Cell that failed
    // halfway may have left half of what it was making, and that is still the
    // only account there is of how far it got.
    const artifacts = await listArtifacts(path, id, cell.id);
    return { ...produced, artifacts, startedAt, endedAt };
  };

  // Halt rather than carry on: a later cell built on a failed one would be
  // building on a partially-applied change — and a cell that timed out may
  // have half-applied one just the same.
  const cells = [
    ...(await runScheduled(cleared.order, {
      run: runCell,
      failed: (recorded) => recorded.status !== "ok",
    })),
  ];

  const anchored = cells.some(
    (recorded) => recorded.type === "prompt" && recorded.anchor !== undefined,
  );
  // Read off the Graph rather than accumulated as the Cells ran, because the
  // Cells left Stale are mostly ones this Run never touched: the question is
  // what the Notebook now stands at, and only the whole Graph answers it.
  const stale = staleAfter({
    cells: cleared.allCells,
    ran: cells.map((recorded) => recorded.id),
    staleBefore: continues?.stale ?? [],
  });

  const record: RunRecord = {
    id,
    notebook: path,
    // The Run whose results the untouched Cells still hold, and whose Stale set
    // this one's was worked out from.
    ...(continues !== undefined ? { continues: continues.id } : {}),
    environment: {
      workspace,
      trusted: shared.environment.trusted,
      piVersion: shared.environment.piVersion,
      tools: [...shared.environment.tools],
    },
    // The shared session, and named only when some Cell left an Anchor in it,
    // since an Anchor is the only thing a later Run would reopen a session for.
    // Nothing anchored a Notebook of Bash Cells, nor one of Isolated Cells whose
    // sessions are gone, nor one whose every turn failed — and pi does not write
    // a session file until an assistant message arrives, so naming one on the
    // strength of having merely tried would point a later Run at nothing.
    ...(anchored && shared.agentSession !== undefined ? { agentSession: shared.agentSession } : {}),
    startedAt,
    endedAt: new Date().toISOString(),
    cells,
    stale: [...stale],
  };
  await writeRunRecord(record);
  return record;
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
      problem: absent.map((id) => `No cell named "${id}" in this notebook.`).join("\n"),
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
  const refuse = (why: string) => new Error(`Cannot run ${path}:\n${why}`);

  const parsed = parseNotebook(await readFile(path, "utf8"));
  if (!parsed.ok) throw refuse(formatDiagnostics(parsed.errors));

  const { metadata } = parsed.notebook;
  const inputs = resolveInputs(metadata.inputs ?? [], options.inputs ?? {});
  if (!inputs.ok) throw refuse(inputs.errors.join("\n"));

  const scheduled = orderToRun(parsed.notebook, options.cells);
  if (!scheduled.ok) throw refuse(scheduled.problem);

  const workspace = workspaceOf(parsed.notebook, path);
  if (!(await isDirectory(workspace))) {
    throw refuse(`Its workspace ${workspace} is not a directory.`);
  }

  // What every agent this Run makes is set up with, the shared one and each
  // Isolated Cell's alike: the same Workspace and the same declared environment,
  // since isolation is about the shared context and not about running elsewhere.
  const setup: AgentSetup = {
    workspace,
    ...(metadata.tools !== undefined ? { tools: metadata.tools } : {}),
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
      throw refuse(cause instanceof Error ? cause.message : String(cause));
    });

  try {
    const problems = checkEnvironment(metadata, shared.environment);
    if (problems.length > 0) throw refuse(problems.join("\n"));

    return await runCells({
      path,
      workspace,
      values: inputs.values,
      shared,
      // No session named, which is what makes it fresh. The environment is not
      // checked a second time: it was checked against this same setup, and a
      // Workspace that changed underneath a running Notebook is a failure for
      // the Cell that meets it rather than a declaration to re-read.
      isolate: () => options.agent(setup),
      order: scheduled.order,
      allCells: cellsOf(parsed.notebook),
      timeoutOf: (cell) => timeoutOf(parsed.notebook, cell),
      modelOf: (cell) => modelOf(parsed.notebook, cell),
      ...(options.continues !== undefined ? { continues: options.continues } : {}),
    });
  } finally {
    await shared.dispose();
  }
}
