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

import {
  type AgentFactory,
  type ContextUsage,
  type ToolCall,
  emptyResult,
  noUsage,
} from "../agent/agent.js";
import { thisMachine } from "../export/credentials.js";
import { type ExportFormat, type Exported, exportNotebook } from "../export/html.js";
import {
  type EditResult,
  type NotebookEdit,
  applyEdit,
  notebookWithMode,
  notebookWithModel,
} from "../notebook/edit.js";
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
import { type CellAccess, cellAccess } from "../run/access.js";
import type { CellRecord, CellStatus, RunEnvironment, RunRecord } from "../run/record.js";
import {
  type CellRounds,
  type RoundsResult,
  attachSystemPrompt,
  readCellRounds,
  roundFromRecord,
} from "../run/rounds.js";
import {
  type RefusalKind,
  type RunEvent,
  RunRefusal,
  concludeRun,
  runNotebook,
} from "../run/runner.js";
import { serviceAlive, stopService } from "../run/shell.js";
import { latestRunId, listArtifacts, readRunRecord, runFile } from "../run/store.js";
import {
  type FoundJournal,
  type Journal,
  type JournalHeader,
  type JournalLine,
  openJournal,
  readJournals,
} from "./journal.js";
import {
  type Assigned,
  type NotebookEntry,
  type Renamed,
  type RenamedFile,
  assignNotebookMode,
  assignNotebookModel,
  fileWithin,
  pathWithin,
  renameFile,
  renameNotebook,
} from "./notebooks.js";
import {
  type TextReview,
  baselineUnder,
  isTextFile,
  readTextFile,
  readTextFiles,
  revertText,
  reviewsBetween,
  textPath,
  writeTextFile,
} from "./text-files.js";
import { applyDecision } from "./diff.js";

/**
 * Where a Cell stands in its Notebook Session: not yet run, running now, what
 * its last Run recorded, or Stale because a Cell it uses has run again since.
 */
export type CellState = "idle" | "running" | CellStatus | "stale";

/**
 * One piece of a Cell's turn, as it happened: a thought, something said, or a
 * tool invoked.
 *
 * Kept in the order the turn produced them, because that order is the turn —
 * a thought, then the tool it led to, then the reply that tool made possible.
 * The Run Record's `thinking`, `text` and `toolCalls` are the same pieces
 * grouped by kind, which is what a record is for; this is what drawing one
 * needs. A Bash Cell's output is a single `text` part.
 */
export type CellPart =
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; input: unknown; result?: string; isError?: boolean }
  | { kind: "text"; text: string };

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
  /** How a Prompt Cell takes its turn, when it is not the agent default. */
  readonly approach?: "plan" | "ask";
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
  /**
   * What a Prompt Cell's model thought, when it recorded any. Absent for a
   * Bash Cell, and when the model recorded none.
   */
  readonly thinking?: string;
  /** The tools the agent has invoked so far, or invoked, in the order it did. */
  readonly toolCalls: readonly ToolCall[];
  /**
   * The same turn as `thinking`, `text` and `toolCalls` hold, in the order it
   * happened, for a browser drawing the Cell as the Rounds dialog reads it.
   * Absent for a Cell that has produced nothing, and for a result read from a
   * Run Record that kept no order — a browser then groups the three fields.
   */
  readonly parts?: readonly CellPart[];
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
  /**
   * How full the model's window was when this Prompt Cell last ended. Absent
   * for a Bash Cell, and for a Prompt Cell that has not run through pi.
   */
  readonly context?: ContextUsage;
  /**
   * A Bash Cell whose command is still running, or that left a service running
   * after the shell exited. The way to end it is to stop that Cell.
   */
  readonly service?: boolean;
  /** When this Cell began running, when it has run or is running. */
  readonly startedAt?: string;
  /** When this Cell ended running, when it has finished running. */
  readonly endedAt?: string;
  /** How long the Cell took to run in milliseconds, when it has run. */
  readonly duration?: number;
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
  /** The model the Notebook names, when it names one. A Cell may still name its own. */
  readonly model?: string;
  /** The mode the Notebook names, when it names one. A run cannot choose another. */
  readonly mode?: string;
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
  /**
   * Text files a Run has created or changed and nobody has accepted or
   * rejected yet. A created file has no `before`. Absent when there are none,
   * so a session that has never reviewed a file says nothing about it.
   */
  readonly reviews?: readonly TextReview[];
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
  | { readonly type: "notebook-changed"; readonly session: NotebookSessionState }
  /**
   * The text files still waiting to be accepted or rejected: the whole list,
   * so whoever is listening can draw it from this event alone. Empty once the
   * last of them has been decided.
   */
  | { readonly type: "text-changed"; readonly reviews: readonly TextReview[] };

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
   * Stops a Cell's turn or command, or the service that command left running.
   * Resolves once a turn or command that was still running has stopped.
   */
  stop(cellId: string): Promise<{ ok: true } | { ok: false; status: 404 | 422; problem: string }>;
  /**
   * The file at `from` is now at `to`. A review of it, and the bytes a later
   * comparison holds for it, follow the file. A name that is no longer a text
   * file drops the review: there is no text left to accept or reject.
   */
  retargetText(from: string, to: string): Promise<void>;
  /**
   * The file at `name` is gone. A review of it is dropped, and so are the
   * bytes a later comparison held for it: there is nothing left to accept
   * or reject.
   */
  forgetText(name: string): Promise<void>;
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
   * The model rounds of a Prompt Cell that has run: the question, then each
   * provider reply and the tool results between them. Read from the Agent
   * Session the Run left, at the Anchor the Cell ended on.
   */
  rounds(cellId: string): Promise<RoundsResult>;
  /**
   * The Notebook and the results of one of its Runs — `run`, or the latest to
   * have finished — as one document to be handed to someone who will never
   * run it; see `export/html.ts`. Read off the disk, as a Run's files are,
   * so a Run under way is not in it until it has written its record.
   */
  export(run?: string, format?: ExportFormat): Promise<Exported>;
  /**
   * Writes the unfinished Run's end, when the journal had refused a line, and
   * reports the problem when it still cannot. Reads do not call this.
   */
  ensureJournal(): Promise<string | undefined>;
  /**
   * The Notebook's file has been renamed to `nextPath`, and this session is
   * that file still: later saves and Runs use the new path, and the Journal
   * records the name so a server that starts later finds it there. False when
   * the rename could not be written.
   */
  relocate(nextPath: string, nextNotebook: string): boolean;
  /**
   * Writes `model` into the Notebook, or removes the field when `model` is
   * absent, and tells whoever is watching. A model the Notebook already names
   * changes nothing. The file on disk is taken up first when it has moved on,
   * so the model is set on the Notebook as it is, not on a copy the session
   * has fallen behind.
   */
  setModel(model: string | undefined): Promise<Saved>;
  /**
   * Writes `mode` into the Notebook, or removes the field when `mode` is
   * absent, and tells whoever is watching. A mode the Notebook already names
   * changes nothing. The file on disk is taken up first when it has moved on,
   * so the mode is set on the Notebook as it is, not on a copy the session
   * has fallen behind.
   */
  setMode(mode: string | undefined): Promise<Saved>;
  /**
   * Keeps a text file a Run created or changed, or puts it back. Accepting
   * leaves the bytes on disk and drops the review. Rejecting writes the
   * previous bytes, or removes a file that was new. When lines are provided,
   * only those lines in the diff are accepted or rejected. A Notebook that does
   * not parse after it is accepted is left under review.
   */
  decideText(
    name: string,
    decision: "accept" | "reject",
    lines?: readonly number[],
  ): Promise<TextDecided>;
  /**
   * Reads the Notebook from disk again after a text save wrote it. A file
   * that no longer parses is left as the session held it; the bytes stay on
   * disk for the text subtab.
   */
  reread(): Promise<void>;
}

/** How deciding a text file went. */
export type TextDecided =
  | { readonly kind: "decided" }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "refused"; readonly problem: string };

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
  /** The served directory, which is where text files are read and reviewed. */
  readonly directory: string;
  /** Where this session's cells may operate. The server's choice, not the notebook's. */
  readonly access: CellAccess;
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

/** Says a review failed without stopping the Run that noticed it. */
const noteFailure = (cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
};

/**
 * Adds a fragment to the last piece of the turn's kind, or begins a new one.
 * Pi streams a thought or a reply a token at a time; a kind that comes back
 * after a tool call was invoked in between is a new piece, and where it sits
 * in the order is the point.
 */
function addToTurn(parts: CellPart[], kind: "text" | "thinking", fragment: string): void {
  const last = parts.at(-1);
  // `last.kind !== "tool"` is what leaves a text piece with a text field to
  // add to; a tool call between two fragments of the same kind makes the
  // second a piece of its own, which is the order the turn happened in.
  if (last !== undefined && last.kind !== "tool" && last.kind === kind) {
    last.text += fragment;
    return;
  }
  parts.push(
    kind === "text" ? { kind: "text", text: fragment } : { kind: "thinking", text: fragment },
  );
}

/** What a turn's text pieces say in total, in order, with nothing between. */
function textOfParts(parts: readonly CellPart[]): string {
  return parts.map((part) => (part.kind === "text" ? part.text : "")).join("");
}

const sameReviewList = (a: readonly TextReview[], b: readonly TextReview[]): boolean =>
  a.length === b.length &&
  a.every((review, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      review.path === other.path &&
      review.kind === other.kind &&
      review.before === other.before
    );
  });

async function createNotebookSession(setup: NotebookSessionSetup): Promise<NotebookSession> {
  const { id, agent, journal, directory, access } = setup;
  /** Where the file is now. A rename moves both, and everything after it reads these. */
  let path = setup.path;
  let notebook = setup.notebook;
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
    {
      text: string;
      thinking: string;
      readonly calls: ToolCall[];
      /** The same, in the order it happened: what a browser draws the Cell from. */
      readonly parts: CellPart[];
      readonly startedAt: string;
    }
  >();
  /**
   * Each Cell's last turn in order, by Cell id, kept past the end of the turn
   * that produced it: the Run Record groups the same pieces by kind, and the
   * order is only here. Cleared when the Cell starts again, which is when the
   * order it holds stops being the order of anything.
   */
  const turns = new Map<string, CellPart[]>();
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
  /** While a Cell runs, the way to stop that Cell alone. */
  const cellStops = new Map<string, () => void>();
  /**
   * Text files as they were when the open reviews were taken. A review still
   * waiting keeps its original bytes here, so the next look does not treat
   * the unaccepted file as the starting point. Absent until a Run has looked.
   */
  let baseline: Map<string, string> | undefined;
  /** Text files still waiting to be accepted or rejected, by path. */
  let reviews = new Map<string, TextReview>();
  /**
   * Reviews are read and written one at a time: a Run publishing what a Cell
   * changed, and a decision to accept or reject, both rewrite the same map.
   */
  let reviewLock: Promise<unknown> = Promise.resolve();
  const withReviews = <T>(work: () => Promise<T>): Promise<T> => {
    const run = reviewLock.then(work, work);
    reviewLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const listedReviews = (): TextReview[] =>
    [...reviews.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  /** Notices text files the Run has created or changed, and says so when the list moved. */
  const publishReviews = async (): Promise<void> => {
    if (baseline === undefined) return;
    const next = reviewsBetween(baseline, await readTextFiles(directory));
    if (sameReviewList(listedReviews(), next)) return;
    observe({ type: "text-changed", reviews: next });
  };

  const takeBaseline = async (): Promise<void> => {
    baseline = baselineUnder(await readTextFiles(directory), listedReviews());
  };

  /**
   * Set when a line could not be written. This session then refuses every
   * command that would append, until one of them can write the end of a Run
   * left unfinished and then do its own work. Reads do not try the write.
   */
  let journalBlocked = false;

  const noteJournalFailure = (cause: unknown) => {
    journalBlocked = true;
    process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
    // Stop the Run producing events that cannot be written. The end is
    // journaled later, once a line can be, as a recovery would write it.
    if (current !== undefined) current.controller.abort();
  };

  const tell = (numbered: NumberedEvent) => {
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
   * Writes one numbered line and keeps it. Nothing is told yet: the caller
   * applies the event to the session first, so a listener that reads the
   * state finds the event already there. A failed write keeps neither the
   * event nor its number.
   */
  const commit = (event: NotebookSessionEvent): NumberedEvent | undefined => {
    const numbered = { sequence: sequence + 1, ...event };
    try {
      journal.append(numbered);
    } catch (cause) {
      noteJournalFailure(cause);
      return undefined;
    }
    journalBlocked = false;
    sequence += 1;
    events.push(numbered);
    return numbered;
  };

  /**
   * Numbers an event and sends it on, once the line is on disk. Given a
   * function, the event is made before the write is tried, for one that
   * carries the state: the state then stands at the event itself.
   */
  const emit = (event: NotebookSessionEvent | (() => NotebookSessionEvent)): boolean => {
    // The number is taken before a function builds the event, so a snapshot of
    // the session carries the number the line will have. A failed write gives
    // the number back.
    const previous = sequence;
    sequence += 1;
    const body = typeof event === "function" ? event() : event;
    const numbered = { sequence, ...body };
    try {
      journal.append(numbered);
    } catch (cause) {
      sequence = previous;
      noteJournalFailure(cause);
      return false;
    }
    journalBlocked = false;
    events.push(numbered);
    tell(numbered);
    return true;
  };

  const viewOf = (cell: Cell): CellView => {
    const declared = {
      id: cell.id,
      type: cell.type,
      body: cell.body,
      uses: cell.uses,
      isolated: cell.isolated,
      ...(cell.approach !== undefined ? { approach: cell.approach } : {}),
      ...(cell.model !== undefined ? { model: cell.model } : {}),
      ...(cell.timeout !== undefined ? { timeout: cell.timeout } : {}),
    };

    const inFlight = speaking.get(cell.id);
    if (inFlight !== undefined) {
      return {
        ...declared,
        status: "running",
        text: inFlight.text,
        ...(inFlight.thinking !== "" ? { thinking: inFlight.thinking } : {}),
        toolCalls: inFlight.calls,
        ...(inFlight.parts.length > 0 ? { parts: inFlight.parts } : {}),
        artifacts: [],
        ...(inProgress !== undefined ? { run: inProgress.run } : {}),
        ...(cell.type === "bash" ? { service: true } : {}),
        ...(inFlight.startedAt !== undefined ? { startedAt: inFlight.startedAt } : {}),
      };
    }

    const found = results.get(cell.id);
    if (found === undefined) {
      return { ...declared, status: "idle", text: "", toolCalls: [], artifacts: [] };
    }

    const { record, run } = found;
    // The order the turn happened in, which the record does not keep: a turn
    // heard in this session has it, and one read back from a record does not.
    // A Bash Cell's output is one piece and needs no order of its own.
    const parts =
      record.type === "bash"
        ? record.stdout === ""
          ? undefined
          : [{ kind: "text" as const, text: record.stdout }]
        : turns.get(cell.id);
    const duration =
      record.startedAt && record.endedAt
        ? Math.max(0, new Date(record.endedAt).getTime() - new Date(record.startedAt).getTime())
        : undefined;
    return {
      ...declared,
      status: stale.has(cell.id) ? "stale" : record.status,
      text: record.type === "prompt" ? record.text : record.stdout,
      ...(record.type === "prompt" && record.thinking !== undefined && record.thinking !== ""
        ? { thinking: record.thinking }
        : {}),
      toolCalls: record.type === "prompt" ? record.toolCalls : [],
      ...(parts !== undefined && parts.length > 0 ? { parts } : {}),
      artifacts: record.artifacts,
      run,
      ...(record.type === "prompt" && record.context !== undefined
        ? { context: record.context }
        : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.type === "bash" &&
      record.servicePids !== undefined &&
      serviceAlive(record.servicePids)
        ? { service: true }
        : {}),
      ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
      ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
      ...(duration !== undefined ? { duration } : {}),
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
        // A Cell starting again begins a turn of its own: whatever order the
        // last one held is the order of nothing now.
        turns.delete(event.cell);
        speaking.set(event.cell, {
          text: "",
          thinking: "",
          calls: [],
          parts: [],
          startedAt: at,
        });
        break;
      case "cell-text": {
        const inFlight = speaking.get(event.cell);
        if (inFlight === undefined) break;
        inFlight.text += event.text;
        addToTurn(inFlight.parts, "text", event.text);
        break;
      }
      case "cell-thinking": {
        const inFlight = speaking.get(event.cell);
        if (inFlight === undefined) break;
        inFlight.thinking += event.thinking;
        addToTurn(inFlight.parts, "thinking", event.thinking);
        break;
      }
      case "cell-tool-call": {
        const inFlight = speaking.get(event.cell);
        if (inFlight === undefined) break;
        inFlight.calls.push(event.call);
        inFlight.parts.push({
          kind: "tool",
          name: event.call.name,
          input: event.call.input,
          ...(event.call.result !== undefined ? { result: event.call.result } : {}),
          ...(event.call.isError ? { isError: true } : {}),
        });
        break;
      }
      case "cell-ended": {
        const inFlight = speaking.get(event.record.id);
        speaking.delete(event.record.id);
        ended.push(event.record);
        // The Run named itself before any Cell started, so a Cell that ended has
        // a Run to be recorded against; the empty name is never reached.
        results.set(event.record.id, { record: event.record, run: inProgress?.run ?? "" });
        // Kept only when what was heard is what the record holds: a record that
        // says the turn said nothing — an interrupted one, whose half-reply is
        // not kept — must not be drawn with a reply the stream left behind.
        if (
          event.record.type === "prompt" &&
          inFlight !== undefined &&
          textOfParts(inFlight.parts) === event.record.text
        ) {
          turns.set(event.record.id, inFlight.parts);
        } else {
          turns.delete(event.record.id);
        }
        break;
      }
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
      case "text-changed":
        reviews = new Map(event.reviews.map((review) => [review.path, review]));
        break;
    }
  };

  const observe = (event: NotebookSessionEvent): boolean => {
    const numbered = commit(event);
    if (numbered === undefined) return false;
    absorb(event);
    tell(numbered);
    return true;
  };

  const state = (): NotebookSessionState => ({
    id,
    notebook,
    title: titleOf(parsed, path),
    revision,
    ...(parsed.metadata.model !== undefined ? { model: parsed.metadata.model } : {}),
    ...(parsed.metadata.mode !== undefined ? { mode: parsed.metadata.mode } : {}),
    ...(parsed.frontmatter !== undefined ? { frontmatter: parsed.frontmatter.text } : {}),
    inputs: parsed.metadata.inputs ?? [],
    segments: parsed.segments.map((segment) =>
      isCellSegment(segment)
        ? { kind: "cell", id: segment.cell.id }
        : { kind: "prose", text: segment.text },
    ),
    running: current !== undefined || (journalBlocked && inProgress !== undefined),
    ...(inProgress !== undefined ? { run: inProgress.run } : {}),
    sequence,
    cells: cellsOf(parsed).map(viewOf),
    ...(reviews.size > 0 ? { reviews: listedReviews() } : {}),
  });

  /**
   * Makes `bytes` the Notebook the session holds, and tells whoever is watching.
   * A journal that cannot take the line leaves the session holding what it held.
   */
  const adopt = (bytes: string, made: Notebook): boolean => {
    const previous = { source, parsed, revision };
    source = bytes;
    parsed = made;
    revision = revisionOf(bytes);
    if (emit(() => ({ type: "notebook-changed", session: state() }))) return true;
    source = previous.source;
    parsed = previous.parsed;
    revision = previous.revision;
    return false;
  };

  const JOURNAL_PROBLEM =
    "The journal could not be written, so this notebook is not taking changes until it can.";

  /**
   * When the journal refused a line during a Run, writes that Run's end the
   * way a server starting again would, and only then lets the command proceed.
   * With no Run unfinished, the command's own line is the try.
   */
  const recoverJournal = async (): Promise<string | undefined> => {
    if (!journalBlocked) return undefined;
    if (current !== undefined) await current.over.catch(() => undefined);
    if (inProgress === undefined) return undefined;
    const lost = inProgress;
    const written = await readRunRecord(path, lost.run);
    if (written !== undefined) {
      for (const record of written.cells) {
        if (results.has(record.id)) continue;
        if (!observe({ type: "cell-ended", record })) return JOURNAL_PROBLEM;
      }
      if (!observe({ type: "run-ended", record: written })) return JOURNAL_PROBLEM;
      return undefined;
    }
    if (!(await settle(lost))) return JOURNAL_PROBLEM;
    return undefined;
  };

  let journalGate: Promise<unknown> = Promise.resolve();
  const ensureJournal = (): Promise<string | undefined> => {
    const run = journalGate.then(recoverJournal, recoverJournal);
    journalGate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** A Run's unaccepted edit of the Notebook itself, which a save must not write over. */
  const blockedByReview = (): string | undefined =>
    reviews.has(notebook)
      ? `${notebook} was changed by a run. Accept or reject that change before saving.`
      : undefined;

  const save = async (request: SaveRequest): Promise<Saved> => {
    const journal = await ensureJournal();
    if (journal !== undefined) return { kind: "refused", problem: journal };
    const blocked = blockedByReview();
    if (blocked !== undefined) return { kind: "refused", problem: blocked };
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
      if (!adopt(onDisk, found.ok ? found.notebook : parsed)) {
        return { kind: "refused", problem: JOURNAL_PROBLEM };
      }
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

    const previous = source;
    await writeFile(path, made.source, "utf8");
    if (!adopt(made.source, made.notebook)) {
      await writeFile(path, previous, "utf8");
      return { kind: "refused", problem: JOURNAL_PROBLEM };
    }
    return { kind: "saved" };
  };

  const writeField = async (
    field: "model" | "mode",
    value: string | undefined,
    rewrite: (notebook: Notebook, value: string | undefined) => EditResult,
  ): Promise<Saved> => {
    const journal = await ensureJournal();
    if (journal !== undefined) return { kind: "refused", problem: journal };
    const blocked = blockedByReview();
    if (blocked !== undefined) return { kind: "refused", problem: blocked };
    const onDisk = await readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return undefined;
      throw cause;
    });
    if (onDisk !== undefined && onDisk !== source) {
      const found = readable(parseNotebook(onDisk), `Cannot open ${notebook}`);
      if (!found.ok) return { kind: "refused", problem: found.problem };
      if (!adopt(onDisk, found.notebook)) return { kind: "refused", problem: JOURNAL_PROBLEM };
    }
    if (parsed.metadata[field] === value) return { kind: "saved" };

    const made = readable(rewrite(parsed, value), `Cannot save ${notebook}`);
    if (!made.ok) return { kind: "refused", problem: made.problem };
    const previous = source;
    await writeFile(path, made.source, "utf8");
    if (!adopt(made.source, made.notebook)) {
      await writeFile(path, previous, "utf8");
      return { kind: "refused", problem: JOURNAL_PROBLEM };
    }
    return { kind: "saved" };
  };

  /**
   * What the Run recorded of a Prompt Cell when its Agent Session cannot be
   * read: the question, the system prompt, and the tool calls. The rounds
   * themselves stay empty; only the session holds those.
   */
  const recordedTurn = (cellId: string, cellRecord: CellRecord): CellRounds => {
    const body = cellsOf(parsed).find((cell) => cell.id === cellId)?.body ?? "";
    const text = body.replace(/\r?\n$/, "");
    const calls = cellRecord.type === "prompt" ? cellRecord.toolCalls : [];
    return attachSystemPrompt(
      {
        query: text,
        prompts: text === "" ? [] : [text],
        rounds: [],
        toolCalls: calls.map((call) => ({ name: call.name, input: call.input })),
      },
      cellRecord.type === "prompt" ? cellRecord.systemPrompt : undefined,
    );
  };

  const interrupt = (): Promise<void> => {
    if (current === undefined) return Promise.resolve();
    current.controller.abort();
    return current.over;
  };

  /**
   * Stops one Cell: the turn or command, when it is still running, and any
   * service that command left behind. A service stopped after the Cell has
   * finished does not change what the Cell recorded; the processes are simply
   * gone, and the Cell no longer offers to stop them.
   */
  const stop = async (
    cellId: string,
  ): Promise<{ ok: true } | { ok: false; status: 404 | 422; problem: string }> => {
    const journal = await ensureJournal();
    if (journal !== undefined) return { ok: false, status: 422, problem: journal };
    const cell = cellsOf(parsed).find((item) => item.id === cellId);
    if (cell === undefined) {
      return { ok: false, status: 404, problem: `No cell named "${cellId}" in this notebook.` };
    }

    const halt = cellStops.get(cellId);
    if (halt !== undefined) {
      halt();
      if (cell.type === "bash") {
        const found = results.get(cellId);
        if (found?.record.type === "bash" && found.record.servicePids !== undefined) {
          const pids = found.record.servicePids;
          stopService(pids);
          const started = Date.now();
          while (serviceAlive(pids) && Date.now() - started < 1000) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
      }
      if (current !== undefined) await current.over;
      return { ok: true };
    }

    if (cell.type !== "bash") {
      return { ok: false, status: 422, problem: "A prompt cell has no service to stop." };
    }

    const found = results.get(cellId);
    if (found?.record.type === "bash" && found.record.servicePids !== undefined) {
      const pids = found.record.servicePids;
      stopService(pids);
      const started = Date.now();
      while (serviceAlive(pids) && Date.now() - started < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (!emit(() => ({ type: "notebook-changed", session: state() }))) {
      return { ok: false, status: 422, problem: JOURNAL_PROBLEM };
    }
    return { ok: true };
  };

  const retargetText = (from: string, to: string): Promise<void> =>
    withReviews(async () => {
      if ((await ensureJournal()) !== undefined) return;
      const review = reviews.get(from);
      if (review !== undefined) {
        reviews.delete(from);
        if (isTextFile(to)) reviews.set(to, { ...review, path: to });
      }
      if (baseline !== undefined && baseline.has(from)) {
        const bytes = baseline.get(from);
        baseline.delete(from);
        if (bytes !== undefined && isTextFile(to)) baseline.set(to, bytes);
      }
      if (review !== undefined) observe({ type: "text-changed", reviews: listedReviews() });
    });

  const forgetText = (name: string): Promise<void> =>
    withReviews(async () => {
      if ((await ensureJournal()) !== undefined) return;
      const review = reviews.get(name);
      baseline?.delete(name);
      if (review === undefined) return;
      reviews.delete(name);
      observe({ type: "text-changed", reviews: listedReviews() });
    });

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
  const settle = async (lost: InProgress): Promise<boolean> => {
    const written = await readRunRecord(path, lost.run);
    if (written !== undefined) {
      return observe({ type: "run-ended", record: written });
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
      if (!observe({ type: "cell-ended", record })) return false;
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
    return observe({ type: "run-ended", record });
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
  if (inProgress !== undefined && !(await settle(inProgress))) {
    throw new Error(JOURNAL_PROBLEM);
  }
  // The file as it is now is what the session holds, and the browsers that
  // were watching hold what it was: a Notebook edited while no server ran is
  // as much a change as one saved from another browser, and is said to be.
  if (held !== undefined && held !== revision && !adopt(source, parsed)) {
    throw new Error(JOURNAL_PROBLEM);
  }

  // When opening fresh with no journal replay (e.g. newly promoted from a chat
  // or run from the CLI), restore results from the latest recorded run.
  if (last === undefined && results.size === 0) {
    const latest = await latestRunId(path);
    if (latest !== undefined) {
      const record = await readRunRecord(path, latest);
      if (record !== undefined) {
        last = record;
        stale = new Set(record.stale);
        for (const cell of record.cells) {
          results.set(cell.id, { record: cell, run: record.id });
          if (cell.type === "prompt") {
            const parts: CellPart[] = [];
            if (record.agentSession !== undefined) {
              const cellRounds = readCellRounds(
                record.agentSession,
                record.anchors,
                cell.id,
                cellsOf(parsed),
              );
              if (cellRounds.ok) {
                for (const round of cellRounds.value.rounds) {
                  if (round.thinking !== undefined && round.thinking !== "") {
                    parts.push({ kind: "thinking", text: round.thinking });
                  }
                  for (const call of round.toolCalls) {
                    parts.push({
                      kind: "tool",
                      name: call.name,
                      input: call.input,
                      ...(call.result !== undefined ? { result: call.result } : {}),
                      ...(call.isError ? { isError: true } : {}),
                    });
                  }
                  if (round.text !== "") {
                    parts.push({ kind: "text", text: round.text });
                  }
                }
              }
            }
            if (parts.length === 0) {
              if (cell.thinking !== undefined && cell.thinking !== "") {
                parts.push({ kind: "thinking", text: cell.thinking });
              }
              for (const call of cell.toolCalls) {
                parts.push({
                  kind: "tool",
                  name: call.name,
                  input: call.input,
                  ...(call.result !== undefined ? { result: call.result } : {}),
                  ...(call.isError ? { isError: true } : {}),
                });
              }
              if (cell.text !== "") {
                parts.push({ kind: "text", text: cell.text });
              }
            }
            if (parts.length > 0) {
              turns.set(cell.id, parts);
            }
          }
        }
      }
    }
  }

  /**
   * Accepts or rejects one open review. When lines are specified, only those
   * lines in the diff are accepted or rejected; the review remains open with
   * updated before text until all changes have been decided. The Notebook file,
   * when it is the file decided, is taken up by the session once the bytes are
   * the ones the decision left — except an acceptance that would leave a Notebook
   * the session cannot open, which stays under review and changes nothing.
   */
  const decide = async (
    name: string,
    decision: "accept" | "reject",
    lines?: readonly number[],
  ): Promise<TextDecided> => {
    const journal = await ensureJournal();
    if (journal !== undefined) return { kind: "refused", problem: journal };
    const named = textPath(directory, name);
    if (named === undefined) return { kind: "invalid" };
    const review = reviews.get(named);
    if (review === undefined) return { kind: "absent" };

    if (lines !== undefined) {
      const read = await readTextFile(directory, named);
      if (read.kind !== "text") return { kind: "invalid" };
      const diskText = read.text;
      const beforeText = review.before ?? "";

      let applied;
      try {
        applied = applyDecision(beforeText, diskText, decision, lines);
      } catch {
        return { kind: "invalid" };
      }

      let adopting: { readonly bytes: string; readonly notebook: Notebook } | undefined;
      if (named === notebook && applied.newAfter !== source) {
        const found = readable(parseNotebook(applied.newAfter), `Cannot open ${notebook}`);
        if (!found.ok) return { kind: "refused", problem: found.problem };
        adopting = { bytes: applied.newAfter, notebook: found.notebook };
      }

      if (applied.newAfter !== diskText) {
        const written = await writeTextFile(directory, named, applied.newAfter);
        if (written.kind !== "saved") return { kind: "invalid" };
      }

      if (applied.resolved) {
        reviews.delete(named);
        if (baseline !== undefined) {
          if (decision === "reject" && review.kind === "created" && applied.newAfter === "") {
            baseline.delete(named);
            await revertText(directory, review);
          } else {
            baseline.set(named, applied.newAfter);
          }
        }
      } else {
        reviews.set(named, { path: named, kind: "modified", before: applied.newBefore });
        if (baseline !== undefined) {
          baseline.set(named, applied.newBefore);
        }
      }

      if (adopting !== undefined && !adopt(adopting.bytes, adopting.notebook)) {
        return { kind: "refused", problem: JOURNAL_PROBLEM };
      }
      if (!observe({ type: "text-changed", reviews: listedReviews() })) {
        return { kind: "refused", problem: JOURNAL_PROBLEM };
      }
      return { kind: "decided" };
    }

    let adopting: { readonly bytes: string; readonly notebook: Notebook } | undefined;
    if (decision === "accept" && named === notebook) {
      const read = await readTextFile(directory, named);
      if (read.kind === "text" && read.text !== source) {
        const found = readable(parseNotebook(read.text), `Cannot open ${notebook}`);
        if (!found.ok) return { kind: "refused", problem: found.problem };
        adopting = { bytes: read.text, notebook: found.notebook };
      }
    }

    if (decision === "reject") {
      const reverted = await revertText(directory, review);
      if (reverted === "invalid") return { kind: "invalid" };
    }

    if (baseline !== undefined) {
      if (decision === "accept") {
        const read = await readTextFile(directory, named);
        if (read.kind === "text") baseline.set(named, read.text);
        else baseline.delete(named);
      } else if (review.kind === "created") baseline.delete(named);
      else if (review.before !== undefined) baseline.set(named, review.before);
    }
    reviews.delete(named);

    if (decision === "reject" && named === notebook) {
      const read = await readTextFile(directory, named);
      if (read.kind === "text" && read.text !== source) {
        const found = readable(parseNotebook(read.text), `Cannot open ${notebook}`);
        if (found.ok) adopting = { bytes: read.text, notebook: found.notebook };
      }
    }

    if (adopting !== undefined && !adopt(adopting.bytes, adopting.notebook)) {
      return { kind: "refused", problem: JOURNAL_PROBLEM };
    }
    if (!observe({ type: "text-changed", reviews: listedReviews() })) {
      return { kind: "refused", problem: JOURNAL_PROBLEM };
    }
    return { kind: "decided" };
  };

  /** Takes up a text save of this Notebook, when the result can still be opened. */
  const readNotebookFromDisk = async (): Promise<void> => {
    if ((await ensureJournal()) !== undefined) return;
    let bytes: string;
    try {
      bytes = await readFile(path, "utf8");
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return;
      throw cause;
    }
    if (bytes === source) return;
    const found = readable(parseNotebook(bytes), `Cannot open ${notebook}`);
    if (!found.ok) return;
    adopt(bytes, found.notebook);
  };

  return {
    id,

    state,

    ensureJournal,

    save(request) {
      const saved = saving.then(() => save(request));
      // The next save waits for this one however it went; its failure is its caller's.
      saving = saved.catch(() => undefined);
      return saved;
    },

    setModel(model) {
      const saved = saving.then(() => writeField("model", model, notebookWithModel));
      saving = saved.catch(() => undefined);
      return saved;
    },

    setMode(mode) {
      const saved = saving.then(() => writeField("mode", mode, notebookWithMode));
      saving = saved.catch(() => undefined);
      return saved;
    },

    run(request) {
      if (current !== undefined || (journalBlocked && inProgress !== undefined)) return false;
      const controller = new AbortController();

      const observeRun = (event: RunEvent) => {
        observe(event);
        // A Cell has finished writing. The review is published beside the
        // Run, and a failure to read the tree must not stop the Cell.
        if (event.type === "cell-ended") void withReviews(publishReviews).catch(noteFailure);
      };

      const over = (async () => {
        try {
          await withReviews(takeBaseline);
        } catch (cause) {
          current = undefined;
          observe({
            type: "run-refused",
            error: cause instanceof Error ? cause.message : String(cause),
          });
          return;
        }

        const finish = async (settle: () => void) => {
          // Still running while the review is taken, so a browser that asks
          // once the session is at rest finds the files the Run changed.
          await withReviews(publishReviews).catch(noteFailure);
          current = undefined;
          settle();
        };

        try {
          const record = await runNotebook(path, {
            agent,
            observe: observeRun,
            signal: controller.signal,
            cellStops,
            bashStops: cellStops,
            access,
            servedDirectory: directory,
            ...(request.cells !== undefined ? { cells: request.cells } : {}),
            ...(request.inputs !== undefined ? { inputs: request.inputs } : {}),
            ...(last !== undefined ? { continues: last } : {}),
          });
          await finish(() => observe({ type: "run-ended", record }));
        } catch (cause) {
          await finish(() =>
            observe({
              type: "run-refused",
              error: cause instanceof Error ? cause.message : String(cause),
              ...(cause instanceof RunRefusal
                ? { refusal: { kind: cause.kind, problems: cause.problems } }
                : {}),
            }),
          );
        }
      })();
      current = { controller, over };
      // The Run names itself, with its id and the Cells in their order, once it
      // is cleared to run; until then the state alone says the session is running.

      return true;
    },

    decideText(name, decision, lines) {
      return withReviews(() => decide(name, decision, lines));
    },

    reread() {
      const read = saving.then(() => readNotebookFromDisk());
      saving = read.catch(() => undefined);
      return read;
    },

    interrupt,

    stop,

    retargetText,
    forgetText,

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

    async rounds(cellId) {
      const found = results.get(cellId);
      if (found === undefined) return { ok: false, problem: "This cell has not run." };
      if (found.record.type !== "prompt") {
        return { ok: false, problem: "A bash cell does not call a model." };
      }
      const kept = found.record;
      const recorded = recordedTurn(cellId, kept);
      // What the record kept, as the rounds to show when the Agent Session
      // cannot be read: the reply is still accounted for even where the
      // session that would give its message-by-message form is gone.
      const fromRecord = (problem: string): CellRounds => {
        const round = roundFromRecord(kept);
        return attachSystemPrompt(
          {
            ...recorded,
            rounds: round === undefined ? [] : [round],
            roundsProblem: problem,
          },
          kept.systemPrompt,
        );
      };

      const anchor = found.record.anchor;
      if (anchor === undefined) {
        return {
          ok: true,
          value: {
            ...recorded,
            roundsProblem:
              "This cell left no model rounds. An isolated cell's session is discarded when it finishes, and a cell that failed before the model answered has none.",
          },
        };
      }
      const record = await readRunRecord(path, found.run);
      if (record?.agentSession === undefined) {
        return {
          ok: true,
          value: fromRecord(
            "The agent session for this cell is not on disk. The reply below is what the run recorded.",
          ),
        };
      }
      const read = readCellRounds(
        record.agentSession,
        { ...record.anchors, [cellId]: anchor },
        cellId,
        cellsOf(parsed),
      );
      if (!read.ok) {
        return {
          ok: true,
          value: fromRecord(`${read.problem} The reply below is what the run recorded.`),
        };
      }
      return {
        ok: true,
        value: attachSystemPrompt(read.value, found.record.systemPrompt),
      };
    },

    relocate(nextPath, nextNotebook): boolean {
      try {
        // Not one of the numbered events: it says where the file went, which a
        // server starting reads off the Journal, and the browsers are told by
        // the change that follows. The name changes only once this line is written.
        journal.append({ type: "renamed", notebook: nextNotebook });
      } catch (cause) {
        noteJournalFailure(cause);
        return false;
      }
      path = nextPath;
      notebook = nextNotebook;
      emit(() => ({ type: "notebook-changed", session: state() }));
      return true;
    },

    export: (run, format) =>
      exportNotebook({
        notebook: path,
        ...(run !== undefined ? { run } : {}),
        ...(format !== undefined ? { format } : {}),
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

/** How renaming went, including a Notebook Session that is in the middle of a Run. */
export type RenameResult = Renamed | { readonly kind: "running" };

/** The path a Journal's Notebook has now: the last rename it recorded, or the name it was opened under. */
function notebookNamed(journal: FoundJournal): string {
  let name = journal.header.notebook;
  for (const line of journal.lines) {
    if (line.type === "renamed" && typeof line.notebook === "string") name = line.notebook;
  }
  return name;
}

/** A Notebook as the list names it, from the session that holds it. */
function listedNotebook(state: NotebookSessionState): NotebookEntry {
  return {
    path: state.notebook,
    title: state.title,
    ...(state.model !== undefined ? { model: state.model } : {}),
    ...(state.mode !== undefined ? { mode: state.mode } : {}),
  };
}

export interface NotebookSessions {
  /** The Notebook Session for the Notebook at `notebook`, opened if it was not already. */
  open(notebook: string): Promise<Opened>;
  /**
   * Renames the Notebook at `from` to `to`. One a session holds is renamed
   * there too, so the session carries on under the new name; one a Run is
   * busy with is left where it is.
   */
  rename(from: string, to: string): Promise<RenameResult>;
  /** Renames a file that is not a Notebook, and points any open review at the new name. */
  renameFile(from: string, to: string): Promise<RenamedFile>;
  /**
   * The file at `name` has been removed. A review of it is dropped. A session
   * that held that Notebook, and is not running, no longer answers for the path.
   */
  dropFile(name: string): Promise<void>;
  /**
   * Sets the Notebook's model, or clears it. One a session holds is set there,
   * so a browser watching it is told; one that is only a file is written directly.
   */
  setModel(notebook: string, model: string | undefined): Promise<Assigned>;
  /**
   * Sets the Notebook's mode, or clears it. One a session holds is set there,
   * so a browser watching it is told; one that is only a file is written directly.
   */
  setMode(notebook: string, mode: string | undefined): Promise<Assigned>;
  get(id: string): NotebookSession | undefined;
  /** The session that already holds `notebook`, when one does. */
  held(notebook: string): NotebookSession | undefined;
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
  /**
   * Where a notebook's cells may operate. Absent keeps the workspace under
   * `directory`. `cellAccess("user")` is the reach a run had before this
   * choice, any path the account can already use.
   */
  readonly access?: CellAccess;
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
  const access = options.access ?? cellAccess("served");
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
    let session: NotebookSession;
    try {
      const journal = openJournal(directory, id);
      if (before === undefined) {
        const header: JournalHeader = {
          type: "opened",
          notebook: relativePath,
          revision: revisionOf(source),
        };
        journal.append(header);
      }
      session = await createNotebookSession({
        id,
        path,
        notebook: relativePath,
        source,
        parsed: found.notebook,
        agent,
        journal,
        directory,
        access,
        ...(before !== undefined ? { recovered: before } : {}),
      });
    } catch (cause) {
      return {
        kind: "refused",
        problem: cause instanceof Error ? cause.message : String(cause),
      };
    }
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
    const path = fileWithin(directory, notebookNamed(journal));
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

    async setModel(notebook, model) {
      const path = fileWithin(directory, notebook);
      if (path === undefined) return { kind: "absent" };
      const session = byPath.get(path);
      if (session === undefined) return assignNotebookModel(directory, notebook, model);
      const saved = await session.setModel(model);
      if (saved.kind !== "saved") return { kind: "refused", problem: saved.problem };
      return { kind: "saved", entry: listedNotebook(session.state()) };
    },

    async setMode(notebook, mode) {
      const path = fileWithin(directory, notebook);
      if (path === undefined) return { kind: "absent" };
      const session = byPath.get(path);
      if (session === undefined) return assignNotebookMode(directory, notebook, mode);
      const saved = await session.setMode(mode);
      if (saved.kind !== "saved") return { kind: "refused", problem: saved.problem };
      return { kind: "saved", entry: listedNotebook(session.state()) };
    },

    async rename(from, to) {
      const source = fileWithin(directory, from);
      if (source === undefined) return { kind: "absent" };
      const session = byPath.get(source);
      if (session !== undefined) {
        const journal = await session.ensureJournal();
        if (journal !== undefined) return { kind: "invalid", problem: journal };
      }
      if (session?.state().running) return { kind: "running" };

      const renamed = await renameNotebook(directory, from, to);
      if (renamed.kind !== "renamed" || session === undefined) return renamed;
      const target = fileWithin(directory, renamed.entry.path);
      if (target === undefined || target === source) return renamed;
      if (!session.relocate(target, renamed.entry.path)) {
        return {
          kind: "invalid",
          problem:
            "The journal could not be written, so this notebook is not taking changes until it can.",
        };
      }
      byPath.delete(source);
      byPath.set(target, session);
      return renamed;
    },

    async renameFile(from, to) {
      const renamed = await renameFile(directory, from, to);
      const source = fileWithin(directory, from);
      const previous = source === undefined ? undefined : pathWithin(directory, source);
      if (renamed.kind !== "renamed" || previous === undefined || previous === renamed.path) {
        return renamed;
      }
      await Promise.all(
        [...byId.values()].map((session) => session.retargetText(previous, renamed.path)),
      );
      return renamed;
    },

    async dropFile(name) {
      const file = fileWithin(directory, name);
      const path = file === undefined ? undefined : pathWithin(directory, file);
      if (file !== undefined) {
        const session = byPath.get(file);
        if (session !== undefined && !session.state().running) byPath.delete(file);
      }
      if (path === undefined) return;
      await Promise.all([...byId.values()].map((session) => session.forgetText(path)));
    },

    get: (id) => byId.get(id),

    held(notebook) {
      const path = fileWithin(directory, notebook);
      return path === undefined ? undefined : byPath.get(path);
    },

    async close() {
      await Promise.all([...byId.values()].map((session) => session.interrupt()));
    },
  };
}
