/**
 * The scheduler: which Cells may run at the same time, and which may not.
 *
 * The Graph already says what has to run before what, and the run order it
 * yields is one legal sequence of that. What the scheduler adds is the second
 * constraint the sequence hides — the Notebook's shared context is one message
 * history, so only one Cell may be speaking into it (ADR-0016). An Isolated
 * Cell has a context of its own and so is bound by nothing but its edges.
 *
 * So the rule is one sentence: an Isolated Cell starts as soon as the Cells it
 * uses have finished, and every other Cell waits for that and for the shared
 * context to be free. A Notebook that marks nothing Isolated runs exactly as it
 * did before this module existed, one Cell at a time in the run order.
 */

import type { Cell } from "../notebook/notebook.js";

export interface ScheduledWork<T> {
  /** Runs one Cell. Called at most once per Cell, and never for a Cell left unrun. */
  readonly run: (cell: Cell) => Promise<T>;
  /**
   * Whether a result is a failure, after which nothing further starts.
   *
   * The scheduler's business rather than the caller's to notice afterwards,
   * because halting is a decision about what to start next and only the thing
   * doing the starting is in a position to take it.
   */
  readonly failed: (result: T) => boolean;
  /**
   * Fires when the Run is interrupted, after which nothing further starts,
   * exactly as after a failure. What is in flight is the caller's to stop; the
   * scheduler waits for it as it waits for anything in flight.
   */
  readonly signal?: AbortSignal;
}

/**
 * Runs Cells given in run order, as concurrently as isolation allows, and
 * reports what they produced.
 *
 * Results come back in the order the Cells were given rather than the order
 * they finished, so a parallel Run's record still reads against the Notebook
 * (ADR-0013). Cells left unrun — those behind a failure, and the failure's own
 * dependents — are absent rather than reported as anything.
 *
 * Halting waits for what is already in flight. A turn that has begun is going
 * to reach a provider and change a Workspace whatever this does about it, so
 * the Run's account of it is worth the wait.
 *
 * @param order the Cells to run, topologically ordered, dependencies first
 */
export async function runScheduled<T extends object>(
  order: readonly Cell[],
  work: ScheduledWork<T>,
): Promise<readonly T[]> {
  const waiting = [...order];
  const inFlight = new Map<Cell, Promise<void>>();
  const results = new Map<Cell, T>();
  /** The Cells that have run and succeeded, which are the ones that satisfy an edge. */
  const succeeded = new Set<string>();
  /** The Cells of this Run, since an edge may name one the Run is not running. */
  const inThisRun = new Set(order.map((cell) => cell.id));

  let sharedContextTaken = false;
  let halted = false;
  let thrown: unknown;

  /**
   * Whether every Cell this one uses has run and succeeded. An edge to a Cell
   * outside this Run asks nothing of it: a Run naming a subset runs that subset,
   * and where the rest of the Notebook stands is the Stale set's business.
   *
   * Succeeded rather than merely finished, so that nothing can be built on a
   * Cell that failed even if some later reason to carry on past a failure
   * arrives. Retries turned out not to be one: they happen inside the agent's
   * turn (ADR-0018), so a Cell that reaches here has already had them.
   */
  const ready = (cell: Cell) =>
    cell.uses.every((used) => !inThisRun.has(used) || succeeded.has(used));

  const start = (cell: Cell) => {
    waiting.splice(waiting.indexOf(cell), 1);
    if (!cell.isolated) sharedContextTaken = true;

    const settled = work
      .run(cell)
      .then(
        (result) => {
          results.set(cell, result);
          if (work.failed(result)) halted = true;
          else succeeded.add(cell.id);
        },
        (cause: unknown) => {
          // The caller's own bug rather than a Cell that failed, which it
          // reports through `failed` instead. Kept until the Cells in flight
          // beside it are done, so one bug does not abandon their turns.
          thrown ??= cause;
          halted = true;
        },
      )
      .finally(() => {
        inFlight.delete(cell);
        if (!cell.isolated) sharedContextTaken = false;
      });

    inFlight.set(cell, settled);
  };

  /**
   * The Cells that may start now, earliest-written first, at most one of them
   * needing the shared context.
   */
  const startable = () => {
    let taken = sharedContextTaken;
    return waiting.filter((cell) => {
      if (!ready(cell)) return false;
      if (cell.isolated) return true;
      if (taken) return false;
      taken = true;
      return true;
    });
  };

  while (inFlight.size > 0 || (!halted && waiting.length > 0)) {
    // Read before each round of starts rather than listened for, since a
    // signal that fired while a Cell was in flight matters only now, when the
    // next would otherwise start.
    if (work.signal?.aborted) halted = true;
    if (!halted) for (const cell of startable()) start(cell);

    if (inFlight.size === 0) {
      // Interrupted between Cells, with nothing in flight to wait for.
      if (halted) break;
      // Unreachable for a topological order: nothing has failed, or the loop
      // would have stopped, so every Cell before the first one still waiting
      // has succeeded — its edges are satisfied and the shared context is free.
      // Said out loud all the same, because the alternative to a message here
      // is a Run that hangs without one.
      const stuck = waiting.map((cell) => `"${cell.id}"`).join(", ");
      throw new Error(`Cannot schedule the cells ${stuck}: nothing is left that could start them.`);
    }

    await Promise.race(inFlight.values());
  }

  if (thrown !== undefined) throw thrown;

  return order.flatMap((cell) => {
    const result = results.get(cell);
    return result === undefined ? [] : [result];
  });
}
