import { describe, expect, it } from "vitest";

import {
  cellsOf,
  formatDiagnostics,
  isCellSegment,
  parseNotebook,
  replaceCellBody,
  serialiseNotebook,
} from "./notebook.js";

/** Parses a Notebook the test expects to be well-formed, reporting why if it isn't. */
function valid(source: string) {
  const result = parseNotebook(source);
  if (!result.ok) {
    throw new Error(`expected a well-formed notebook, got ${formatDiagnostics(result.errors)}`);
  }
  return result.notebook;
}

const roundTrip = (source: string) => serialiseNotebook(valid(source));

describe("round-trip fidelity", () => {
  it("returns frontmatter, prose and a cell exactly as written", () => {
    const source = `---
title: Greeting
---

Some prose introducing the work.

\`\`\`prompt id=greet
Say hello.
\`\`\`
`;

    expect(roundTrip(source)).toBe(source);
  });

  it("preserves the blank lines around and between cells", () => {
    const source = `---
title: Spacing
---


Prose after two blank lines.



\`\`\`prompt id=first
Do the first thing.
\`\`\`


\`\`\`prompt id=second
Do the second thing.
\`\`\`


Trailing prose after blank lines.


`;

    expect(roundTrip(source)).toBe(source);
  });

  it("preserves a cell body's own indentation and blank lines", () => {
    const source = `\`\`\`prompt id=analyse
First line.

    an indented line

Last line.
\`\`\`
`;

    expect(roundTrip(source)).toBe(source);
    expect(valid(source).segments).toEqual([
      expect.objectContaining({
        kind: "cell",
        cell: expect.objectContaining({
          body: "First line.\n\n    an indented line\n\nLast line.\n",
        }),
      }),
    ]);
  });

  it("returns a notebook with no frontmatter unchanged", () => {
    const source = `Just prose and a cell.

\`\`\`prompt id=only
Do the thing.
\`\`\`
`;

    expect(roundTrip(source)).toBe(source);
  });

  it("returns a file that does not end in a newline unchanged", () => {
    const source = `\`\`\`prompt id=only
Do the thing.
\`\`\``;

    expect(roundTrip(source)).toBe(source);
  });

  it("preserves CRLF line endings rather than normalising them", () => {
    const source =
      "---\r\ntitle: Windows\r\n---\r\n\r\nProse.\r\n\r\n```prompt id=only\r\nDo it.\r\n```\r\n";

    expect(roundTrip(source)).toBe(source);
  });

  it("keeps a fenced block that is not a cell as prose, verbatim", () => {
    const source = `Run it like this:

\`\`\`bash
npm run notebook
\`\`\`

\`\`\`prompt id=greet
Say hello.
\`\`\`
`;

    expect(roundTrip(source)).toBe(source);
    expect(valid(source).segments.filter(isCellSegment)).toHaveLength(1);
  });

  it("returns an empty notebook unchanged", () => {
    expect(roundTrip("")).toBe("");
    expect(valid("").segments).toEqual([]);
  });

  it("keeps a thematic break in prose as prose", () => {
    const source = `Some prose.

---

More prose after the break.
`;

    expect(roundTrip(source)).toBe(source);
    expect(valid(source).frontmatter).toBeUndefined();
  });

  it("does not mistake a cell fence quoted inside a prose block for a cell", () => {
    const source = `An example of the format:

\`\`\`\`markdown
\`\`\`prompt id=example
Not a real cell.
\`\`\`
\`\`\`\`
`;

    expect(roundTrip(source)).toBe(source);
    expect(valid(source).segments.filter(isCellSegment)).toEqual([]);
  });
});

describe("frontmatter", () => {
  it("parses every field in the format contract", () => {
    const source = `---
title: Dependency audit
mode: code
workspace: ../service
model: anthropic/claude-sonnet-4
pi_version: 0.84.2
tools:
  - bash
  - read
skills: [reviewing, reporting]
packages:
  - pi-subagents
inputs:
  - name: target
    type: string
    default: src
    description: The directory to audit
  - name: strict
    type: boolean
    default: false
---
`;

    expect(valid(source).metadata).toEqual({
      title: "Dependency audit",
      mode: "code",
      workspace: "../service",
      model: "anthropic/claude-sonnet-4",
      piVersion: "0.84.2",
      tools: ["bash", "read"],
      skills: ["reviewing", "reporting"],
      packages: ["pi-subagents"],
      inputs: [
        { name: "target", type: "string", default: "src", description: "The directory to audit" },
        { name: "strict", type: "boolean", default: false },
      ],
    });
    expect(roundTrip(source)).toBe(source);
  });

  it("takes an input's type from its default when it declares none", () => {
    const source = `---
inputs:
  - name: retries
    default: 3
  - name: strict
    default: false
  - name: target
    default: src
---
`;

    expect(valid(source).metadata.inputs).toEqual([
      { name: "retries", type: "number", default: 3 },
      { name: "strict", type: "boolean", default: false },
      { name: "target", type: "string", default: "src" },
    ]);
  });

  it("treats an input with neither type nor default as a required string", () => {
    expect(valid("---\ninputs:\n  - name: target\n---\n").metadata.inputs).toEqual([
      { name: "target", type: "string" },
    ]);
  });

  it("reports no metadata for a notebook without frontmatter", () => {
    expect(valid("Just prose.\n").metadata).toEqual({});
    expect(valid("Just prose.\n").frontmatter).toBeUndefined();
  });

  it("reports no metadata for empty frontmatter, keeping the block", () => {
    const source = "---\n---\n\nProse.\n";

    expect(valid(source).metadata).toEqual({});
    expect(roundTrip(source)).toBe(source);
  });
});

describe("cell attributes", () => {
  it("parses every attribute in the format contract", () => {
    // The cells `audit` names are declared too, because an edge naming no cell
    // is a malformed notebook rather than an attribute parsed successfully.
    const source = `---
title: Attributes
---

\`\`\`prompt id=audit uses=collect,summarise isolated model=openai/gpt-5
Do the work.
\`\`\`

\`\`\`prompt id=collect
Collect it.
\`\`\`

\`\`\`prompt id=summarise
Summarise it.
\`\`\`
`;

    const [cell] = cellsOf(valid(source));

    expect(cell).toEqual({
      id: "audit",
      type: "prompt",
      body: "Do the work.\n",
      uses: ["collect", "summarise"],
      isolated: true,
      model: "openai/gpt-5",
    });
  });

  it("defaults a cell to shared context and no dependencies", () => {
    const [cell] = cellsOf(valid("```prompt id=only\nDo it.\n```\n"));

    expect(cell?.isolated).toBe(false);
    expect(cell?.uses).toEqual([]);
    expect(cell?.model).toBeUndefined();
  });

  it("parses a bash cell as a cell of its own type", () => {
    const [cell] = cellsOf(valid("```bash id=build\nnpm run build\n```\n"));

    expect(cell).toEqual({
      id: "build",
      type: "bash",
      body: "npm run build\n",
      uses: [],
      isolated: false,
    });
  });

  it("accepts isolated written as an explicit boolean", () => {
    expect(cellsOf(valid("```prompt id=a isolated=true\nx\n```\n"))[0]?.isolated).toBe(true);
    expect(cellsOf(valid("```prompt id=a isolated=false\nx\n```\n"))[0]?.isolated).toBe(false);
  });

  it("accepts a quoted attribute value containing spaces", () => {
    const source =
      '```prompt id=a uses="first, second"\nx\n```\n\n```prompt id=first\nx\n```\n\n```prompt id=second\nx\n```\n';

    expect(cellsOf(valid(source))[0]?.uses).toEqual(["first", "second"]);
  });

  it("accepts a type attribute that restates the fence tag", () => {
    expect(cellsOf(valid("```prompt id=a type=prompt\nx\n```\n"))[0]?.type).toBe("prompt");
  });
});

/** The problems reported for a notebook the test expects to be malformed. */
function problems(source: string) {
  const result = parseNotebook(source);
  if (result.ok) throw new Error("expected the notebook to be reported as malformed");
  return result.errors;
}

describe("malformed notebooks", () => {
  it("reports a problem instead of throwing", () => {
    expect(() => parseNotebook("```prompt\nno id\n```\n")).not.toThrow();
    expect(parseNotebook("```prompt\nno id\n```\n").ok).toBe(false);
  });

  it("reports frontmatter that is never closed", () => {
    expect(problems("---\ntitle: x\n\nProse.\n")).toEqual([
      { line: 1, message: expect.stringContaining("never closed") },
    ]);
  });

  it("reports invalid YAML at the line it went wrong", () => {
    const [error] = problems("---\ntitle: a\n\tbad: b\n---\n");

    expect(error?.line).toBe(3);
    expect(error?.message).toContain("Tabs are not allowed");
  });

  it("reports a frontmatter field of the wrong type at its own line", () => {
    expect(problems("---\ntitle: Fine\nworkspace: 3\n---\n")).toEqual([
      { line: 3, message: `Frontmatter field "workspace" must be a string` },
    ]);
  });

  it("reports a list field that is not a list", () => {
    expect(problems("---\ntools: bash\n---\n")).toEqual([
      { line: 2, message: `Frontmatter field "tools" must be a list of strings` },
    ]);
  });

  it("reports a non-string entry inside a list field", () => {
    expect(problems("---\nskills:\n  - reviewing\n  - 7\n---\n")).toEqual([
      { line: 4, message: `Every entry in "skills" must be a string` },
    ]);
  });

  it("reports an input with no name", () => {
    expect(problems("---\ninputs:\n  - type: string\n---\n")).toEqual([
      { line: 3, message: "An input is missing its name" },
    ]);
  });

  it("reports an input name a cell body could not reference", () => {
    const [error] = problems("---\ninputs:\n  - name: the target\n---\n");

    expect(error?.line).toBe(3);
    expect(error?.message).toContain(`Input name "the target"`);
  });

  it("reports an input type that is not one an input can hold", () => {
    const [error] = problems("---\ninputs:\n  - name: retries\n    type: integer\n---\n");

    expect(error?.line).toBe(4);
    expect(error?.message).toContain(`Unknown input type "integer"`);
  });

  it("reports a default that disagrees with the type its input declares", () => {
    expect(
      problems("---\ninputs:\n  - name: retries\n    type: number\n    default: many\n---\n"),
    ).toEqual([{ line: 5, message: `Input "retries" is a number, but its default is a string` }]);
  });

  it("reports a default of a shape no input can hold", () => {
    const [error] = problems("---\ninputs:\n  - name: paths\n    default: [src, docs]\n---\n");

    expect(error?.line).toBe(4);
    expect(error?.message).toContain("must be a string, a number or a boolean");
  });

  it("reports an unknown frontmatter field, which is usually a typo", () => {
    const [error] = problems("---\nworksapce: .\n---\n");

    expect(error?.line).toBe(2);
    expect(error?.message).toContain(`Unknown frontmatter field "worksapce"`);
  });

  it("reports a duplicated frontmatter field", () => {
    const [error] = problems("---\ntitle: One\ntitle: Two\n---\n");

    expect(error?.line).toBe(3);
    expect(error?.message).toContain("must be unique");
  });

  it("reports a cell that is never closed at its opening line", () => {
    expect(problems("Prose.\n\n```prompt id=a\nbody\n")).toEqual([
      { line: 3, message: "Cell fence is never closed" },
    ]);
  });

  it("reports a prose fence that is never closed", () => {
    expect(problems("Prose.\n\n```js\nconst x = 1;\n")).toEqual([
      { line: 3, message: "Fenced block is never closed" },
    ]);
  });

  it("reports a prompt cell with no id", () => {
    expect(problems("```prompt\nno id\n```\n")).toEqual([
      { line: 1, message: "Cell is missing an id" },
    ]);
  });

  it("reports a duplicate cell id at the second cell", () => {
    expect(problems("```prompt id=a\nx\n```\n\n```prompt id=a\ny\n```\n")).toEqual([
      { line: 5, message: `Duplicate cell id "a"` },
    ]);
  });

  it("reports an unknown cell attribute", () => {
    const [error] = problems("```prompt id=a bogus=1\nx\n```\n");

    expect(error?.line).toBe(1);
    expect(error?.message).toContain(`Unknown cell attribute "bogus"`);
  });

  it("reports an isolated attribute that is not a boolean", () => {
    expect(problems("```prompt id=a isolated=maybe\nx\n```\n")).toEqual([
      { line: 1, message: `"isolated" must be true or false` },
    ]);
  });

  it("reports a cell id that would not be safe to reference", () => {
    const [error] = problems("```prompt id=a.b\nx\n```\n");

    expect(error?.message).toContain(`Cell id "a.b"`);
  });

  it("reports a type attribute that disagrees with the fence", () => {
    expect(problems("```prompt id=a type=bash\nx\n```\n")).toEqual([
      { line: 1, message: `Cell type "bash" disagrees with its "prompt" fence` },
    ]);
  });

  it("reports an empty entry in uses", () => {
    expect(problems("```prompt id=a uses=first,,second\nx\n```\n")).toEqual([
      { line: 1, message: `"uses" has an empty entry` },
    ]);
  });

  it("reports a mistyped fence tag rather than silently leaving it as prose", () => {
    const [error] = problems("```promt id=greet\nSay hello.\n```\n");

    expect(error?.line).toBe(1);
    expect(error?.message).toContain(`Unknown cell type "promt"`);
  });

  it("reports attributes written with no fence tag in front of them", () => {
    const [error] = problems("``` id=greet type=prompt\nSay hello.\n```\n");

    expect(error?.message).toContain("missing its type");
  });

  it("reports an indented cell fence, which Markdown would read as prose", () => {
    expect(problems("- a list item\n\n  ```prompt id=greet\n  Say hello.\n  ```\n")).toEqual([
      { line: 3, message: "A cell fence must start at the beginning of the line" },
    ]);
  });

  it("still leaves a shell snippet with no id as prose rather than reporting it", () => {
    const source = "Run it like this:\n\n```bash\nnpm run notebook\n```\n";

    expect(parseNotebook(source).ok).toBe(true);
  });

  it("reports a bash fence carrying cell attributes but no id", () => {
    expect(problems("```bash uses=collect\nnpm test\n```\n")).toEqual([
      { line: 1, message: "Cell is missing an id" },
    ]);
    expect(problems("```bash isolated\nnpm test\n```\n")).toEqual([
      { line: 1, message: "Cell is missing an id" },
    ]);
  });

  it("leaves a shell snippet carrying another tool's attributes as prose", () => {
    const source = '```bash title="Install" copy\nnpm install\n```\n';

    expect(parseNotebook(source).ok).toBe(true);
    expect(valid(source).segments.filter(isCellSegment)).toEqual([]);
  });

  it("reports every problem at once rather than only the first", () => {
    const source = `---
title: 3
---

\`\`\`prompt
no id here
\`\`\`

\`\`\`prompt id=b isolated=perhaps
another
\`\`\`
`;

    expect(problems(source).map((error) => error.line)).toEqual([2, 5, 9]);
  });
});

describe("input references", () => {
  const declaring = (body: string) => `---\ninputs:\n  - name: target\n---\n\n${body}`;

  it("reports a reference to an input the notebook never declared", () => {
    const [error] = problems(declaring("```prompt id=audit\nAudit {{taget}}.\n```\n"));

    expect(error?.line).toBe(7);
    expect(error?.message).toContain(`Unknown input "taget"`);
  });

  it("reports the reference on its own line of a longer body", () => {
    const [error] = problems(
      declaring("```prompt id=audit\nAudit {{target}}.\n\nThen check {{tests}}.\n```\n"),
    );

    expect(error?.line).toBe(9);
  });

  it("accepts a reference to an input the notebook declares", () => {
    expect(parseNotebook(declaring("```prompt id=audit\nAudit {{ target }}.\n```\n")).ok).toBe(
      true,
    );
  });

  it("leaves a braced expression that is not a bare name alone", () => {
    const source = '```bash id=status\ndocker inspect -f "{{.State.Status}}" web\n```\n';

    expect(parseNotebook(source).ok).toBe(true);
  });

  it("accepts an escaped reference, which is text rather than a reference", () => {
    expect(parseNotebook("```bash id=status\necho \\{{end}}\n```\n").ok).toBe(true);
  });
});

describe("declared edges", () => {
  const cell = (attributes: string, body: string) =>
    `\`\`\`prompt ${attributes}\n${body}\n\`\`\`\n`;

  it("accepts an edge naming a cell written later in the file", () => {
    // The Graph rather than the document decides what runs first, so a forward
    // reference is ordinary rather than a mistake.
    const source = `${cell("id=report uses=collect", "Write it up.")}\n${cell("id=collect", "Gather.")}`;

    expect(parseNotebook(source).ok).toBe(true);
  });

  it("reports an edge naming a cell the notebook does not have", () => {
    expect(problems(cell("id=report uses=colect", "Write it up."))).toEqual([
      { line: 1, message: `Cell "report" uses "colect", which is not a cell in this notebook` },
    ]);
  });

  it("reports the unknown edge against the line of the cell declaring it", () => {
    const source = `${cell("id=collect", "Gather.")}\n${cell("id=report uses=nowhere", "Write.")}`;

    expect(problems(source).map((error) => error.line)).toEqual([5]);
  });

  it("reports every unknown edge one cell declares, rather than only the first", () => {
    const errors = problems(cell("id=report uses=one,two", "Write."));

    expect(errors.map((error) => error.message)).toEqual([
      `Cell "report" uses "one", which is not a cell in this notebook`,
      `Cell "report" uses "two", which is not a cell in this notebook`,
    ]);
  });

  it("reports a cycle as the chain of cells that closes it", () => {
    const source = [
      cell("id=audit uses=review", "Audit it."),
      cell("id=review uses=fix", "Review it."),
      cell("id=fix uses=audit", "Fix it."),
    ].join("\n");

    expect(problems(source)).toEqual([
      {
        line: 1,
        message: "Dependency cycle: audit uses review, which uses fix, which uses audit",
      },
    ]);
  });

  it("reports two cells that depend on each other", () => {
    const source = `${cell("id=first uses=second", "One.")}\n${cell("id=second uses=first", "Two.")}`;

    expect(problems(source)).toEqual([
      { line: 1, message: "Dependency cycle: first uses second, which uses first" },
    ]);
  });

  it("reports a cell that declares a dependency on itself", () => {
    expect(problems(cell("id=loop uses=loop", "Again."))).toEqual([
      { line: 1, message: "Dependency cycle: loop uses loop" },
    ]);
  });

  it("names only the cells in the cycle, not the ones that merely reach it", () => {
    const source = [
      cell("id=start uses=left", "Start."),
      cell("id=left uses=right", "Left."),
      cell("id=right uses=left", "Right."),
    ].join("\n");

    expect(problems(source)).toEqual([
      { line: 5, message: "Dependency cycle: left uses right, which uses left" },
    ]);
  });

  it("reports two independent cycles separately", () => {
    const source = [
      cell("id=a uses=b", "A."),
      cell("id=b uses=a", "B."),
      cell("id=c uses=d", "C."),
      cell("id=d uses=c", "D."),
    ].join("\n");

    expect(problems(source).map((error) => error.message)).toEqual([
      "Dependency cycle: a uses b, which uses a",
      "Dependency cycle: c uses d, which uses c",
    ]);
  });

  it("names one cycle at a time where two of them share an edge", () => {
    // `a` closes a loop through `b`, and another straight through `c`. Breaking
    // the reported one reveals the second, which is the cost of a report whose
    // length is bounded rather than one guaranteed to be complete.
    const source = [
      cell("id=a uses=b,c", "A."),
      cell("id=b uses=c", "B."),
      cell("id=c uses=a", "C."),
    ].join("\n");

    expect(problems(source)).toEqual([
      { line: 1, message: "Dependency cycle: a uses b, which uses c, which uses a" },
    ]);
  });

  it("reports an unknown edge in its place among the other problems", () => {
    // The graph is checked once the whole file has been scanned, so without
    // sorting this edge on line 1 would be reported below the id on line 5.
    const source = `${cell("id=report uses=nowhere", "Write.")}\n\`\`\`prompt\nno id\n\`\`\`\n`;

    expect(problems(source).map((error) => error.line)).toEqual([1, 5]);
  });

  it("collapses a dependency named twice into the one edge it can only be", () => {
    const source = `${cell("id=collect", "Gather.")}\n${cell("id=report uses=collect,collect", "Write.")}`;

    expect(cellsOf(valid(source))[1]?.uses).toEqual(["collect"]);
  });

  it("accepts a diamond, where two cells share a dependency and a dependent", () => {
    const source = [
      cell("id=collect", "Gather."),
      cell("id=left uses=collect", "Left."),
      cell("id=right uses=collect", "Right."),
      cell("id=report uses=left,right", "Write."),
    ].join("\n");

    expect(parseNotebook(source).ok).toBe(true);
  });
});

describe("editing a cell", () => {
  const source = `---
title: Two cells
---

Prose before.

\`\`\`prompt id=first isolated model=openai/gpt-5
Original first body.
\`\`\`

Prose between the cells.

\`\`\`prompt id=second
Second body.
\`\`\`

Prose after.
`;

  it("leaves every other byte of the file unchanged", () => {
    const edited = replaceCellBody(valid(source), "first", "Replaced body.\n");

    expect(serialiseNotebook(edited)).toBe(
      source.replace("Original first body.\n", "Replaced body.\n"),
    );
  });

  it("keeps the file intact when the new body spans several lines", () => {
    const body = "A longer body.\n\n    with indentation\n";
    const edited = replaceCellBody(valid(source), "second", body);

    expect(serialiseNotebook(edited)).toBe(source.replace("Second body.\n", body));
  });

  it("leaves the cell's declared attributes as they were", () => {
    const edited = replaceCellBody(valid(source), "first", "Replaced.\n");
    const [first] = cellsOf(edited);

    expect(first).toEqual({
      id: "first",
      type: "prompt",
      body: "Replaced.\n",
      uses: [],
      isolated: true,
      model: "openai/gpt-5",
    });
  });

  it("refuses to edit a cell the notebook does not have", () => {
    expect(() => replaceCellBody(valid(source), "absent", "x\n")).toThrow(/absent/);
  });
});
