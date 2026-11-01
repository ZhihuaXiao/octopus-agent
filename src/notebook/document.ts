/**
 * NotebookDocument: an immutable value-object representing a Notebook document,
 * its AST, frontmatter, and cell segments.
 *
 * Encapsulates byte-preserving edits (ADR-0002), frontmatter mutation, branch
 * slicing, cell lookup, and serialization behind a unified deep document module.
 */

import { createHash } from "node:crypto";

import { type Diagnostic } from "./diagnostic.js";
import { formatDuration, parseDuration } from "./duration.js";
import {
  type Cell,
  type CellSegment,
  type CellType,
  type Metadata,
  type Notebook,
  type ParseResult,
  type PromptApproach,
  type Segment,
  type SourceLine,
  cellsOf,
  isCellSegment,
  modelOf,
  parseNotebook,
  serialiseNotebook,
  timeoutOf,
  titleOf,
  workspaceOf,
} from "./notebook.js";

export interface CellEdit {
  readonly kind: "cell";
  readonly id: string;
  readonly type: CellType;
  readonly body: string;
  readonly uses: readonly string[];
  readonly isolated: boolean;
  readonly approach?: PromptApproach | undefined;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
  readonly timeout?: string | undefined;
}

export interface ProseEdit {
  readonly kind: "prose";
  readonly text: string;
}

export type SegmentEdit = CellEdit | ProseEdit;

export interface NotebookEdit {
  readonly frontmatter?: string | undefined;
  readonly segments: readonly SegmentEdit[];
}

export type EditResult<T = NotebookDocument> =
  | {
      readonly ok: true;
      readonly document: T;
      readonly notebook: Notebook;
      readonly source: string;
    }
  | { readonly ok: false; readonly errors: readonly Diagnostic[] };

const FRONTMATTER_DELIMITER = "---";

const raw = (line: SourceLine) => line.text + line.terminator;
const contentOf = (body: string) => body.replace(/\r?\n$/, "");

function declarationOf(cell: Cell): CellEdit {
  return {
    kind: "cell",
    id: cell.id,
    type: cell.type,
    body: contentOf(cell.body),
    uses: cell.uses,
    isolated: cell.isolated,
    ...(cell.approach !== undefined ? { approach: cell.approach } : {}),
    ...(cell.model !== undefined ? { model: cell.model } : {}),
    ...(cell.thinking !== undefined ? { thinking: cell.thinking } : {}),
    ...(cell.timeout !== undefined ? { timeout: formatDuration(cell.timeout) } : {}),
  };
}

export function editOf(notebook: Notebook): NotebookEdit {
  return {
    ...(notebook.frontmatter !== undefined ? { frontmatter: notebook.frontmatter.text } : {}),
    segments: notebook.segments.map((segment) =>
      isCellSegment(segment) ? declarationOf(segment.cell) : { kind: "prose", text: segment.text },
    ),
  };
}

function newlineOf(notebook: Notebook): string {
  if (notebook.frontmatter !== undefined) return notebook.frontmatter.open.terminator;
  for (const segment of notebook.segments) {
    if (isCellSegment(segment)) return segment.open.terminator;
    const found = /\r?\n/.exec(segment.text);
    if (found !== null) return found[0];
  }
  return "\n";
}

function framed(text: string, newline: string): string {
  const lines = text.replace(/\r\n|\r|\n/g, newline);
  return lines === "" || lines.endsWith(newline) ? lines : lines + newline;
}

const closed = (body: string, newline: string) =>
  body === "" ? "" : body.replace(/\r\n|\r|\n/g, newline) + newline;

function sameDeclaration(cell: Cell, edit: CellEdit): boolean {
  const timeout = edit.timeout === undefined ? undefined : parseDuration(edit.timeout);
  return (
    cell.id === edit.id &&
    cell.type === edit.type &&
    cell.uses.length === edit.uses.length &&
    cell.uses.every((used, at) => used === edit.uses[at]) &&
    cell.isolated === edit.isolated &&
    (cell.approach ?? "agent") === (edit.approach ?? "agent") &&
    cell.model === edit.model &&
    cell.thinking === edit.thinking &&
    (edit.timeout === undefined
      ? cell.timeout === undefined
      : timeout !== undefined && cell.timeout === timeout)
  );
}

const attribute = (key: string, value: string) =>
  `${key}=${/\s/.test(value) ? `"${value}"` : value}`;

function infoOf(edit: CellEdit): string {
  const parts = [edit.type, attribute("id", edit.id)];
  if (edit.uses.length > 0) parts.push(attribute("uses", edit.uses.join(",")));
  if (edit.isolated) parts.push("isolated");
  if (edit.approach === "plan" || edit.approach === "ask") {
    parts.push(attribute("approach", edit.approach));
  }
  if (edit.model !== undefined) parts.push(attribute("model", edit.model));
  if (edit.thinking !== undefined) parts.push(attribute("thinking", edit.thinking));
  if (edit.timeout !== undefined) parts.push(attribute("timeout", edit.timeout));
  return parts.join(" ");
}

function markerFor(body: string, previous: string | undefined): string {
  const character = previous?.[0] ?? "`";
  const runs = [...body.matchAll(new RegExp(`^[${character}]+`, "gm"))].map((run) => run[0].length);
  const length = Math.max(3, previous?.length ?? 0, ...runs.map((run) => run + 1));
  return character.repeat(length);
}

const markerOf = (segment: CellSegment) => /^(`{3,}|~{3,})/.exec(segment.open.text)?.[1] ?? "```";

function applyEditToNotebook(
  notebook: Notebook,
  edit: NotebookEdit,
): { ok: true; notebook: Notebook; source: string } | { ok: false; errors: readonly Diagnostic[] } {
  const newline = newlineOf(notebook);
  const existing = new Map(
    notebook.segments.filter(isCellSegment).map((segment) => [segment.cell.id, segment]),
  );
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

export function branchAt(notebook: Notebook, cell: string): NotebookEdit | undefined {
  const at = notebook.segments.findIndex(
    (segment) => isCellSegment(segment) && segment.cell.id === cell,
  );
  if (at < 0) return undefined;
  const kept = new Set(
    notebook.segments
      .slice(0, at + 1)
      .flatMap((segment) => (isCellSegment(segment) ? [segment.cell.id] : [])),
  );
  const current = editOf(notebook);
  return {
    ...(current.frontmatter !== undefined ? { frontmatter: current.frontmatter } : {}),
    segments: current.segments
      .slice(0, at + 1)
      .map((segment) =>
        segment.kind === "cell"
          ? { ...segment, uses: segment.uses.filter((used) => kept.has(used)) }
          : segment,
      ),
  };
}

export function frontmatterWithField(
  frontmatter: string | undefined,
  field: string,
  value: string | undefined,
): string | undefined {
  const lines = frontmatter?.split(/\r?\n/) ?? [];
  const next = lines.filter((line) => !new RegExp(`^\\s*${field}:`).test(line));
  if (value !== undefined) {
    next.push(`${field}: ${value.includes(" ") ? `"${value}"` : value}`);
  }
  const filtered = next.filter((line) => line.trim() !== "");
  if (filtered.length === 0) return undefined;
  return filtered.join("\n") + "\n";
}

export function notebookWithModel(
  notebook: Notebook,
  model: string | undefined,
): EditResult<NotebookDocument> {
  const frontmatter = frontmatterWithField(notebook.frontmatter?.text, "model", model);
  const current = editOf(notebook);
  const applied = applyEditToNotebook(notebook, { ...current, frontmatter });
  if (!applied.ok) return applied;
  return {
    ok: true,
    document: new NotebookDocument(applied.source, applied.notebook),
    notebook: applied.notebook,
    source: applied.source,
  };
}

export function notebookWithMode(
  notebook: Notebook,
  mode: string | undefined,
): EditResult<NotebookDocument> {
  const frontmatter = frontmatterWithField(notebook.frontmatter?.text, "mode", mode);
  const current = editOf(notebook);
  const applied = applyEditToNotebook(notebook, { ...current, frontmatter });
  if (!applied.ok) return applied;
  return {
    ok: true,
    document: new NotebookDocument(applied.source, applied.notebook),
    notebook: applied.notebook,
    source: applied.source,
  };
}

export type DocumentParseResult =
  | { readonly ok: true; readonly notebook: Notebook; readonly document: NotebookDocument }
  | { readonly ok: false; readonly errors: readonly Diagnostic[] };

export class NotebookDocument {
  constructor(
    readonly source: string,
    readonly notebook: Notebook,
  ) {}

  static parse(source: string): DocumentParseResult {
    const parsed = parseNotebook(source);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      notebook: parsed.notebook,
      document: new NotebookDocument(source, parsed.notebook),
    };
  }

  static empty(): NotebookDocument {
    const emptySource = "```prompt id=cell-1\n```\n";
    const parsed = parseNotebook(emptySource);
    if (!parsed.ok) throw new Error("A new empty notebook does not parse");
    return new NotebookDocument(emptySource, parsed.notebook);
  }

  get revision(): string {
    return createHash("sha256").update(this.source).digest("hex");
  }

  get metadata(): Metadata {
    return this.notebook.metadata;
  }

  get segments(): readonly Segment[] {
    return this.notebook.segments;
  }

  get cells(): readonly Cell[] {
    return cellsOf(this.notebook);
  }

  cell(id: string): Cell | undefined {
    return this.cells.find((c) => c.id === id);
  }

  title(path?: string): string {
    return titleOf(this.notebook, path ?? "");
  }

  workspace(path: string): string {
    return workspaceOf(this.notebook, path);
  }

  model(cell?: Cell): string | undefined {
    return cell !== undefined ? modelOf(this.notebook, cell) : this.notebook.metadata.model;
  }

  mode(): string | undefined {
    return this.notebook.metadata.mode;
  }

  timeout(cell: Cell): number | undefined {
    return timeoutOf(this.notebook, cell);
  }

  edit(): NotebookEdit {
    return editOf(this.notebook);
  }

  apply(edit: NotebookEdit): EditResult<NotebookDocument> {
    const applied = applyEditToNotebook(this.notebook, edit);
    if (!applied.ok) return applied;
    return {
      ok: true,
      document: new NotebookDocument(applied.source, applied.notebook),
      notebook: applied.notebook,
      source: applied.source,
    };
  }

  branchAt(cellId: string): NotebookDocument | undefined {
    const edit = branchAt(this.notebook, cellId);
    if (edit === undefined) return undefined;
    const applied = this.apply(edit);
    return applied.ok ? applied.document : undefined;
  }

  setModel(model: string | undefined): EditResult<NotebookDocument> {
    return notebookWithModel(this.notebook, model);
  }

  setMode(mode: string | undefined): EditResult<NotebookDocument> {
    return notebookWithMode(this.notebook, mode);
  }

  serialize(): string {
    return this.source;
  }
}

// Standalone functions for backward compatibility without wrapping layers
export function applyEdit(
  notebook: Notebook,
  edit: NotebookEdit,
):
  | { readonly ok: true; readonly notebook: Notebook; readonly source: string }
  | { readonly ok: false; readonly errors: readonly Diagnostic[] } {
  return applyEditToNotebook(notebook, edit);
}
