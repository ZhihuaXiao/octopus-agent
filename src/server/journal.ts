/**
 * A Notebook Session's Journal: every event it has emitted, numbered, written
 * to disk as it happens.
 *
 * What lets a Notebook Session outlive the server it was opened in. A server
 * that starts finds the Journals the one before it left, and opens each
 * Notebook again into a session that stands where the last one stood, having
 * heard its own events over. Pi's session file is not read for any of this:
 * it is pi's, holds the Agent Session and not the Run, and is only ever
 * reopened through pi's own API when a Run carries on (ADR-0014). The Run
 * Records hold what each Run left, and the Journal holds what the session
 * saw of them, which is what a browser coming back is told (ADR-0021).
 *
 * One file per Notebook Session, a line per entry, appended and never
 * rewritten, like pi's own session files: a process that dies mid-line leaves
 * a file that reads to the line before, and nothing earlier is put at risk by
 * anything later.
 */

import { appendFileSync } from "node:fs";

import { OWNER_FILE, mkdirOwnerSync, protectOwnerSync } from "../util/owner.js";
import { readFile, readdir, truncate } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { isRecord } from "../util/guards.js";

const JOURNALS_DIRECTORY = join(".octo", "journals");
const EXTENSION = ".jsonl";

/** Where the Notebook Sessions of the served `directory` are journaled. */
export const journalsDirectory = (directory: string) => join(directory, JOURNALS_DIRECTORY);

const journalPath = (directory: string, id: string) =>
  join(journalsDirectory(directory), `${id}${EXTENSION}`);

/**
 * The first line of a Journal: which Notebook the session is of, and which
 * Revision of it the session opened, so a file that moved on while no server
 * was running is told from one that did not.
 */
export interface JournalHeader {
  readonly type: "opened";
  readonly notebook: string;
  readonly revision: string;
}

/** A line as it is written: what it says, and when it was written. */
export type JournalLine = { readonly at: string } & Record<string, unknown>;

/** A Journal as found on disk, read whole. */
export interface FoundJournal {
  /** The Notebook Session's id, which the file is named by. */
  readonly id: string;
  readonly header: JournalHeader;
  /** Every line after the header, in order, as far as the file reads. */
  readonly lines: readonly JournalLine[];
}

export interface Journal {
  /**
   * Writes one line, and returns once it is written. Synchronous, as pi's own
   * appends are, so that nothing a browser is told has yet to reach the disk:
   * a browser that comes back after a crash asks for everything since a
   * number, and every number it heard must be the same event in the Journal.
   */
  append(entry: object): void;
}

/**
 * Opens the Journal of the Notebook Session `id` for writing, at the end of
 * what it holds: a Journal being recovered carries on, one being made begins.
 */
export function openJournal(directory: string, id: string): Journal {
  const path = journalPath(directory, id);
  mkdirOwnerSync(journalsDirectory(directory));

  return {
    append(entry) {
      const line: JournalLine = { at: new Date().toISOString(), ...entry };
      // A line that could not be written is reported, and the lines after it
      // are still tried: the Journal is the session's memory, not its Run,
      // and a full disk should not stop a Cell.
      try {
        appendFileSync(path, `${JSON.stringify(line)}\n`, { encoding: "utf8", mode: OWNER_FILE });
        protectOwnerSync(path);
      } catch (cause) {
        process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
      }
    },
  };
}

const isHeader = (line: unknown): line is JournalHeader =>
  isRecord(line) &&
  line.type === "opened" &&
  typeof line.notebook === "string" &&
  typeof line.revision === "string";

/**
 * Reads a Journal's lines, as far as it reads, and how many bytes that is. A
 * line is a line once its line ending is written, so one without — the one a
 * process died in the middle of writing — ends the reading, as does one that
 * is not JSON: nothing after either can be trusted to follow what came before.
 */
function parseLines(contents: string): { lines: JournalLine[]; read: number } {
  const lines: JournalLine[] = [];
  let offset = 0;
  for (;;) {
    const end = contents.indexOf("\n", offset);
    if (end === -1) break;
    const text = contents.slice(offset, end);
    if (text !== "") {
      let line: unknown;
      try {
        line = JSON.parse(text) as unknown;
      } catch {
        break;
      }
      if (!isRecord(line) || typeof line.at !== "string") break;
      lines.push(line as JournalLine);
    }
    offset = end + 1;
  }
  return { lines, read: Buffer.byteLength(contents.slice(0, offset), "utf8") };
}

/**
 * Every Journal under the served `directory`, each read whole. One cut short
 * by a dying process is cut off where it stops reading, so that what the
 * recovered session appends begins a line of its own rather than finishing
 * the one that was never finished — which the next server would then be
 * unable to read past. One that does not begin as a Journal begins is left
 * out and said so on stderr, since a file this program did not write is not
 * one it should act on.
 */
export async function readJournals(directory: string): Promise<FoundJournal[]> {
  const names = await readdir(journalsDirectory(directory)).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    },
  );

  const found: FoundJournal[] = [];
  for (const name of names.filter((candidate) => extname(candidate) === EXTENSION).sort()) {
    const path = join(journalsDirectory(directory), name);
    const contents = await readFile(path, "utf8");
    const { lines, read } = parseLines(contents);
    if (read < Buffer.byteLength(contents, "utf8")) await truncate(path, read);
    const [header, ...rest] = lines;
    if (!isHeader(header)) {
      process.stderr.write(`Not a notebook session journal, so not recovered: ${path}\n`);
      continue;
    }
    found.push({ id: basename(name, EXTENSION), header, lines: rest });
  }
  return found;
}
