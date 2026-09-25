/**
 * The Notebook format: parse and serialise.
 *
 * This module owns round-trip fidelity, which ADR-0002 makes a requirement: a
 * Notebook is reviewed in a pull request, so an editor that reformats the file
 * on save destroys the reviewability the Markdown format exists for.
 *
 * Fidelity is structural rather than careful. A parsed Notebook keeps every
 * byte of the source in one of two places: the verbatim text of Prose and Cell
 * bodies, and the verbatim lines framing them — the frontmatter delimiters and
 * each Cell's fences. Serialising replays those parts in order, so it cannot
 * normalise what it never interpreted. The cooked view of a Cell's attributes
 * sits beside its framing rather than replacing it, which is why the parsed
 * value is readonly throughout: edits go through the operations below, so the
 * two views can never drift apart.
 */

import { basename, dirname, extname, resolve } from "node:path";

import { type Diagnostic, lineOffset } from "./diagnostic.js";
import { DURATION_RULE, parseDuration } from "./duration.js";
import { type Metadata, readMetadata } from "./frontmatter.js";
import { type PlacedCell, checkGraph } from "./graph.js";
import { ARTIFACTS_REFERENCE, referencesIn } from "./inputs.js";
import { NAME_RULE, isName } from "./name.js";

export type { Diagnostic } from "./diagnostic.js";
export type { Metadata } from "./frontmatter.js";
export type { Input, InputType, InputValue, InputValues } from "./inputs.js";
export { formatDiagnostics } from "./diagnostic.js";
export { formatDuration } from "./duration.js";
export { runOrder, staleAfter } from "./graph.js";
export {
  ARTIFACTS_REFERENCE,
  escapeReferences,
  interpolate,
  referencesIn,
  resolveInputs,
} from "./inputs.js";

export type CellType = "prompt" | "bash";

export interface Cell {
  readonly id: string;
  readonly type: CellType;
  /** The body exactly as written, its line terminators included. */
  readonly body: string;
  /** The Cells this one declares a Dependency on, which form the Graph. */
  readonly uses: readonly string[];
  /** Whether the Cell runs in a fresh context rather than the shared one. */
  readonly isolated: boolean;
  /** Overrides the Notebook's model for this Cell alone. */
  readonly model?: string;
  /**
   * How long this Cell may run before the Run aborts it, in milliseconds.
   * Overrides the Notebook's own `timeout` for this Cell alone.
   */
  readonly timeout?: number;
}

/** One line of the source with its own terminator, so replaying it is exact. */
export interface SourceLine {
  readonly text: string;
  /** Empty when the line ends the file without a final newline. */
  readonly terminator: string;
}

/** Ordinary Markdown between Cells, kept verbatim. Not a Cell: it has no id. */
export interface Prose {
  readonly kind: "prose";
  readonly text: string;
}

export interface CellSegment {
  readonly kind: "cell";
  readonly cell: Cell;
  readonly open: SourceLine;
  readonly close: SourceLine;
}

export type Segment = Prose | CellSegment;

/** The frontmatter as written, so serialising reproduces it untouched. */
export interface FrontmatterSource {
  /** The YAML between the delimiters, terminators included. */
  readonly text: string;
  readonly open: SourceLine;
  readonly close: SourceLine;
}

export interface Notebook {
  readonly metadata: Metadata;
  /** Absent when the Notebook has no frontmatter at all. */
  readonly frontmatter?: FrontmatterSource;
  readonly segments: readonly Segment[];
}

export type ParseResult =
  | { readonly ok: true; readonly notebook: Notebook }
  | { readonly ok: false; readonly errors: readonly Diagnostic[] };

const FRONTMATTER_DELIMITER = "---";
const FENCE = /^(`{3,}|~{3,})(.*)$/;
const INDENTED_FENCE = /^ {1,3}(`{3,}|~{3,})(.*)$/;
const CELL_ATTRIBUTES = ["id", "type", "uses", "isolated", "model", "timeout"];
/** The attributes that are this project's own invention, so no snippet has one. */
const CELL_ONLY_ATTRIBUTES = CELL_ATTRIBUTES.filter((key) => key !== "id");
const MISSING_ID = "Cell is missing an id";

const raw = (line: SourceLine) => line.text + line.terminator;

const isFrontmatterDelimiter = (text: string) => text.trimEnd() === FRONTMATTER_DELIMITER;

export const isCellSegment = (segment: Segment): segment is CellSegment => segment.kind === "cell";

export function cellsOf(notebook: Notebook): readonly Cell[] {
  return notebook.segments.filter(isCellSegment).map((segment) => segment.cell);
}

/**
 * A Cell's body as content rather than as bytes: what a Prompt Cell asks, or
 * what a Bash Cell runs, without the surrounding whitespace its fence implies.
 * `Cell.body` keeps the bytes, because those are what has to round-trip.
 */
export function bodyOf(cell: Cell): string {
  return cell.body.trim();
}

/**
 * The directory the Notebook operates on: the Workspace it declares, resolved
 * against the Notebook's own location, or that location when it declares none.
 *
 * Relative to the Notebook rather than to the process, so a Notebook and the
 * code it operates on travel together and a Run does the same thing wherever
 * it was started from. Whether the directory is there is the Run's to check.
 */
export function workspaceOf(notebook: Notebook, notebookPath: string): string {
  return resolve(dirname(notebookPath), notebook.metadata.workspace ?? ".");
}

/** A Notebook's declared title, or its file's name when it declares none. */
export function titleOf(notebook: Notebook, notebookPath: string): string {
  return notebook.metadata.title ?? basename(notebookPath, extname(notebookPath));
}

/**
 * How long a Cell may run, in milliseconds: its own `timeout`, else the
 * Notebook's, else nothing at all — a Notebook that says nothing runs as long
 * as it takes, as it always did.
 */
export function timeoutOf(notebook: Notebook, cell: Cell): number | undefined {
  return cell.timeout ?? notebook.metadata.timeout;
}

/**
 * The model a Cell asks for: its own `model`, else the Notebook's, else nothing
 * — the agent's own default then, which is what every Cell ran on before a
 * model could be named. The same shape as `timeoutOf`, because the Cell's
 * attribute overrides the Notebook's field in the same way.
 */
export function modelOf(notebook: Notebook, cell: Cell): string | undefined {
  return cell.model ?? notebook.metadata.model;
}

/**
 * Splits into lines that keep their own terminators, so reassembling them
 * cannot silently turn CRLF into LF or add a final newline nobody wrote.
 */
function splitLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let index = 0;

  while (index < source.length) {
    let end = index;
    while (end < source.length && source[end] !== "\n" && source[end] !== "\r") end += 1;

    const terminator =
      source[end] === "\r" && source[end + 1] === "\n" ? "\r\n" : (source[end] ?? "");
    lines.push({ text: source.slice(index, end), terminator });
    index = end + terminator.length;
  }

  return lines;
}

/** One `key=value` or bare flag from a fence's info string. */
type Attribute = readonly [key: string, value: string | true];

/** Splits an info string into its tag and attributes, honouring double quotes. */
function tokenizeInfo(info: string): { tag: string; attributes: Attribute[] } {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;

  for (const character of info) {
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);

  const [tag = "", ...rest] = tokens;
  const attributes = rest.map((token): Attribute => {
    const separator = token.indexOf("=");
    return separator === -1
      ? [token, true]
      : [token.slice(0, separator), token.slice(separator + 1)];
  });

  return { tag, attributes };
}

const declaresId = (attributes: readonly Attribute[]) => attributes.some(([key]) => key === "id");

function readBoolean(value: string | true): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * Builds the cooked view of a Cell from its fence, reporting every attribute it
 * cannot make sense of.
 */
function readCell(
  tag: CellType,
  attributes: readonly Attribute[],
  body: string,
  line: number,
  errors: Diagnostic[],
): Cell | undefined {
  let id: string | undefined;
  let uses: readonly string[] = [];
  let isolated = false;
  let model: string | undefined;
  let timeout: number | undefined;
  const seen = new Set<string>();

  for (const [key, value] of attributes) {
    if (seen.has(key)) {
      errors.push({ line, message: `Duplicate cell attribute "${key}"` });
      continue;
    }
    seen.add(key);

    if (!CELL_ATTRIBUTES.includes(key)) {
      errors.push({
        line,
        message: `Unknown cell attribute "${key}". Expected one of ${CELL_ATTRIBUTES.join(", ")}`,
      });
      continue;
    }

    if (key === "isolated") {
      const flag = readBoolean(value);
      if (flag === undefined) {
        errors.push({ line, message: `"isolated" must be true or false` });
        continue;
      }
      isolated = flag;
      continue;
    }

    if (value === true) {
      errors.push({ line, message: `Cell attribute "${key}" needs a value` });
      continue;
    }

    if (key === "id") {
      if (!isName(value)) {
        errors.push({ line, message: `Cell id "${value}" ${NAME_RULE}` });
        continue;
      }
      id = value;
      continue;
    }

    if (key === "type") {
      // The fence tag carries the type (ADR-0008), so a `type` attribute is
      // only ever a restatement of it. Letting it disagree would give one Cell
      // two types, and leave the reader guessing which one runs.
      if (value !== tag) {
        errors.push({ line, message: `Cell type "${value}" disagrees with its "${tag}" fence` });
      }
      continue;
    }

    if (key === "uses") {
      const names = value.split(",").map((name) => name.trim());
      if (names.some((name) => name === "")) {
        errors.push({ line, message: `"uses" has an empty entry` });
        continue;
      }
      // A repeated name collapses, because one Cell either depends on another
      // or does not: there is no second edge for it to have declared. The fence
      // keeps the author's bytes either way, as it already does for the
      // whitespace around these names.
      uses = [...new Set(names)];
      continue;
    }

    if (key === "model") model = value;

    if (key === "timeout") {
      timeout = parseDuration(value);
      if (timeout === undefined) errors.push({ line, message: `"timeout" ${DURATION_RULE}` });
    }
  }

  if (id === undefined) {
    errors.push({ line, message: MISSING_ID });
    return undefined;
  }

  return {
    id,
    type: tag,
    body,
    uses,
    isolated,
    ...(model !== undefined ? { model } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

function isClosingFence(text: string, marker: string): boolean {
  const trimmed = text.trimEnd();
  return (
    trimmed.length >= marker.length && [...trimmed].every((character) => character === marker[0])
  );
}

/**
 * Reports a fence that was probably meant as a Cell but cannot be one.
 *
 * A Cell nobody notices is worse than a Cell that fails: it silently never
 * runs. So the near misses — a mistyped tag, attributes with no tag in front of
 * them, an indented fence — are named rather than quietly left as Prose.
 */
function reportNearMiss(
  tag: string,
  attributes: readonly Attribute[],
  line: number,
  errors: Diagnostic[],
): void {
  if (tag.includes("=")) {
    errors.push({
      line,
      message: "Cell fence is missing its type: write ```prompt or ```bash before the attributes",
    });
    return;
  }

  // A bash fence with no id is a shell snippet in the documentation, not a
  // Cell (ADR-0008) — unless it carries an attribute only a Cell would have,
  // which is evidence enough of intent to report the missing id rather than
  // leave the author's Bash Cell silently never running.
  if (tag === "bash") {
    if (attributes.some(([key]) => CELL_ONLY_ATTRIBUTES.includes(key))) {
      errors.push({ line, message: MISSING_ID });
    }
    return;
  }

  if (declaresId(attributes)) {
    errors.push({
      line,
      message: `Unknown cell type "${tag}". Expected a prompt or bash fence`,
    });
  }
}

/**
 * Reports every reference in a Cell body that names no declared Input.
 *
 * @param firstLine the Notebook line the body starts on
 */
function reportUnknownReferences(
  body: string,
  firstLine: number,
  declared: ReadonlySet<string>,
  errors: Diagnostic[],
): void {
  for (const { name, offset } of referencesIn(body)) {
    if (declared.has(name)) continue;
    errors.push({
      line: firstLine + lineOffset(body, offset),
      message: `Unknown input "${name}". Declare it in the frontmatter, or write \\{{${name}}} to keep it as text`,
    });
  }
}

export function parseNotebook(source: string): ParseResult {
  const lines = splitLines(source);
  const errors: Diagnostic[] = [];

  let index = 0;
  let frontmatter: FrontmatterSource | undefined;
  let metadata: Metadata = {};

  // Only the very first line can open frontmatter, so a `---` thematic break
  // anywhere else is ordinary Prose. A Notebook that means to open with a
  // thematic break cannot, an ambiguity inherent to frontmatter and resolved
  // this way everywhere it is used.
  const opening = lines[0];
  if (opening && isFrontmatterDelimiter(opening.text)) {
    const close = lines.findIndex((line, at) => at > 0 && isFrontmatterDelimiter(line.text));
    if (close === -1) {
      return { ok: false, errors: [{ line: 1, message: "Frontmatter is never closed" }] };
    }

    const text = lines.slice(1, close).map(raw).join("");
    frontmatter = { text, open: opening, close: lines[close] ?? { text: "", terminator: "" } };
    metadata = readMetadata(text, 2, errors);
    index = close + 1;
  }

  const segments: Segment[] = [];
  let prose: string[] = [];
  const ids = new Set<string>();
  const placed: PlacedCell[] = [];
  // What a body may refer to: the declared Inputs, and the one name every Cell
  // has without declaring it — its artifact directory, which the Run supplies.
  const inputs = new Set([
    ARTIFACTS_REFERENCE,
    ...(metadata.inputs ?? []).map((input) => input.name),
  ]);

  const flushProse = () => {
    if (prose.length === 0) return;
    segments.push({ kind: "prose", text: prose.join("") });
    prose = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;

    const fence = FENCE.exec(line.text);
    if (!fence) {
      const indented = INDENTED_FENCE.exec(line.text);
      if (indented) {
        const { tag, attributes } = tokenizeInfo(indented[2] ?? "");
        if ((tag === "prompt" || tag === "bash") && declaresId(attributes)) {
          errors.push({
            line: index + 1,
            message: "A cell fence must start at the beginning of the line",
          });
        }
      }
      prose.push(raw(line));
      index += 1;
      continue;
    }

    const marker = fence[1] ?? "";
    const { tag, attributes } = tokenizeInfo(fence[2] ?? "");
    // A `bash` fence is a Cell only when it carries an id, so a shell snippet
    // shown as an example in Prose stays Prose. A `prompt` fence is always
    // meant as a Cell, so a missing id there is a mistake worth reporting.
    const isCell = tag === "prompt" || (tag === "bash" && declaresId(attributes));

    let close = index + 1;
    while (close < lines.length && !isClosingFence(lines[close]?.text ?? "", marker)) close += 1;

    if (close >= lines.length) {
      errors.push({
        line: index + 1,
        message: isCell ? "Cell fence is never closed" : "Fenced block is never closed",
      });
      break;
    }

    if (!isCell) {
      reportNearMiss(tag, attributes, index + 1, errors);
      // Skipped wholesale, so a Cell fence quoted inside a longer fence is
      // never mistaken for a Cell of its own.
      for (let at = index; at <= close; at += 1) {
        const inner = lines[at];
        if (inner) prose.push(raw(inner));
      }
      index = close + 1;
      continue;
    }

    const body = lines
      .slice(index + 1, close)
      .map(raw)
      .join("");
    const cell = readCell(tag, attributes, body, index + 1, errors);

    if (cell) {
      if (ids.has(cell.id)) {
        errors.push({ line: index + 1, message: `Duplicate cell id "${cell.id}"` });
      } else {
        ids.add(cell.id);
        placed.push({ cell, line: index + 1 });
        reportUnknownReferences(cell.body, index + 2, inputs, errors);
        flushProse();
        segments.push({
          kind: "cell",
          cell,
          open: line,
          close: lines[close] ?? { text: marker, terminator: "" },
        });
      }
    }

    index = close + 1;
  }

  flushProse();

  // Last, because an edge may name a Cell written further down the file: the
  // Graph decides what runs before what, so where a Cell sits does not.
  errors.push(...checkGraph(placed));

  // Sorted because the author reads them against the file, top to bottom, and
  // the Graph is checked after the scan rather than during it. Stable, so two
  // problems on one line stay in the order they were found.
  if (errors.length > 0) return { ok: false, errors: [...errors].sort((a, b) => a.line - b.line) };
  return { ok: true, notebook: { metadata, ...(frontmatter ? { frontmatter } : {}), segments } };
}

export function serialiseNotebook(notebook: Notebook): string {
  const parts: string[] = [];

  const { frontmatter } = notebook;
  if (frontmatter) {
    parts.push(raw(frontmatter.open), frontmatter.text, raw(frontmatter.close));
  }

  for (const segment of notebook.segments) {
    if (segment.kind === "prose") {
      parts.push(segment.text);
      continue;
    }
    parts.push(raw(segment.open), segment.cell.body, raw(segment.close));
  }

  return parts.join("");
}

/**
 * Replaces one Cell's body, leaving every other byte of the file alone.
 *
 * The operation the editor needs: because the framing is untouched and every
 * other segment is the same value, serialising the result can only differ from
 * the original inside this Cell.
 *
 * Throws when no Cell has the id. Unlike a malformed Notebook, which is the
 * author's mistake to see and fix, this is the caller's own bug.
 */
export function replaceCellBody(notebook: Notebook, id: string, body: string): Notebook {
  if (!notebook.segments.some((segment) => isCellSegment(segment) && segment.cell.id === id)) {
    throw new Error(`No cell with id "${id}" in this notebook`);
  }

  return {
    ...notebook,
    segments: notebook.segments.map((segment) =>
      isCellSegment(segment) && segment.cell.id === id
        ? { ...segment, cell: { ...segment.cell, body } }
        : segment,
    ),
  };
}
