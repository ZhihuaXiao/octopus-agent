import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AgentFactory } from "../agent/agent.js";
import { type ScriptedAgent, createScriptedAgent } from "../agent/scripted.js";
import type { CellRecord, RunRecord } from "./record.js";
import { type RunEvent, RunRefusal, runNotebook } from "./runner.js";
import { serviceAlive, stopService } from "./shell.js";
import { recordPath, runDirectory } from "./store.js";

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
        usage: { inputTokens: 12, outputTokens: 3, cost: 0.0001 },
        model: "anthropic/claude-sonnet-4",
        toolCalls: [{ name: "bash", input: { command: "ls" } }],
      },
    ]);

    const cell = onlyCell(await runNotebook(path, { agent: agent.create }), "prompt");

    expect(cell.usage).toEqual({ inputTokens: 12, outputTokens: 3, cost: 0.0001 });
    expect(cell.model).toBe("anthropic/claude-sonnet-4");
    expect(cell.toolCalls).toEqual([{ name: "bash", input: { command: "ls" } }]);
  });

  it("tells a plan cell to plan and an ask cell only to answer", async () => {
    const path = await notebookFile(
      "```prompt id=plan mode=plan\nLook.\n```\n\n```prompt id=ask mode=ask\nWhy?\n```\n\n```prompt id=act\nDo it.\n```\n",
    );
    const agent = createScriptedAgent([
      { text: "a plan" },
      { text: "an answer" },
      { text: "done" },
    ]);

    await runNotebook(path, { agent: agent.create });

    expect(agent.prompts[0]).toMatch(/^Plan mode\./);
    expect(agent.prompts[0]).toContain("\n\nLook.");
    expect(agent.prompts[1]).toMatch(/^Ask mode\./);
    expect(agent.prompts[1]).toContain("\n\nWhy?");
    expect(agent.prompts[2]).toBe("Do it.");
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
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        artifacts: [],
        startedAt: expect.any(String),
        endedAt: expect.any(String),
      },
    ]);
  });

  it("names a service the command left running, so it can be stopped", async () => {
    const path = await notebookFile(oneBashCell("sleep 30 &\necho launched"));
    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");
    const pids = cell.servicePids ?? [];
    try {
      expect(cell).toMatchObject({ status: "ok", stdout: "launched\n", exitCode: 0 });
      expect(pids.length).toBeGreaterThan(0);
      expect(serviceAlive(pids)).toBe(true);
      stopService(pids);
      const started = Date.now();
      while (serviceAlive(pids) && Date.now() - started < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(serviceAlive(pids)).toBe(false);
    } finally {
      stopService(pids);
    }
  });

  it("spends no tokens, because it never reaches the agent", async () => {
    const path = await notebookFile(oneBashCell("echo cheap"));
    const agent = unusedAgent();

    const cell = onlyCell(await runNotebook(path, { agent: agent.create }), "bash");

    expect(agent.prompts).toEqual([]);
    expect(cell.usage).toEqual({ inputTokens: 0, outputTokens: 0, cost: 0 });
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
    // Null rather than a status it never reached, as a command stopped by its
    // timeout reports too.
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

/** A prompt cell with the given id, carrying whatever else its fence declares. */
const promptFence = (id: string, attributes: string) =>
  `\`\`\`prompt id=${id}${attributes}\nDo ${id}.\n\`\`\`\n`;

const declaringUses = (uses: string | undefined) => (uses === undefined ? "" : ` uses=${uses}`);

/** A prompt cell with the given id, and the cells it uses if it declares any. */
const promptCell = (id: string, uses?: string) => promptFence(id, declaringUses(uses));

const notebookOf = (...cells: readonly string[]) => notebookFile(cells.join("\n"));

/** Enough scripted turns for any of these notebooks, since none of them fail. */
const readyAgent = () => createScriptedAgent(Array.from({ length: 8 }, () => ({ text: "done" })));

describe("what a refusal says of itself", () => {
  /** The refusal a run ends in, for asserting on beyond its message. */
  async function refusalOf(run: Promise<RunRecord>): Promise<RunRefusal> {
    try {
      await run;
    } catch (cause) {
      if (cause instanceof RunRefusal) return cause;
      throw new Error(`Expected a refusal, got ${String(cause)}`);
    }
    throw new Error("Expected the run to be refused");
  }

  it("names the inputs, with everything wrong with them one to a line", async () => {
    const path = await notebookFile(
      withInputs(
        "  - name: target\n  - name: retries\n    default: 3\n",
        "Audit {{target}} {{retries}} times.",
      ),
    );

    const refusal = await refusalOf(
      runNotebook(path, { agent: unusedAgent().create, inputs: { retries: "many" } }),
    );

    expect(refusal.kind).toBe("inputs");
    expect(refusal.problems).toEqual([
      'No value for the required input "target" (string).',
      'Input "retries" expects a number, but was given "many".',
    ]);
    // The message a terminal prints is the problems under the path, as before.
    expect(refusal.message).toBe(`Cannot run ${path}:\n${refusal.problems.join("\n")}`);
  });

  it("names the environment when a declared skill, package or tool is missing", async () => {
    const path = await notebookFile(declaring("skills:\n  - review\ntools:\n  - grep\n"));
    const agent = createScriptedAgent([{ text: "never reached" }], { tools: [] });

    const refusal = await refusalOf(runNotebook(path, { agent: agent.create }));

    expect(refusal.kind).toBe("environment");
    expect(refusal.problems).toEqual([
      'This notebook declares the tool "grep", which is not available here.',
      'This notebook declares the skill "review", which is not available here.',
    ]);
  });

  it("names the notebook, the cells, the workspace and the agent in their turn", async () => {
    const broken = await notebookFile("```prompt id=go\nnever closed\n");
    expect((await refusalOf(runNotebook(broken, { agent: unusedAgent().create }))).kind).toBe(
      "notebook",
    );

    const sound = await notebookFile(oneCell);
    const cells = await refusalOf(
      runNotebook(sound, { agent: unusedAgent().create, cells: ["gret"] }),
    );
    expect(cells.kind).toBe("cells");
    expect(cells.problems).toEqual(['No cell named "gret" in this notebook.']);

    const elsewhere = await notebookFile(declaring("workspace: absent\n"));
    expect((await refusalOf(runNotebook(elsewhere, { agent: unusedAgent().create }))).kind).toBe(
      "workspace",
    );

    const undecided = () => Promise.reject(new Error("nothing has decided whether to trust it"));
    const agent = await refusalOf(runNotebook(sound, { agent: undecided }));
    expect(agent.kind).toBe("agent");
    expect(agent.problems).toEqual(["nothing has decided whether to trust it"]);
  });
});

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

  it("records the anchors standing after it, this run's laid over the continued run's", async () => {
    const path = await notebookFile(twoCells);
    const first = createScriptedAgent([{ text: "first done" }, { text: "second done" }]);
    const before = await runNotebook(path, { agent: first.create });

    const again = createScriptedAgent([{ text: "second, again" }]);
    const rerun = await runNotebook(path, {
      agent: again.create,
      continues: before,
      cells: ["second"],
    });

    // Carried through the chain as `stale` is: a run of `second` alone still
    // says where `first` stands, which is what a later run needs of it.
    expect(before.anchors).toEqual({ first: first.anchors[0], second: first.anchors[1] });
    expect(rerun.anchors).toEqual({ first: first.anchors[0], second: again.anchors[0] });
  });

  it("puts the same cell run twice over back where it began both times", async () => {
    const path = await notebookFile(twoCells);
    const first = createScriptedAgent([{ text: "first done" }, { text: "second done" }]);
    const before = await runNotebook(path, { agent: first.create });

    const again = createScriptedAgent([{ text: "second, again" }]);
    const rerun = await runNotebook(path, {
      agent: again.create,
      continues: before,
      cells: ["second"],
    });
    const once = createScriptedAgent([{ text: "second, once more" }]);
    await runNotebook(path, { agent: once.create, continues: rerun, cells: ["second"] });

    // A run of `second` alone has nothing before `second` in its own cells, so
    // reading that run's cells alone would drop `second` into an empty context
    // the second time; the anchors it carried forward say where `first` ended.
    expect(once.resumptions).toEqual([first.anchors[0]]);
  });

  it("begins a cell in an empty context however many runs since it last ran first", async () => {
    const path = await notebookFile(twoCells);
    const first = createScriptedAgent([{ text: "first done" }, { text: "second done" }]);
    const before = await runNotebook(path, { agent: first.create });

    const again = createScriptedAgent([{ text: "second, again" }]);
    const rerun = await runNotebook(path, {
      agent: again.create,
      continues: before,
      cells: ["second"],
    });
    const back = createScriptedAgent([{ text: "first, again" }]);
    await runNotebook(path, { agent: back.create, continues: rerun, cells: ["first"] });

    // `first` runs before `second`, so nothing stands before it, whatever the
    // run being continued happened to run; reading that run's cells alone
    // would have put `first` after the new `second`.
    expect(back.resumptions).toEqual([undefined]);
  });

  it("forks a re-run of a failed cell at where the failed turn began", async () => {
    const path = await notebookFile(twoCells);
    const first = createScriptedAgent([{ text: "first done" }, { text: "second done" }]);
    const before = await runNotebook(path, { agent: first.create });

    const failing = createScriptedAgent([{ error: "provider exploded" }]);
    const failed = await runNotebook(path, {
      agent: failing.create,
      continues: before,
      cells: ["second"],
    });
    const again = createScriptedAgent([{ text: "second, at last" }]);
    await runNotebook(path, { agent: again.create, continues: failed, cells: ["second"] });

    // The failed turn recorded no anchor (ADR-0014), and the run before it is
    // not in hand; the anchors the failed run carried forward — `second`'s own
    // dropped, `first`'s standing — say where to go, and name the agent
    // session they are in, which the failed run kept though it anchored nothing.
    expect(failed.anchors).toEqual({ first: first.anchors[0] });
    expect(failed.agentSession).toBe(before.agentSession);
    expect(again.setup?.agentSession).toBe(before.agentSession);
    expect(again.resumptions).toEqual([first.anchors[0]]);
  });

  it("carries the agent session it reopened forward, though it anchored nothing in it", async () => {
    const path = await notebookFile(
      `${promptCell("ask")}\n\`\`\`bash id=count\necho 2\n\`\`\`\n\n${promptCell("explain")}`,
    );
    const first = readyAgent();
    const before = await runNotebook(path, { agent: first.create });

    // A bash cell alone: no turn, so no anchor, but the run still carried on
    // from a session and the next run must be able to as well.
    const counted = await runNotebook(path, {
      agent: unusedAgent().create,
      continues: before,
      cells: ["count"],
    });
    const again = createScriptedAgent([{ text: "explained again" }]);
    await runNotebook(path, { agent: again.create, continues: counted, cells: ["explain"] });

    expect(counted.agentSession).toBe(before.agentSession);
    expect(again.setup?.agentSession).toBe(before.agentSession);
    // `explain` begins where the run being continued left the session: after
    // `ask`, the only turn ever taken in it.
    expect(again.resumptions).toEqual([first.anchors[0]]);
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

/** The same, marked isolated, since isolation and dependency are separate axes. */
const isolatedCell = (id: string, uses?: string) =>
  promptFence(id, ` isolated${declaringUses(uses)}`);

/** The turn a body was sent in, for asking what context that cell saw. */
const turnFor = (agent: ScriptedAgent, id: string) => {
  const turn = agent.turns.find((sent) => sent.body === `Do ${id}.`);
  if (turn === undefined) throw new Error(`"${id}" never reached the agent`);
  return turn;
};

describe("isolated cells", () => {
  it("gives an isolated cell a context holding nothing of the notebook's shared one", async () => {
    const path = await notebookOf(promptCell("first"), isolatedCell("apart"), promptCell("last"));
    const agent = readyAgent();

    await runNotebook(path, { agent: agent.create });

    // None of the notebook's shared context reaches it, though two cells that
    // share that context ran either side of it.
    expect(turnFor(agent, "apart").context).toEqual([]);
    expect(turnFor(agent, "apart").session).not.toBe(agent.agentSession);
  });

  it("leaves the shared context as though the isolated cell had not run", async () => {
    const path = await notebookOf(promptCell("first"), isolatedCell("apart"), promptCell("last"));
    const agent = readyAgent();

    await runNotebook(path, { agent: agent.create });

    // `last` sees `first` and only `first`: isolation cuts both ways, or a cell
    // saying "now do the same for the others" would mean something different
    // for having had an unrelated cell run beside it.
    expect(turnFor(agent, "last").context).toEqual(["Do first."]);
    expect(turnFor(agent, "last").session).toBe(agent.agentSession);
  });

  it("asks for a fresh agent session rather than reopening the notebook's", async () => {
    const path = await notebookOf(promptCell("shared"), isolatedCell("apart"));
    const agent = readyAgent();

    await runNotebook(path, { agent: agent.create });

    expect(agent.creations).toBe(2);
    expect(agent.setups[1]?.agentSession).toBeUndefined();
    // The same workspace and the same declared environment: isolation is about
    // the shared context, not about running somewhere else.
    expect(agent.setups[1]?.workspace).toBe(agent.setups[0]?.workspace);
  });

  it("disposes the agent it made for an isolated cell", async () => {
    const path = await notebookOf(promptCell("shared"), isolatedCell("apart"));
    const agent = readyAgent();

    await runNotebook(path, { agent: agent.create });

    expect(agent.disposed).toBe(true);
  });

  it("records no anchor for an isolated cell, whose session is not kept", async () => {
    const path = await notebookOf(promptCell("shared"), isolatedCell("apart"));

    const record = await runNotebook(path, { agent: readyAgent().create });

    // An anchor names an entry inside one agent session. The isolated cell's is
    // gone when the cell ends, so recording one would offer a later run a place
    // to fork that no longer exists.
    expect(anchorsOf(record)).toEqual([expect.any(String), undefined]);
  });

  it("records no agent session for a notebook whose every cell is isolated", async () => {
    const path = await notebookOf(isolatedCell("a"), isolatedCell("b"));

    const record = await runNotebook(path, { agent: readyAgent().create });

    expect(record.agentSession).toBeUndefined();
    expect(record.cells.map((cell) => cell.status)).toEqual(["ok", "ok"]);
  });

  it("records what an isolated cell produced like any other cell", async () => {
    const path = await notebookFile(isolatedCell("apart"));
    const agent = createScriptedAgent([
      { text: "done apart", usage: { inputTokens: 7, outputTokens: 2, cost: 0.00005 } },
    ]);

    const cell = onlyCell(await runNotebook(path, { agent: agent.create }), "prompt");

    expect(cell.text).toBe("done apart");
    expect(cell.usage).toEqual({ inputTokens: 7, outputTokens: 2, cost: 0.00005 });
  });

  it("fails only the cell whose fresh context could not be made", async () => {
    const path = await notebookOf(isolatedCell("apart"), promptCell("after", "apart"));
    const ready = readyAgent();
    let made = 0;
    // The first agent is the notebook's shared one, made before any cell runs,
    // so the refusal here is the isolated cell's own and not the run's.
    const flaky: AgentFactory = (setup) =>
      (made += 1) > 1
        ? Promise.reject(new Error("no session could be opened"))
        : ready.create(setup);

    const record = await runNotebook(path, { agent: flaky });

    expect(record.cells).toEqual([
      expect.objectContaining({
        id: "apart",
        status: "error",
        error: expect.stringContaining("no session"),
      }),
    ]);
  });
});

describe("an isolated cell run again", () => {
  it("is given exactly what it was given the first time", async () => {
    const path = await notebookOf(promptCell("shared"), isolatedCell("apart"));
    const first = readyAgent();
    const before = await runNotebook(path, { agent: first.create });

    const again = readyAgent();
    await runNotebook(path, { agent: again.create, continues: before, cells: ["apart"] });

    // Reproducible is this and nothing more: the same body against the same
    // empty context, so what differs between the two runs is only the model's
    // own non-determinism.
    expect(turnFor(again, "apart").body).toBe(turnFor(first, "apart").body);
    expect(turnFor(again, "apart").context).toEqual([]);
  });

  it("produces the same record it produced the first time, given the same turn", async () => {
    const path = await notebookOf(promptCell("shared"), isolatedCell("apart"));
    const turns = [{ text: "shared done" }, { text: "apart done", model: "openai/gpt-5" }];
    const before = await runNotebook(path, { agent: createScriptedAgent(turns).create });

    const record = await runNotebook(path, {
      agent: createScriptedAgent([turns[1] ?? { text: "" }]).create,
      continues: before,
      cells: ["apart"],
    });

    // As far as a scripted agent can carry it: what the two runs recorded for
    // the cell is the same, because what the cell was given is the same. What
    // a real model does with the same input twice is the part no test reaches,
    // and is why reproducible here means the context and not the text. When
    // each ran is the one thing that is honestly different.
    const untimed = ({ startedAt: _s, endedAt: _e, ...rest }: CellRecord) => rest;
    const first = before.cells.find((cell) => cell.id === "apart");
    if (first === undefined) throw new Error("the first run never recorded the cell");
    expect(untimed(onlyCell(record, "prompt"))).toEqual(untimed(first));
  });

  it("forks no session, having nothing to fork at", async () => {
    const path = await notebookOf(promptCell("shared"), isolatedCell("apart"));
    const first = readyAgent();
    const before = await runNotebook(path, { agent: first.create });

    const again = readyAgent();
    await runNotebook(path, { agent: again.create, continues: before, cells: ["apart"] });

    // A shared-context cell would be moved back to where it began last time.
    // An isolated one begins where it always begins.
    expect(again.resumptions).toEqual([]);
    expect(again.setups[1]?.agentSession).toBeUndefined();
  });

  it("leaves the shared cells to fork at their own anchors", async () => {
    const path = await notebookOf(promptCell("first"), isolatedCell("apart"), promptCell("last"));
    const first = readyAgent();
    const before = await runNotebook(path, { agent: first.create });

    const again = readyAgent();
    await runNotebook(path, { agent: again.create, continues: before, cells: ["apart", "last"] });

    // `last` forks where it began, which is the anchor `first` recorded. The
    // isolated cell between them recorded none and is passed over, exactly as a
    // bash cell is.
    expect(again.resumptions).toEqual([first.anchors[0]]);
  });
});

describe("parallel scheduling", () => {
  it("runs isolated cells with no edge between them at the same time", async () => {
    const path = await notebookOf(isolatedCell("a"), isolatedCell("b"), isolatedCell("c"));
    const agent = readyAgent();

    await runNotebook(path, { agent: agent.create });

    expect(agent.overlap).toBe(3);
  });

  it("never runs two shared-context cells at the same time", async () => {
    const path = await notebookOf(promptCell("a"), promptCell("b"), promptCell("c"));
    const agent = readyAgent();

    await runNotebook(path, { agent: agent.create });

    // They would both be appending to one message history, which is the whole
    // reason isolation is what parallelism is granted on.
    expect(agent.overlap).toBe(1);
  });

  it("holds an isolated cell back for the cells it declares it uses", async () => {
    const path = await notebookOf(isolatedCell("report", "collect"), isolatedCell("collect"));
    const agent = readyAgent();

    const record = await runNotebook(path, { agent: agent.create });

    // Isolation and dependency are separate axes: a fresh context says nothing
    // about when the cell may run.
    expect(record.cells.map((cell) => cell.id)).toEqual(["collect", "report"]);
    expect(agent.overlap).toBe(1);
  });

  it("records the cells in run order, whichever finished first", async () => {
    const path = await notebookOf(isolatedCell("a"), isolatedCell("b"), isolatedCell("c"));

    const record = await runNotebook(path, { agent: readyAgent().create });

    expect(record.cells.map((cell) => cell.id)).toEqual(["a", "b", "c"]);
  });

  it("runs isolated bash cells at the same time, as the workspace can see", async () => {
    // Each waits for the other's file, so this can only finish if the two are
    // running at once. Serially the first would wait out its own bound, fail,
    // and halt the run before the second started.
    const waitsFor = (id: string, mine: string, theirs: string) =>
      `\`\`\`bash id=${id} isolated\ntouch ${mine}\nwaited=0\nwhile [ ! -f ${theirs} ] && [ $waited -lt 100 ]; do sleep 0.05; waited=$((waited + 1)); done\n[ -f ${theirs} ]\n\`\`\`\n`;
    const path = await notebookOf(
      waitsFor("one", "one-here", "two-here"),
      waitsFor("two", "two-here", "one-here"),
    );

    const record = await runNotebook(path, { agent: unusedAgent().create });

    expect(record.cells.map((cell) => [cell.id, cell.status])).toEqual([
      ["one", "ok"],
      ["two", "ok"],
    ]);
  });

  it("runs a bash cell that is not isolated one at a time, as its author wrote it", async () => {
    // The first dawdles before writing its line. Run at the same time the two
    // would come out the other way round, which is what serial has to prevent:
    // an author writing two bash cells means the second to follow the first.
    const path = await notebookOf(
      "```bash id=one\nsleep 0.2\nprintf 'one\\n' >> log\n```\n",
      "```bash id=two\nprintf 'two\\n' >> log\n```\n",
    );

    await runNotebook(path, { agent: unusedAgent().create });

    expect(await readFile(join(dirname(path), "log"), "utf8")).toBe("one\ntwo\n");
  });

  it("runs the example notebook the isolated cells are documented against", async () => {
    const example = fileURLToPath(new URL("../../examples/survey.md", import.meta.url));
    const path = await notebookFile(await readFile(example, "utf8"));
    const agent = readyAgent();

    const record = await runNotebook(path, { agent: agent.create, inputs: { target: "src" } });

    expect(record.cells.map((cell) => [cell.id, cell.status])).toEqual([
      ["scope", "ok"],
      ["naming", "ok"],
      ["tests", "ok"],
      ["comments", "ok"],
      ["summary", "ok"],
    ]);
    // The three readings overlap and the summary does not, having said it waits
    // for them. It is the only cell to speak into the notebook's own session,
    // and finds nothing in it: the three readings left no trace there, which is
    // why the example has them hand their work on through the workspace.
    expect(agent.overlap).toBe(3);
    expect(agent.turns.at(-1)).toMatchObject({ session: agent.agentSession, context: [] });
  });

  it("starts nothing further once a cell has failed", async () => {
    // `c` is a bash cell so that the one scripted turn can only be `a`'s,
    // whichever of the two the scheduler happens to reach first.
    const path = await notebookOf(
      isolatedCell("a"),
      isolatedCell("b", "a"),
      "```bash id=c isolated\necho c\n```\n",
    );
    const agent = createScriptedAgent([{ error: "provider exploded" }]);

    const record = await runNotebook(path, { agent: agent.create });

    // `c` had already started beside `a` and is recorded; `b` was waiting on the
    // cell that failed and never starts.
    expect(record.cells.map((cell) => [cell.id, cell.status])).toEqual([
      ["a", "error"],
      ["c", "ok"],
    ]);
    expect(record.stale).toEqual(["b"]);
  });
});

describe("retries", () => {
  it("records the transient failures a turn was retried past, and the turn's result", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([
      { transient: "503 Service Unavailable" },
      { transient: "connection reset before headers" },
      { text: "Hello, at last" },
    ]);

    const cell = onlyCell(await runNotebook(path, { agent: agent.create }), "prompt");

    // The retries are the agent's to make — pi already retries a transient
    // provider or transport error — and the run's to account for: a cell that
    // took three attempts to answer should not read like one that took one.
    expect(cell.status).toBe("ok");
    expect(cell.text).toBe("Hello, at last");
    expect(cell.retries).toEqual([
      { error: "503 Service Unavailable" },
      { error: "connection reset before headers" },
    ]);
  });

  it("records the retries of a turn that failed all the same, and halts on it", async () => {
    const path = await notebookFile(twoCells);
    const agent = createScriptedAgent([
      { transient: "503 Service Unavailable" },
      { error: "401 Unauthorized" },
      { text: "never reached" },
    ]);

    const record = await runNotebook(path, { agent: agent.create });

    // Retried once and then failed for a reason no retry gets past. The record
    // says both: what was tried, and what the cell finally failed with.
    expect(record.cells).toEqual([
      expect.objectContaining({
        id: "first",
        status: "error",
        error: "401 Unauthorized",
        retries: [{ error: "503 Service Unavailable" }],
      }),
    ]);
    expect(agent.prompts).toEqual(["Do the first thing."]);
  });

  it("records no retries for a turn that answered first time", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([{ text: "Hello" }]);

    const cell = onlyCell(await runNotebook(path, { agent: agent.create }), "prompt");

    expect(cell.retries).toEqual([]);
  });

  it("records no retries for a bash cell, which is never retried", async () => {
    const path = await notebookFile(oneBashCell("exit 1"));

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");

    // A command that failed did what it was told and reported it; running it
    // again is a decision for whoever reads the record, not for the run.
    expect(cell.status).toBe("error");
    expect("retries" in cell).toBe(false);
  });
});

describe("timeouts", () => {
  it("aborts a prompt cell that outruns its timeout and reports a timeout, not a failure", async () => {
    const path = await notebookFile(
      `\`\`\`prompt id=slow timeout=50ms\nThink about it.\n\`\`\`\n\n\`\`\`prompt id=after\nCarry on.\n\`\`\`\n`,
    );
    const agent = createScriptedAgent([{ hangs: true }, { text: "never reached" }]);

    const record = await runNotebook(path, { agent: agent.create });

    // A status of its own rather than an error, because what to do next differs:
    // a timed-out cell may want a longer timeout, and an errored one a fix.
    expect(record.cells).toEqual([
      expect.objectContaining({
        id: "slow",
        status: "timeout",
        error: expect.stringContaining("50ms"),
      }),
    ]);
    // Told to stop, rather than left running with the run gone on without it.
    expect(agent.aborted).toEqual(["Think about it."]);
    expect(agent.prompts).toEqual(["Think about it."]);
  });

  it("kills a bash cell that outruns its timeout, keeping what it had written", async () => {
    // Two commands, so bash forks a child for the sleep rather than becoming
    // it: killing bash alone would leave the sleep holding the cell's output
    // open, and the run waiting the full five seconds for it to let go.
    const path = await notebookFile(
      "```bash id=slow timeout=100ms\necho started\nsleep 5\necho finished\n```\n",
    );
    const began = Date.now();

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");

    expect(cell.status).toBe("timeout");
    expect(cell.error).toBe("Timed out after 100ms");
    expect(cell.stdout).toBe("started\n");
    expect(cell.exitCode).toBeNull();
    expect(Date.now() - began).toBeLessThan(3000);
  });

  it("leaves a cell that finishes within its timeout alone", async () => {
    const path = await notebookFile("```bash id=quick timeout=5s\necho quick\n```\n");

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");

    expect(cell).toMatchObject({ status: "ok", stdout: "quick\n" });
    expect(cell.error).toBeUndefined();
  });

  it("bounds every cell by the notebook's own timeout when the cell declares none", async () => {
    const path = await notebookFile(`---\ntimeout: 50ms\n---\n\n${oneCell}`);
    const agent = createScriptedAgent([{ hangs: true }]);

    const cell = onlyCell(await runNotebook(path, { agent: agent.create }), "prompt");

    expect(cell.status).toBe("timeout");
    expect(cell.error).toBe("Timed out after 50ms");
  });

  it("lets a cell's own timeout override the notebook's", async () => {
    // The notebook allows almost nothing; the cell allows plenty and takes a
    // little, so it is the cell's word that has to be the one that counts.
    const path = await notebookFile(
      "---\ntimeout: 10ms\n---\n\n```bash id=own timeout=5s\nsleep 0.1\necho done\n```\n",
    );

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");

    expect(cell).toMatchObject({ status: "ok", stdout: "done\n" });
  });

  it("runs a cell as long as it takes when nothing declares a timeout", async () => {
    const path = await notebookFile(oneBashCell("sleep 0.2\necho patient"));

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");

    expect(cell).toMatchObject({ status: "ok", stdout: "patient\n" });
  });

  it("halts the run at a timed-out cell and leaves its dependents stale", async () => {
    const path = await notebookOf(
      "```prompt id=a timeout=50ms\nDo a.\n```\n",
      promptCell("b", "a"),
      promptCell("c", "b"),
    );
    const agent = createScriptedAgent([{ hangs: true }, { text: "never reached" }]);

    const record = await runNotebook(path, { agent: agent.create });

    // A cell that timed out may have half-applied a change just as a failed
    // one may have, so nothing downstream is built on it.
    expect(record.cells.map((cell) => [cell.id, cell.status])).toEqual([["a", "timeout"]]);
    expect(record.stale).toEqual(["b", "c"]);
    expect(agent.prompts).toEqual(["Do a."]);
  });

  it("records no anchor and no session for a turn that timed out", async () => {
    const path = await notebookFile("```prompt id=slow timeout=50ms\nThink.\n```\n");
    const agent = createScriptedAgent([{ hangs: true }]);

    const record = await runNotebook(path, { agent: agent.create });

    expect(anchorsOf(record)).toEqual([undefined]);
    expect(record.agentSession).toBeUndefined();
  });

  it("times an isolated cell out like any other, and disposes its context", async () => {
    const path = await notebookFile("```prompt id=apart isolated timeout=50ms\nThink.\n```\n");
    const agent = createScriptedAgent([{ hangs: true }]);

    const record = await runNotebook(path, { agent: agent.create });

    expect(onlyCell(record, "prompt").status).toBe("timeout");
    expect(agent.aborted).toEqual(["Think."]);
    expect(agent.disposed).toBe(true);
  });

  it("times an isolated cell from when its turn starts, not from when its context is made", async () => {
    // Making the context takes longer than the whole allowance. Charged to the
    // cell, the turn would be out of time before it was asked.
    const path = await notebookFile("```prompt id=apart isolated timeout=100ms\nThink.\n```\n");
    const ready = createScriptedAgent([{ text: "thought" }]);
    let made = 0;
    const slowToMake: AgentFactory = async (setup) => {
      if ((made += 1) > 1) await new Promise((resume) => setTimeout(resume, 200));
      return ready.create(setup);
    };

    const cell = onlyCell(await runNotebook(path, { agent: slowToMake }), "prompt");

    expect(cell).toMatchObject({ status: "ok", text: "thought" });
  });

  it("keeps the exit of a command that finished just as its time ran out", async () => {
    // The command exits at about the moment the timer fires. Whichever wins, a
    // command that exited on its own has its exit, and only one the run had
    // to stop is recorded as timed out.
    const path = await notebookFile("```bash id=close timeout=100ms\nsleep 0.1\nexit 0\n```\n");

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");

    if (cell.status === "timeout") expect(cell.exitCode).toBeNull();
    else expect(cell).toMatchObject({ status: "ok", exitCode: 0 });
  });

  it("times a cell from when it starts, not from when the run did", async () => {
    // The first cell takes longer than the second's whole allowance. Measured
    // from the start of the run the second would be out of time before it
    // began; measured from its own start it has all the time it needs.
    const path = await notebookOf(
      "```bash id=first\nsleep 0.2\n```\n",
      "```bash id=second timeout=150ms\necho in time\n```\n",
    );

    const record = await runNotebook(path, { agent: unusedAgent().create });

    expect(record.cells.map((cell) => cell.status)).toEqual(["ok", "ok"]);
  });
});

describe("what the run record says of each cell", () => {
  it("records when each cell started and ended, within the run's own span", async () => {
    const path = await notebookOf(
      "```bash id=first\nsleep 0.05\n```\n",
      "```bash id=second\nsleep 0.05\n```\n",
    );

    const record = await runNotebook(path, { agent: unusedAgent().create });
    const [first, second] = record.cells;
    if (first === undefined || second === undefined) throw new Error("expected two cells");

    // Each cell's own span, in order: the first ended before the second began,
    // since neither is isolated, and both fit inside the run's.
    expect(first.startedAt <= first.endedAt).toBe(true);
    expect(first.endedAt <= second.startedAt).toBe(true);
    expect(second.startedAt <= second.endedAt).toBe(true);
    expect(record.startedAt <= first.startedAt && second.endedAt <= record.endedAt).toBe(true);
    // Not the same instant, each cell having slept.
    expect(Date.parse(first.endedAt) - Date.parse(first.startedAt)).toBeGreaterThanOrEqual(40);
  });

  it("shows two isolated cells overlapping, which is what running at once looks like", async () => {
    const path = await notebookOf(
      "```bash id=a isolated\nsleep 0.1\n```\n",
      "```bash id=b isolated\nsleep 0.1\n```\n",
    );

    const record = await runNotebook(path, { agent: unusedAgent().create });
    const [a, b] = record.cells;
    if (a === undefined || b === undefined) throw new Error("expected two cells");

    // Each began before the other ended. ADR-0016 left the overlap invisible
    // until the record had per-cell timings; now it is what a reader sees.
    expect(a.startedAt < b.endedAt && b.startedAt < a.endedAt).toBe(true);
  });

  it("records what a prompt cell's turn cost, beside the tokens it spent", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([
      { text: "Hello", usage: { inputTokens: 1200, outputTokens: 300, cost: 0.0081 } },
    ]);

    const cell = onlyCell(await runNotebook(path, { agent: agent.create }), "prompt");

    // The agent's figure rather than one worked out here: the provider's prices
    // are pi's to know, and pi already reports what each message cost.
    expect(cell.usage).toEqual({ inputTokens: 1200, outputTokens: 300, cost: 0.0081 });
  });

  it("records a bash cell at no cost, having run no model", async () => {
    const path = await notebookFile(oneBashCell("echo cheap"));

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");

    expect(cell.usage).toEqual({ inputTokens: 0, outputTokens: 0, cost: 0 });
  });

  it("records what a turn had spent when it failed, since that was spent all the same", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([
      { error: "provider exploded", usage: { inputTokens: 900, outputTokens: 40, cost: 0.003 } },
    ]);

    const cell = onlyCell(await runNotebook(path, { agent: agent.create }), "prompt");

    // ADR-0017 left a stopped turn's tokens for this accounting: a cell that
    // failed after a long think cost what it cost, and its record says so.
    expect(cell.status).toBe("error");
    expect(cell.usage).toEqual({ inputTokens: 900, outputTokens: 40, cost: 0.003 });
  });

  it("records what a turn had spent when the run stopped it", async () => {
    const path = await notebookFile("```prompt id=slow timeout=50ms\nThink.\n```\n");
    const agent = createScriptedAgent([
      { hangs: true, usage: { inputTokens: 500, outputTokens: 0, cost: 0.001 } },
    ]);

    const cell = onlyCell(await runNotebook(path, { agent: agent.create }), "prompt");

    expect(cell.status).toBe("timeout");
    expect(cell.usage).toEqual({ inputTokens: 500, outputTokens: 0, cost: 0.001 });
  });

  it("times a failed cell too, since what it spent is still spent", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([{ error: "provider exploded" }]);

    const cell = onlyCell(await runNotebook(path, { agent: agent.create }), "prompt");

    expect(cell.status).toBe("error");
    expect(cell.startedAt <= cell.endedAt).toBe(true);
  });
});

/** One prompt cell naming a model, under frontmatter naming one or not. */
const modelled = (frontmatter: string, attributes = "") =>
  `${frontmatter}\`\`\`prompt id=step${attributes}\nDo the step.\n\`\`\`\n`;

describe("a cell's model", () => {
  it("asks the agent for the model the cell names, and records it", async () => {
    const path = await notebookFile(modelled("", " model=anthropic/claude-haiku-4-5"));
    const agent = createScriptedAgent([{ text: "done" }]);

    const cell = onlyCell(await runNotebook(path, { agent: agent.create }), "prompt");

    expect(agent.turns[0]?.model).toBe("anthropic/claude-haiku-4-5");
    expect(cell.model).toBe("anthropic/claude-haiku-4-5");
  });

  it("records the model that actually served the turn, not the one asked for", async () => {
    const path = await notebookFile(modelled("", " model=anthropic/claude-haiku-4-5"));
    // Providers rotate versions under a stable name, which is the whole reason
    // the record carries the model at all.
    const agent = createScriptedAgent([
      { text: "done", model: "anthropic/claude-haiku-4-5-20251001" },
    ]);

    const cell = onlyCell(await runNotebook(path, { agent: agent.create }), "prompt");

    expect(cell.model).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("falls back to the notebook's model for a cell that names none", async () => {
    const path = await notebookFile(modelled("---\nmodel: openai/gpt-5\n---\n\n"));
    const agent = createScriptedAgent([{ text: "done" }]);

    await runNotebook(path, { agent: agent.create });

    expect(agent.turns[0]?.model).toBe("openai/gpt-5");
  });

  it("lets a cell's model override the notebook's, for that cell alone", async () => {
    const path = await notebookFile(
      `---\nmodel: openai/gpt-5\n---\n\n${promptCell("first")}\n${promptFence("cheap", " model=openai/gpt-5-mini")}\n${promptCell("last")}`,
    );
    const agent = readyAgent();

    await runNotebook(path, { agent: agent.create });

    // The cell after the override goes back to the notebook's model: an
    // override is the cell's, not a switch left thrown for the rest of the run.
    expect(agent.turns.map((turn) => turn.model)).toEqual([
      "openai/gpt-5",
      "openai/gpt-5-mini",
      "openai/gpt-5",
    ]);
  });

  it("asks for no model in particular when neither the cell nor the notebook names one", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([{ text: "Hello" }]);

    const cell = onlyCell(await runNotebook(path, { agent: agent.create }), "prompt");

    // Pi's own default, whatever the machine is set up with, as every notebook
    // before models could be named.
    expect(agent.turns[0]?.model).toBeUndefined();
    expect(cell.model).toBe("scripted");
  });
});

/** A directory of the user's own modes, holding each file given by name. */
async function modesDirectory(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "octo-modes-"));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, name), contents, "utf8");
  }
  return dir;
}

/** The tools pi has of its own, which is every tool there is without an extension. */
const PI_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

describe("modes", () => {
  it("runs a notebook in Code mode as pi is: pi's own prompt, tools, skills and model", async () => {
    const path = await notebookFile(declaring("mode: code\n"));
    const agent = createScriptedAgent([{ text: "done" }], { tools: PI_TOOLS });

    await runNotebook(path, { agent: agent.create, userModesDirectory: await modesDirectory() });

    // No tools named, since naming any is an allowlist to pi: it would shut out
    // the tools of the machine's extensions and its own configured defaults.
    expect(agent.setup?.systemPrompt).toBeUndefined();
    expect(agent.setup?.tools).toBeUndefined();
    expect(agent.setup?.skills).toBeUndefined();
    expect(agent.turns[0]?.model).toBeUndefined();
  });

  it("runs a notebook in Work mode on a prompt and model of its own, with no connectors", async () => {
    const path = await notebookFile(declaring("mode: work\nskills:\n  - review\n"));
    const agent = createScriptedAgent([{ text: "done" }], { tools: PI_TOOLS, skills: ["review"] });

    await runNotebook(path, { agent: agent.create, userModesDirectory: await modesDirectory() });

    expect(agent.setup?.systemPrompt).toMatch(/office and knowledge work/);
    expect(agent.turns[0]?.model).toBe("anthropic/claude-sonnet-4-5");
    expect(agent.setup?.skills).toEqual(["review"]);
    // A connector would be a tool beyond pi's own, which is what Work mode has none of.
    expect(agent.setup?.tools?.every((tool) => PI_TOOLS.includes(tool))).toBe(true);
  });

  it("records the mode the notebook ran in with the rest of its environment", async () => {
    const path = await notebookFile(declaring("mode: work\n"));
    const agent = createScriptedAgent([{ text: "done" }], { tools: PI_TOOLS });

    const record = await runNotebook(path, {
      agent: agent.create,
      userModesDirectory: await modesDirectory(),
    });

    expect(record.environment.mode).toBe("work");
  });

  it("runs a notebook in a mode the user defined, on that mode's default model", async () => {
    const modes = await modesDirectory({ "design.md": "---\nmodel: openai/gpt-5\n---\n" });
    const path = await notebookFile(declaring("mode: design\n"));
    const agent = createScriptedAgent([{ text: "done" }]);

    await runNotebook(path, { agent: agent.create, userModesDirectory: modes });

    expect(agent.turns[0]?.model).toBe("openai/gpt-5");
  });

  it("sets the agent up with the mode's system prompt, which is the body of its file", async () => {
    const modes = await modesDirectory({
      "design.md": "---\nmodel: openai/gpt-5\n---\n\nYou are a careful visual designer.\n",
    });
    const path = await notebookFile(declaring("mode: design\n"));
    const agent = createScriptedAgent([{ text: "done" }]);

    await runNotebook(path, { agent: agent.create, userModesDirectory: modes });

    expect(agent.setup?.systemPrompt).toBe("You are a careful visual designer.");
  });

  it("gives the agent only the tools the mode allows", async () => {
    const modes = await modesDirectory({ "design.md": "---\ntools:\n  - read\n  - write\n---\n" });
    const path = await notebookFile(declaring("mode: design\n"));
    const agent = createScriptedAgent([{ text: "done" }], { tools: ["read", "write"] });

    await runNotebook(path, { agent: agent.create, userModesDirectory: modes });

    expect(agent.setup?.tools).toEqual(["read", "write"]);
  });

  it("stops before any cell runs when a tool the mode allows is not on offer, naming the mode", async () => {
    const modes = await modesDirectory({ "design.md": "---\ntools:\n  - read\n  - reed\n---\n" });
    const path = await notebookFile(declaring("mode: design\n"));
    const agent = createScriptedAgent([{ text: "never reached" }], { tools: ["read"] });

    await expect(
      runNotebook(path, { agent: agent.create, userModesDirectory: modes }),
    ).rejects.toThrow('The mode "design" declares the tool "reed", which is not available here.');
    expect(agent.prompts).toEqual([]);
  });

  it("lets the notebook's own model and tools stand in place of the mode's", async () => {
    const modes = await modesDirectory({
      "design.md": "---\nmodel: openai/gpt-5\ntools:\n  - read\n  - write\n---\n",
    });
    const path = await notebookFile(
      declaring("mode: design\nmodel: anthropic/claude-haiku-4-5\ntools:\n  - bash\n"),
    );
    const agent = createScriptedAgent([{ text: "done" }], { tools: ["bash"] });

    await runNotebook(path, { agent: agent.create, userModesDirectory: modes });

    expect(agent.turns[0]?.model).toBe("anthropic/claude-haiku-4-5");
    expect(agent.setup?.tools).toEqual(["bash"]);
  });

  it("gives the agent only the mode's skills, and the skills the notebook declares besides", async () => {
    const modes = await modesDirectory({ "design.md": "---\nskills:\n  - brand\n---\n" });
    const path = await notebookFile(declaring("mode: design\nskills:\n  - review\n"));
    const agent = createScriptedAgent([{ text: "done" }], { skills: ["brand", "review", "tdd"] });

    await runNotebook(path, { agent: agent.create, userModesDirectory: modes });

    expect(agent.setup?.skills).toEqual(["brand", "review"]);
  });

  it("leaves the skills alone when the mode names none", async () => {
    const modes = await modesDirectory({ "design.md": "---\nmodel: openai/gpt-5\n---\n" });
    const path = await notebookFile(declaring("mode: design\n"));
    const agent = createScriptedAgent([{ text: "done" }]);

    await runNotebook(path, { agent: agent.create, userModesDirectory: modes });

    expect(agent.setup?.skills).toBeUndefined();
  });

  it("stops before any cell runs when a skill the mode names is missing, naming the mode", async () => {
    const modes = await modesDirectory({ "design.md": "---\nskills:\n  - brand\n---\n" });
    const path = await notebookFile(declaring("mode: design\n"));
    const agent = createScriptedAgent([{ text: "never reached" }]);

    await expect(
      runNotebook(path, { agent: agent.create, userModesDirectory: modes }),
    ).rejects.toThrow('The mode "design" declares the skill "brand", which is not available here.');
    expect(agent.prompts).toEqual([]);
  });

  it("refuses a mode this machine does not have, naming the modes it does", async () => {
    const modes = await modesDirectory({ "design.md": "" });
    const path = await notebookFile(declaring("mode: review\n"));
    const agent = createScriptedAgent([{ text: "never reached" }]);

    const refusal = await runNotebook(path, {
      agent: agent.create,
      userModesDirectory: modes,
    }).catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(RunRefusal);
    expect((refusal as RunRefusal).kind).toBe("environment");
    expect((refusal as RunRefusal).problems).toEqual([
      `This notebook declares the mode "review", which is not available here. The modes here are code, design and work; your own are ${join(modes, "<name>.md")}.`,
    ]);
    expect(agent.setup, "no agent is set up for a mode that is not there").toBeUndefined();
  });

  it("refuses a mode of the user's own that takes the name of one octo ships", async () => {
    const modes = await modesDirectory({ "code.md": "You are something else entirely.\n" });
    const path = await notebookFile(declaring("mode: code\n"));
    const agent = createScriptedAgent([{ text: "never reached" }]);

    await expect(
      runNotebook(path, { agent: agent.create, userModesDirectory: modes }),
    ).rejects.toThrow(
      `${join(modes, "code.md")} has the name of a mode octo ships, so "code" would not mean the same on every machine. Rename it.`,
    );
    expect(agent.setup).toBeUndefined();
  });

  it("refuses a mode whose file is malformed, naming every problem against its line", async () => {
    const modes = await modesDirectory({
      "design.md": "---\nmodel:\n  - openai/gpt-5\ntool:\n  - read\nskills:\n  - 3\n---\nDesign.\n",
    });
    const path = await notebookFile(declaring("mode: design\n"));
    const agent = createScriptedAgent([{ text: "never reached" }]);
    const file = join(modes, "design.md");

    const refusal = await runNotebook(path, {
      agent: agent.create,
      userModesDirectory: modes,
    }).catch((cause: unknown) => cause);

    expect((refusal as RunRefusal).kind).toBe("environment");
    expect((refusal as RunRefusal).problems).toEqual([
      `${file}, line 2: Mode field "model" must be a string`,
      `${file}, line 4: Unknown mode field "tool". Expected one of model, tools, skills`,
      `${file}, line 7: Every entry in "skills" must be a string`,
    ]);
    expect(agent.setup).toBeUndefined();
  });

  it("refuses a mode file whose frontmatter is never closed", async () => {
    const modes = await modesDirectory({ "design.md": "---\nmodel: openai/gpt-5\n\nDesign.\n" });
    const path = await notebookFile(declaring("mode: design\n"));
    const agent = createScriptedAgent([{ text: "never reached" }]);

    await expect(
      runNotebook(path, { agent: agent.create, userModesDirectory: modes }),
    ).rejects.toThrow(`${join(modes, "design.md")}, line 1: Frontmatter is never closed`);
  });
});

/** Where a run keeps the artifacts of one of its cells. */
const artifactsDirectory = (path: string, record: RunRecord, cellId: string) =>
  join(runDirectory(path, record.id), "artifacts", cellId);

describe("artifacts", () => {
  it("gives a bash cell a directory of its own to write to, and records what it left there", async () => {
    const path = await notebookFile(oneBashCell("echo hello > {{artifacts}}/greeting.txt"));

    const record = await runNotebook(path, { agent: unusedAgent().create });
    const cell = onlyCell(record, "bash");

    // By path, relative to the run's own directory, so the record and the files
    // it names travel together; and beside the record rather than in the
    // notebook, which holds no results (ADR-0005).
    expect(cell.status).toBe("ok");
    expect(cell.artifacts).toEqual(["artifacts/step/greeting.txt"]);
    expect(
      await readFile(join(runDirectory(path, record.id), "artifacts/step/greeting.txt"), "utf8"),
    ).toBe("hello\n");
  });

  it("hands a cell an absolute path, whatever path the notebook was named by", async () => {
    // Deeper than the directory the tests run from, so that a path relative to
    // that directory, taken from the workspace instead, cannot happen to land.
    const deep = join(dirname(await notebookFile("")), "a/b/c/d/e/f");
    await mkdir(deep, { recursive: true });
    const absolute = join(deep, "notebook.md");
    await writeFile(absolute, oneBashCell("echo hello > {{artifacts}}/greeting.txt"), "utf8");
    const path = relative(process.cwd(), absolute);

    const record = await runNotebook(path, { agent: unusedAgent().create });
    const cell = onlyCell(record, "bash");

    // A bash cell runs in the workspace, not where the run was launched from, so
    // a path relative to the launch directory would point it somewhere else.
    expect(path.startsWith("/")).toBe(false);
    expect(cell.status).toBe("ok");
    expect(cell.artifacts).toEqual(["artifacts/step/greeting.txt"]);
    expect(
      await readFile(
        join(runDirectory(absolute, record.id), "artifacts/step/greeting.txt"),
        "utf8",
      ),
    ).toBe("hello\n");
  });

  it("tells the agent where a prompt cell's artifacts go, with the directory already there", async () => {
    const path = await notebookFile(
      "```prompt id=chart\nPlot it and save the chart to {{artifacts}}/chart.png.\n```\n",
    );
    const agent = createScriptedAgent([{ text: "saved" }]);

    const record = await runNotebook(path, { agent: agent.create });
    const directory = artifactsDirectory(path, record, "chart");

    // Made before the turn, so the agent can write straight into it rather than
    // having to be told to make it first.
    expect(agent.prompts).toEqual([`Plot it and save the chart to ${directory}/chart.png.`]);
    expect((await stat(directory)).isDirectory()).toBe(true);
  });

  it("lists everything a cell left, however deep, in a fixed order", async () => {
    const path = await notebookFile(
      oneBashCell(
        "mkdir -p {{artifacts}}/figures\ntouch {{artifacts}}/figures/b.png {{artifacts}}/figures/a.png {{artifacts}}/notes.md",
      ),
    );

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");

    expect(cell.artifacts).toEqual([
      "artifacts/step/figures/a.png",
      "artifacts/step/figures/b.png",
      "artifacts/step/notes.md",
    ]);
  });

  it("records no artifacts for a cell that never referred to its directory, and makes none", async () => {
    const path = await notebookFile(oneBashCell("echo plain"));

    const record = await runNotebook(path, { agent: unusedAgent().create });

    expect(onlyCell(record, "bash").artifacts).toEqual([]);
    await expect(stat(artifactsDirectory(path, record, "step"))).rejects.toThrow();
  });

  it("keeps each cell's artifacts apart from the others', under the cell's own id", async () => {
    const path = await notebookOf(
      "```bash id=one\necho 1 > {{artifacts}}/out.txt\n```\n",
      "```bash id=two\necho 2 > {{artifacts}}/out.txt\n```\n",
    );

    const record = await runNotebook(path, { agent: unusedAgent().create });

    expect(record.cells.map((cell) => cell.artifacts)).toEqual([
      ["artifacts/one/out.txt"],
      ["artifacts/two/out.txt"],
    ]);
  });

  it("keeps the artifacts of two runs apart, as it keeps their records", async () => {
    const path = await notebookFile(oneBashCell("echo $RANDOM$RANDOM > {{artifacts}}/out.txt"));

    const first = await runNotebook(path, { agent: unusedAgent().create });
    const second = await runNotebook(path, { agent: unusedAgent().create });

    const written = (record: RunRecord) =>
      readFile(join(artifactsDirectory(path, record, "step"), "out.txt"), "utf8");
    expect(await written(first)).not.toBe(await written(second));
  });

  it("keeps what a cell left before it failed, as the account of how far it got", async () => {
    const path = await notebookFile(oneBashCell("echo partial > {{artifacts}}/out.txt\nexit 1"));

    const cell = onlyCell(await runNotebook(path, { agent: unusedAgent().create }), "bash");

    expect(cell.status).toBe("error");
    expect(cell.artifacts).toEqual(["artifacts/step/out.txt"]);
  });

  it("runs the example notebook the artifacts and the model override are documented against", async () => {
    const example = fileURLToPath(new URL("../../examples/report.md", import.meta.url));
    const path = await notebookFile(await readFile(example, "utf8"));
    const agent = createScriptedAgent([{ text: "Wrote the summary." }, { text: "A headline" }]);

    const record = await runNotebook(path, { agent: agent.create, inputs: { target: "." } });

    expect(record.cells.map((cell) => [cell.id, cell.status])).toEqual([
      ["count", "ok"],
      ["summary", "ok"],
      ["headline", "ok"],
    ]);
    expect(record.cells[0]?.artifacts).toEqual(["artifacts/count/count.txt"]);
    // The summary runs on the notebook's model, which here is pi's own default;
    // only the headline names one.
    expect(agent.turns.map((turn) => turn.model)).toEqual([
      undefined,
      "anthropic/claude-haiku-4-5",
    ]);
    expect(agent.prompts[0]).toContain(artifactsDirectory(path, record, "summary"));
  });

  it("writes nothing into the notebook, whatever the cells produced", async () => {
    const source = oneBashCell("echo hello > {{artifacts}}/greeting.txt\necho to stdout");
    const path = await notebookFile(source);

    await runNotebook(path, { agent: unusedAgent().create });

    expect(await readFile(path, "utf8")).toBe(source);
  });
});

describe("watching a run", () => {
  it("reports the run starting, a cell starting, what it says, and what it recorded, in that order", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([{ text: "Hello, world" }]);
    const events: RunEvent[] = [];

    const record = await runNotebook(path, { agent: agent.create, observe: (e) => events.push(e) });

    expect(events).toEqual([
      {
        type: "run-started",
        run: record.id,
        cells: ["greet"],
        environment: record.environment,
        agentSession: agent.agentSession,
      },
      { type: "cell-started", cell: "greet" },
      { type: "cell-text", cell: "greet", text: "Hello, world" },
      { type: "cell-ended", record: record.cells[0] },
    ]);
  });

  it("names the run before its first cell, with the cells it will run in their order", async () => {
    const path = await notebookOf(promptCell("report", "collect"), promptCell("collect"));
    const events: RunEvent[] = [];

    const record = await runNotebook(path, {
      agent: readyAgent().create,
      observe: (e) => events.push(e),
    });

    // The id the record will carry, announced first: a watcher can then place
    // whatever the cells leave — their artifacts are under the run's directory —
    // before the record that names them arrives.
    expect(events[0]).toMatchObject({
      type: "run-started",
      run: record.id,
      cells: ["collect", "report"],
    });
  });

  it("names the environment it found and the agent session it speaks into as it starts", async () => {
    const path = await notebookFile(oneCell);
    const agent = createScriptedAgent([{ text: "Hello, world" }], { tools: ["read"] });
    const events: RunEvent[] = [];

    const record = await runNotebook(path, { agent: agent.create, observe: (e) => events.push(e) });

    // What the record will say at the end, said at the start: a watcher that
    // outlives the run when the process does not can then write the record
    // the run never got to.
    expect(events[0]).toMatchObject({
      type: "run-started",
      environment: record.environment,
      agentSession: agent.agentSession,
    });
    expect(record.environment.tools).toEqual(["read"]);
  });

  it("reports what a cell has said so far, before the cell is over", async () => {
    const path = await notebookFile("```prompt id=slow timeout=50ms\nThink.\n```\n");
    // Says this much, then goes quiet until the run gives up on it.
    const agent = createScriptedAgent([{ hangs: true, text: "Working on it…" }]);
    const events: RunEvent[] = [];

    const record = await runNotebook(path, { agent: agent.create, observe: (e) => events.push(e) });

    expect(events.map((event) => event.type)).toEqual([
      "run-started",
      "cell-started",
      "cell-text",
      "cell-ended",
    ]);
    expect(events[2]).toEqual({ type: "cell-text", cell: "slow", text: "Working on it…" });
    expect(onlyCell(record, "prompt").status).toBe("timeout");
  });

  it("reports each tool the agent invokes, as it invokes it, before the cell is over", async () => {
    const path = await notebookFile(oneCell);
    const calls = [
      { name: "read", input: { path: "README.md" } },
      { name: "bash", input: { command: "ls" } },
    ];
    const agent = createScriptedAgent([{ text: "Looked around", toolCalls: calls }]);
    const events: RunEvent[] = [];

    const record = await runNotebook(path, { agent: agent.create, observe: (e) => events.push(e) });

    // What the agent actually did rather than only what it says it did, and in
    // the order it did it. The same calls end up on the record, so a watcher
    // that kept every event holds what the record holds.
    expect(events.slice(1, 4)).toEqual([
      { type: "cell-started", cell: "greet" },
      { type: "cell-tool-call", cell: "greet", call: calls[0] },
      { type: "cell-tool-call", cell: "greet", call: calls[1] },
    ]);
    expect(events.at(-1)?.type).toBe("cell-ended");
    expect(onlyCell(record, "prompt").toolCalls).toEqual(calls);
  });

  it("reports a tool call while the cell is still running", async () => {
    const path = await notebookFile("```prompt id=slow timeout=50ms\nThink.\n```\n");
    const call = { name: "bash", input: { command: "sleep 100" } };
    // Invokes the tool, then goes quiet until the run gives up on it.
    const agent = createScriptedAgent([{ hangs: true, toolCalls: [call] }]);
    const events: RunEvent[] = [];

    const record = await runNotebook(path, { agent: agent.create, observe: (e) => events.push(e) });

    expect(events[2]).toEqual({ type: "cell-tool-call", cell: "slow", call });
    expect(onlyCell(record, "prompt").status).toBe("timeout");
  });

  it("reports a bash cell's output with its record, since a command is not spoken", async () => {
    const path = await notebookFile(oneBashCell("echo hello"));
    const events: RunEvent[] = [];

    const record = await runNotebook(path, {
      agent: unusedAgent().create,
      observe: (e) => events.push(e),
    });

    expect(events).toEqual([
      expect.objectContaining({ type: "run-started", run: record.id, cells: ["step"] }),
      { type: "cell-started", cell: "step" },
      { type: "cell-ended", record: expect.objectContaining({ id: "step", stdout: "hello\n" }) },
    ]);
    expect(record.cells).toHaveLength(1);
  });
});

describe("interrupting a run", () => {
  /** Interrupts the run at the first event of the given kind. */
  const interruptingAt = (type: RunEvent["type"]) => {
    const controller = new AbortController();
    const observe = (event: RunEvent) => {
      if (event.type === type) controller.abort();
    };
    return { signal: controller.signal, observe };
  };

  it("stops the cell in flight, and records it as interrupted rather than failed", async () => {
    const path = await notebookFile(twoCells);
    const agent = createScriptedAgent([{ hangs: true }, { text: "never reached" }]);

    const record = await runNotebook(path, {
      agent: agent.create,
      ...interruptingAt("cell-started"),
    });

    // A status of its own, as a timeout is (ADR-0017): nothing went wrong that
    // wants putting right, somebody stopped it.
    expect(record.cells).toEqual([
      expect.objectContaining({ id: "first", status: "interrupted", error: "Interrupted" }),
    ]);
    expect(agent.aborted).toEqual(["Do the first thing."]);
    expect(agent.prompts).toEqual(["Do the first thing."]);
  });

  it("starts nothing further once interrupted, leaving the rest unrun", async () => {
    const path = await notebookFile(twoCells);
    const agent = createScriptedAgent([{ text: "first done" }, { text: "never reached" }]);

    const record = await runNotebook(path, {
      agent: agent.create,
      ...interruptingAt("cell-ended"),
    });

    // The first cell finished on its own, so its result stands; the second
    // never began, so it is absent rather than recorded as anything.
    expect(record.cells.map((cell) => [cell.id, cell.status])).toEqual([["first", "ok"]]);
    expect(agent.prompts).toEqual(["Do the first thing."]);
  });

  it("leaves an interrupted cell's dependents stale, as a failed cell does", async () => {
    const path = await chainOfThree();
    const agent = createScriptedAgent([{ hangs: true }]);

    const record = await runNotebook(path, {
      agent: agent.create,
      ...interruptingAt("cell-started"),
    });

    expect(record.cells.map((cell) => [cell.id, cell.status])).toEqual([["a", "interrupted"]]);
    expect(record.stale).toEqual(["b", "c"]);
  });

  it("tells an interruption from a timeout on a cell that has one", async () => {
    const path = await notebookFile("```prompt id=slow timeout=5s\nThink.\n```\n");
    const agent = createScriptedAgent([{ hangs: true }]);

    const cell = onlyCell(
      await runNotebook(path, { agent: agent.create, ...interruptingAt("cell-started") }),
      "prompt",
    );

    expect(cell.status).toBe("interrupted");
  });

  it("kills a bash cell where it is, keeping what it had written", async () => {
    const path = await notebookFile(oneBashCell("echo started\nsleep 5\necho finished"));
    const controller = new AbortController();
    const began = Date.now();

    const record = await runNotebook(path, {
      agent: unusedAgent().create,
      signal: controller.signal,
      // A moment after the command starts, so it has written its first line.
      observe: (event) => {
        if (event.type === "cell-started") setTimeout(() => controller.abort(), 200);
      },
    });
    const cell = onlyCell(record, "bash");

    expect(cell.status).toBe("interrupted");
    expect(cell.stdout).toBe("started\n");
    expect(cell.exitCode).toBeNull();
    expect(Date.now() - began).toBeLessThan(3000);
  });

  it("never starts a command the interruption beat to the start", async () => {
    const path = await notebookFile(oneBashCell("echo started\nsleep 5"));
    const began = Date.now();

    const record = await runNotebook(path, {
      agent: unusedAgent().create,
      ...interruptingAt("cell-started"),
    });
    const cell = onlyCell(record, "bash");

    expect(cell).toMatchObject({ status: "interrupted", stdout: "", exitCode: null });
    expect(Date.now() - began).toBeLessThan(3000);
  });

  it("runs as it always did when the signal never fires", async () => {
    const path = await notebookFile(twoCells);
    const agent = createScriptedAgent([{ text: "one" }, { text: "two" }]);

    const record = await runNotebook(path, {
      agent: agent.create,
      signal: new AbortController().signal,
    });

    expect(record.cells.map((cell) => cell.status)).toEqual(["ok", "ok"]);
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
