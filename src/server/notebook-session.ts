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

import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import type { AgentFactory, ToolCall } from "../agent/agent.js";
import { type NotebookEdit, applyEdit } from "../notebook/edit.js";
import {
  type Cell,
  type CellType,
  type Diagnostic,
  type Notebook,
  cellsOf,
  formatDiagnostics,
  isCellSegment,
  parseNotebook,
} from "../notebook/notebook.js";
import type { CellRecord, CellStatus, RunRecord } from "../run/record.js";
import { type RunEvent, runNotebook } from "../run/runner.js";
import { runFile } from "../run/store.js";
import { fileWithin, pathWithin, titleOf } from "./notebooks.js";

/**
 * Where a Cell stands in its Notebook Session: not yet run, running now, what
 * its last Run recorded, or Stale because a Cell it uses has run again since.
 */
export type CellState = "idle" | "running" | CellStatus | "stale";

/**
 * One Cell as the browser draws it: what the Notebook declares of it, and what
 * running it has produced so far.
 */
export interface CellView {
  readonly id: string;
  readonly type: CellType;
  /** The body as written, which is what an author is here to read and run. */
  readonly body: string;
  /** The Cells this one declares a Dependency on. */
  readonly uses: readonly string[];
  readonly isolated: boolean;
  /** The model the Cell names for itself, when it does. */
  readonly model?: string;
  /** The Cell's own Timeout in milliseconds, when it declares one. */
  readonly timeout?: number;
  readonly status: CellState;
  /**
   * What the Cell has said so far while it runs, and what it said once it is
   * over — a Bash Cell's standard output, since a command is not spoken.
   */
  readonly text: string;
  /** The tools the agent has invoked so far, or invoked, in the order it did. */
  readonly toolCalls: readonly ToolCall[];
  /**
   * The files the Cell left, as its record names them: paths relative to the
   * directory of the Run named by `run`, which is where the server serves them
   * from. Empty until the Cell has a record.
   */
  readonly artifacts: readonly string[];
  /** The Run the Cell is running in, or last ran in; absent for a Cell that has never run. */
  readonly run?: string;
  /** Why the Cell did not succeed, when it did not. */
  readonly error?: string;
}

/**
 * The Notebook's layout: its Prose as written, and where among it each Cell
 * sits, by id. The Cells themselves are in `cells`, so a browser that is only
 * running them need not look here, and one that is editing has the whole
 * Notebook to draw.
 */
export type SegmentView =
  | { readonly kind: "prose"; readonly text: string }
  | { readonly kind: "cell"; readonly id: string };

/** What a Notebook Session says of itself: enough to draw it, and to edit it. */
export interface NotebookSessionState {
  readonly id: string;
  /** The Notebook's path relative to the served directory, forward slashes throughout. */
  readonly notebook: string;
  readonly title: string;
  /**
   * Which version of the file the session holds. A save says which revision
   * its draft was made from, so one made from an earlier version — the file
   * saved by another browser since, or changed on disk — is detected rather
   * than written over what it never saw.
   */
  readonly revision: string;
  /** The YAML between the frontmatter's delimiters, as written; absent when there is none. */
  readonly frontmatter?: string;
  readonly segments: readonly SegmentView[];
  readonly running: boolean;
  /**
   * The Run in progress, once it has named itself: what a Cell that starts
   * from now on is running in, for a browser that arrives between Cells.
   */
  readonly run?: string;
  readonly cells: readonly CellView[];
}

/**
 * What a Notebook Session tells whoever is listening. The runner's own events
 * pass through as they are — the Run naming itself first, once it is cleared
 * to run — and the Notebook Session adds the Run's end; a Run the runner
 * refused to start — a missing Input, an undecided Workspace — never names
 * itself, and ends with the refusal instead.
 */
export type NotebookSessionEvent =
  | RunEvent
  | { readonly type: "run-ended"; readonly record: RunRecord }
  | { readonly type: "run-refused"; readonly error: string }
  /** The Notebook itself changed — saved from a browser, or found changed on disk — and this is it now. */
  | { readonly type: "notebook-changed"; readonly session: NotebookSessionState };

export interface RunRequest {
  /** The Cells to run, by id; absent runs the whole Notebook. */
  readonly cells?: readonly string[];
  /** Values for the Notebook's declared Inputs, as written. */
  readonly inputs?: Readonly<Record<string, string>>;
}

/** The Notebook as a browser wants it saved, and the revision its draft was made from. */
export interface SaveRequest extends NotebookEdit {
  readonly base: string;
}

/** How saving went. */
export type Saved =
  | { readonly kind: "saved" }
  /** The draft was made from a version the session no longer holds; the state says what it holds now. */
  | { readonly kind: "changed"; readonly problem: string }
  /** What the edit makes is not a Notebook that can be opened, and nothing was written. */
  | { readonly kind: "refused"; readonly problem: string };

export interface NotebookSession {
  readonly id: string;
  state(): NotebookSessionState;
  /**
   * Writes the Notebook as edited to its file, when the draft was made from
   * the version the file still holds and the result is a Notebook that can be
   * opened; the session then shows the Notebook as saved. Only the bytes the
   * edit changed change on disk — see `applyEdit`.
   */
  save(request: SaveRequest): Promise<Saved>;
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
  /**
   * The file at `file` under the directory of this Notebook's Run `run` — an
   * Artifact as a record names one, or the record itself — or nothing when the
   * pair names no file there, a climb out of the Run's directory included.
   */
  runFile(run: string, file: string): Promise<string | undefined>;
}

interface NotebookSessionSetup {
  readonly id: string;
  /** The Notebook's absolute path, which is what the runner is given. */
  readonly path: string;
  /** The Notebook's path as the server names it. */
  readonly notebook: string;
  /** The file's bytes as read, which is what a save is checked against. */
  readonly source: string;
  readonly parsed: Notebook;
  readonly agent: AgentFactory;
}

/** The revision a file's bytes are: enough of their digest to tell two versions apart. */
const revisionOf = (source: string) =>
  createHash("sha256").update(source).digest("hex").slice(0, 16);

/**
 * Whether what was read or made is a Notebook the server can hold — one that
 * parses, with a Cell in it — and why not when it is not, said as `cannot`
 * begins it: "Cannot open essay.md", "Cannot save essay.md".
 */
function readable<Made extends { readonly ok: true; readonly notebook: Notebook }>(
  result: Made | { readonly ok: false; readonly errors: readonly Diagnostic[] },
  cannot: string,
): Made | { readonly ok: false; readonly problem: string } {
  if (!result.ok) return { ok: false, problem: `${cannot}:\n${formatDiagnostics(result.errors)}` };
  if (cellsOf(result.notebook).length === 0) {
    return { ok: false, problem: `${cannot}: it has no cells.` };
  }
  return result;
}

function createNotebookSession(setup: NotebookSessionSetup): NotebookSession {
  const { id, path, notebook, agent } = setup;
  const listeners = new Set<(event: NotebookSessionEvent) => void>();

  /** The Notebook as the session holds it: the file's bytes, and what they parse to. */
  let source = setup.source;
  let parsed = setup.parsed;
  let revision = revisionOf(source);
  /**
   * The saves in flight, one after another: a save reads the file and then
   * writes it, and two doing so at once would each write over the other's
   * work without either being told.
   */
  let saving: Promise<unknown> = Promise.resolve();

  /** What each Cell last recorded, across every Run so far, and in which Run. */
  const results = new Map<string, { readonly record: CellRecord; readonly run: string }>();
  /** The Cells the last Run left Stale. */
  let stale = new Set<string>();
  /** What the Cells in flight have said and done so far. */
  const speaking = new Map<string, { text: string; readonly calls: ToolCall[] }>();
  /** The Run before this one, for the next to carry on from. */
  let last: RunRecord | undefined;
  /** The Run in progress: the way to interrupt it, when it is over, and its id once it has named itself. */
  let current:
    | { readonly controller: AbortController; readonly over: Promise<void>; run?: string }
    | undefined;

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
    const declared = {
      id: cell.id,
      type: cell.type,
      body: cell.body,
      uses: cell.uses,
      isolated: cell.isolated,
      ...(cell.model !== undefined ? { model: cell.model } : {}),
      ...(cell.timeout !== undefined ? { timeout: cell.timeout } : {}),
    };

    const inFlight = speaking.get(cell.id);
    if (inFlight !== undefined) {
      return {
        ...declared,
        status: "running",
        text: inFlight.text,
        toolCalls: inFlight.calls,
        artifacts: [],
        ...(current?.run !== undefined ? { run: current.run } : {}),
      };
    }

    const found = results.get(cell.id);
    if (found === undefined) {
      return { ...declared, status: "idle", text: "", toolCalls: [], artifacts: [] };
    }

    const { record, run } = found;
    return {
      ...declared,
      status: stale.has(cell.id) ? "stale" : record.status,
      text: record.type === "prompt" ? record.text : record.stdout,
      toolCalls: record.type === "prompt" ? record.toolCalls : [],
      artifacts: record.artifacts,
      run,
      ...(record.error !== undefined ? { error: record.error } : {}),
    };
  };

  const observe = (event: RunEvent) => {
    switch (event.type) {
      case "run-started":
        if (current !== undefined) current.run = event.run;
        break;
      case "cell-started":
        speaking.set(event.cell, { text: "", calls: [] });
        break;
      case "cell-text": {
        const inFlight = speaking.get(event.cell);
        if (inFlight !== undefined) inFlight.text += event.text;
        break;
      }
      case "cell-tool-call":
        speaking.get(event.cell)?.calls.push(event.call);
        break;
      case "cell-ended":
        speaking.delete(event.record.id);
        // The Run named itself before any Cell started, so a Cell that ended has
        // a Run to be recorded against; the empty name is never reached.
        results.set(event.record.id, { record: event.record, run: current?.run ?? "" });
        break;
    }
    emit(event);
  };

  const state = (): NotebookSessionState => ({
    id,
    notebook,
    title: titleOf(parsed, path),
    revision,
    ...(parsed.frontmatter !== undefined ? { frontmatter: parsed.frontmatter.text } : {}),
    segments: parsed.segments.map((segment) =>
      isCellSegment(segment)
        ? { kind: "cell", id: segment.cell.id }
        : { kind: "prose", text: segment.text },
    ),
    running: current !== undefined,
    ...(current?.run !== undefined ? { run: current.run } : {}),
    cells: cellsOf(parsed).map(viewOf),
  });

  /** Makes `bytes` the Notebook the session holds, and tells whoever is watching. */
  const adopt = (bytes: string, made: Notebook) => {
    source = bytes;
    parsed = made;
    revision = revisionOf(bytes);
    emit({ type: "notebook-changed", session: state() });
  };

  const save = async (request: SaveRequest): Promise<Saved> => {
    // The file first: a Notebook is edited in any editor (ADR-0002), and one
    // that changed under the session is what the session should hold, whether
    // or not the draft is then written over it. A file that is gone has
    // nothing in it to write over, so saving puts it back.
    const onDisk = await readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return undefined;
      throw cause;
    });
    if (onDisk !== undefined && onDisk !== source) {
      const found = readable(parseNotebook(onDisk), `Cannot open ${notebook}`);
      // A file that no longer parses is still the file: the revision moves to
      // it, so a save made knowingly can put a readable Notebook back, and
      // the Cells shown stay the last ones that could be read.
      adopt(onDisk, found.ok ? found.notebook : parsed);
      return {
        kind: "changed",
        problem: `${notebook} changed on disk since it was opened${found.ok ? "" : `, and cannot now be read:\n${found.problem}`}`,
      };
    }
    if (request.base !== revision) {
      return { kind: "changed", problem: `${notebook} was saved since this draft was made.` };
    }

    const { base: _base, ...edit } = request;
    const made = readable(applyEdit(parsed, edit), `Cannot save ${notebook}`);
    if (!made.ok) return { kind: "refused", problem: made.problem };

    await writeFile(path, made.source, "utf8");
    adopt(made.source, made.notebook);
    return { kind: "saved" };
  };

  return {
    id,

    state,

    save(request) {
      const saved = saving.then(() => save(request));
      // The next save waits for this one however it went; its failure is its caller's.
      saving = saved.catch(() => undefined);
      return saved;
    },

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
      // The Run names itself, with its id and the Cells in their order, once it
      // is cleared to run; until then the state alone says the session is running.

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

    runFile: (run, file) => runFile(path, run, file),
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

  return {
    async open(notebook) {
      const path = fileWithin(directory, notebook);
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

      const relativePath = pathWithin(directory, path);
      const found = readable(parseNotebook(source), `Cannot open ${relativePath}`);
      if (!found.ok) return { kind: "refused", problem: found.problem };

      // Two requests to open the same Notebook may have read it side by side;
      // whichever finished first has the session, and the other joins it.
      const raced = byPath.get(path);
      if (raced !== undefined) return { kind: "opened", session: raced, created: false };

      const session = createNotebookSession({
        id: randomUUID(),
        path,
        notebook: relativePath,
        source,
        parsed: found.notebook,
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
