import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createScriptedAgent } from "../agent/scripted.js";
import { runNotebook } from "./runner.js";
import { recordPath } from "./store.js";

async function notebookFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "octo-run-"));
  const path = join(dir, "notebook.md");
  await writeFile(path, contents, "utf8");
  return path;
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

    const [cell] = (await runNotebook(path, { agent })).cells;

    expect(cell?.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(cell?.model).toBe("anthropic/claude-sonnet-4");
    expect(cell?.toolCalls).toEqual([{ name: "bash", input: { command: "ls" } }]);
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

  it("refuses a bash cell rather than silently skipping it", async () => {
    const path = await notebookFile(`\`\`\`bash id=build\nnpm run build\n\`\`\`\n`);
    const agent = createScriptedAgent([]);

    await expect(runNotebook(path, { agent })).rejects.toThrow(/Bash cells are not supported yet/);
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
