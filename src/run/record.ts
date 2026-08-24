/**
 * The persisted result of a Run, kept outside the Notebook so the document
 * stays a program rather than a log (ADR-0005).
 *
 * Minimal by design: ticket 12 adds per-cell timings, cost, and artifacts.
 */

import type { CellResult } from "../agent/agent.js";

export type CellStatus = "ok" | "error";

/** What one Cell produced, plus which Cell it was and how it ended. */
export interface CellRecord extends CellResult {
  id: string;
  status: CellStatus;
  /** Why the cell failed, present only when the status is `error`. */
  error?: string;
}

export interface RunRecord {
  /** Identifies this Run among the Notebook's other Runs. */
  id: string;
  /** Path to the Notebook this Run executed. */
  notebook: string;
  startedAt: string;
  endedAt: string;
  cells: CellRecord[];
}
