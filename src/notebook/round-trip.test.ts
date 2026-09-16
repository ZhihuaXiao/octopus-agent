/**
 * The round-trip property.
 *
 * Sits below the runner seam the spec designates for most testing, which it
 * says is the one narrow exception worth making: format fidelity is invisible
 * from above, and an editor that reformats a Notebook on every save destroys
 * the reviewability the Markdown format exists for.
 *
 * The generator's job is to be nastier than a person would be on purpose —
 * CRLF files, trailing whitespace, blank lines in frontmatter, YAML comments,
 * long fences with shorter fences inside them, files that stop without a final
 * newline.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { applyEdit, editOf } from "./edit.js";
import {
  cellsOf,
  formatDiagnostics,
  parseNotebook,
  replaceCellBody,
  serialiseNotebook,
} from "./notebook.js";

const PROSE_LINES = [
  "",
  "Some prose explaining the work.",
  "# A heading",
  "## Another heading",
  "- a list item",
  "  - a nested list item",
  "> a quotation",
  "Text with `inline code` in it.",
  "    an indented block",
  "A line with trailing spaces   ",
  "Unicode: café — ✓ 日本語",
  "A [link](https://example.com).",
  "1. a numbered item",
  "| a | table |",
  "Text with a --- dash run inside it.",
];

/** Fenced blocks that are Prose rather than Cells, fences included. */
const PROSE_FENCES = [
  ["```js", "const x = 1;", "```"],
  ["```", "an unlabelled block", "```"],
  ["~~~text", "a tilde-fenced block", "~~~"],
  ["```bash", "npm run build", "```"],
  ["````markdown", "```prompt id=quoted", "not a real cell", "```", "````"],
];

const BODY_LINES = [
  "Do the thing.",
  "",
  "Explain what you found, briefly.",
  "    an indented instruction",
  "A body line with trailing spaces  ",
  "Use `ls` to look around.",
  "npm run build -- --flag",
  "Unicode: naïve ✓",
  "A line with a --- dash run.",
  // Braces that are not input references, which a body may hold whether or not
  // the Notebook declares any inputs: a Go template, and an escaped reference.
  'docker inspect -f "{{.State.Status}}" web',
  "kubectl get pods -o go-template='{{range .items}}x\\{{end}}'",
];

const FRONTMATTER_VARIANTS: readonly (readonly string[])[][] = [
  [["title: Dependency audit"], ['title: "A quoted title"'], ["title: Report"]],
  [["mode: code"], ["mode: work"]],
  [["workspace: ."], ["workspace: ../service"]],
  [["model: anthropic/claude-sonnet-4"], ["model: openai/gpt-5"]],
  [["pi_version: 0.84.2"], ['pi_version: "1.0"']],
  [["tools: [bash, read]"], ["tools:", "  - bash", "  - read"]],
  [["skills: [reviewing]"], ["skills:", "  - reviewing", "  - reporting"]],
  [["packages: [pi-subagents]"], ["packages:", "  - pi-subagents"]],
  [
    ["inputs:", "  - name: target", "    type: string", "    default: src"],
    [
      "inputs:",
      "  - name: target",
      '    description: "Where to look"',
      "  - name: strict",
      "    default: false",
    ],
  ],
  [["# a comment in the frontmatter"], [""], ["", "# a comment after a blank line"]],
];

interface ProseShape {
  readonly kind: "prose";
  readonly lines: readonly string[];
}

interface CellShape {
  readonly kind: "cell";
  readonly fenceLength: number;
  readonly tag: "prompt" | "bash";
  readonly separator: string;
  readonly declaresIsolated: string | undefined;
  readonly model: string | undefined;
  readonly declaresUses: boolean;
  readonly infoSuffix: string;
  readonly closeSuffix: string;
  readonly bodyLines: readonly string[];
}

type Shape = ProseShape | CellShape;

const proseShape: fc.Arbitrary<Shape> = fc
  .array(fc.constantFrom(...PROSE_LINES), { minLength: 1, maxLength: 4 })
  .map((lines) => ({ kind: "prose", lines }));

const proseFenceShape: fc.Arbitrary<Shape> = fc
  .constantFrom(...PROSE_FENCES)
  .map((lines) => ({ kind: "prose", lines }));

const cellShape: fc.Arbitrary<Shape> = fc.record({
  kind: fc.constant("cell" as const),
  fenceLength: fc.integer({ min: 3, max: 5 }),
  tag: fc.constantFrom("prompt" as const, "bash" as const),
  separator: fc.constantFrom(" ", "  "),
  declaresIsolated: fc.constantFrom(undefined, "isolated", "isolated=true", "isolated=false"),
  model: fc.constantFrom(undefined, "openai/gpt-5", "anthropic/claude-sonnet-4"),
  declaresUses: fc.boolean(),
  infoSuffix: fc.constantFrom("", "  "),
  closeSuffix: fc.constantFrom("", "  "),
  bodyLines: fc.array(fc.constantFrom(...BODY_LINES), { maxLength: 5 }),
});

interface GeneratedNotebook {
  readonly source: string;
  /** Every generated Cell's id and the exact body text the parser should see. */
  readonly cells: readonly { id: string; body: string }[];
}

interface Draft {
  readonly frontmatter: readonly (readonly string[])[] | undefined;
  readonly shapes: readonly Shape[];
  readonly newline: string;
  readonly finalNewline: boolean;
  /** Marks each body with its own id, so a body is unique within a Notebook. */
  readonly uniqueBodies: boolean;
}

function render(draft: Draft): GeneratedNotebook {
  const lines: string[] = [];
  const cells: { id: string; body: string }[] = [];

  if (draft.frontmatter) {
    lines.push("---");
    for (const block of draft.frontmatter) lines.push(...block);
    lines.push("---");
  }

  for (const shape of draft.shapes) {
    if (shape.kind === "prose") {
      lines.push(...shape.lines);
      continue;
    }

    const id = `cell${cells.length}`;
    const fence = "`".repeat(shape.fenceLength);
    const attributes = [`id=${id}`];

    if (shape.declaresUses && cells.length > 0) {
      attributes.push(`uses=${cells.map((cell) => cell.id).join(",")}`);
    }
    if (shape.declaresIsolated) attributes.push(shape.declaresIsolated);
    if (shape.model) attributes.push(`model=${shape.model}`);

    // A fence longer than three backticks can hold a shorter fence in its body,
    // which is the case a naive scan for the next ``` gets wrong.
    const bodyLines = [
      ...shape.bodyLines,
      ...(shape.fenceLength > 3 ? ["```"] : []),
      ...(draft.uniqueBodies ? [`-- ${id}`] : []),
    ];

    lines.push(
      `${fence}${shape.tag}${shape.separator}${attributes.join(shape.separator)}${shape.infoSuffix}`,
      ...bodyLines,
      `${fence}${shape.closeSuffix}`,
    );
    cells.push({
      id,
      body: bodyLines.map((line) => line + draft.newline).join(""),
    });
  }

  const source =
    lines.join(draft.newline) + (draft.finalNewline && lines.length > 0 ? draft.newline : "");
  return { source, cells };
}

const generated = (options: {
  uniqueBodies: boolean;
  minCells: number;
}): fc.Arbitrary<GeneratedNotebook> =>
  fc
    .record({
      frontmatter: fc.option(
        fc.tuple(
          ...FRONTMATTER_VARIANTS.map((variants) =>
            fc.option(fc.constantFrom(...variants), { nil: undefined }),
          ),
        ),
        { nil: undefined },
      ),
      shapes: fc.array(fc.oneof(proseShape, proseFenceShape, cellShape, cellShape), {
        maxLength: 8,
      }),
      newline: fc.constantFrom("\n", "\r\n"),
      finalNewline: fc.boolean(),
    })
    .map(({ frontmatter, shapes, newline, finalNewline }) =>
      render({
        frontmatter: frontmatter?.filter(
          (block): block is readonly string[] => block !== undefined,
        ),
        shapes,
        newline,
        finalNewline,
        uniqueBodies: options.uniqueBodies,
      }),
    )
    .filter((notebook) => notebook.cells.length >= options.minCells);

const notebooks = generated({ uniqueBodies: false, minCells: 0 });
const editableNotebooks = generated({ uniqueBodies: true, minCells: 1 });

/** Parses a generated Notebook, treating any diagnostic as a generator bug. */
function parsed(notebook: GeneratedNotebook) {
  const result = parseNotebook(notebook.source);
  if (!result.ok) {
    throw new Error(
      `a generated notebook was rejected (${formatDiagnostics(result.errors)}):\n${JSON.stringify(notebook.source)}`,
    );
  }
  return result.notebook;
}

describe("round-trip property", () => {
  it("serialises a parsed notebook back to the bytes it came from", () => {
    fc.assert(
      fc.property(notebooks, (notebook) => {
        expect(serialiseNotebook(parsed(notebook))).toBe(notebook.source);
      }),
      { numRuns: 1000 },
    );
  });

  it("finds every generated cell, with its body exactly as written", () => {
    fc.assert(
      fc.property(notebooks, (notebook) => {
        expect(cellsOf(parsed(notebook)).map((cell) => ({ id: cell.id, body: cell.body }))).toEqual(
          notebook.cells,
        );
      }),
      { numRuns: 500 },
    );
  });

  it("changes nothing outside a cell whose body is replaced", () => {
    fc.assert(
      fc.property(editableNotebooks, fc.nat(), (notebook, choice) => {
        const target = notebook.cells[choice % notebook.cells.length];
        if (!target) throw new Error("expected a generated cell to edit");

        const edited = serialiseNotebook(
          replaceCellBody(parsed(notebook), target.id, "A replaced body.\n"),
        );

        // The generated bodies are unique, so putting the original back is a
        // check that nothing else moved: any other change would survive it.
        expect(edited.replace("A replaced body.\n", target.body)).toBe(notebook.source);
      }),
      { numRuns: 500 },
    );
  });

  it("reproduces the bytes from an edit that describes the notebook as it stands", () => {
    fc.assert(
      fc.property(notebooks, (notebook) => {
        const before = parsed(notebook);
        const result = applyEdit(before, editOf(before));

        expect(result.ok && result.source).toBe(notebook.source);
      }),
      { numRuns: 1000 },
    );
  });

  it("changes nothing outside a cell whose body an edit replaces", () => {
    fc.assert(
      fc.property(editableNotebooks, fc.nat(), (notebook, choice) => {
        const target = notebook.cells[choice % notebook.cells.length];
        if (!target) throw new Error("expected a generated cell to edit");
        const before = parsed(notebook);
        const edit = editOf(before);

        const result = applyEdit(before, {
          ...edit,
          segments: edit.segments.map((segment) =>
            segment.kind === "cell" && segment.id === target.id
              ? { ...segment, body: "A replaced body." }
              : segment,
          ),
        });

        if (!result.ok) throw new Error(formatDiagnostics(result.errors));
        const newline = notebook.source.includes("\r\n") ? "\r\n" : "\n";
        expect(result.source.replace(`A replaced body.${newline}`, target.body)).toBe(
          notebook.source,
        );
      }),
      { numRuns: 500 },
    );
  });
});
