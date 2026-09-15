/**
 * Where a Cell run again begins.
 *
 * Cells share one Agent Session, so a Cell's context is not its own body but
 * every turn that ran before it. Running one Cell again therefore has to say
 * where among those turns it starts, and the answer is read from the Run being
 * continued rather than worked out: the Cell before it recorded the Anchor its
 * turn ended on, which is exactly the point the re-run Cell began from.
 *
 * Why that point is reached by forking pi's session rather than by replaying
 * the earlier Cells or rebuilding their messages is ADR-0014.
 */

import { type Cell, runOrder } from "../notebook/notebook.js";
import type { CellRecord } from "./record.js";

/** The Anchor each Prompt Cell's turn last ended on, by the Cell's id. */
export type Anchors = Readonly<Record<string, string>>;

/**
 * The Anchors a Run leaves standing: those the Run it continued left, with this
 * Run's own laid over them.
 *
 * Accumulated through the chain of Runs as `stale` is, because a Run of some
 * Cells has nothing to say about the rest, and a later Run re-running one of
 * the rest still needs to know where it began. A Prompt Cell whose turn ended
 * on an Anchor replaces whatever it had; one whose turn did not — it failed,
 * was stopped, or was Isolated and its context is gone — has none standing,
 * since the Anchor it had before is on a branch the new turn abandoned. A Bash
 * Cell never enters the Agent Session and changes nothing here.
 */
export function anchorsAfter(run: {
  /** What the Run this one carried on from had left standing, if it carried on from one. */
  readonly anchorsBefore: Anchors;
  /** The Cells this Run ran. */
  readonly cells: readonly CellRecord[];
}): Record<string, string> {
  const anchors: Record<string, string> = { ...run.anchorsBefore };
  for (const cell of run.cells) {
    if (cell.type !== "prompt") continue;
    if (cell.anchor !== undefined) anchors[cell.id] = cell.anchor;
    else delete anchors[cell.id];
  }
  return anchors;
}

/**
 * The Anchor a Cell should begin from: the last one standing before that Cell
 * in the Run order.
 *
 * Undefined when no Cell before it has one, which is a Cell that speaks first
 * — its context is an empty one, and that is a position in the Agent Session
 * like any other rather than an absence of one.
 *
 * Cells are searched in the order they run rather than the order the Notebook
 * writes them, because that order is the one the turns followed, and it is the
 * same for every Run of the Notebook (ADR-0013). A Bash Cell has no Anchor, so
 * the search passes over it: a Cell whose predecessor in the document was a
 * shell command still begins where the last turn ended.
 */
export function anchorBefore(
  standing: Anchors,
  /** Every Cell of the Notebook, since the Cells before this one may not have run lately. */
  cells: readonly Cell[],
  id: string,
): string | undefined {
  let anchor: string | undefined;

  for (const cell of runOrder(cells)) {
    if (cell.id === id) break;
    const found = standing[cell.id];
    if (found !== undefined) anchor = found;
  }

  return anchor;
}
