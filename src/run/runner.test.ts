import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createScriptedAgent } from "../agent/scripted.js";
import type { CellRecord, RunRecord } from "./record.js";
import { runNotebook } from "./runner.js";
import { recordPath } from "./store.js";

async function notebookFile(contents: string): Promise<string> {
  // Resolved, because a bash cell reporting its own working directory sees the
  // real path rather than the symlink some platforms put the temp directory behind.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "octo-run-")));
  const path = join(dir, "notebook.md");
  await writeFile(path, contents, "utf8");
  return path;
}

/** The one cell a run recorded, narrowed to the kind of cell the test is about. */
function onlyCell<T extends CellRecord["type"]>(record: RunRecord, type: T) {
  const [cell] = record.cells;
  if (record.cells.length !== 1 || cell?.type !== type) {
    throw new Error(`expected the run to record exactly one ${type} cell`);
  }
  return cell as Extract<CellRecord, { type: T }>;
}

const oneCell = `---
title: Greeting
---

Some prose introducing the work.

\`\`\`prompt id=greet
Say hello.
\`\`\`
`;

const twoCells = `---
title: Two steps
---

\`\`\`prompt id=first
Do the first thing.
\`\`\`

Prose between the cells.

\`\`\`prompt id=second
Do the second thing.
\`\`\`
`;

describe("runNotebook", () => {
  it("runs a notebook's single prompt cell and records what it produced", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([{ text: "Hello, world" }]);

    const record = await runNotebook(path, { agent: agent.create });

    expect(agent.prompts).toEqual(["Say hello."]);
    expect(record.cells).toEqual([
      expect.objectContaining({ id: "greet", status: "ok", text: "Hello, world" }),
    ]);
  });

  it("records the token usage and model the turn reported", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([
      {
        text: "Hello",
        usage: { inputTokens: 12, outputTokens: 3 },
        model: "anthropic/claude-sonnet-4",
        toolCalls: [{ name: "bash", input: { command: "ls" } }],
      },
    ]);

    const cell = onlyCell(await runNotebook(path, { agent: agent.create }), "prompt");

    expect(cell.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(cell.model).toBe("anthropic/claude-sonnet-4");
    expect(cell.toolCalls).toEqual([{ name: "bash", input: { command: "ls" } }]);
  });

  it("runs cells in document order, ignoring the prose between them", async () => {
    const path = await notebookFile(twoCells);
    const agent = createScriptedAgent([{ text: "first done" }, { text: "second done" }]);

    const record = await runNotebook(path, { agent: agent.create });

    expect(agent.prompts).toEqual(["Do the first thing.", "Do the second thing."]);
    expect(record.cells.map((cell) => cell.id)).toEqual(["first", "second"]);
  });

  it("writes the run record beside the notebook rather than into it", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([{ text: "Hello, world" }]);

    const record = await runNotebook(path, { agent: agent.create });
    const written = JSON.parse(await readFile(recordPath(path, record.id), "utf8"));

    expect(written).toEqual(record);
    expect(await readFile(path, "utf8")).toBe(oneCell);
  });

  it("keeps a separate record for each run of the same notebook", async () => {
    const path = await notebookFile(oneCell);

    const first = await runNotebook(path, { agent: createScriptedAgent([{ text: "one" }]).create });
    const second = await runNotebook(path, {
      agent: createScriptedAgent([{ text: "two" }]).create,
    });

    expect(second.id).not.toBe(first.id);
    expect(JSON.parse(await readFile(recordPath(path, first.id), "utf8")).cells[0].text).toBe(
      "one",
    );
  });

  it("halts the run when a cell fails, leaving later cells unrun", async () => {
    const path = await notebookFile(twoCells);
    const agent = createScriptedAgent([{ error: "provider exploded" }, { text: "never reached" }]);

    const record = await runNotebook(path, { agent: agent.create });

    expect(record.cells).toEqual([
      expect.objectContaining({ id: "first", status: "error", error: "provider exploded" }),
    ]);
    expect(agent.prompts).toEqual(["Do the first thing."]);
  });

  it("leaves a fenced shell snippet with no id as prose", async () => {
    const path = await notebookFile(
      `Run it like this:\n\n\`\`\`bash\nnpm run notebook\n\`\`\`\n\n\`\`\`prompt id=greet\nSay hello.\n\`\`\`\n`,
    );
    const agent = createScriptedAgent([{ text: "Hello" }]);

    const record = await runNotebook(path, { agent: agent.create });

    expect(record.cells.map((cell) => cell.id)).toEqual(["greet"]);
  });

  it("runs the example notebook that the command line is documented against", async () => {
    const example = fileURLToPath(new URL("../../examples/hello.md", import.meta.url));
    // Run a copy, so the suite leaves no run records inside the repo.
    const path = await notebookFile(await readFile(example, "utf8"));
    const agent = createScriptedAgent([{ text: "pong" }]);

    const record = await runNotebook(path, { agent: agent.create });

    expect(agent.prompts).toEqual(["Reply with exactly the word: pong"]);
    expect(record.cells).toEqual([
      expect.objectContaining({ id: "greet", status: "ok", text: "pong" }),
    ]);
  });
});

/** A notebook that is one bash cell, which is what most of these tests need. */
const oneBashCell = (body: string) => `\`\`\`bash id=step\n${body}\n\`\`\`\n`;

/** No turns scripted, so a bash cell that reached the agent would fail loudly. */
const unusedAgent = () => createScriptedAgent([]);

describe("bash cells", () => {
  it("records what the command wrote and the status it exited with", async () => {
    const path = await notebookFile(oneBashCell("echo to stdout\necho to stderr >&2"));

    const record = await runNotebook(path, { agent: unusedAgent().create });

    expect(record.cells).toEqual([
      {
        id: "step",
        type: "bash",
        status: "ok",
        stdout: "to stdout\n",
        stderr: "to stderr\n",
        exitCode: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]);
  });

  it("spends no tokens, because it never reaches the agent", async () => {
    const path = await notebookFile(oneBashCell("echo cheap"));
    const agent = unusedAgent();

    const cell = onlyCell(await runNotebook(path, { agent: agent.create }), "bash");

    expect(agent.prompts).toEqual([]);
    expect(cell.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("treats a non-zero exit as a failure, halting before the next cell", async () => {
    const path = await notebookFile(
      `\`\`\`bash id=check\necho what went wrong >&2\nexit 3\n\`\`\`\n\n\`\`\`prompt id=explain\nExplain it.\n\`\`\`\n`,
    );
    const agent = createScriptedAgent([{ text: "never reached" }]);

    const record = await runNotebook(path, { agent: agent.create });
    const cell = onlyCell(record, "bash");

    expect(cell.status).toBe("error");
    expect(cell.exitCode).toBe(3);
    expect(cell.error).toContain("3");
    // The record keeps what the command said, which is the only account of why it failed.
    expect(cell.stderr).toBe("what went wrong\n");
    expect(agent.prompts).toEqual([]);
  });

  it("runs the command in the notebook's own directory by default", async () => {
    const path = await notebookFile(oneBashCell("pwd"));

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");

    expect(cell.stdout.trim()).toBe(dirname(path));
  });

  it("runs the command in the workspace the notebook declares", async () => {
    const path = await notebookFile(`---\nworkspace: service\n---\n\n${oneBashCell("pwd")}`);
    await mkdir(join(dirname(path), "service"));

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");

    expect(cell.stdout.trim()).toBe(join(dirname(path), "service"));
  });

  it("records a command killed by a signal as a failure, naming the signal", async () => {
    const path = await notebookFile(oneBashCell("kill -9 $$"));

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");

    expect(cell.status).toBe("error");
    expect(cell.exitCode).toBeNull();
    expect(cell.error).toContain("SIGKILL");
  });

  it("records a command it could not even start as a failure of the cell", async () => {
    // A workspace that went away mid-run, which is the only way past the check
    // that refuses a notebook whose workspace was already missing.
    const path = await notebookFile(
      `---\nworkspace: doomed\n---\n\n\`\`\`bash id=remove\nrmdir "$PWD"\n\`\`\`\n\n\`\`\`bash id=after\npwd\n\`\`\`\n`,
    );
    await mkdir(join(dirname(path), "doomed"));

    const [, cell] = (await runNotebook(path, { agent: unusedAgent().create })).cells;

    expect(cell?.status).toBe("error");
    expect(cell?.error).toContain("could not be run");
    if (cell?.type !== "bash") throw new Error("expected the second cell to be a bash cell");
    // Null rather than a status it never reached, which is the hook ticket 11
    // needs for timeouts.
    expect(cell.exitCode).toBeNull();
    // Not the command's own output, so it is not passed off as such.
    expect(cell.stderr).toBe("");
  });

  it("runs a multi-line body as one script, so its work lands in the workspace", async () => {
    const path = await notebookFile(
      oneBashCell('greeting=hello\nprintf "%s\\n" "$greeting" > made'),
    );

    await runNotebook(path, { agent: unusedAgent().create });

    expect(await readFile(join(dirname(path), "made"), "utf8")).toBe("hello\n");
  });

  it("runs bash and prompt cells together, in document order", async () => {
    const path = await notebookFile(
      `\`\`\`prompt id=ask\nAsk something.\n\`\`\`\n\n\`\`\`bash id=then\necho after\n\`\`\`\n`,
    );
    const agent = createScriptedAgent([{ text: "asked" }]);

    const record = await runNotebook(path, { agent: agent.create });

    expect(record.cells.map((cell) => [cell.id, cell.type, cell.status])).toEqual([
      ["ask", "prompt", "ok"],
      ["then", "bash", "ok"],
    ]);
  });

  it("reads nothing from the terminal, so a command expecting input cannot wedge", async () => {
    const path = await notebookFile(oneBashCell("cat"));

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");

    expect(cell.status).toBe("ok");
    expect(cell.stdout).toBe("");
  });
});

/** One prompt cell, under frontmatter declaring whatever the test needs. */
const withInputs = (inputs: string, body = "Audit {{target}}.") =>
  `---\ninputs:\n${inputs}---\n\n\`\`\`prompt id=audit\n${body}\n\`\`\`\n`;

const target = "  - name: target\n    default: src\n";

describe("declared inputs", () => {
  it("replaces a reference with the input's default before the cell runs", async () => {
    const path = await notebookFile(withInputs(target));
    const agent = createScriptedAgent([{ text: "audited" }]);

    await runNotebook(path, { agent: agent.create });

    expect(agent.prompts).toEqual(["Audit src."]);
  });

  it("prefers a value supplied for the run over the declared default", async () => {
    const path = await notebookFile(withInputs(target));
    const agent = createScriptedAgent([{ text: "audited" }]);

    await runNotebook(path, { agent: agent.create, inputs: { target: "docs" } });

    expect(agent.prompts).toEqual(["Audit docs."]);
  });

  it("replaces every reference to the same input", async () => {
    const path = await notebookFile(
      withInputs(target, "Audit {{target}}, then re-read {{target}}."),
    );
    const agent = createScriptedAgent([{ text: "audited" }]);

    await runNotebook(path, { agent: agent.create });

    expect(agent.prompts).toEqual(["Audit src, then re-read src."]);
  });

  it("writes a number or a boolean as the text the reader would have written", async () => {
    const path = await notebookFile(
      withInputs(
        "  - name: retries\n    default: 3\n  - name: strict\n    default: false\n",
        "Try {{retries}} times, strict={{strict}}.",
      ),
    );
    const agent = createScriptedAgent([{ text: "tried" }]);

    await runNotebook(path, { agent: agent.create });

    expect(agent.prompts).toEqual(["Try 3 times, strict=false."]);
  });

  it("interpolates into a bash cell's command as well", async () => {
    const path = await notebookFile(
      `---\ninputs:\n  - name: greeting\n    default: hello\n---\n\n\`\`\`bash id=say\necho {{greeting}}\n\`\`\`\n`,
    );

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");

    expect(cell.stdout).toBe("hello\n");
  });

  it("leaves an escaped reference as the text it stands for", async () => {
    const path = await notebookFile(`\`\`\`bash id=say\necho '\\{{end}}'\n\`\`\`\n`);

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");

    expect(cell.stdout).toBe("{{end}}\n");
  });

  it("stops before anything runs when a required input has no value", async () => {
    const path = await notebookFile(
      withInputs("  - name: target\n    description: The directory to audit\n"),
    );
    const agent = createScriptedAgent([{ text: "never reached" }]);

    await expect(runNotebook(path, { agent: agent.create })).rejects.toThrow(
      /required input "target".*The directory to audit/,
    );
    expect(agent.prompts).toEqual([]);
  });

  it("stops before anything runs when a supplied value is of the wrong type", async () => {
    const path = await notebookFile(
      withInputs("  - name: retries\n    default: 3\n", "Try {{retries}} times."),
    );
    const agent = createScriptedAgent([{ text: "never reached" }]);

    await expect(
      runNotebook(path, { agent: agent.create, inputs: { retries: "many" } }),
    ).rejects.toThrow(/"retries" expects a number/);
    expect(agent.prompts).toEqual([]);
  });

  it("stops before anything runs when a value names no declared input", async () => {
    const path = await notebookFile(withInputs(target));
    const agent = createScriptedAgent([{ text: "never reached" }]);

    await expect(
      runNotebook(path, { agent: agent.create, inputs: { targt: "docs" } }),
    ).rejects.toThrow(/No input named "targt"/);
    expect(agent.prompts).toEqual([]);
  });

  it("reports everything wrong with the inputs at once", async () => {
    const path = await notebookFile(
      withInputs(
        "  - name: target\n  - name: retries\n    default: 3\n",
        "Audit {{target}} {{retries}} times.",
      ),
    );

    await expect(
      runNotebook(path, { agent: unusedAgent().create, inputs: { retries: "many" } }),
    ).rejects.toThrow(/required input "target"[\s\S]*"retries" expects a number/);
  });

  it("runs the example notebook the input flags are documented against", async () => {
    const example = fileURLToPath(new URL("../../examples/greet.md", import.meta.url));
    const path = await notebookFile(await readFile(example, "utf8"));
    const agent = createScriptedAgent([{ text: "Hello, Ada!" }]);

    const record = await runNotebook(path, { agent: agent.create, inputs: { name: "Ada" } });

    expect(agent.prompts).toEqual(["Say hello to Ada in one short sentence."]);
    expect(record.cells).toEqual([
      expect.objectContaining({ id: "announce", status: "ok", stdout: "Greeting Ada\n" }),
      expect.objectContaining({ id: "greet", status: "ok" }),
    ]);
  });
});

/** One prompt cell, under frontmatter declaring whatever the test needs. */
const declaring = (frontmatter: string) =>
  `---\n${frontmatter}---\n\n\`\`\`prompt id=work\nDo the work.\n\`\`\`\n`;

describe("declared environment", () => {
  it("sets the agent up in the workspace the notebook declares", async () => {
    const path = await notebookFile(declaring("workspace: service\n"));
    await mkdir(join(dirname(path), "service"));
    const agent = createScriptedAgent([{ text: "done" }]);

    await runNotebook(path, { agent: agent.create });

    expect(agent.setup?.workspace).toBe(join(dirname(path), "service"));
  });

  it("sets the agent up in the notebook's own directory when it declares no workspace", async () => {
    const path = await notebookFile(declaring("title: Plain\n"));
    const agent = createScriptedAgent([{ text: "done" }]);

    await runNotebook(path, { agent: agent.create });

    expect(agent.setup?.workspace).toBe(dirname(path));
  });

  it("gives the agent only the tools the notebook declares", async () => {
    const path = await notebookFile(declaring("tools:\n  - read\n  - bash\n"));
    const agent = createScriptedAgent([{ text: "done" }], { tools: ["read", "bash"] });

    await runNotebook(path, { agent: agent.create });

    expect(agent.setup?.tools).toEqual(["read", "bash"]);
  });

  it("leaves the tools alone when the notebook declares none", async () => {
    const path = await notebookFile(declaring("title: Plain\n"));
    const agent = createScriptedAgent([{ text: "done" }]);

    await runNotebook(path, { agent: agent.create });

    expect(agent.setup?.tools).toBeUndefined();
  });

  it("tells the agent what the run was told about trusting the workspace", async () => {
    const path = await notebookFile(declaring("title: Plain\n"));
    const agent = createScriptedAgent([{ text: "done" }]);

    await runNotebook(path, { agent: agent.create, trust: true });

    expect(agent.setup?.trust).toBe(true);
  });

  it("stops before any cell runs when a declared skill is missing, naming it", async () => {
    const path = await notebookFile(declaring("skills:\n  - review\n"));
    const agent = createScriptedAgent([{ text: "never reached" }]);

    await expect(runNotebook(path, { agent: agent.create })).rejects.toThrow(/skill "review"/);
    expect(agent.prompts).toEqual([]);
  });

  it("stops before any cell runs when a declared package is missing", async () => {
    const path = await notebookFile(declaring("packages:\n  - npm:@acme/skills@1.0.0\n"));
    const agent = createScriptedAgent([{ text: "never reached" }]);

    await expect(runNotebook(path, { agent: agent.create })).rejects.toThrow(
      /npm:@acme\/skills@1\.0\.0/,
    );
    expect(agent.prompts).toEqual([]);
  });

  it("stops before any cell runs when a declared tool is not on offer", async () => {
    const path = await notebookFile(declaring("tools:\n  - grep\n"));
    const agent = createScriptedAgent([{ text: "never reached" }], { tools: [] });

    await expect(runNotebook(path, { agent: agent.create })).rejects.toThrow(/tool "grep"/);
    expect(agent.prompts).toEqual([]);
  });

  it("reports a declared pi version that is not the one running", async () => {
    const path = await notebookFile(declaring("pi_version: 0.83.0\n"));
    const agent = createScriptedAgent([{ text: "never reached" }], { piVersion: "0.84.2" });

    await expect(runNotebook(path, { agent: agent.create })).rejects.toThrow(/0\.83\.0/);
  });

  it("stops a bash-only notebook too, since a degraded workspace is still degraded", async () => {
    const path = await notebookFile(
      `---\nskills:\n  - review\n---\n\n\`\`\`bash id=step\ntouch ran\n\`\`\`\n`,
    );

    await expect(runNotebook(path, { agent: unusedAgent().create })).rejects.toThrow(
      /skill "review"/,
    );
    await expect(readFile(join(dirname(path), "ran"), "utf8")).rejects.toThrow();
  });

  it("refuses to run against a workspace that is not there", async () => {
    const path = await notebookFile(declaring("workspace: absent\n"));
    const agent = createScriptedAgent([{ text: "never reached" }]);

    await expect(runNotebook(path, { agent: agent.create })).rejects.toThrow(/absent/);
    expect(agent.setup, "the agent is never set up against a workspace that is not there").toBe(
      undefined,
    );
  });

  it("reads a refusal to set the agent up as a refusal to run the notebook", async () => {
    const path = await notebookFile(oneCell);
    const undecided = () => Promise.reject(new Error("nothing has decided whether to trust it"));

    await expect(runNotebook(path, { agent: undecided })).rejects.toThrow(
      /Cannot run [\s\S]*decided whether to trust it/,
    );
  });

  it("records the environment the cells actually ran in", async () => {
    const path = await notebookFile(declaring("tools:\n  - read\n"));
    const agent = createScriptedAgent([{ text: "done" }], {
      piVersion: "0.84.2",
      tools: ["read"],
      trusted: false,
    });

    const record = await runNotebook(path, { agent: agent.create });

    expect(record.environment).toEqual({
      workspace: dirname(path),
      piVersion: "0.84.2",
      tools: ["read"],
      trusted: false,
    });
  });

  it("disposes the agent when the run is over", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([{ text: "Hello" }]);

    await runNotebook(path, { agent: agent.create });

    expect(agent.disposed).toBe(true);
  });

  it("disposes the agent when the environment refuses the run", async () => {
    const path = await notebookFile(declaring("skills:\n  - review\n"));
    const agent = createScriptedAgent([{ text: "never reached" }]);

    await expect(runNotebook(path, { agent: agent.create })).rejects.toThrow();
    expect(agent.disposed).toBe(true);
  });
});

/** A prompt cell with the given id, and the cells it uses if it declares any. */
const promptCell = (id: string, uses?: string) =>
  `\`\`\`prompt id=${id}${uses === undefined ? "" : ` uses=${uses}`}\nDo ${id}.\n\`\`\`\n`;

const notebookOf = (...cells: readonly string[]) => notebookFile(cells.join("\n"));

/** Enough scripted turns for any of these notebooks, since none of them fail. */
const readyAgent = () => createScriptedAgent(Array.from({ length: 8 }, () => ({ text: "done" })));

describe("dependency graph", () => {
  it("runs a cell before the cell that uses it, though it is written second", async () => {
    const path = await notebookOf(promptCell("report", "collect"), promptCell("collect"));
    const agent = readyAgent();

    const record = await runNotebook(path, { agent: agent.create });

    expect(record.cells.map((cell) => cell.id)).toEqual(["collect", "report"]);
  });

  it("follows a chain of edges written in reverse of the order it requires", async () => {
    const path = await notebookOf(
      promptCell("third", "second"),
      promptCell("second", "first"),
      promptCell("first"),
    );

    const record = await runNotebook(path, { agent: readyAgent().create });

    expect(record.cells.map((cell) => cell.id)).toEqual(["first", "second", "third"]);
  });

  it("keeps document order between cells the edges leave interchangeable", async () => {
    // `b` waits for `c`, which is the only reordering the edges ask for: `a`
    // still runs first and `d` still runs last, because that is how they are
    // written and nothing says otherwise.
    const path = await notebookOf(
      promptCell("a"),
      promptCell("b", "c"),
      promptCell("c"),
      promptCell("d"),
    );

    const record = await runNotebook(path, { agent: readyAgent().create });

    expect(record.cells.map((cell) => cell.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("orders a bash cell and a prompt cell by their edge, not their type", async () => {
    const path = await notebookFile(
      `\`\`\`prompt id=explain uses=collect\nExplain it.\n\`\`\`\n\n\`\`\`bash id=collect\necho collected\n\`\`\`\n`,
    );
    const agent = readyAgent();

    const record = await runNotebook(path, { agent: agent.create });

    expect(record.cells.map((cell) => [cell.id, cell.type])).toEqual([
      ["collect", "bash"],
      ["explain", "prompt"],
    ]);
  });

  it("gives the agent the reordered cells, so a later cell can build on an earlier one", async () => {
    const path = await notebookOf(promptCell("report", "collect"), promptCell("collect"));
    const agent = readyAgent();

    await runNotebook(path, { agent: agent.create });

    expect(agent.prompts).toEqual(["Do collect.", "Do report."]);
  });

  it("stops before anything runs when an edge names no cell in the notebook", async () => {
    const path = await notebookOf(promptCell("report", "colect"), promptCell("collect"));
    const agent = readyAgent();

    await expect(runNotebook(path, { agent: agent.create })).rejects.toThrow(
      /uses "colect", which is not a cell in this notebook/,
    );
    expect(agent.prompts).toEqual([]);
  });

  it("stops before anything runs when the edges form a cycle, naming the cells", async () => {
    const path = await notebookOf(promptCell("first", "second"), promptCell("second", "first"));
    const agent = readyAgent();

    await expect(runNotebook(path, { agent: agent.create })).rejects.toThrow(
      /Dependency cycle: first uses second, which uses first/,
    );
    expect(agent.prompts).toEqual([]);
  });

  // A bash cell leaves a mark on the workspace, so these two are the ones that
  // can show "nothing runs" rather than only "the agent was never asked".
  const touching = (attributes: string, file: string) =>
    `\`\`\`bash ${attributes}\ntouch ${file}\n\`\`\`\n`;

  it("leaves a cycle's cells unrun rather than stopping partway through", async () => {
    const path = await notebookOf(
      touching("id=one uses=two", "ran-one"),
      touching("id=two uses=one", "ran-two"),
    );

    await expect(runNotebook(path, { agent: unusedAgent().create })).rejects.toThrow(
      /Dependency cycle/,
    );
    await expect(readFile(join(dirname(path), "ran-one"), "utf8")).rejects.toThrow();
  });

  it("leaves every cell unrun when one edge names no cell, including the sound ones", async () => {
    const path = await notebookOf(
      touching("id=sound", "ran-sound"),
      touching("id=broken uses=nowhere", "ran-broken"),
    );

    await expect(runNotebook(path, { agent: unusedAgent().create })).rejects.toThrow(
      /uses "nowhere"/,
    );
    // `sound` has no edges and would have run first, which is what makes this
    // a check that the graph is settled before the run rather than during it.
    await expect(readFile(join(dirname(path), "ran-sound"), "utf8")).rejects.toThrow();
  });

  it("runs a notebook that declares no edges at all in document order", async () => {
    const path = await notebookOf(promptCell("a"), promptCell("b"), promptCell("c"));

    const record = await runNotebook(path, { agent: readyAgent().create });

    expect(record.cells.map((cell) => cell.id)).toEqual(["a", "b", "c"]);
  });

  it("runs the example notebook whose cells are written out of order", async () => {
    const example = fileURLToPath(new URL("../../examples/audit.md", import.meta.url));
    const path = await notebookFile(await readFile(example, "utf8"));
    const agent = createScriptedAgent([{ text: "Nothing alarming." }, { text: "Written up." }]);

    const record = await runNotebook(path, { agent: agent.create, inputs: { target: "src" } });

    expect(record.cells.map((cell) => [cell.id, cell.status])).toEqual([
      ["scope", "ok"],
      ["review", "ok"],
      ["report", "ok"],
    ]);
  });
});

/** The anchors a run recorded, in the order its cells ran, absent ones included. */
const anchorsOf = (record: RunRecord) =>
  record.cells.map((cell) => (cell.type === "prompt" ? cell.anchor : undefined));

describe("shared context", () => {
  it("sends every cell to one agent session, so a later cell can build on an earlier one", async () => {
    const path = await notebookFile(twoCells);
    const agent = createScriptedAgent([{ text: "first done" }, { text: "second done" }]);

    await runNotebook(path, { agent: agent.create });

    // One session for the whole notebook is what makes "now do the same for the
    // others" mean anything: the second body arrives at an agent that already
    // holds the first turn.
    expect(agent.creations).toBe(1);
    expect(agent.prompts).toEqual(["Do the first thing.", "Do the second thing."]);
  });

  it("records the agent session its prompt cells ran in", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([{ text: "Hello" }]);

    const record = await runNotebook(path, { agent: agent.create });

    expect(record.agentSession).toBe(agent.agentSession);
  });

  it("records no session for a notebook that never reaches the agent", async () => {
    const path = await notebookFile(oneBashCell("echo cheap"));

    const record = await runNotebook(path, { agent: unusedAgent().create });

    expect(record.agentSession).toBeUndefined();
  });

  it("records no session when every turn failed, since none of them anchored it", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([{ error: "provider exploded" }]);

    const record = await runNotebook(path, { agent: agent.create });

    expect(record.agentSession).toBeUndefined();
  });
});

describe("running some of a notebook's cells", () => {
  it("runs only the cells the run names", async () => {
    const path = await notebookFile(twoCells);
    const agent = createScriptedAgent([{ text: "second done" }]);

    const record = await runNotebook(path, { agent: agent.create, cells: ["second"] });

    expect(record.cells.map((cell) => cell.id)).toEqual(["second"]);
    expect(agent.prompts).toEqual(["Do the second thing."]);
  });

  it("runs the cells it names in the order the graph requires, not the order given", async () => {
    const path = await notebookOf(promptCell("report", "collect"), promptCell("collect"));

    const record = await runNotebook(path, {
      agent: readyAgent().create,
      cells: ["report", "collect"],
    });

    expect(record.cells.map((cell) => cell.id)).toEqual(["collect", "report"]);
  });

  it("refuses a run naming a cell the notebook does not have", async () => {
    const path = await notebookFile(twoCells);
    const agent = createScriptedAgent([{ text: "never reached" }]);

    await expect(runNotebook(path, { agent: agent.create, cells: ["scond"] })).rejects.toThrow(
      /No cell named "scond"/,
    );
    expect(agent.prompts).toEqual([]);
  });
});

describe("anchoring", () => {
  it("records the anchor each prompt cell's turn ended at", async () => {
    const path = await notebookFile(twoCells);
    const agent = createScriptedAgent([{ text: "first done" }, { text: "second done" }]);

    const record = await runNotebook(path, { agent: agent.create });

    expect(anchorsOf(record)).toEqual(agent.anchors);
    expect(agent.anchors).toHaveLength(2);
  });

  it("records no anchor for a bash cell, which never enters the agent session", async () => {
    const path = await notebookFile(oneBashCell("echo cheap"));

    const record = await runNotebook(path, { agent: unusedAgent().create });

    expect(anchorsOf(record)).toEqual([undefined]);
  });

  it("records no anchor for a cell whose turn failed", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([{ error: "provider exploded" }]);

    const record = await runNotebook(path, { agent: agent.create });

    expect(anchorsOf(record)).toEqual([undefined]);
  });

  it("reopens the agent session of the run it continues", async () => {
    const path = await notebookFile(twoCells);
    const first = createScriptedAgent([{ text: "first done" }, { text: "second done" }]);
    const before = await runNotebook(path, { agent: first.create });

    const again = createScriptedAgent([{ text: "second, again" }]);
    await runNotebook(path, { agent: again.create, continues: before, cells: ["second"] });

    expect(again.setup?.agentSession).toBe(before.agentSession);
  });

  it("forks the session at the anchor the re-run cell's predecessor recorded", async () => {
    const path = await notebookFile(twoCells);
    const first = createScriptedAgent([{ text: "first done" }, { text: "second done" }]);
    const before = await runNotebook(path, { agent: first.create });

    const again = createScriptedAgent([{ text: "second, again" }]);
    await runNotebook(path, { agent: again.create, continues: before, cells: ["second"] });

    // Where `second` began the last time, rather than where the run left off:
    // the turn it is replacing is the one after this anchor.
    expect(again.resumptions).toEqual([first.anchors[0]]);
    expect(again.prompts).toEqual(["Do the second thing."]);
  });

  it("begins in an empty context when the cell it runs again ran first", async () => {
    const path = await notebookFile(twoCells);
    const first = createScriptedAgent([{ text: "first done" }, { text: "second done" }]);
    const before = await runNotebook(path, { agent: first.create });

    const again = createScriptedAgent([{ text: "first, again" }]);
    await runNotebook(path, { agent: again.create, continues: before, cells: ["first"] });

    // Undefined rather than nothing at all: the reopened session's leaf sits at
    // the end of the run being continued, so it has to be moved off it.
    expect(again.resumptions).toEqual([undefined]);
  });

  it("passes over a predecessor that recorded no anchor", async () => {
    const path = await notebookFile(
      `${promptCell("ask")}\n\`\`\`bash id=count\necho 2\n\`\`\`\n\n${promptCell("explain")}`,
    );
    const first = readyAgent();
    const before = await runNotebook(path, { agent: first.create });

    const again = createScriptedAgent([{ text: "explained again" }]);
    await runNotebook(path, { agent: again.create, continues: before, cells: ["explain"] });

    // The bash cell between them never entered the session, so the anchor to
    // fork at is the prompt cell's, two places back.
    expect(again.resumptions).toEqual([first.anchors[0]]);
  });

  it("forks once and then carries on, rather than forking before every cell", async () => {
    const path = await notebookOf(promptCell("a"), promptCell("b"), promptCell("c"));
    const first = readyAgent();
    const before = await runNotebook(path, { agent: first.create });

    const again = readyAgent();
    await runNotebook(path, { agent: again.create, continues: before, cells: ["b", "c"] });

    // `c` follows the `b` that has just run, so its context is already right
    // and forking it back to where `c` began last time would discard `b`.
    expect(again.resumptions).toEqual([first.anchors[0]]);
    expect(again.prompts).toEqual(["Do b.", "Do c."]);
  });

  it("leaves the run it continues holding its own anchors", async () => {
    const path = await notebookFile(twoCells);
    const first = createScriptedAgent([{ text: "first done" }, { text: "second done" }]);
    const before = await runNotebook(path, { agent: first.create });

    const again = createScriptedAgent([{ text: "second, again" }]);
    await runNotebook(path, { agent: again.create, continues: before, cells: ["second"] });

    // Nothing is rewritten and nothing is deleted: the abandoned turn is still
    // accounted for, in the record of the run that produced it.
    const written: RunRecord = JSON.parse(await readFile(recordPath(path, before.id), "utf8"));
    expect(anchorsOf(written)).toEqual(first.anchors);
  });

  it("starts a fresh session when it continues nothing", async () => {
    const path = await notebookFile(twoCells);
    const agent = createScriptedAgent([{ text: "first done" }, { text: "second done" }]);

    await runNotebook(path, { agent: agent.create });

    expect(agent.setup?.agentSession).toBeUndefined();
    expect(agent.resumptions).toEqual([]);
  });
});

/** A chain: each cell uses the one written before it. */
const chainOfThree = () => notebookOf(promptCell("a"), promptCell("b", "a"), promptCell("c", "b"));

/** Two cells joined by an edge, and a third joined to neither of them. */
const pairAndSpare = () => notebookOf(promptCell("a"), promptCell("b", "a"), promptCell("spare"));

/** Runs some of a notebook's cells again, carrying on from an earlier run. */
const rerun = (path: string, before: RunRecord, cells: readonly string[]) =>
  runNotebook(path, { agent: readyAgent().create, continues: before, cells });

describe("staleness", () => {
  it("leaves nothing stale when the whole notebook runs", async () => {
    const path = await chainOfThree();

    const record = await runNotebook(path, { agent: readyAgent().create });

    expect(record.stale).toEqual([]);
  });

  it("marks the cell that uses a re-run cell stale", async () => {
    const path = await chainOfThree();
    const before = await runNotebook(path, { agent: readyAgent().create });

    const record = await rerun(path, before, ["b"]);

    expect(record.stale).toEqual(["c"]);
  });

  it("marks a dependent's own dependents stale, the length of the chain", async () => {
    const path = await chainOfThree();
    const before = await runNotebook(path, { agent: readyAgent().create });

    const record = await rerun(path, before, ["a"]);

    expect(record.stale).toEqual(["b", "c"]);
  });

  it("leaves a cell that does not use the re-run one alone", async () => {
    const path = await pairAndSpare();
    const before = await runNotebook(path, { agent: readyAgent().create });

    const record = await rerun(path, before, ["a"]);

    expect(record.stale).toEqual(["b"]);
  });

  it("keeps the previous result of a cell the re-run left valid", async () => {
    const path = await pairAndSpare();
    const first = createScriptedAgent([{ text: "a done" }, { text: "b done" }, { text: "spared" }]);
    const before = await runNotebook(path, { agent: first.create });

    await rerun(path, before, ["a"]);

    // Nothing is deleted and nothing is rewritten: the run that produced the
    // spare cell's result still holds it, which is where a reader finds it.
    const written: RunRecord = JSON.parse(await readFile(recordPath(path, before.id), "utf8"));
    expect(written.cells).toEqual(before.cells);
    expect(written.cells.find((cell) => cell.id === "spare")).toMatchObject({ text: "spared" });
  });

  it("lists the stale cells in the order they would run, not the order written", async () => {
    const path = await notebookOf(
      promptCell("third", "second"),
      promptCell("second", "first"),
      promptCell("first"),
    );
    const before = await runNotebook(path, { agent: readyAgent().create });

    const record = await rerun(path, before, ["first"]);

    expect(record.stale).toEqual(["second", "third"]);
  });

  it("runs no dependent of its own accord", async () => {
    const path = await chainOfThree();
    const before = await runNotebook(path, { agent: readyAgent().create });
    const again = readyAgent();

    const record = await runNotebook(path, {
      agent: again.create,
      continues: before,
      cells: ["a"],
    });

    expect(again.prompts).toEqual(["Do a."]);
    expect(record.cells.map((cell) => cell.id)).toEqual(["a"]);
  });

  it("marks the dependents of a failed cell stale", async () => {
    const path = await chainOfThree();
    const agent = createScriptedAgent([{ text: "a done" }, { error: "provider exploded" }]);

    const record = await runNotebook(path, { agent: agent.create });

    // `b` errored, which its own record says; `c` is stale, having been left
    // behind a cell that ran again and produced nothing to build on.
    expect(record.cells.map((cell) => [cell.id, cell.status])).toEqual([
      ["a", "ok"],
      ["b", "error"],
    ]);
    expect(record.stale).toEqual(["c"]);
  });

  it("keeps a cell stale that was stale already and did not run again", async () => {
    const path = await notebookOf(
      promptCell("a"),
      promptCell("b", "a"),
      promptCell("x"),
      promptCell("y", "x"),
    );
    const before = await runNotebook(path, { agent: readyAgent().create });

    const first = await rerun(path, before, ["a"]);
    const second = await rerun(path, first, ["x"]);

    expect(first.stale).toEqual(["b"]);
    // `b` is no less stale for this run having been about the other chain.
    expect(second.stale).toEqual(["b", "y"]);
  });

  it("marks a cell stale that ran over a gap, having missed the cell between", async () => {
    const path = await chainOfThree();
    const before = await runNotebook(path, { agent: readyAgent().create });

    const record = await rerun(path, before, ["a", "c"]);

    // `c` has just run, and is stale all the same: it forked at `a`'s new turn
    // and never saw `b`'s, so what it was built on is no longer what `b` says.
    expect(record.cells.map((cell) => cell.id)).toEqual(["a", "c"]);
    expect(record.stale).toEqual(["b", "c"]);
  });

  it("leaves a cell that has never run out of it, having no result to go out of date", async () => {
    const path = await pairAndSpare();

    const record = await runNotebook(path, { agent: readyAgent().create, cells: ["a"] });

    // `spare` depends on nothing and has never run, which is not the same as
    // being stale: there is no result of it for `a` to have got ahead of. What
    // it is instead — never run — is read off the cells of the runs so far.
    expect(record.stale).toEqual(["b"]);
  });

  it("names the run it carried on from, so the rest of the results can be found", async () => {
    const path = await chainOfThree();
    const before = await runNotebook(path, { agent: readyAgent().create });

    const record = await rerun(path, before, ["b"]);

    expect(before.continues).toBeUndefined();
    expect(record.continues).toBe(before.id);
  });
});

describe("re-running the stale cells", () => {
  it("returns the notebook to fully valid", async () => {
    const path = await chainOfThree();
    const before = await runNotebook(path, { agent: readyAgent().create });
    const changed = await rerun(path, before, ["a"]);

    const record = await rerun(path, changed, changed.stale);

    expect(record.cells.map((cell) => cell.id)).toEqual(["b", "c"]);
    expect(record.stale).toEqual([]);
  });

  it("returns a notebook run over a gap to fully valid, in one run", async () => {
    const path = await chainOfThree();
    const before = await runNotebook(path, { agent: readyAgent().create });
    const gapped = await rerun(path, before, ["a", "c"]);

    const record = await rerun(path, gapped, gapped.stale);

    expect(record.stale).toEqual([]);
  });

  it("spends nothing on the cells that were left valid", async () => {
    const path = await pairAndSpare();
    const before = await runNotebook(path, { agent: readyAgent().create });
    const changed = await rerun(path, before, ["a"]);
    const again = readyAgent();

    await runNotebook(path, { agent: again.create, continues: changed, cells: changed.stale });

    expect(again.prompts).toEqual(["Do b."]);
  });
});
