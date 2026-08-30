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

    const record = await runNotebook(path, { agent });

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

    const cell = onlyCell(await runNotebook(path, { agent }), "prompt");

    expect(cell.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(cell.model).toBe("anthropic/claude-sonnet-4");
    expect(cell.toolCalls).toEqual([{ name: "bash", input: { command: "ls" } }]);
  });

  it("runs cells in document order, ignoring the prose between them", async () => {
    const path = await notebookFile(twoCells);
    const agent = createScriptedAgent([{ text: "first done" }, { text: "second done" }]);

    const record = await runNotebook(path, { agent });

    expect(agent.prompts).toEqual(["Do the first thing.", "Do the second thing."]);
    expect(record.cells.map((cell) => cell.id)).toEqual(["first", "second"]);
  });

  it("writes the run record beside the notebook rather than into it", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([{ text: "Hello, world" }]);

    const record = await runNotebook(path, { agent });
    const written = JSON.parse(await readFile(recordPath(path, record.id), "utf8"));

    expect(written).toEqual(record);
    expect(await readFile(path, "utf8")).toBe(oneCell);
  });

  it("keeps a separate record for each run of the same notebook", async () => {
    const path = await notebookFile(oneCell);

    const first = await runNotebook(path, { agent: createScriptedAgent([{ text: "one" }]) });
    const second = await runNotebook(path, { agent: createScriptedAgent([{ text: "two" }]) });

    expect(second.id).not.toBe(first.id);
    expect(JSON.parse(await readFile(recordPath(path, first.id), "utf8")).cells[0].text).toBe(
      "one",
    );
  });

  it("halts the run when a cell fails, leaving later cells unrun", async () => {
    const path = await notebookFile(twoCells);
    const agent = createScriptedAgent([{ error: "provider exploded" }, { text: "never reached" }]);

    const record = await runNotebook(path, { agent });

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

    const record = await runNotebook(path, { agent });

    expect(record.cells.map((cell) => cell.id)).toEqual(["greet"]);
  });

  it("runs the example notebook that the command line is documented against", async () => {
    const example = fileURLToPath(new URL("../../examples/hello.md", import.meta.url));
    // Run a copy, so the suite leaves no run records inside the repo.
    const path = await notebookFile(await readFile(example, "utf8"));
    const agent = createScriptedAgent([{ text: "pong" }]);

    const record = await runNotebook(path, { agent });

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

    const record = await runNotebook(path, { agent: unusedAgent() });

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

    const cell = onlyCell(await runNotebook(path, { agent }), "bash");

    expect(agent.prompts).toEqual([]);
    expect(cell.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("treats a non-zero exit as a failure, halting before the next cell", async () => {
    const path = await notebookFile(
      `\`\`\`bash id=check\necho what went wrong >&2\nexit 3\n\`\`\`\n\n\`\`\`prompt id=explain\nExplain it.\n\`\`\`\n`,
    );
    const agent = createScriptedAgent([{ text: "never reached" }]);

    const record = await runNotebook(path, { agent });
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

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent() }), "bash");

    expect(cell.stdout.trim()).toBe(dirname(path));
  });

  it("runs the command in the workspace the notebook declares", async () => {
    const path = await notebookFile(`---\nworkspace: service\n---\n\n${oneBashCell("pwd")}`);
    await mkdir(join(dirname(path), "service"));

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent() }), "bash");

    expect(cell.stdout.trim()).toBe(join(dirname(path), "service"));
  });

  it("records a command killed by a signal as a failure, naming the signal", async () => {
    const path = await notebookFile(oneBashCell("kill -9 $$"));

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent() }), "bash");

    expect(cell.status).toBe("error");
    expect(cell.exitCode).toBeNull();
    expect(cell.error).toContain("SIGKILL");
  });

  it("records a command it could not even start as a failure of the cell", async () => {
    const path = await notebookFile(`---\nworkspace: absent\n---\n\n${oneBashCell("pwd")}`);

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent() }), "bash");

    expect(cell.status).toBe("error");
    expect(cell.exitCode).toBeNull();
    expect(cell.error).toContain("could not be run");
    // Not the command's own output, so it is not passed off as such.
    expect(cell.stderr).toBe("");
  });

  it("runs a multi-line body as one script, so its work lands in the workspace", async () => {
    const path = await notebookFile(
      oneBashCell('greeting=hello\nprintf "%s\\n" "$greeting" > made'),
    );

    await runNotebook(path, { agent: unusedAgent() });

    expect(await readFile(join(dirname(path), "made"), "utf8")).toBe("hello\n");
  });

  it("runs bash and prompt cells together, in document order", async () => {
    const path = await notebookFile(
      `\`\`\`prompt id=ask\nAsk something.\n\`\`\`\n\n\`\`\`bash id=then\necho after\n\`\`\`\n`,
    );
    const agent = createScriptedAgent([{ text: "asked" }]);

    const record = await runNotebook(path, { agent });

    expect(record.cells.map((cell) => [cell.id, cell.type, cell.status])).toEqual([
      ["ask", "prompt", "ok"],
      ["then", "bash", "ok"],
    ]);
  });

  it("reads nothing from the terminal, so a command expecting input cannot wedge", async () => {
    const path = await notebookFile(oneBashCell("cat"));

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent() }), "bash");

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

    await runNotebook(path, { agent });

    expect(agent.prompts).toEqual(["Audit src."]);
  });

  it("prefers a value supplied for the run over the declared default", async () => {
    const path = await notebookFile(withInputs(target));
    const agent = createScriptedAgent([{ text: "audited" }]);

    await runNotebook(path, { agent, inputs: { target: "docs" } });

    expect(agent.prompts).toEqual(["Audit docs."]);
  });

  it("replaces every reference to the same input", async () => {
    const path = await notebookFile(
      withInputs(target, "Audit {{target}}, then re-read {{target}}."),
    );
    const agent = createScriptedAgent([{ text: "audited" }]);

    await runNotebook(path, { agent });

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

    await runNotebook(path, { agent });

    expect(agent.prompts).toEqual(["Try 3 times, strict=false."]);
  });

  it("interpolates into a bash cell's command as well", async () => {
    const path = await notebookFile(
      `---\ninputs:\n  - name: greeting\n    default: hello\n---\n\n\`\`\`bash id=say\necho {{greeting}}\n\`\`\`\n`,
    );

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent() }), "bash");

    expect(cell.stdout).toBe("hello\n");
  });

  it("leaves an escaped reference as the text it stands for", async () => {
    const path = await notebookFile(`\`\`\`bash id=say\necho '\\{{end}}'\n\`\`\`\n`);

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent() }), "bash");

    expect(cell.stdout).toBe("{{end}}\n");
  });

  it("stops before anything runs when a required input has no value", async () => {
    const path = await notebookFile(
      withInputs("  - name: target\n    description: The directory to audit\n"),
    );
    const agent = createScriptedAgent([{ text: "never reached" }]);

    await expect(runNotebook(path, { agent })).rejects.toThrow(
      /required input "target".*The directory to audit/,
    );
    expect(agent.prompts).toEqual([]);
  });

  it("stops before anything runs when a supplied value is of the wrong type", async () => {
    const path = await notebookFile(
      withInputs("  - name: retries\n    default: 3\n", "Try {{retries}} times."),
    );
    const agent = createScriptedAgent([{ text: "never reached" }]);

    await expect(runNotebook(path, { agent, inputs: { retries: "many" } })).rejects.toThrow(
      /"retries" expects a number/,
    );
    expect(agent.prompts).toEqual([]);
  });

  it("stops before anything runs when a value names no declared input", async () => {
    const path = await notebookFile(withInputs(target));
    const agent = createScriptedAgent([{ text: "never reached" }]);

    await expect(runNotebook(path, { agent, inputs: { targt: "docs" } })).rejects.toThrow(
      /No input named "targt"/,
    );
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
      runNotebook(path, { agent: unusedAgent(), inputs: { retries: "many" } }),
    ).rejects.toThrow(/required input "target"[\s\S]*"retries" expects a number/);
  });

  it("runs the example notebook the input flags are documented against", async () => {
    const example = fileURLToPath(new URL("../../examples/greet.md", import.meta.url));
    const path = await notebookFile(await readFile(example, "utf8"));
    const agent = createScriptedAgent([{ text: "Hello, Ada!" }]);

    const record = await runNotebook(path, { agent, inputs: { name: "Ada" } });

    expect(agent.prompts).toEqual(["Say hello to Ada in one short sentence."]);
    expect(record.cells).toEqual([
      expect.objectContaining({ id: "announce", status: "ok", stdout: "Greeting Ada\n" }),
      expect.objectContaining({ id: "greet", status: "ok" }),
    ]);
  });
});
