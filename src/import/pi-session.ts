/**
 * Importing a Chat: work done at pi's prompt becomes a Notebook.
 *
 * One-way, and a copy (ADR-0022): pi's session file is read and copied, never
 * written, since pi holds it while it runs and there is one active session per
 * process. Nothing here syncs back to a live session, and nothing ever will.
 *
 * What comes out is what a Run would have left. Each message the user sent
 * along the Chat's active path is a Prompt Cell and each command they ran with
 * `!` a Bash Cell, and a Run Record beside the Notebook holds what each said,
 * did, cost and ran on, read off pi's messages exactly as a live turn's are
 * (`pi/turn.ts`). The copy of the session is that Run's Agent Session, so the
 * record's Anchors address it and a later Run may carry on from it as from any
 * other — writing into the copy, which is ours, and never into pi's file.
 *
 * Both of the ticket's features are this one function: the command line's
 * `import` names the file, and the browser's Promote picks it off pi's list.
 */

import { copyFile, mkdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { stringify } from "yaml";

import { noUsage } from "../agent/agent.js";
import { type SegmentEdit, applyEdit } from "../notebook/edit.js";
import { type Notebook, escapeReferences, parseNotebook } from "../notebook/notebook.js";
import {
  failureOf,
  saidIn,
  summariseTurn,
  textBlocksOf,
  thoughtIn,
  wasStopped,
} from "../pi/turn.js";
import { anchorsAfter } from "../run/anchor.js";
import type { BashCellRecord, CellRecord, PromptCellRecord, RunRecord } from "../run/record.js";
import { newRunId, runDirectory, runsDirectory, writeRunRecord } from "../run/store.js";
import { isRecord } from "../util/guards.js";

export interface ImportRequest {
  /** Pi's session file, as pi wrote it. Read and copied, never written. */
  readonly session: string;
  /** Where the Notebook is written, as an absolute path. */
  readonly notebook: string;
}

/** How importing went. Whatever refused it, nothing was written. */
export type Imported =
  | {
      readonly kind: "imported";
      /** The Notebook as written, parsed. */
      readonly notebook: Notebook;
      /** The Run Record the Chat populated, as written beside the Notebook. */
      readonly record: RunRecord;
    }
  /** No file at the session's path. */
  | { readonly kind: "absent" }
  /** A file that is not a pi session, or a Chat with nothing in it to make a Cell of. */
  | { readonly kind: "invalid"; readonly problem: string }
  /** A file is already there where the Notebook would go. */
  | { readonly kind: "exists" };

/** What the copy of the session is called under the Run's directory. */
const SESSION_COPY = "session.jsonl";

/**
 * One turn of the Chat as pi recorded it: what was asked, and every entry that
 * followed until the next thing the user did — the assistant's messages, the
 * tools' results, and whatever else pi recorded on the way.
 */
interface Turn {
  readonly kind: "prompt";
  readonly asked: SessionEntry;
  /** Appended to while the path is walked, until the next thing the user did. */
  readonly followed: SessionEntry[];
}

/** A command the user ran at pi's prompt with `!`, which pi ran itself and recorded. */
interface RanCommand {
  readonly kind: "bash";
  readonly entry: SessionEntry;
  readonly command: string;
  readonly output: string;
  readonly exitCode: number | null;
  readonly cancelled: boolean;
}

/** What one Cell is made of: a turn, or a command the user ran. */
type CellSource = Turn | RanCommand;

/** The Cells to be made along the Chat's active path: each user message a turn, each `!` command a command. */
function cellSourcesOf(path: readonly SessionEntry[]): CellSource[] {
  const sources: CellSource[] = [];
  for (const entry of path) {
    const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
    if (message?.role === "user") {
      sources.push({ kind: "prompt", asked: entry, followed: [] });
      continue;
    }
    if (message?.role === "bashExecution") {
      sources.push({
        kind: "bash",
        entry,
        command: typeof message.command === "string" ? message.command : "",
        output: typeof message.output === "string" ? message.output : "",
        exitCode: typeof message.exitCode === "number" ? message.exitCode : null,
        cancelled: message.cancelled === true,
      });
      continue;
    }
    // Everything else belongs to the turn under way, and to nothing when there
    // is none yet — a model chosen before anything was asked.
    const current = sources.at(-1);
    if (current?.kind === "prompt") current.followed.push(entry);
  }
  return sources;
}

/** The messages among a turn's entries, which is what a turn is read off. */
const messagesOf = (turn: Turn) =>
  turn.followed.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));

/**
 * What a turn's Cell records: as a live turn would have, read off the same
 * messages. A turn somebody stopped at the terminal is Interrupted, as one
 * stopped from the browser is, and what it had said by then is kept — it is
 * in the Chat, where a live Run's half-reply never was.
 */
function turnRecordOf(id: string, turn: Turn): PromptCellRecord {
  const messages = messagesOf(turn);
  const summary = summariseTurn(messages);
  const thinking = thoughtIn(messages);
  const ended = turn.followed.at(-1) ?? turn.asked;
  const failed = failureOf(messages);
  const outcome =
    failed === undefined
      ? // The entry the turn left the session on, which is the Anchor: where a
        // later Run forks to put a Cell back in this context. None for a turn
        // that did not end well, as a live one records none.
        { status: "ok" as const, anchor: ended.id }
      : wasStopped(messages)
        ? { status: "interrupted" as const, error: "Interrupted" }
        : { status: "error" as const, error: failed };
  return {
    id,
    type: "prompt",
    text: saidIn(messages),
    ...summary,
    ...(thinking !== "" ? { thinking } : {}),
    retries: [],
    ...outcome,
    artifacts: [],
    startedAt: turn.asked.timestamp,
    endedAt: ended.timestamp,
  };
}

/**
 * What a command's Cell records: its output as pi kept it — pi keeps one
 * stream, so it is all standard output here — and how it ended, said as the
 * runner says it of a command it ran. One the user cancelled is Interrupted.
 */
function commandRecordOf(id: string, ran: RanCommand): BashCellRecord {
  const outcome = ran.cancelled
    ? { status: "interrupted" as const, error: "Interrupted" }
    : ran.exitCode === 0
      ? { status: "ok" as const }
      : {
          status: "error" as const,
          error:
            ran.exitCode === null
              ? "Command never got as far as exiting"
              : `Command exited with status ${ran.exitCode}`,
        };
  return {
    id,
    type: "bash",
    ...outcome,
    usage: noUsage,
    stdout: ran.output,
    stderr: "",
    exitCode: ran.cancelled ? null : ran.exitCode,
    artifacts: [],
    startedAt: ran.entry.timestamp,
    endedAt: ran.entry.timestamp,
  };
}

/** The Cell a source is written as, and the record of what it did. */
function cellOf(id: string, source: CellSource): { segment: SegmentEdit; record: CellRecord } {
  if (source.kind === "bash") {
    return {
      segment: { kind: "cell", id, type: "bash", body: source.command, uses: [], isolated: false },
      record: commandRecordOf(id, source),
    };
  }
  const { asked } = source;
  const content = asked.type === "message" && isRecord(asked.message) ? asked.message.content : "";
  // Escaped so that braces typed at the terminal stay text: the Chat had no
  // Inputs, so nothing in it was a reference. A fence in the text is the edit
  // machinery's to fence longer, as it does for a body typed in the browser.
  const body = escapeReferences(textBlocksOf(content));
  return {
    segment: { kind: "cell", id, type: "prompt", body, uses: [], isolated: false },
    record: turnRecordOf(id, source),
  };
}

/**
 * The model the Chat was on at its end, `provider/model` as a Notebook names
 * one: the last assistant message's, since pi records a change of model as an
 * entry but the message says what actually answered. The model asked for, not
 * the dated version the provider served, since that is what pi resolves a
 * Notebook's `model` against. Nothing when no assistant ever answered.
 */
function modelOf(path: readonly SessionEntry[]): string | undefined {
  const answered = path
    .flatMap((entry) =>
      entry.type === "message" && isRecord(entry.message) ? [entry.message] : [],
    )
    .filter((message) => message.role === "assistant")
    .at(-1);
  if (answered === undefined) return undefined;
  const { provider, model } = answered;
  return typeof provider === "string" && typeof model === "string"
    ? `${provider}/${model}`
    : undefined;
}

/** The frontmatter's YAML for what the import knows of the Notebook, or none when it knows nothing. */
function frontmatterOf(metadata: Readonly<Record<string, string | undefined>>): string | undefined {
  const known = Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
  return Object.keys(known).length === 0 ? undefined : stringify(known);
}

/**
 * The Prose that opens the Notebook: where it came from, and — when the Chat
 * forked and the path pi was left on is not all of it — that the branches it
 * left behind are not here, since a reader who remembers asking something
 * would otherwise wonder where it went.
 */
function introductionOf(manager: SessionManager, path: readonly SessionEntry[]): string {
  const begun = manager.getHeader()?.timestamp ?? "at an unrecorded time";
  const branched = manager.getEntries().length > path.length;
  return (
    `\nImported from a pi session begun ${begun} in \`${manager.getCwd()}\`.` +
    (branched
      ? " Only the path the session was left on is here; the branches it left behind are in the copy of the session beside the run record."
      : "") +
    "\n\n"
  );
}

/** The empty Notebook every import begins from, so the edit machinery writes the whole file. */
function emptyNotebook() {
  const parsed = parseNotebook("");
  if (!parsed.ok) throw new Error("An empty file is not a notebook");
  return parsed.notebook;
}

const isFile = (path: string) =>
  stat(path).then(
    (entry) => entry.isFile(),
    () => false,
  );

const isThere = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Takes back a Run's directory made for an import that was then refused, and
 * the directories made on the way to it when nothing else is in them — the
 * Notebook's own included, when the import made it — so a refusal leaves the
 * disk as it was.
 */
async function takeBack(notebook: string, run: string, madeNotebookDirectory: boolean) {
  await rm(run, { recursive: true, force: true });
  const runs = runsDirectory(notebook);
  const made = [runs, dirname(runs), dirname(dirname(runs))];
  if (madeNotebookDirectory) made.push(dirname(notebook));
  for (const directory of made) {
    // `rmdir` takes only an empty directory, which is the only kind to take back.
    await rmdir(directory).catch(() => undefined);
  }
}

export async function importSession(request: ImportRequest): Promise<Imported> {
  const { session, notebook } = request;
  if (!(await isFile(session))) return { kind: "absent" };
  // Asked first, so a name already taken costs nothing; asked again when the
  // file is written, since the answer may have changed meanwhile.
  if (await isThere(notebook)) return { kind: "exists" };

  const id = newRunId();
  const run = runDirectory(notebook, id);
  const madeNotebookDirectory = !(await isThere(dirname(notebook)));
  await mkdir(run, { recursive: true });
  const refuse = async (refusal: Imported): Promise<Imported> => {
    await takeBack(notebook, run, madeNotebookDirectory);
    return refusal;
  };

  // Copied before it is opened: pi migrates an older session file in place when
  // it opens one, and the file it may rewrite has to be ours.
  const copy = join(run, SESSION_COPY);
  await copyFile(session, copy);
  let manager: SessionManager;
  try {
    manager = SessionManager.open(copy);
  } catch {
    // Pi's own complaint names the copy, which is nobody's concern; the file
    // that was named is the one to say something about.
    return refuse({ kind: "invalid", problem: `${session} is not a pi session file.` });
  }
  // From the leaf pi was left on back to the root: the Chat as it stood when
  // the terminal was closed, and not the branches it abandoned on the way.
  const path = manager.getBranch();
  const made = cellSourcesOf(path).map((source, at) => cellOf(`cell-${at + 1}`, source));
  if (made.length === 0) {
    return refuse({
      kind: "invalid",
      problem: "Nothing was asked in this session, so there is no cell to make of it.",
    });
  }
  const cells = made.map((cell) => cell.record);
  const workspace = manager.getCwd();

  const frontmatter = frontmatterOf({
    title: manager.getSessionName(),
    // Relative to the Notebook, as `workspaceOf` reads it, and left out when
    // the Notebook is written into the Workspace the Chat happened in.
    workspace: relative(dirname(notebook), workspace) || undefined,
    model: modelOf(path),
  });
  const edited = applyEdit(emptyNotebook(), {
    ...(frontmatter !== undefined ? { frontmatter } : {}),
    segments: [
      { kind: "prose", text: introductionOf(manager, path) },
      ...made.flatMap((cell, at) =>
        at === 0 ? [cell.segment] : [{ kind: "prose" as const, text: "\n" }, cell.segment],
      ),
    ],
  });
  if (!edited.ok) throw new Error("The imported notebook does not parse");

  const anchors = anchorsAfter({ anchorsBefore: {}, cells });
  const record: RunRecord = {
    id,
    notebook,
    imported: session,
    environment: {
      workspace,
      trusted: false,
      piVersion: "",
      tools: [
        ...new Set(
          cells.flatMap((cell) =>
            cell.type === "prompt" ? cell.toolCalls.map((call) => call.name) : [],
          ),
        ),
      ],
    },
    // Named only when an Anchor stands in it, as the runner names one: a Chat
    // whose every turn failed has nothing in it for a later Run to fork at.
    ...(Object.keys(anchors).length > 0 ? { agentSession: copy } : {}),
    startedAt: path[0]?.timestamp ?? new Date().toISOString(),
    endedAt: path.at(-1)?.timestamp ?? new Date().toISOString(),
    cells,
    anchors,
    stale: [],
  };
  // The record first, so a Notebook is never left without the account of what
  // it came from; then the Notebook, never over a file that is there, since
  // that would be a way to lose one by mistyping a name.
  await writeRunRecord(record);
  try {
    await writeFile(notebook, edited.source, { encoding: "utf8", flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return refuse({ kind: "exists" });
    throw cause;
  }

  return { kind: "imported", notebook: edited.notebook, record };
}
