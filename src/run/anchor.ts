/**
 * Where a Cell run again begins.
 *
 * Cells share one Agent Session, so a Cell's context is not its own body but
 * every turn that ran before it. Running one Cell again therefore has to say
 * where among those turns it starts, and the answer is read from the last Run
 * rather than worked out: the Cell before it recorded the Anchor its turn ended
 * on, which is exactly the point the re-run Cell began from.
 *
 * Why that point is reached by forking pi's session rather than by replaying
 * the earlier Cells or rebuilding their messages is ADR-0014.
 */

import type { RunRecord } from "./record.js";

/**
 * The Anchor a Cell should begin from, as the Run being continued recorded it:
 * the last Anchor written before that Cell ran.
 *
 * Undefined when no Cell before it recorded one, which is a Cell that spoke
 * first — its context is an empty one, and that is a position in the Agent
 * Session like any other rather than an absence of one.
 *
 * Cells are searched in the order the Run ran them rather than the order the
 * Notebook writes them, because that order is the one the turns followed. A
 * Bash Cell records no Anchor, so the search passes over it: a Cell whose
 * predecessor in the document was a shell command still begins where the last
 * turn ended.
 */
export function anchorBefore(previous: RunRecord, id: string): string | undefined {
  let anchor: string | undefined;

  for (const cell of previous.cells) {
    if (cell.id === id) break;
    if (cell.type === "prompt" && cell.anchor !== undefined) anchor = cell.anchor;
  }

  return anchor;
}
