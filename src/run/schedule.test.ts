/**
 * The scheduler's own tests, driven with fake work rather than through
 * `runNotebook`.
 *
 * Below the seam the spec designates, because what is being asserted is when
 * one Cell starts relative to another, and a Run Record says only what ran and
 * in what order. Holding a Cell in flight and watching what starts beside it is
 * the whole subject here, so the test needs to be the thing releasing it.
 */

import { describe, expect, it } from "vitest";

import type { Cell } from "../notebook/notebook.js";
import { runScheduled } from "./schedule.js";

/** A Cell with only the attributes the scheduler reads. */
const cell = (
  id: string,
  options: { uses?: readonly string[]; isolated?: boolean } = {},
): Cell => ({
  id,
  type: "prompt",
  body: `Do ${id}.`,
  uses: options.uses ?? [],
  isolated: options.isolated ?? false,
});

const isolated = (id: string, uses?: readonly string[]) =>
  cell(id, { isolated: true, ...(uses !== undefined ? { uses } : {}) });

interface Outcome {
  readonly id: string;
  readonly failed: boolean;
}

/**
 * A scheduled run whose Cells finish only when the test says so.
 *
 * Nothing here resolves on its own, so "these two ran at the same time" is
 * observable as "both started while neither had finished" rather than as a
 * race the test would have to win.
 */
function holding(cells: readonly Cell[]) {
  const started: string[] = [];
  const release = new Map<string, (outcome: Outcome) => void>();
  let over = false;

  const finished = runScheduled(cells, {
    run: (waiting) =>
      new Promise<Outcome>((settle) => {
        started.push(waiting.id);
        release.set(waiting.id, settle);
      }),
    failed: (outcome) => outcome.failed,
  });
  void finished.then(() => {
    over = true;
  });

  /** Lets the scheduler act on everything released so far. */
  const settle = () => new Promise((resume) => setTimeout(resume, 0));

  const settling =
    (outcome: (id: string) => Outcome) =>
    async (...ids: readonly string[]) => {
      for (const id of ids) {
        const settled = release.get(id);
        if (settled === undefined) throw new Error(`"${id}" has not started, so it cannot finish`);
        settled(outcome(id));
      }
      await settle();
    };

  return {
    started,
    finished,
    /** Whether the whole scheduled run is over. */
    get over() {
      return over;
    },
    /** Finishes the named cells, then waits for whatever that lets start. */
    finish: settling((id) => ({ id, failed: false })),
    /** Fails the named cells, then waits for the scheduler to react. */
    fail: settling((id) => ({ id, failed: true })),
    /** Waits for everything the scheduler could start without anything finishing. */
    settle,
  };
}

const ran = (outcomes: readonly Outcome[]) => outcomes.map((outcome) => outcome.id);

describe("scheduling isolated cells", () => {
  it("starts isolated cells with no edge between them at the same time", async () => {
    const run = holding([isolated("a"), isolated("b"), isolated("c")]);
    await run.settle();

    // All three are in flight: none has been finished, and the scheduler did
    // not wait to be told before starting the next.
    expect(run.started).toEqual(["a", "b", "c"]);

    await run.finish("a", "b", "c");
    expect(ran(await run.finished)).toEqual(["a", "b", "c"]);
  });

  it("holds an isolated cell back until the cell it uses has finished", async () => {
    const run = holding([isolated("collect"), isolated("report", ["collect"])]);
    await run.settle();

    expect(run.started).toEqual(["collect"]);

    await run.finish("collect");
    expect(run.started).toEqual(["collect", "report"]);
    await run.finish("report");
    await run.finished;
  });

  it("starts the isolated cells an edge leaves free while one of them waits", async () => {
    // `report` waits for `collect`; `spare` waits for nothing, so it has no
    // reason to sit behind either of them.
    const run = holding([isolated("collect"), isolated("report", ["collect"]), isolated("spare")]);
    await run.settle();

    expect(run.started).toEqual(["collect", "spare"]);

    await run.finish("collect", "spare");
    expect(run.started).toEqual(["collect", "spare", "report"]);
    await run.finish("report");
    await run.finished;
  });
});

describe("scheduling shared-context cells", () => {
  it("runs one shared-context cell at a time, though no edge separates them", async () => {
    const run = holding([cell("a"), cell("b"), cell("c")]);
    await run.settle();

    // They would both be appending to one message history, so the edges do not
    // come into it: the second waits because the first has not finished.
    expect(run.started).toEqual(["a"]);

    await run.finish("a");
    expect(run.started).toEqual(["a", "b"]);
    await run.finish("b");
    expect(run.started).toEqual(["a", "b", "c"]);
    await run.finish("c");
    await run.finished;
  });

  it("runs an isolated cell alongside a shared-context one", async () => {
    // Only the shared context is exclusive. An isolated cell speaks into a
    // context of its own, so it disturbs nothing by running beside one.
    const run = holding([cell("shared"), isolated("apart")]);
    await run.settle();

    expect(run.started).toEqual(["shared", "apart"]);

    await run.finish("shared", "apart");
    await run.finished;
  });

  it("gives the shared context to the earliest-written cell waiting for it", async () => {
    const run = holding([cell("first"), isolated("apart"), cell("second")]);
    await run.settle();

    expect(run.started).toEqual(["first", "apart"]);

    // `second` takes the shared context the moment `first` gives it up, whether
    // or not the isolated cell beside them has finished.
    await run.finish("first");
    expect(run.started).toEqual(["first", "apart", "second"]);
    await run.finish("apart", "second");
    await run.finished;
  });
});

describe("the results a scheduled run reports", () => {
  it("returns them in run order, however the cells finished", async () => {
    const run = holding([isolated("a"), isolated("b"), isolated("c")]);
    await run.settle();

    await run.finish("c", "a", "b");

    // The record reads against the notebook rather than against the clock, so
    // finishing out of order is not reordering.
    expect(ran(await run.finished)).toEqual(["a", "b", "c"]);
  });

  it("reports only the cells that ran", async () => {
    const run = holding([cell("a"), cell("b")]);
    await run.settle();

    await run.fail("a");

    expect(ran(await run.finished)).toEqual(["a"]);
  });
});

describe("a scheduled run that fails", () => {
  it("starts nothing further once a cell has failed", async () => {
    const run = holding([isolated("a"), isolated("b", ["a"]), cell("c")]);
    await run.settle();

    await run.fail("a");
    await run.finish("c");

    // `b` was waiting on the cell that failed and `c` was merely later; neither
    // starts, because a cell built on a failed one is built on nothing.
    expect(run.started).toEqual(["a", "c"]);
    expect(ran(await run.finished)).toEqual(["a", "c"]);
  });

  it("lets the cells already in flight finish", async () => {
    const run = holding([isolated("a"), isolated("b")]);
    await run.settle();

    await run.fail("a");

    // `b` was already speaking to a provider when `a` failed. Abandoning it
    // would leave a turn that happened with no record that it did.
    expect(run.over).toBe(false);

    await run.finish("b");
    expect(ran(await run.finished)).toEqual(["a", "b"]);
  });

  it("waits for the cells in flight before reporting a cell that threw", async () => {
    const thrown = new Error("the scheduler's caller has a bug");
    const started: string[] = [];
    let release: (() => void) | undefined;

    const finished = runScheduled([isolated("a"), isolated("b")], {
      run: (waiting) => {
        started.push(waiting.id);
        if (waiting.id === "a") return Promise.reject(thrown);
        return new Promise<Outcome>((settle) => {
          release = () => settle({ id: waiting.id, failed: false });
        });
      },
      failed: (outcome) => outcome.failed,
    });

    await new Promise((resume) => setTimeout(resume, 0));
    expect(started).toEqual(["a", "b"]);
    release?.();

    await expect(finished).rejects.toThrow(thrown);
  });
});
