import { describe, expect, it } from "vitest";

import {
  type NotebookEdit,
  type SegmentEdit,
  applyEdit,
  branchAt,
  editOf,
  notebookWithMode,
  notebookWithModel,
} from "./edit.js";
import { type Notebook, cellsOf, formatDiagnostics, parseNotebook } from "./notebook.js";

/** Parses a Notebook the tests wrote, treating any diagnostic as a test bug. */
function valid(source: string): Notebook {
  const result = parseNotebook(source);
  if (!result.ok) throw new Error(formatDiagnostics(result.errors));
  return result.notebook;
}

/** Applies an edit the tests expect to be taken, and returns the bytes it made. */
function edited(notebook: Notebook, edit: NotebookEdit): string {
  const result = applyEdit(notebook, edit);
  if (!result.ok) throw new Error(formatDiagnostics(result.errors));
  return result.source;
}

const source = `---
title: Two cells
inputs:
  - name: target
    default: src
---

Prose before.

\`\`\`prompt id=first isolated model=openai/gpt-5
Original first body about {{target}}.
\`\`\`

Prose between the cells.

\`\`\`bash id=second uses=first timeout=30s
ls
\`\`\`

Prose after.
`;

/** The edit describing `notebook`, with one of its segments replaced by `change`. */
function changing(
  notebook: Notebook,
  match: (segment: SegmentEdit) => boolean,
  change: (segment: SegmentEdit) => SegmentEdit,
): NotebookEdit {
  const edit = editOf(notebook);
  return {
    ...edit,
    segments: edit.segments.map((segment) => (match(segment) ? change(segment) : segment)),
  };
}

const isCell = (id: string) => (segment: SegmentEdit) =>
  segment.kind === "cell" && segment.id === id;

describe("applying an edit to a notebook", () => {
  it("reproduces the bytes when the edit changes nothing", () => {
    const notebook = valid(source);

    expect(edited(notebook, editOf(notebook))).toBe(source);
  });

  it("describes the notebook as it stands, each body as content and each timeout as an author writes it", () => {
    expect(editOf(valid(source))).toEqual({
      frontmatter: "title: Two cells\ninputs:\n  - name: target\n    default: src\n",
      segments: [
        { kind: "prose", text: "\nProse before.\n\n" },
        {
          kind: "cell",
          id: "first",
          type: "prompt",
          body: "Original first body about {{target}}.",
          uses: [],
          isolated: true,
          model: "openai/gpt-5",
        },
        { kind: "prose", text: "\nProse between the cells.\n\n" },
        {
          kind: "cell",
          id: "second",
          type: "bash",
          body: "ls",
          uses: ["first"],
          isolated: false,
          timeout: "30s",
        },
        { kind: "prose", text: "\nProse after.\n" },
      ],
    });
  });

  describe("one cell's body", () => {
    it("changes only that cell's bytes", () => {
      const notebook = valid(source);

      const made = edited(
        notebook,
        changing(notebook, isCell("first"), (cell) => ({ ...cell, body: "A new body." })),
      );

      expect(made).toBe(source.replace("Original first body about {{target}}.\n", "A new body.\n"));
    });

    it("is given its final line ending when the author's editor left it off", () => {
      const notebook = valid(source);

      const made = edited(
        notebook,
        changing(notebook, isCell("second"), (cell) => ({ ...cell, body: "ls -la" })),
      );

      expect(made).toBe(source.replace("\nls\n", "\nls -la\n"));
    });

    it("may be empty", () => {
      const notebook = valid(source);

      const made = edited(
        notebook,
        changing(notebook, isCell("second"), (cell) => ({ ...cell, body: "" })),
      );

      expect(made).toBe(source.replace("\nls\n", "\n"));
      expect(cellsOf(valid(made))[1]?.body).toBe("");
    });

    it("is fenced longer when it comes to hold a fence of its own", () => {
      const notebook = valid(source);
      const body = "Write this:\n```\ncode\n```";

      const made = edited(
        notebook,
        changing(notebook, isCell("second"), (cell) => ({ ...cell, body })),
      );

      expect(made).toBe(
        source.replace(
          "```bash id=second uses=first timeout=30s\nls\n```",
          `\`\`\`\`bash id=second uses=first timeout=30s\n${body}\n\`\`\`\``,
        ),
      );
      expect(cellsOf(valid(made))[1]?.body).toBe(`${body}\n`);
    });

    it("keeps a blank line that ends a body the author did not touch", () => {
      const spaced = "```prompt id=a\nGo.\n\n```\n\n```prompt id=b\nThen.\n```\n";
      const notebook = valid(spaced);

      const made = edited(
        notebook,
        changing(notebook, isCell("b"), (cell) => ({ ...cell, body: "Then again." })),
      );

      expect(made).toBe(spaced.replace("Then.", "Then again."));
    });

    it("keeps a blank line the author typed at the end of a body", () => {
      const notebook = valid(source);

      const made = edited(
        notebook,
        changing(notebook, isCell("second"), (cell) => ({ ...cell, body: "ls\n" })),
      );

      expect(made).toBe(source.replace("\nls\n", "\nls\n\n"));
    });
  });

  describe("a cell's declaration", () => {
    it("rewrites only that cell's fence when its edges change", () => {
      const notebook = valid(source);

      const made = edited(
        notebook,
        changing(notebook, isCell("second"), (cell) => ({ ...cell, uses: [] })),
      );

      expect(made).toBe(
        source.replace("```bash id=second uses=first timeout=30s", "```bash id=second timeout=30s"),
      );
    });

    it("keeps the fence as the author wrote it when the declaration is the same", () => {
      // `isolated` spelt as a flag, the timeout in minutes: neither is how the
      // edit spells them, and neither should be rewritten for it.
      const spelt = "```prompt id=a isolated=true timeout=0.5m\nGo.\n```\n";
      const notebook = valid(spelt);

      expect(edited(notebook, editOf(notebook))).toBe(spelt);
      expect(
        edited(
          notebook,
          changing(notebook, isCell("a"), (cell) => ({ ...cell, isolated: true, timeout: "30s" })),
        ),
      ).toBe(spelt);
    });

    it("renames a cell in its fence, and in nothing else", () => {
      const notebook = valid(source);
      const edit = editOf(notebook);

      const made = edited(notebook, {
        ...edit,
        segments: edit.segments.map((segment) =>
          segment.kind === "cell"
            ? segment.id === "first"
              ? { ...segment, id: "opening" }
              : { ...segment, uses: ["opening"] }
            : segment,
        ),
      });

      expect(made).toBe(
        source
          .replace("id=first isolated", "id=opening isolated")
          .replace("uses=first timeout=30s", "uses=opening timeout=30s"),
      );
    });

    it("writes plan or ask onto the fence, and leaves agent unwritten", () => {
      const notebook = valid("```prompt id=a\nGo.\n```\n");

      const planned = edited(
        notebook,
        changing(notebook, isCell("a"), (cell) =>
          cell.kind === "cell" ? { ...cell, approach: "plan" } : cell,
        ),
      );

      expect(planned).toBe("```prompt id=a approach=plan\nGo.\n```\n");

      const back = valid(planned);
      expect(
        edited(
          back,
          changing(back, isCell("a"), (cell) =>
            cell.kind === "cell" ? { ...cell, approach: "agent" } : cell,
          ),
        ),
      ).toBe("```prompt id=a\nGo.\n```\n");
    });

    it("keeps a fence that already says approach=agent when nothing else changes", () => {
      const source = "```prompt id=a approach=agent\nGo.\n```\n";
      expect(edited(valid(source), editOf(valid(source)))).toBe(source);
    });

    it("may change a cell's type, model and timeout", () => {
      const notebook = valid(source);

      const made = edited(
        notebook,
        changing(notebook, isCell("second"), (cell) => ({
          ...cell,
          type: "prompt",
          model: "anthropic/claude-haiku-4-5",
          timeout: "2m",
        })),
      );

      expect(made).toBe(
        source.replace(
          "```bash id=second uses=first timeout=30s",
          "```prompt id=second uses=first model=anthropic/claude-haiku-4-5 timeout=2m",
        ),
      );
    });

    it("quotes a value a fence could not otherwise carry", () => {
      const notebook = valid("```prompt id=a\nGo.\n```\n");

      const made = edited(
        notebook,
        changing(notebook, isCell("a"), (cell) => ({ ...cell, model: "a model name" })),
      );

      expect(made).toBe('```prompt id=a model="a model name"\nGo.\n```\n');
      expect(cellsOf(valid(made))[0]?.model).toBe("a model name");
    });
  });

  describe("the cells of the document", () => {
    it("may gain one, fenced afresh, with nothing else moving", () => {
      const notebook = valid(source);
      const edit = editOf(notebook);
      const added: SegmentEdit = {
        kind: "cell",
        id: "third",
        type: "prompt",
        body: "Summarise.",
        uses: ["second"],
        isolated: false,
      };

      const made = edited(notebook, {
        ...edit,
        segments: [...edit.segments, { kind: "prose", text: "\n" }, added],
      });

      expect(made).toBe(`${source}\n\`\`\`prompt id=third uses=second\nSummarise.\n\`\`\`\n`);
    });

    it("may lose one, with the prose around it staying", () => {
      const notebook = valid(source);
      const edit = editOf(notebook);

      const made = edited(notebook, {
        ...edit,
        segments: edit.segments.filter((segment) => !isCell("second")(segment)),
      });

      expect(made).toBe(source.replace("```bash id=second uses=first timeout=30s\nls\n```\n", ""));
    });

    it("may be reordered, each keeping its own fence", () => {
      const two = "```prompt id=a\nA.\n```\n\nBetween.\n\n```bash id=b\nb\n```\n";
      const notebook = valid(two);
      const edit = editOf(notebook);
      const [a, between, b] = edit.segments as [SegmentEdit, SegmentEdit, SegmentEdit];

      const made = edited(notebook, { ...edit, segments: [b, between, a] });

      expect(made).toBe("```bash id=b\nb\n```\n\nBetween.\n\n```prompt id=a\nA.\n```\n");
    });

    it("gives a cell that ended the file without a newline one when it no longer ends it", () => {
      const notebook = valid("```prompt id=a\nA.\n```\n```prompt id=b\nB.\n```");
      const edit = editOf(notebook);
      const [a, b] = edit.segments as [SegmentEdit, SegmentEdit];

      const made = edited(notebook, { ...edit, segments: [b, a] });

      expect(made).toBe("```prompt id=b\nB.\n```\n```prompt id=a\nA.\n```\n");
    });
  });

  describe("prose", () => {
    it("is the bytes the edit carries, given a line ending before a cell when it lacks one", () => {
      const notebook = valid(source);
      const edit = editOf(notebook);

      const made = edited(notebook, {
        ...edit,
        segments: edit.segments.map((segment) =>
          segment.kind === "prose" && segment.text.includes("between")
            ? { kind: "prose", text: "\nRewritten." }
            : segment,
        ),
      });

      expect(made).toBe(source.replace("\nProse between the cells.\n\n", "\nRewritten.\n"));
    });

    it("keeps the file's end as it was when the prose ends it", () => {
      const notebook = valid("```prompt id=a\nA.\n```\nAfter");

      expect(edited(notebook, editOf(notebook))).toBe("```prompt id=a\nA.\n```\nAfter");
    });

    it("that is empty is left out rather than written", () => {
      const notebook = valid(source);
      const edit = editOf(notebook);

      const made = edited(notebook, {
        ...edit,
        segments: [{ kind: "prose", text: "" }, ...edit.segments],
      });

      expect(made).toBe(source);
    });
  });

  describe("the frontmatter", () => {
    it("is replaced between its delimiters, and nothing else moves", () => {
      const notebook = valid(source);

      const made = edited(notebook, {
        ...editOf(notebook),
        frontmatter: "title: Renamed\ninputs:\n  - name: target\n    default: lib",
      });

      expect(made).toBe(
        source.replace(
          "title: Two cells\ninputs:\n  - name: target\n    default: src\n",
          "title: Renamed\ninputs:\n  - name: target\n    default: lib\n",
        ),
      );
      expect(valid(made).metadata).toEqual({
        title: "Renamed",
        inputs: [{ name: "target", type: "string", default: "lib" }],
      });
    });

    it("is added to a notebook that had none", () => {
      const bare = "```prompt id=a\nGo.\n```\n";
      const notebook = valid(bare);

      const made = edited(notebook, { ...editOf(notebook), frontmatter: "title: Named\n" });

      expect(made).toBe(`---\ntitle: Named\n---\n${bare}`);
    });

    it("is removed, delimiters and all, when the edit has none", () => {
      const titled = "---\ntitle: Named\n---\n\n```prompt id=a\nGo.\n```\n";
      const notebook = valid(titled);
      const { frontmatter: _dropped, ...edit } = editOf(notebook);

      const made = edited(notebook, edit);

      expect(made).toBe("\n```prompt id=a\nGo.\n```\n");
      expect(valid(made).metadata).toEqual({});
    });
  });

  describe("line endings", () => {
    const crlf = source.replace(/\n/g, "\r\n");

    it("are the document's own, whatever the browser sent", () => {
      const notebook = valid(crlf);

      const made = edited(notebook, {
        ...changing(notebook, isCell("first"), (cell) => ({
          ...cell,
          body: "Line one.\nLine two.",
        })),
        frontmatter: "title: Two cells\ninputs:\n  - name: target\n    default: lib\n",
      });

      expect(made).toBe(
        crlf
          .replace("Original first body about {{target}}.\r\n", "Line one.\r\nLine two.\r\n")
          .replace("default: src", "default: lib"),
      );
    });

    it("reproduce a CRLF notebook exactly when nothing changes", () => {
      const notebook = valid(crlf);

      expect(edited(notebook, editOf(notebook))).toBe(crlf);
    });

    it("reproduce a notebook of mixed line endings exactly when nothing changes", () => {
      const mixed = "Intro.\r\nMore.\n\n```prompt id=a\nGo.\r\nOn.\n```\r\nAfter.\n";
      const notebook = valid(mixed);

      expect(edited(notebook, editOf(notebook))).toBe(mixed);
      expect(
        edited(
          notebook,
          changing(notebook, isCell("a"), (cell) => ({ ...cell, body: "Gone." })),
        ),
      ).toBe("Intro.\r\nMore.\n\n```prompt id=a\nGone.\r\n```\r\nAfter.\n");
    });
  });

  describe("an edit the format refuses", () => {
    it("reports where, against the document it would have made, and makes nothing", () => {
      const notebook = valid(source);

      const result = applyEdit(
        notebook,
        changing(notebook, isCell("second"), (cell) => ({ ...cell, uses: ["nowhere"] })),
      );

      expect(result).toEqual({
        ok: false,
        errors: [
          {
            line: 16,
            message: 'Cell "second" uses "nowhere", which is not a cell in this notebook',
          },
        ],
      });
    });

    it("includes an id spelt wrongly, a duplicate id, and frontmatter that is not YAML", () => {
      const notebook = valid(source);
      const edit = editOf(notebook);

      const misspelt = applyEdit(
        notebook,
        changing(notebook, isCell("second"), (cell) => ({ ...cell, id: "-bad" })),
      );
      const duplicated = applyEdit(
        notebook,
        changing(notebook, isCell("second"), (cell) => ({ ...cell, id: "first" })),
      );
      const unreadable = applyEdit(notebook, { ...edit, frontmatter: "title: [unclosed" });

      expect(misspelt.ok).toBe(false);
      if (!misspelt.ok) expect(misspelt.errors[0]?.message).toMatch(/Cell id "-bad"/);
      expect(duplicated.ok).toBe(false);
      if (!duplicated.ok) expect(duplicated.errors[0]?.message).toMatch(/Duplicate cell id/);
      expect(unreadable.ok).toBe(false);
      if (!unreadable.ok) expect(unreadable.errors.length).toBeGreaterThan(0);
    });

    it("includes a timeout that is not a duration, on a cell that had one or had none", () => {
      const notebook = valid(source);

      const changed = applyEdit(
        notebook,
        changing(notebook, isCell("second"), (cell) => ({ ...cell, timeout: "30" })),
      );
      const given = applyEdit(
        notebook,
        changing(notebook, isCell("first"), (cell) => ({ ...cell, timeout: "30" })),
      );

      expect(changed.ok).toBe(false);
      if (!changed.ok) expect(changed.errors[0]?.message).toMatch(/"timeout" must be a duration/);
      expect(given.ok).toBe(false);
      if (!given.ok) expect(given.errors[0]?.message).toMatch(/"timeout" must be a duration/);
    });
  });
});

describe("setting a notebook's model", () => {
  const bare = "```prompt id=greet\nSay hello.\n```\n";

  it("adds the model and leaves the cells as they were written", () => {
    const made = notebookWithModel(valid(source), "anthropic/claude-sonnet-4-5");
    if (!made.ok) throw new Error(formatDiagnostics(made.errors));

    expect(made.source).toBe(
      source.replace(
        "    default: src\n",
        "    default: src\nmodel: anthropic/claude-sonnet-4-5\n",
      ),
    );
    expect(made.notebook.metadata.model).toBe("anthropic/claude-sonnet-4-5");
    expect(made.source).toContain("```prompt id=first isolated model=openai/gpt-5");
    expect(made.source).toContain("```bash id=second uses=first timeout=30s");
  });

  it("replaces a model the notebook already names, and can clear it", () => {
    const named = valid(
      "---\ntitle: Hello\nmodel: old/one\n---\n\n```prompt id=greet\nSay hello.\n```\n",
    );
    const replaced = notebookWithModel(named, "new/two");
    if (!replaced.ok) throw new Error(formatDiagnostics(replaced.errors));
    expect(replaced.source).toBe(
      "---\ntitle: Hello\nmodel: new/two\n---\n\n```prompt id=greet\nSay hello.\n```\n",
    );

    const cleared = notebookWithModel(replaced.notebook, undefined);
    if (!cleared.ok) throw new Error(formatDiagnostics(cleared.errors));
    expect(cleared.source).toBe("---\ntitle: Hello\n---\n\n```prompt id=greet\nSay hello.\n```\n");
    expect(cleared.notebook.metadata.model).toBeUndefined();
  });

  it("writes a frontmatter block when the notebook had none, and removes it when the model was all it held", () => {
    const made = notebookWithModel(valid(bare), "ollama/llama3.1:8b");
    if (!made.ok) throw new Error(formatDiagnostics(made.errors));
    expect(made.source).toBe(`---\nmodel: ollama/llama3.1:8b\n---\n${bare}`);

    const cleared = notebookWithModel(made.notebook, undefined);
    if (!cleared.ok) throw new Error(formatDiagnostics(cleared.errors));
    expect(cleared.source).toBe(bare);
  });

  it("quotes a model whose id would not read back as a plain scalar", () => {
    const made = notebookWithModel(
      valid(bare),
      "Oracle1/gemini-3.8-flash-high, gemini-3.7-flash-high",
    );
    if (!made.ok) throw new Error(formatDiagnostics(made.errors));
    expect(made.notebook.metadata.model).toBe(
      "Oracle1/gemini-3.8-flash-high, gemini-3.7-flash-high",
    );
    expect(made.source).toContain(
      'model: "Oracle1/gemini-3.8-flash-high, gemini-3.7-flash-high"\n',
    );
  });
});

describe("setting a notebook's mode", () => {
  const bare = "```prompt id=greet\nSay hello.\n```\n";

  it("adds the mode and leaves the cells as they were written", () => {
    const made = notebookWithMode(valid(source), "work");
    if (!made.ok) throw new Error(formatDiagnostics(made.errors));

    expect(made.source).toBe(
      source.replace("    default: src\n", "    default: src\nmode: work\n"),
    );
    expect(made.notebook.metadata.mode).toBe("work");
    expect(made.source).toContain("```prompt id=first isolated model=openai/gpt-5");
    expect(made.source).toContain("```bash id=second uses=first timeout=30s");
  });

  it("replaces a mode the notebook already names, and can clear it", () => {
    const named = valid(
      "---\ntitle: Hello\nmode: code\n---\n\n```prompt id=greet\nSay hello.\n```\n",
    );
    const replaced = notebookWithMode(named, "work");
    if (!replaced.ok) throw new Error(formatDiagnostics(replaced.errors));
    expect(replaced.source).toBe(
      "---\ntitle: Hello\nmode: work\n---\n\n```prompt id=greet\nSay hello.\n```\n",
    );

    const cleared = notebookWithMode(replaced.notebook, undefined);
    if (!cleared.ok) throw new Error(formatDiagnostics(cleared.errors));
    expect(cleared.source).toBe("---\ntitle: Hello\n---\n\n```prompt id=greet\nSay hello.\n```\n");
    expect(cleared.notebook.metadata.mode).toBeUndefined();
  });

  it("writes a frontmatter block when the notebook had none, and removes it when the mode was all it held", () => {
    const made = notebookWithMode(valid(bare), "code");
    if (!made.ok) throw new Error(formatDiagnostics(made.errors));
    expect(made.source).toBe(`---\nmode: code\n---\n${bare}`);

    const cleared = notebookWithMode(made.notebook, undefined);
    if (!cleared.ok) throw new Error(formatDiagnostics(cleared.errors));
    expect(cleared.source).toBe(bare);
  });

  it("leaves a model the notebook names where it is", () => {
    const named = valid(
      "---\ntitle: Hello\nmodel: ollama/llama3.1:8b\n---\n\n```prompt id=greet\nSay hello.\n```\n",
    );
    const made = notebookWithMode(named, "work");
    if (!made.ok) throw new Error(formatDiagnostics(made.errors));
    expect(made.source).toBe(
      "---\ntitle: Hello\nmodel: ollama/llama3.1:8b\nmode: work\n---\n\n```prompt id=greet\nSay hello.\n```\n",
    );
    expect(made.notebook.metadata.model).toBe("ollama/llama3.1:8b");
    expect(made.notebook.metadata.mode).toBe("work");
  });
});

describe("branching a notebook through a cell", () => {
  const taken = (notebook: Notebook, cell: string) => {
    const edit = branchAt(notebook, cell);
    if (edit === undefined) throw new Error(`no cell ${cell}`);
    return edited(notebook, edit);
  };

  it("keeps the notebook through that cell and drops what follows, to the byte", () => {
    const notebook = valid(source);
    const throughFirst = source.slice(0, source.indexOf("\n\nProse between"));
    expect(taken(notebook, "first")).toBe(`${throughFirst}\n`);
    const throughSecond = source.slice(0, source.indexOf("\n\nProse after."));
    expect(taken(notebook, "second")).toBe(`${throughSecond}\n`);
  });

  it("drops a dependency on a cell the branch no longer holds", () => {
    const ahead =
      "```prompt id=a\nA\n```\n\n```prompt id=b uses=a,c\nB\n```\n\n```prompt id=c\nC\n```\n";
    expect(taken(valid(ahead), "b")).toBe(
      "```prompt id=a\nA\n```\n\n```prompt id=b uses=a\nB\n```\n",
    );
    expect(cellsOf(valid(taken(valid(ahead), "b")))[1]?.uses).toEqual(["a"]);
  });

  it("is nothing when the notebook has no such cell", () => {
    expect(branchAt(valid(source), "missing")).toBeUndefined();
  });
});
