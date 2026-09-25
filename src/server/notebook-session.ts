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
 *
 * Nor does a Notebook Session live only in memory. Every event it emits is
 * numbered and journaled (`journal.ts`), and the journal is what it is made
 * from again when a server starts: the events heard over, the session stands
 * where it stood, under the id it had, and a browser that comes back — after
 * its own connection dropped, or after the server's restart — asks for
 * everything since the last event it heard and is told exactly that
 * (ADR-0021). A Run the server died in the middle of is ended here, as far as
 * it got, since the process that was running it is gone.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { type AgentFactory, type ToolCall, emptyResult, noUsage } from "../agent/agent.js";
import { thisMachine } from "../export/credentials.js";
import { type Exported, exportNotebook } from "../export/html.js";
import { type NotebookEdit, applyEdit } from "../notebook/edit.js";
import {
  type Cell,
  type CellType,
  type Diagnostic,
  type Input,
  type Notebook,
  cellsOf,
  formatDiagnostics,
  isCellSegment,
  parseNotebook,
  titleOf,
} from "../notebook/notebook.js";
import type { CellRecord, CellStatus, RunEnvironment, RunRecord } from "../run/record.js";
import {
  type RefusalKind,
  type RunEvent,
  RunRefusal,
  concludeRun,
  runNotebook,
} from "../run/runner.js";
import { listArtifacts, readRunRecord, runFile } from "../run/store.js";
import {
  type FoundJournal,
  type Journal,
  type JournalHeader,
  type JournalLine,
  openJournal,
  readJournals,
} from "./journal.js";
import { fileWithin, pathWithin } from "./notebooks.js";

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

/**
 * Why the runner would not start a Run, as it said: which kind of thing was
 * wrong, and everything wrong of that kind, one problem to a line. Absent
 * from a refusal the runner did not make — something failing that should not
 * have — which has only its message.
 */
export interface Refusal {
  readonly kind: RefusalKind;
  readonly problems: readonly string[];
}

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
  /**
   * The Inputs the Notebook declares, each with its type, its description and
   * its default when it has one — an Input without a default being one a Run
   * must be given a value for. What the Run View draws as its form, so that a
   * browser need not read the frontmatter's YAML for itself.
   */
  readonly inputs: readonly Input[];
  readonly segments: readonly SegmentView[];
  readonly running: boolean;
  /**
   * The Run in progress, once it has named itself: what a Cell that starts
   * from now on is running in, for a browser that arrives between Cells.
   */
  readonly run?: string;
  /**
   * The number of the last event this state reflects, so a browser that holds
   * it can later ask for everything since. Zero when nothing has happened yet.
   */
  readonly sequence: number;
  readonly cells: readonly CellView[];
}

/**
 * What a Notebook Session tells whoever is listening. The runner's own events
 * pass through as they are — the Run naming itself first, once it is cleared
 * to run — and the Notebook Session adds the Run's end; a Run the runner
 * refused to start — a missing Input, an undecided Workspace — never names
 * itself, and ends with the refusal instead: the message whole, and, when the
 * runner said which of the things it settles first was wrong, that and the
 * problems apart, so a browser can say what to do about it.
 */
export type NotebookSessionEvent =
  | RunEvent
  | { readonly type: "run-ended"; readonly record: RunRecord }
  | { readonly type: "run-refused"; readonly error: string; readonly refusal?: Refusal }
  /** The Notebook itself changed — saved from a browser, or found changed on disk — and this is it now. */
  | { readonly type: "notebook-changed"; readonly session: NotebookSessionState };

/**
 * An event as a listener hears it: numbered in the order the Notebook Session
 * emitted it, from one, with no gaps. The number is what a browser that went
 * away comes back with, to be told everything since.
 */
export type NumberedEvent = NotebookSessionEvent & { readonly sequence: number };

/**
 * What a browser is first told when it has no way to catch up: the Notebook
 * Session as it stands now, to be drawn whole. Its `sequence` is where the
 * events pick up from.
 */
export interface Snapshot {
  readonly type: "notebook-session";
  readonly session: NotebookSessionState;
}

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
  /**
   * Hears every event from now on, and first whatever it has to catch up on:
   * given `since` — the number of the last event the listener heard — every
   * event after it, in order, so that a browser coming back is told what
   * happened while it was away exactly as it would have heard it; given none,
   * or a number that names no place in this session's events, the state as it
   * stands, to be drawn whole. Returns the way to stop hearing.
   */
  subscribe(listener: (event: NumberedEvent | Snapshot) => void, since?: number): () => void;
  /**
   * The file at `file` under the directory of this Notebook's Run `run` — an
   * Artifact as a record names one, or the record itself — or nothing when the
   * pair names no file there, a climb out of the Run's directory included.
   */
  runFile(run: string, file: string): Promise<string | undefined>;
  /**
   * The Notebook and the results of one of its Runs — `run`, or the latest to
   * have finished — as one document to be handed to someone who will never
   * run it; see `export/html.ts`. Read off the disk, as a Run's files are,
   * so a Run under way is not in it until it has written its record.
   */
  export(run?: string): Promise<Exported>;
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
  /** Where the session writes what happens to it, for a server after this one. */
  readonly journal: Journal;
  /**
   * What a session before this one journaled, for this one to stand where it
   * stood: absent for a session being made rather than recovered.
   */
  readonly recovered?: FoundJournal;
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

/** Whether a journal line is an event, as the session wrote it. */
const isEvent = (line: JournalLine): line is JournalLine & NumberedEvent =>
  typeof line.sequence === "number" && typeof line.type === "string";

/** A Run that has named itself and not yet ended: what it said of itself, and when. */
interface InProgress {
  readonly run: string;
  readonly startedAt: string;
  readonly environment: RunEnvironment;
  readonly agentSession?: string;
}

/**
 * Why a Cell the server died under did not finish. Interrupted rather than
 * errored, since nothing about the Cell wants putting right; what stopped it
 * was the process going out from under it.
 */
const LOST = "The server stopped while this cell was running";

async function createNotebookSession(setup: NotebookSessionSetup): Promise<NotebookSession> {
  const { id, path, notebook, agent, journal } = setup;
  const listeners = new Set<(event: NumberedEvent | Snapshot) => void>();
  /** Every event emitted so far, in order: what a browser coming back is told. */
  const events: NumberedEvent[] = [];
  /** The number of the last event emitted. */
  let sequence = 0;

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
  /** What the Cells in flight have said and done so far, and since when. */
  const speaking = new Map<
    string,
    { text: string; readonly calls: ToolCall[]; readonly startedAt: string }
  >();
  /** The Run before this one, for the next to carry on from. */
  let last: RunRecord | undefined;
  /**
   * The Run in progress once it has named itself: what a Cell that starts is
   * running in, and what the Run said of itself as it started — enough to
   * write its record should the Run never get to.
   */
  let inProgress: InProgress | undefined;
  /** The Cells the Run in progress has finished with, in the order they ended. */
  let ended: CellRecord[] = [];
  /** The Run in progress: the way to interrupt it, and when it is over. */
  let current: { readonly controller: AbortController; readonly over: Promise<void> } | undefined;

  const dispatch = (numbered: NumberedEvent) => {
    events.push(numbered);
    journal.append(numbered);
    for (const listener of listeners) {
      // A listener's failure is its own: the events are emitted from inside the
      // Run, and a socket that could not be written to must not stop a Cell.
      try {
        listener(numbered);
      } catch (cause) {
        process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
      }
    }
  };

  /**
   * Numbers an event and sends it on. Given a function, the event is made
   * after the number is taken, for one that carries the state: the state then
   * stands at the event itself, and a browser that adopts it has heard it.
   */
  const emit = (event: NotebookSessionEvent | (() => NotebookSessionEvent)) => {
    sequence += 1;
    dispatch({ sequence, ...(typeof event === "function" ? event() : event) });
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
        ...(inProgress !== undefined ? { run: inProgress.run } : {}),
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

  /**
   * Takes in what an event says happened, whether it is happening now or is
   * being heard over from the journal: the one account of a Run, kept the same
   * way both times, is what makes a recovered session stand where it stood.
   * `at` is when it happened, which is now unless the journal says otherwise.
   */
  const absorb = (event: NotebookSessionEvent, at = new Date().toISOString()) => {
    switch (event.type) {
      case "run-started": {
        const { run, environment, agentSession } = event;
        inProgress = {
          run,
          startedAt: at,
          environment,
          ...(agentSession !== undefined ? { agentSession } : {}),
        };
        ended = [];
        break;
      }
      case "cell-started":
        speaking.set(event.cell, { text: "", calls: [], startedAt: at });
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
        ended.push(event.record);
        // The Run named itself before any Cell started, so a Cell that ended has
        // a Run to be recorded against; the empty name is never reached.
        results.set(event.record.id, { record: event.record, run: inProgress?.run ?? "" });
        break;
      case "run-ended":
        last = event.record;
        stale = new Set(event.record.stale);
        speaking.clear();
        inProgress = undefined;
        break;
      case "run-refused":
        speaking.clear();
        inProgress = undefined;
        break;
      case "notebook-changed":
        // The Notebook is read from its file, here and on recovery; the event
        // carries what it was for whoever was watching, not for the session.
        break;
    }
  };

  const observe = (event: NotebookSessionEvent) => {
    absorb(event);
    emit(event);
  };

  const state = (): NotebookSessionState => ({
    id,
    notebook,
    title: titleOf(parsed, path),
    revision,
    ...(parsed.frontmatter !== undefined ? { frontmatter: parsed.frontmatter.text } : {}),
    inputs: parsed.metadata.inputs ?? [],
    segments: parsed.segments.map((segment) =>
      isCellSegment(segment)
        ? { kind: "cell", id: segment.cell.id }
        : { kind: "prose", text: segment.text },
    ),
    running: current !== undefined,
    ...(inProgress !== undefined ? { run: inProgress.run } : {}),
    sequence,
    cells: cellsOf(parsed).map(viewOf),
  });

  /** Makes `bytes` the Notebook the session holds, and tells whoever is watching. */
  const adopt = (bytes: string, made: Notebook) => {
    source = bytes;
    parsed = made;
    revision = revisionOf(bytes);
    emit(() => ({ type: "notebook-changed", session: state() }));
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

  const interrupt = (): Promise<void> => {
    if (current === undefined) return Promise.resolve();
    current.controller.abort();
    return current.over;
  };

  /**
   * Ends a Run the server before this one died in the middle of, as far as it
   * got: each Cell still in flight is recorded as Interrupted — as one stopped
   * from the browser is, with nothing of the half-reply kept (ADR-0017) — and
   * the Run is concluded as the runner would have concluded it, so that the
   * next Run carries on from it, from the Anchors of the Cells that did end,
   * rather than from the Run before as if these had never run. What the Cells
   * in flight had spent is not known and is recorded as nothing, which is the
   * one figure here that is not what happened. A Run whose record the runner
   * did write — the process died between writing it and journaling its end —
   * is concluded with that record, not a second one written over it.
   */
  const settle = async (lost: InProgress): Promise<void> => {
    const written = await readRunRecord(path, lost.run);
    if (written !== undefined) {
      observe({ type: "run-ended", record: written });
      return;
    }

    const endedAt = new Date().toISOString();
    const declared = new Map(cellsOf(parsed).map((cell) => [cell.id, cell]));
    for (const [cellId, said] of speaking) {
      // A Cell the Notebook no longer declares — removed while no server ran —
      // has no type to be recorded as, and no place to be shown in.
      const cell = declared.get(cellId);
      if (cell === undefined) continue;
      const interrupted = {
        id: cellId,
        status: "interrupted" as const,
        usage: noUsage,
        // Whatever it left: half of what it was making is still the only
        // account there is of how far it got, as after any failure.
        artifacts: await listArtifacts(path, lost.run, cellId),
        startedAt: said.startedAt,
        endedAt,
        error: LOST,
      };
      const record: CellRecord =
        cell.type === "prompt"
          ? { ...interrupted, type: "prompt", ...emptyResult }
          : { ...interrupted, type: "bash", stdout: "", stderr: "", exitCode: null };
      observe({ type: "cell-ended", record });
    }

    const record = await concludeRun({
      id: lost.run,
      notebook: path,
      ...(last !== undefined ? { continues: last } : {}),
      environment: lost.environment,
      ...(lost.agentSession !== undefined ? { agentSession: lost.agentSession } : {}),
      startedAt: lost.startedAt,
      cells: ended,
      allCells: cellsOf(parsed),
    });
    observe({ type: "run-ended", record });
  };

  // Heard over, to stand where the session before stood. Nothing is emitted
  // or journaled: these events happened, and are on disk already.
  let held = setup.recovered?.header.revision;
  for (const line of setup.recovered?.lines ?? []) {
    if (!isEvent(line)) continue;
    const { at, ...event } = line;
    events.push(event);
    sequence = event.sequence;
    absorb(event, at);
    if (event.type === "notebook-changed") held = event.session.revision;
  }
  // A Run the journal leaves in progress is one the server died in: the
  // process that ran it is gone, so it ends here, and is said to.
  if (inProgress !== undefined) await settle(inProgress);
  // The file as it is now is what the session holds, and the browsers that
  // were watching hold what it was: a Notebook edited while no server ran is
  // as much a change as one saved from another browser, and is said to be.
  if (held !== undefined && held !== revision) adopt(source, parsed);

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

      const over = runNotebook(path, {
        agent,
        observe,
        signal: controller.signal,
        ...(request.cells !== undefined ? { cells: request.cells } : {}),
        ...(request.inputs !== undefined ? { inputs: request.inputs } : {}),
        ...(last !== undefined ? { continues: last } : {}),
      }).then(
        (record) => {
          // Settled before the end is announced, so a listener that asks for
          // the state on hearing it finds the session already at rest.
          current = undefined;
          observe({ type: "run-ended", record });
        },
        (cause: unknown) => {
          current = undefined;
          observe({
            type: "run-refused",
            error: cause instanceof Error ? cause.message : String(cause),
            ...(cause instanceof RunRefusal
              ? { refusal: { kind: cause.kind, problems: cause.problems } }
              : {}),
          });
        },
      );
      current = { controller, over };
      // The Run names itself, with its id and the Cells in their order, once it
      // is cleared to run; until then the state alone says the session is running.

      return true;
    },

    interrupt,

    subscribe(listener, since) {
      // Caught up and subscribed in one breath, with nothing emitted between:
      // an event that arrived meanwhile would be neither replayed nor heard.
      if (since !== undefined && Number.isInteger(since) && since >= 0 && since <= sequence) {
        for (const event of events.slice(since)) listener(event);
      } else listener({ type: "notebook-session", session: state() });
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    runFile: (run, file) => runFile(path, run, file),

    export: (run) =>
      exportNotebook({
        notebook: path,
        ...(run !== undefined ? { run } : {}),
        ...thisMachine(),
      }),
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
   * Interrupts every Run in progress and resolves once each has stopped,
   * written its record and journaled its end: nothing outlives the server it
   * runs in, and nothing is left half-written for the next one to find.
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
 *
 * Those a server before this one left journaled are opened again first, under
 * the ids it gave out, so that a browser holding one finds its session where
 * it left it. One whose Notebook cannot be opened now — gone, or broken in an
 * editor while no server ran — is kept to be opened when it can be, rather
 * than lost, or made twice.
 */
export async function createNotebookSessions(
  options: NotebookSessionsOptions,
): Promise<NotebookSessions> {
  const { directory, agent } = options;
  const byId = new Map<string, NotebookSession>();
  const byPath = new Map<string, NotebookSession>();
  /** The journaled sessions not yet open, by the Notebook's resolved path. */
  const journaled = new Map<string, FoundJournal>();
  /** The Notebooks being opened right now, by resolved path. */
  const opening = new Map<string, Promise<Opened>>();

  const openFresh = async (path: string): Promise<Opened> => {
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

    const before = journaled.get(path);
    const id = before?.id ?? randomUUID();
    const journal = openJournal(directory, id);
    if (before === undefined) {
      const header: JournalHeader = {
        type: "opened",
        notebook: relativePath,
        revision: revisionOf(source),
      };
      journal.append(header);
    }
    const session = await createNotebookSession({
      id,
      path,
      notebook: relativePath,
      source,
      parsed: found.notebook,
      agent,
      journal,
      ...(before !== undefined ? { recovered: before } : {}),
    });
    // Taken up only now: a recovery that failed halfway — the record of a Run
    // left unfinished could not be written — leaves the Journal to be tried
    // again, rather than a second one begun beside it.
    journaled.delete(path);
    byId.set(session.id, session);
    byPath.set(path, session);
    return { kind: "opened", session, created: before === undefined };
  };

  /**
   * One opening per Notebook at a time: two requests to open the same one
   * would otherwise each read it, and each make a session — and a Journal —
   * for it, where there is to be one.
   */
  const openAt = (path: string): Promise<Opened> => {
    const existing = byPath.get(path);
    if (existing !== undefined) {
      return Promise.resolve({ kind: "opened", session: existing, created: false });
    }
    let inFlight = opening.get(path);
    if (inFlight === undefined) {
      inFlight = openFresh(path).finally(() => opening.delete(path));
      opening.set(path, inFlight);
    }
    return inFlight;
  };

  for (const journal of await readJournals(directory)) {
    const path = fileWithin(directory, journal.header.notebook);
    if (path === undefined) continue;
    // Two Journals of one Notebook is two servers having served this directory
    // at once, which nothing yet prevents; the later begun stands, and the
    // other is left where it is and said so.
    const other = journaled.get(path);
    if (other !== undefined) {
      process.stderr.write(
        `Two journals of ${journal.header.notebook}, ${other.id} and ${journal.id}; only the latter is recovered.\n`,
      );
    }
    journaled.set(path, journal);
  }
  for (const path of [...journaled.keys()]) {
    const opened = await openAt(path);
    if (opened.kind !== "opened") {
      process.stderr.write(
        `Not recovered until it can be opened: ${pathWithin(directory, path)}${opened.kind === "refused" ? `\n${opened.problem}` : ""}\n`,
      );
    }
  }

  return {
    async open(notebook) {
      const path = fileWithin(directory, notebook);
      if (path === undefined) return { kind: "absent" };
      return openAt(path);
    },

    get: (id) => byId.get(id),

    async close() {
      await Promise.all([...byId.values()].map((session) => session.interrupt()));
    },
  };
}
