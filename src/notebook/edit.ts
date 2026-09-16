/**
 * Editing a Notebook as a whole: the Notebook as an author wants it, applied
 * to the Notebook as it stands.
 *
 * An edit describes the whole Notebook — the frontmatter's text, and the Prose
 * and Cells in the order they should appear — rather than one change to it, so
 * that adding, removing and reordering Cells are the same operation as changing
 * one's body, and a browser holding a draft need not keep a history of what it
 * did to get there.
 *
 * Fidelity is kept the way `notebook.ts` keeps it: nothing is rendered that
 * can be replayed. Prose the Notebook already has is its own bytes; a Cell
 * whose body is what it was keeps it to the byte, and one whose declaration is
 * unchanged keeps the fence lines its author wrote; the frontmatter keeps its
 * delimiters. Only what the edit changes is written out — a new body with the
 * line ending the Notebook uses, a fence for a Cell that is new or declared
 * differently — and only that changes. An edit that describes the Notebook as
 * it already is therefore reproduces it byte for byte, whatever its line
 * endings, and one that changes a body changes nothing else — the property
 * ADR-0002 makes a requirement.
 */

import { type Diagnostic } from "./diagnostic.js";
import { formatDuration, parseDuration } from "./duration.js";
import {
  type Cell,
  type CellSegment,
  type CellType,
  type Notebook,
  type SourceLine,
  isCellSegment,
  parseNotebook,
} from "./notebook.js";

/**
 * One Cell as an author declares it, its Timeout as written rather than in
 * milliseconds: the author's word is what goes in the fence and what the
 * parser rules on, so nothing here need know how to spell a duration.
 */
export interface CellEdit {
  readonly kind: "cell";
  readonly id: string;
  readonly type: CellType;
  /**
   * The body as content: without the line ending that closes its last line,
   * which is the fence's to supply. What a text field holds, and what
   * `editOf` gives back, so a body an author did not touch is known for one.
   */
  readonly body: string;
  readonly uses: readonly string[];
  readonly isolated: boolean;
  readonly model?: string;
  readonly timeout?: string;
}

export interface ProseEdit {
  readonly kind: "prose";
  readonly text: string;
}

export type SegmentEdit = CellEdit | ProseEdit;

/** The Notebook as it should be, whole. */
export interface NotebookEdit {
  /** The YAML between the delimiters; absent for a Notebook with no frontmatter. */
  readonly frontmatter?: string;
  readonly segments: readonly SegmentEdit[];
}

export type EditResult =
  | { readonly ok: true; readonly notebook: Notebook; readonly source: string }
  /** What the edit makes is not a Notebook that can be read, and nothing was changed. */
  | { readonly ok: false; readonly errors: readonly Diagnostic[] };

const FRONTMATTER_DELIMITER = "---";

const raw = (line: SourceLine) => line.text + line.terminator;

/** A body as content: its bytes without the line ending that closes its last line. */
const contentOf = (body: string) => body.replace(/\r?\n$/, "");

/** The Cell's declaration as an edit would spell it. */
function declarationOf(cell: Cell): CellEdit {
  return {
    kind: "cell",
    id: cell.id,
    type: cell.type,
    body: contentOf(cell.body),
    uses: cell.uses,
    isolated: cell.isolated,
    ...(cell.model !== undefined ? { model: cell.model } : {}),
    ...(cell.timeout !== undefined ? { timeout: formatDuration(cell.timeout) } : {}),
  };
}

/** The edit that describes a Notebook exactly as it stands. */
export function editOf(notebook: Notebook): NotebookEdit {
  return {
    ...(notebook.frontmatter !== undefined ? { frontmatter: notebook.frontmatter.text } : {}),
    segments: notebook.segments.map((segment) =>
      isCellSegment(segment) ? declarationOf(segment.cell) : { kind: "prose", text: segment.text },
    ),
  };
}

/**
 * The line terminator the Notebook is written with: whatever its first line
 * ends with, and LF for a Notebook that has no line ending in it yet.
 */
function newlineOf(notebook: Notebook): string {
  if (notebook.frontmatter !== undefined) return notebook.frontmatter.open.terminator;
  for (const segment of notebook.segments) {
    if (isCellSegment(segment)) return segment.open.terminator;
    const found = /\r?\n/.exec(segment.text);
    if (found !== null) return found[0];
  }
  return "\n";
}

/**
 * Text the edit wrote, as the Notebook writes it: its line endings the
 * Notebook's, and ending on one. Only for text that is new: what the Notebook
 * already had is kept to the byte, whatever its line endings.
 */
function framed(text: string, newline: string): string {
  const lines = text.replace(/\r\n|\r|\n/g, newline);
  return lines === "" || lines.endsWith(newline) ? lines : lines + newline;
}

/** A body the edit wrote, its last line closed: nothing at all when there is nothing in it. */
const closed = (body: string, newline: string) =>
  body === "" ? "" : body.replace(/\r\n|\r|\n/g, newline) + newline;

/**
 * Whether two Cells are declared alike: everything the fence says other than
 * the body. A Timeout the edit spells in a way the format does not read is
 * never alike, so that the fence is written and the parser says so.
 */
function sameDeclaration(cell: Cell, edit: CellEdit): boolean {
  const timeout = edit.timeout === undefined ? undefined : parseDuration(edit.timeout);
  return (
    cell.id === edit.id &&
    cell.type === edit.type &&
    cell.uses.length === edit.uses.length &&
    cell.uses.every((used, at) => used === edit.uses[at]) &&
    cell.isolated === edit.isolated &&
    cell.model === edit.model &&
    (edit.timeout === undefined
      ? cell.timeout === undefined
      : timeout !== undefined && cell.timeout === timeout)
  );
}

/** An attribute's value as a fence can carry it: quoted when it holds a space. */
const attribute = (key: string, value: string) =>
  `${key}=${/\s/.test(value) ? `"${value}"` : value}`;

/** The info string of a Cell's fence, as the format contract spells it. */
function infoOf(edit: CellEdit): string {
  const parts = [edit.type, attribute("id", edit.id)];
  if (edit.uses.length > 0) parts.push(attribute("uses", edit.uses.join(",")));
  if (edit.isolated) parts.push("isolated");
  if (edit.model !== undefined) parts.push(attribute("model", edit.model));
  if (edit.timeout !== undefined) parts.push(attribute("timeout", edit.timeout));
  return parts.join(" ");
}

/**
 * A fence marker the body cannot close: longer than any run of the marker's
 * character that begins one of the body's lines, and never shorter than the
 * marker the Cell had, so an author's longer fence stays as long as it was.
 */
function markerFor(body: string, previous: string | undefined): string {
  const character = previous?.[0] ?? "`";
  const runs = [...body.matchAll(new RegExp(`^[${character}]+`, "gm"))].map((run) => run[0].length);
  const length = Math.max(3, previous?.length ?? 0, ...runs.map((run) => run + 1));
  return character.repeat(length);
}

/** The opening fence marker of a Cell as written: the backticks or tildes alone. */
const markerOf = (segment: CellSegment) => /^(`{3,}|~{3,})/.exec(segment.open.text)?.[1] ?? "```";

/**
 * Applies an edit to the Notebook and parses what it makes, so an edit that
 * would leave the file unreadable — a `uses` naming no Cell, two Cells with
 * one id, frontmatter that is not YAML — is reported against the lines of the
 * Notebook it would have made, and changes nothing.
 */
export function applyEdit(notebook: Notebook, edit: NotebookEdit): EditResult {
  const newline = newlineOf(notebook);
  const existing = new Map(
    notebook.segments.filter(isCellSegment).map((segment) => [segment.cell.id, segment]),
  );
  // Prose the Notebook already has, by its bytes: Prose has no id, so what the
  // edit carries is known to be the Notebook's own by being the same text.
  const written = new Set(
    notebook.segments.flatMap((segment) => (isCellSegment(segment) ? [] : [segment.text])),
  );
  const parts: string[] = [];

  if (edit.frontmatter !== undefined) {
    const { frontmatter } = notebook;
    const open = frontmatter?.open ?? { text: FRONTMATTER_DELIMITER, terminator: newline };
    const close = frontmatter?.close ?? { text: FRONTMATTER_DELIMITER, terminator: newline };
    const text =
      edit.frontmatter === frontmatter?.text ? frontmatter.text : framed(edit.frontmatter, newline);
    parts.push(raw(open), text, raw(close));
  }

  edit.segments.forEach((segment, at) => {
    const last = at === edit.segments.length - 1;
    if (segment.kind === "prose") {
      if (segment.text === "") return;
      // Its own bytes when the Notebook had it; framed when the edit wrote it.
      // Either way a fence after it has to begin a line of its own.
      const text = written.has(segment.text) ? segment.text : framed(segment.text, newline);
      parts.push(!last && !/\r?\n$/.test(text) ? text + newline : text);
      return;
    }

    const was = existing.get(segment.id);
    const body =
      was !== undefined && contentOf(was.cell.body) === segment.body
        ? was.cell.body
        : closed(segment.body, newline);
    const previous = was === undefined ? undefined : markerOf(was);
    const marker = markerFor(body, previous);
    const kept = was !== undefined && marker === previous && sameDeclaration(was.cell, segment);

    const open = kept ? was.open : { text: `${marker}${infoOf(segment)}`, terminator: newline };
    // The closing fence ends the file without a terminator only when the Cell
    // is still the last thing in it; moved above something, it needs one.
    const close =
      was !== undefined && marker === previous
        ? {
            text: was.close.text,
            terminator: was.close.terminator === "" && !last ? newline : was.close.terminator,
          }
        : { text: marker, terminator: newline };
    parts.push(raw(open), body, raw(close));
  });

  const source = parts.join("");
  const parsed = parseNotebook(source);
  if (!parsed.ok) return parsed;
  return { ok: true, notebook: parsed.notebook, source };
}
