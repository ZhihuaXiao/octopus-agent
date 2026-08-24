/**
 * A minimal Notebook parser: frontmatter, Prompt Cells, and Prose.
 *
 * Deliberately the thinnest thing the tracer bullet needs. Ticket 03 owns the
 * complete format contract and the byte-identical round-trip property test that
 * ADR-0002 requires, so nothing here tries to serialise or preserve layout.
 */

export type CellType = "prompt";

export interface Cell {
  id: string;
  type: CellType;
  body: string;
}

export interface Notebook {
  title?: string;
  /** The directory the Notebook operates on, relative to the Notebook itself. */
  workspace?: string;
  model?: string;
  cells: Cell[];
}

export class NotebookParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (line ${line})`);
    this.name = "NotebookParseError";
  }
}

const FRONTMATTER_FENCE = "---";
const CELL_FENCE = "```";

function parseFrontmatter(lines: string[]): { fields: Map<string, string>; next: number } {
  const fields = new Map<string, string>();
  if (lines[0] !== FRONTMATTER_FENCE) return { fields, next: 0 };

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === FRONTMATTER_FENCE) return { fields, next: index + 1 };

    if (line.trim() === "") continue;
    const separator = line.indexOf(":");
    if (separator === -1) {
      throw new NotebookParseError(`Expected a "key: value" pair in frontmatter`, index + 1);
    }
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }

  throw new NotebookParseError("Frontmatter is never closed", 1);
}

function parseAttributes(tokens: string[]): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (separator === -1) continue;
    attributes.set(token.slice(0, separator), token.slice(separator + 1));
  }
  return attributes;
}

/**
 * Reads `prompt id=greet` from a fence's info string, or returns undefined for
 * a fence that is ordinary Prose.
 *
 * A `bash` fence is only a Cell when it carries an id, so a shell snippet shown
 * as an example stays Prose. Throwing on one that does carry an id keeps a Bash
 * Cell from being silently dropped before ticket 04 can run it.
 */
function parseInfo(
  info: string,
  line: number,
): { type: CellType; attributes: Map<string, string> } | undefined {
  const [tag, ...rest] = info.trim().split(/\s+/);
  const attributes = parseAttributes(rest);

  if (tag === "bash" && attributes.has("id")) {
    throw new NotebookParseError("Bash cells are not supported yet (ticket 04)", line);
  }
  if (tag !== "prompt") return undefined;

  return { type: tag, attributes };
}

export function parseNotebook(source: string): Notebook {
  const lines = source.split("\n");
  const { fields, next } = parseFrontmatter(lines);

  const cells: Cell[] = [];
  const seen = new Set<string>();

  for (let index = next; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.startsWith(CELL_FENCE)) continue;

    const info = parseInfo(line.slice(CELL_FENCE.length), index + 1);
    // A fence that is not a Cell is ordinary Prose — a code sample, say — and
    // is skipped along with everything up to its closing fence, so a `prompt`
    // fence quoted inside it is never mistaken for a Cell.
    const close = lines.findIndex((candidate, at) => at > index && candidate.trim() === CELL_FENCE);
    if (close === -1) {
      throw new NotebookParseError("Fenced block is never closed", index + 1);
    }

    if (info) {
      const id = info.attributes.get("id");
      if (!id) throw new NotebookParseError("Cell is missing an id", index + 1);
      if (seen.has(id)) throw new NotebookParseError(`Duplicate cell id "${id}"`, index + 1);
      seen.add(id);
      cells.push({
        id,
        type: info.type,
        body: lines
          .slice(index + 1, close)
          .join("\n")
          .trim(),
      });
    }

    index = close;
  }

  const notebook: Notebook = { cells };
  const title = fields.get("title");
  const workspace = fields.get("workspace");
  const model = fields.get("model");
  if (title !== undefined) notebook.title = title;
  if (workspace !== undefined) notebook.workspace = workspace;
  if (model !== undefined) notebook.model = model;
  return notebook;
}
