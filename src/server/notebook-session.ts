/**
 * Notebook Sessions: a Notebook loaded live in the server, with an Agent
 * Session attached and its own execution state.
 *
 * Owned by the server rather than by whoever opened it, so a Run carries on
 * when the browser that started it has gone, and a browser that arrives later
 * finds the Notebook where the work left it. Every Notebook Session runs its
 * own Runs, so one long Run never holds up another Notebook's.
 *
 * A Notebook Session does not hold a live agent between Runs. Each Run is the
 * runner's own, given the Run before it to carry on from, and it is the Run
 * Record's `agentSession` that attaches the Agent Session: the runner reopens
 * it and forks at the Anchor the re-run Cell began at (ADR-0014), which is the
 * same path a headless re-run takes. The alternative — an agent kept open and
 * handed to each Run — would have the runner take a ready-made agent and stop
 * deciding its setup from the Notebook it has just read, which is what lets a
 * Notebook edited between Runs be run as it now stands.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { AgentFactory } from "../agent/agent.js";
import {
  type Cell,
  type CellType,
  cellsOf,
  formatDiagnostics,
  parseNotebook,
} from "../notebook/notebook.js";
import type { CellRecord, CellStatus, RunRecord } from "../run/record.js";
import { type RunEvent, runNotebook } from "../run/runner.js";
import { pathWithin, titleOf } from "./notebooks.js";

/**
 * Where a Cell stands in its Notebook Session: not yet run, running now, what
 * its last Run recorded, or Stale because a Cell it uses has run again since.
 */
export type CellState = "idle" | "running" | CellStatus | "stale";

export interface CellView {
  readonly id: string;
  readonly type: CellType;
  readonly status: CellState;
  /**
   * What the Cell has said so far while it runs, and what it said once it is
   * over — a Bash Cell's standard output, since a command is not spoken.
   */
  readonly text: string;
  /** Why the Cell did not succeed, when it did not. */
  readonly error?: string;
}

/** What a Notebook Session says of itself: enough to draw it. */
export interface NotebookSessionState {
  readonly id: string;
  /** The Notebook's path relative to the served directory, forward slashes throughout. */
  readonly notebook: string;
  readonly title: string;
  readonly running: boolean;
  readonly cells: readonly CellView[];
}

/**
 * What a Notebook Session tells whoever is listening. The runner's own events
 * pass through as they are, framed by the Run's beginning and end; a Run the
 * runner refused to start — a missing Input, an undecided Workspace — ends
 * before it began, with the refusal.
 */
export type NotebookSessionEvent =
  | { readonly type: "run-started"; readonly cells: readonly string[] }
  | RunEvent
  | { readonly type: "run-ended"; readonly record: RunRecord }
  | { readonly type: "run-refused"; readonly error: string };

export interface RunRequest {
  /** The Cells to run, by id; absent runs the whole Notebook. */
  readonly cells?: readonly string[];
  /** Values for the Notebook's declared Inputs, as written. */
  readonly inputs?: Readonly<Record<string, string>>;
}

export interface NotebookSession {
  readonly id: string;
  state(): NotebookSessionState;
  /**
   * Starts a Run of the Notebook, carrying on from the Run before it, and
   * returns whether it started: a Notebook Session runs one Run at a time,
   * since two would both be appending to one Agent Session.
   */
  run(request: RunRequest): boolean;
  /**
   * Stops the Run in progress where it is, and resolves once it has stopped —
   * at once when there was none — so that afterwards nothing is running.
   */
  interrupt(): Promise<void>;
  /** Hears every event from now on; returns the way to stop hearing them. */
  subscribe(listener: (event: NotebookSessionEvent) => void): () => void;
}

interface NotebookSessionSetup {
  readonly id: string;
  /** The Notebook's absolute path, which is what the runner is given. */
  readonly path: string;
  readonly notebook: string;
  readonly title: string;
  readonly cells: readonly Cell[];
  readonly agent: AgentFactory;
}

function createNotebookSession(setup: NotebookSessionSetup): NotebookSession {
  const { id, path, notebook, title, cells, agent } = setup;
  const listeners = new Set<(event: NotebookSessionEvent) => void>();

  /** What each Cell last recorded, across every Run so far. */
  const results = new Map<string, CellRecord>();
  /** The Cells the last Run left Stale. */
  let stale = new Set<string>();
  /** What the Cells in flight have said so far. */
  const speaking = new Map<string, string>();
  /** The Run before this one, for the next to carry on from. */
  let last: RunRecord | undefined;
  /** The Run in progress: the way to interrupt it, and when it is over. */
  let current: { readonly controller: AbortController; readonly over: Promise<void> } | undefined;

  const emit = (event: NotebookSessionEvent) => {
    for (const listener of listeners) {
      // A listener's failure is its own: the events are emitted from inside the
      // Run, and a socket that could not be written to must not stop a Cell.
      try {
        listener(event);
      } catch (cause) {
        process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
      }
    }
  };

  const viewOf = (cell: Cell): CellView => {
    const spoken = speaking.get(cell.id);
    if (spoken !== undefined)
      return { id: cell.id, type: cell.type, status: "running", text: spoken };

    const recorded = results.get(cell.id);
    if (recorded === undefined) return { id: cell.id, type: cell.type, status: "idle", text: "" };

    return {
      id: cell.id,
      type: cell.type,
      status: stale.has(cell.id) ? "stale" : recorded.status,
      text: recorded.type === "prompt" ? recorded.text : recorded.stdout,
      ...(recorded.error !== undefined ? { error: recorded.error } : {}),
    };
  };

  const observe = (event: RunEvent) => {
    switch (event.type) {
      case "cell-started":
        speaking.set(event.cell, "");
        break;
      case "cell-text":
        speaking.set(event.cell, (speaking.get(event.cell) ?? "") + event.text);
        break;
      case "cell-ended":
        speaking.delete(event.record.id);
        results.set(event.record.id, event.record);
        break;
    }
    emit(event);
  };

  return {
    id,

    state: () => ({
      id,
      notebook,
      title,
      running: current !== undefined,
      cells: cells.map(viewOf),
    }),

    run(request) {
      if (current !== undefined) return false;
      const controller = new AbortController();

      // Whatever was still in flight is over, however the Run ended. Settled
      // before the end is announced, so a listener that asks for the state on
      // hearing it finds the session already at rest.
      const settle = () => {
        speaking.clear();
        current = undefined;
      };

      const over = runNotebook(path, {
        agent,
        observe,
        signal: controller.signal,
        ...(request.cells !== undefined ? { cells: request.cells } : {}),
        ...(request.inputs !== undefined ? { inputs: request.inputs } : {}),
        ...(last !== undefined ? { continues: last } : {}),
      }).then(
        (record) => {
          last = record;
          stale = new Set(record.stale);
          settle();
          emit({ type: "run-ended", record });
        },
        (cause: unknown) => {
          settle();
          emit({
            type: "run-refused",
            error: cause instanceof Error ? cause.message : String(cause),
          });
        },
      );
      current = { controller, over };
      emit({ type: "run-started", cells: request.cells ?? cells.map((cell) => cell.id) });

      return true;
    },

    interrupt() {
      if (current === undefined) return Promise.resolve();
      current.controller.abort();
      return current.over;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** How opening a Notebook went. */
export type Opened =
  | { readonly kind: "opened"; readonly session: NotebookSession; readonly created: boolean }
  /** No such Notebook under the served directory, or a path that leads out of it. */
  | { readonly kind: "absent" }
  /** A file that is there but is not a Notebook that can be opened. */
  | { readonly kind: "refused"; readonly problem: string };

export interface NotebookSessions {
  /** The Notebook Session for the Notebook at `notebook`, opened if it was not already. */
  open(notebook: string): Promise<Opened>;
  get(id: string): NotebookSession | undefined;
  /**
   * Interrupts every Run in progress and resolves once each has stopped and
   * written its record: nothing outlives the server it runs in.
   */
  close(): Promise<void>;
}

export interface NotebookSessionsOptions {
  /** The directory the Notebooks are opened from, resolved. */
  readonly directory: string;
  /** Makes the agent each Run's Prompt Cells go to. */
  readonly agent: AgentFactory;
}

/**
 * The Notebook Sessions the server owns, one per Notebook: a Notebook is one
 * file with one set of Run Records beside it, and two live copies of it would
 * be two Runs writing into one history.
 */
export function createNotebookSessions(options: NotebookSessionsOptions): NotebookSessions {
  const { directory, agent } = options;
  const byId = new Map<string, NotebookSession>();
  const byPath = new Map<string, NotebookSession>();

  /** The file a name under the served directory points at, or nothing when it leads out. */
  const fileOf = (notebook: string): string | undefined => {
    if (notebook.includes("\0")) return undefined;
    const file = resolve(directory, notebook);
    const inside = relative(directory, file);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return undefined;
    return file;
  };

  return {
    async open(notebook) {
      const path = fileOf(notebook);
      if (path === undefined) return { kind: "absent" };

      const existing = byPath.get(path);
      if (existing !== undefined) return { kind: "opened", session: existing, created: false };

      let source: string;
      try {
        source = await readFile(path, "utf8");
      } catch (cause) {
        const { code } = cause as NodeJS.ErrnoException;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return { kind: "absent" };
        throw cause;
      }

      const parsed = parseNotebook(source);
      const within = pathWithin(directory, path);
      if (!parsed.ok) {
        return {
          kind: "refused",
          problem: `Cannot open ${within}:\n${formatDiagnostics(parsed.errors)}`,
        };
      }
      const cells = cellsOf(parsed.notebook);
      if (cells.length === 0) {
        return { kind: "refused", problem: `Cannot open ${within}: it has no cells.` };
      }

      // Two requests to open the same Notebook may have read it side by side;
      // whichever finished first has the session, and the other joins it.
      const raced = byPath.get(path);
      if (raced !== undefined) return { kind: "opened", session: raced, created: false };

      const session = createNotebookSession({
        id: randomUUID(),
        path,
        notebook: within,
        title: titleOf(parsed.notebook, path),
        cells,
        agent,
      });
      byId.set(session.id, session);
      byPath.set(path, session);
      return { kind: "opened", session, created: true };
    },

    get: (id) => byId.get(id),

    async close() {
      await Promise.all([...byId.values()].map((session) => session.interrupt()));
    },
  };
}
