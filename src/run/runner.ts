import { readFile, stat } from "node:fs/promises";

import { type Agent, type AgentFactory, emptyResult, noUsage } from "../agent/agent.js";
import { checkEnvironment } from "../agent/environment.js";
import {
  type Cell,
  type InputValues,
  type Notebook,
  bodyOf,
  cellsOf,
  formatDiagnostics,
  interpolate,
  parseNotebook,
  resolveInputs,
  runOrder,
  workspaceOf,
} from "../notebook/notebook.js";
import { anchorBefore } from "./anchor.js";
import type { BashCellRecord, CellRecord, PromptCellRecord, RunRecord } from "./record.js";
import { type ShellResult, runShellCommand } from "./shell.js";
import { newRunId, writeRunRecord } from "./store.js";

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
   * simply do not run — nothing is inferred from their absence, and nothing
   * they produced before is carried forward. Which Cells belong in the list is
   * ticket 09's question, not this option's.
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

async function runPromptCell(cell: Cell, body: string, agent: Agent): Promise<PromptCellRecord> {
  try {
    return { id: cell.id, type: "prompt", status: "ok", ...(await agent.prompt(body)) };
  } catch (cause) {
    return {
      id: cell.id,
      type: "prompt",
      status: "error",
      ...emptyResult,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** How a command failed, or undefined when it succeeded. */
function failureOf(result: ShellResult): string | undefined {
  if (result.startupError !== null) return `Command could not be run: ${result.startupError}`;
  if (result.signal !== null) return `Command was killed by ${result.signal}`;
  if (result.exitCode !== 0) return `Command exited with status ${result.exitCode}`;
  return undefined;
}

async function runBashCell(cell: Cell, body: string, workspace: string): Promise<BashCellRecord> {
  const result = await runShellCommand(body, workspace);
  const error = failureOf(result);

  return {
    id: cell.id,
    type: "bash",
    status: error === undefined ? "ok" : "error",
    // No model ran, which is the whole reason to write a Bash Cell rather than
    // ask the agent to do the same deterministic thing.
    usage: noUsage,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    ...(error !== undefined ? { error } : {}),
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
  readonly agent: Agent;
  /**
   * The Cells to run, already ordered and already known to exist, which is what
   * leaves the loop below with no way to fail before it has run anything.
   */
  readonly order: readonly Cell[];
  /** The Run being carried on from, when this Run carries on from one. */
  readonly continues?: RunRecord;
}

/** Runs the Cells of a Notebook that has already been cleared to run. */
async function runCells(cleared: Cleared): Promise<RunRecord> {
  const { path, workspace, agent, continues } = cleared;
  const startedAt = new Date().toISOString();
  const cells: CellRecord[] = [];

  let forked = false;

  for (const cell of cleared.order) {
    const body = interpolate(bodyOf(cell), cleared.values);

    // Once, before the first Cell that speaks to the agent, and only when this
    // Run carries on from another — an Agent Session of its own already sits
    // where a first Cell begins. Every Cell after it follows the one before,
    // which is where the session now is; forking each of them back to where it
    // began last time would throw away the turn just taken.
    if (continues !== undefined && !forked && cell.type === "prompt") {
      await agent.resumeFrom(anchorBefore(continues, cell.id));
      forked = true;
    }

    const recorded =
      cell.type === "bash"
        ? await runBashCell(cell, body, workspace)
        : await runPromptCell(cell, body, agent);
    cells.push(recorded);

    // Halt rather than carry on: a later cell built on a failed one would be
    // building on a partially-applied change. Ticket 11 adds retries and
    // timeouts around this.
    if (recorded.status === "error") break;
  }

  const anchored = cells.some(
    (recorded) => recorded.type === "prompt" && recorded.anchor !== undefined,
  );
  const record: RunRecord = {
    id: newRunId(),
    notebook: path,
    environment: {
      workspace,
      trusted: agent.environment.trusted,
      piVersion: agent.environment.piVersion,
      tools: [...agent.environment.tools],
    },
    // Named only when some Cell left an Anchor in it, since an Anchor is the
    // only thing a later Run would reopen a session for. Nothing anchored a
    // Notebook of Bash Cells, nor one whose every turn failed — and pi does not
    // write a session file until an assistant message arrives, so naming one on
    // the strength of having merely tried would point a later Run at nothing.
    ...(anchored && agent.agentSession !== undefined ? { agentSession: agent.agentSession } : {}),
    startedAt,
    endedAt: new Date().toISOString(),
    cells,
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

  // The agent is set up before the environment is checked because setting it
  // up is what discovers the environment: pi finds the Workspace's skills and
  // packages while loading them, not by being asked separately.
  const agent = await options
    .agent({
      workspace,
      ...(metadata.tools !== undefined ? { tools: metadata.tools } : {}),
      ...(options.trust !== undefined ? { trust: options.trust } : {}),
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
    const problems = checkEnvironment(metadata, agent.environment);
    if (problems.length > 0) throw refuse(problems.join("\n"));

    return await runCells({
      path,
      workspace,
      values: inputs.values,
      agent,
      order: scheduled.order,
      ...(options.continues !== undefined ? { continues: options.continues } : {}),
    });
  } finally {
    await agent.dispose();
  }
}
