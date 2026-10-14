import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createScriptedAgent } from "../agent/scripted.js";
import {
  type Notebook,
  bodyOf,
  cellsOf,
  interpolate,
  parseNotebook,
  serialiseNotebook,
  workspaceOf,
} from "../notebook/notebook.js";
import { runNotebook } from "../run/runner.js";
import { recordPath, runDirectory } from "../run/store.js";
import { type Imported, importSession } from "./pi-session.js";

// Derived from pi's own signature rather than imported: the message types live
// in @earendil-works/pi-ai, which is pi's dependency and not ours to pin.
type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "octo-import-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const user = (content: string): AppendableMessage => ({
  role: "user",
  content,
  timestamp: Date.now(),
});

const usage = (input: number, output: number, total: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

type AssistantMessage = Extract<AppendableMessage, { role: "assistant" }>;

/** An assistant's reply, ended as pi ends one: on its own unless the test says otherwise. */
const assistant = (
  text: string,
  ended: Pick<AssistantMessage, "stopReason" | "errorMessage"> = { stopReason: "stop" },
): AppendableMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  usage: usage(10, 5, 0.25),
  ...ended,
});

/** An assistant message that stops to call a tool, as pi records the first half of a tool-using turn. */
const callsTool = (name: string, args: Record<string, unknown>): AppendableMessage => ({
  role: "assistant",
  content: [
    { type: "text", text: "Let me look." },
    { type: "toolCall", id: "call-1", name, arguments: args },
  ],
  timestamp: Date.now(),
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  usage: usage(20, 10, 0.5),
  stopReason: "toolUse",
});

/** A command the user ran at pi's prompt with `!`, as pi records it. */
const ran = (
  command: string,
  output: string,
  exitCode: number | undefined,
  rest: { cancelled?: boolean } = {},
): AppendableMessage => ({
  role: "bashExecution",
  command,
  output,
  exitCode,
  cancelled: rest.cancelled ?? false,
  truncated: false,
  timestamp: Date.now(),
});

const toolResult = (name: string, text: string): AppendableMessage => ({
  role: "toolResult",
  toolCallId: "call-1",
  toolName: name,
  content: [{ type: "text", text }],
  isError: false,
  timestamp: Date.now(),
});

/**
 * A session file as pi writes one at the terminal: made in a directory of its
 * own beside the Workspace, the way pi keeps them apart from the project. The
 * entries come back too, since the ids and moments pi gave them are what an
 * import is expected to carry over.
 */
function chatIn(
  workspace: string,
  messages: readonly AppendableMessage[],
  options: { readonly name?: string } = {},
) {
  const manager = SessionManager.create(workspace, join(dir, "pi-sessions"));
  if (options.name !== undefined) manager.appendSessionInfo(options.name);
  for (const message of messages) manager.appendMessage(message);
  const file = manager.getSessionFile();
  if (file === undefined) throw new Error("the session was not written");
  return { file, entries: manager.getEntries() };
}

/** When pi says the session began, read off its header line rather than through pi. */
async function begunAt(file: string): Promise<string> {
  const [header = "{}"] = (await readFile(file, "utf8")).split("\n");
  return (JSON.parse(header) as { timestamp: string }).timestamp;
}

/** The Notebook the import wrote, read back off the disk and parsed. */
async function written(notebook: string): Promise<{ source: string; parsed: Notebook }> {
  const source = await readFile(notebook, "utf8");
  const result = parseNotebook(source);
  if (!result.ok)
    throw new Error(`the imported notebook does not parse: ${result.errors[0]?.message}`);
  return { source, parsed: result.notebook };
}

/** An import the test expects to have gone through, with its record. */
function succeeded(imported: Imported): Extract<Imported, { kind: "imported" }> {
  if (imported.kind !== "imported") throw new Error(`expected an import, got ${imported.kind}`);
  return imported;
}

describe("importing a chat", () => {
  it("keeps every thought a turn recorded, apart from what it said", async () => {
    const looked = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "list them" },
        { type: "text", text: "Looking." },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
      ],
      timestamp: Date.now(),
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: usage(20, 10, 0.5),
      stopReason: "toolUse",
    } as AppendableMessage;
    const answered = {
      ...assistant("One file."),
      content: [
        { type: "thinking", thinking: "just the one" },
        { type: "text", text: "One file." },
      ],
    } as AppendableMessage;
    const { file } = chatIn(dir, [
      user("What's there?"),
      looked,
      toolResult("bash", "a.txt"),
      answered,
    ]);
    const notebook = join(dir, "chat.md");

    const { record } = succeeded(await importSession({ session: file, notebook }));

    expect(record.cells[0]).toMatchObject({
      text: "Looking.\n\nOne file.",
      thinking: "list them\n\njust the one",
    });
  });

  it("writes a notebook whose prompt cells are the session's user messages, in order", async () => {
    const { file } = chatIn(dir, [
      user("List the files here."),
      assistant("There are three."),
      user("Now count the lines in each."),
      assistant("Ten, twenty and thirty."),
    ]);
    const notebook = join(dir, "notes", "chat.md");

    const imported = await importSession({ session: file, notebook });

    expect(imported.kind).toBe("imported");
    const { parsed } = await written(notebook);
    expect(cellsOf(parsed)).toEqual([
      { id: "cell-1", type: "prompt", body: "List the files here.\n", uses: [], isolated: false },
      {
        id: "cell-2",
        type: "prompt",
        body: "Now count the lines in each.\n",
        uses: [],
        isolated: false,
      },
    ]);
  });

  it("populates a run record from the chat: what each turn said, did, cost and ran on", async () => {
    const { file, entries } = chatIn(dir, [
      user("List the files here."),
      callsTool("bash", { command: "ls" }),
      toolResult("bash", "a b c"),
      assistant("There are three."),
      user("Thanks."),
      assistant("Any time."),
    ]);
    const notebook = join(dir, "chat.md");
    const [askedFirst, , , repliedFirst, askedSecond, repliedSecond] = entries;

    const { record } = succeeded(await importSession({ session: file, notebook }));

    expect(record).toEqual({
      id: expect.any(String),
      notebook,
      imported: file,
      environment: { workspace: dir, trusted: false, piVersion: "", tools: ["bash"] },
      agentSession: join(runDirectory(notebook, record.id), "session.jsonl"),
      startedAt: askedFirst?.timestamp,
      endedAt: repliedSecond?.timestamp,
      cells: [
        {
          id: "cell-1",
          type: "prompt",
          status: "ok",
          text: "Let me look.\n\nThere are three.",
          toolCalls: [{ name: "bash", input: { command: "ls" } }],
          usage: { inputTokens: 30, outputTokens: 15, cost: 0.75 },
          model: "anthropic/claude-sonnet-4-5",
          retries: [],
          anchor: repliedFirst?.id,
          artifacts: [],
          startedAt: askedFirst?.timestamp,
          endedAt: repliedFirst?.timestamp,
        },
        {
          id: "cell-2",
          type: "prompt",
          status: "ok",
          text: "Any time.",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5, cost: 0.25 },
          model: "anthropic/claude-sonnet-4-5",
          retries: [],
          anchor: repliedSecond?.id,
          artifacts: [],
          startedAt: askedSecond?.timestamp,
          endedAt: repliedSecond?.timestamp,
        },
      ],
      anchors: { "cell-1": repliedFirst?.id, "cell-2": repliedSecond?.id },
      stale: [],
    });
    // Written beside the Notebook as any Run's is, with the copy of the chat beside it.
    expect(JSON.parse(await readFile(recordPath(notebook, record.id), "utf8"))).toEqual(record);
    expect(await readFile(record.agentSession ?? "", "utf8")).toBe(await readFile(file, "utf8"));
  });

  it("records a turn that failed, one that was stopped, and one never answered, each with no anchor", async () => {
    const { file, entries } = chatIn(dir, [
      user("First."),
      assistant("", { stopReason: "error", errorMessage: "overloaded_error" }),
      user("Second."),
      assistant("Half of a rep", { stopReason: "aborted" }),
      user("Third."),
    ]);
    const notebook = join(dir, "chat.md");

    const { record } = succeeded(await importSession({ session: file, notebook }));

    expect(record.cells).toEqual([
      expect.objectContaining({ id: "cell-1", status: "error", error: "overloaded_error" }),
      expect.objectContaining({
        id: "cell-2",
        status: "interrupted",
        error: "Interrupted",
        text: "Half of a rep",
      }),
      expect.objectContaining({
        id: "cell-3",
        status: "error",
        error: "The turn produced no reply",
        startedAt: entries.at(-1)?.timestamp,
        endedAt: entries.at(-1)?.timestamp,
      }),
    ]);
    expect(record.cells.map((cell) => "anchor" in cell)).toEqual([false, false, false]);
    expect(record.anchors).toEqual({});
    // Nothing for a later Run to fork at, so no Agent Session is named, as the runner names none.
    expect(record).not.toHaveProperty("agentSession");
  });

  it("makes a bash cell of a command run at pi's prompt, with its output on the record", async () => {
    const { file, entries } = chatIn(dir, [
      user("What is here?"),
      assistant("Let me see."),
      ran("ls -1", "a\nb\n", 0),
      ran("false", "", 1),
      ran("sleep 100", "", undefined, { cancelled: true }),
      user("Thanks."),
      assistant("Any time."),
    ]);
    const notebook = join(dir, "chat.md");

    const { record } = succeeded(await importSession({ session: file, notebook }));

    const { parsed } = await written(notebook);
    expect(cellsOf(parsed).map((cell) => [cell.id, cell.type, cell.body])).toEqual([
      ["cell-1", "prompt", "What is here?\n"],
      ["cell-2", "bash", "ls -1\n"],
      ["cell-3", "bash", "false\n"],
      ["cell-4", "bash", "sleep 100\n"],
      ["cell-5", "prompt", "Thanks.\n"],
    ]);
    expect(record.cells.slice(1, 4)).toEqual([
      {
        id: "cell-2",
        type: "bash",
        status: "ok",
        stdout: "a\nb\n",
        stderr: "",
        exitCode: 0,
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        artifacts: [],
        startedAt: entries[2]?.timestamp,
        endedAt: entries[2]?.timestamp,
      },
      expect.objectContaining({
        id: "cell-3",
        status: "error",
        exitCode: 1,
        error: "Command exited with status 1",
      }),
      expect.objectContaining({
        id: "cell-4",
        status: "interrupted",
        exitCode: null,
        error: "Interrupted",
      }),
    ]);
    // The prompt cell after the commands still anchors where its own turn ended.
    expect(record.anchors).toEqual({ "cell-1": entries[1]?.id, "cell-5": entries.at(-1)?.id });
  });

  it("keeps a message that reads like an input reference, or holds a fence, as the text it was", async () => {
    const said =
      "Rename {{ target }} to {{artifacts}}, as in:\n```\nmv {{target}} out\n```\nThanks.";
    const { file } = chatIn(dir, [user(said), assistant("Done.")]);
    const notebook = join(dir, "chat.md");

    await importSession({ session: file, notebook });

    const { parsed } = await written(notebook);
    const [cell] = cellsOf(parsed);
    expect(cell?.body).toBe(
      "Rename \\{{ target }} to \\{{artifacts}}, as in:\n```\nmv \\{{target}} out\n```\nThanks.\n",
    );
    // What reaches the agent when the Cell runs is what was typed at the terminal.
    expect(interpolate(bodyOf(cell!), {})).toBe(said);
  });

  it("declares the session's name, workspace and model, and says where it came from", async () => {
    const workspace = join(dir, "project");
    await mkdir(workspace);
    const { file } = chatIn(workspace, [user("Audit it."), assistant("Audited.")], {
      name: "Weekly audit",
    });
    const notebook = join(dir, "notebooks", "audit.md");

    await importSession({ session: file, notebook });

    const { source, parsed } = await written(notebook);
    expect(parsed.metadata).toEqual({
      title: "Weekly audit",
      workspace: "../project",
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(workspaceOf(parsed, notebook)).toBe(workspace);
    expect(source).toBe(
      `---
title: Weekly audit
workspace: ../project
model: anthropic/claude-sonnet-4-5
---

Imported from a pi session begun ${await begunAt(file)} in \`${workspace}\`.

\`\`\`prompt id=cell-1
Audit it.
\`\`\`
`,
    );
  });

  it("declares no workspace for a session had where the notebook is, and no title for one unnamed", async () => {
    const { file } = chatIn(dir, [user("Audit it."), assistant("Audited.")]);
    const notebook = join(dir, "audit.md");

    await importSession({ session: file, notebook });

    const { parsed } = await written(notebook);
    expect(parsed.metadata).toEqual({ model: "anthropic/claude-sonnet-4-5" });
  });

  it("imports the path the chat was left on, and says that the branches it left are not here", async () => {
    const manager = SessionManager.create(dir, join(dir, "pi-sessions"));
    manager.appendMessage(user("Start."));
    const fork = manager.appendMessage(assistant("Started."));
    manager.appendMessage(user("First way."));
    manager.appendMessage(assistant("Went the first way."));
    // Back to the fork and off another way, which is where the chat was left.
    manager.branch(fork);
    manager.appendMessage(user("Second way."));
    manager.appendMessage(assistant("Went the second way."));
    const notebook = join(dir, "chat.md");

    const { record } = succeeded(
      await importSession({ session: manager.getSessionFile() ?? "", notebook }),
    );

    const { parsed } = await written(notebook);
    expect(cellsOf(parsed).map((cell) => cell.body)).toEqual(["Start.\n", "Second way.\n"]);
    expect(record.cells.map((cell) => cell.id)).toEqual(["cell-1", "cell-2"]);
    const [introduction] = parsed.segments;
    expect(introduction).toMatchObject({
      kind: "prose",
      text: expect.stringContaining("the branches it left behind are in the copy of the session"),
    });
    // The copy keeps every branch, as the byte copy it is.
    expect(SessionManager.open(record.agentSession ?? "").getChildren(fork)).toHaveLength(2);
  });

  it("imports a chat whose workspace has gone, declaring it, so that a run refuses on it plainly", async () => {
    const gone = join(dir, "gone");
    const { file } = chatIn(gone, [user("Audit it."), assistant("Audited.")]);
    const notebook = join(dir, "audit.md");

    const { record } = succeeded(await importSession({ session: file, notebook }));

    expect(record.environment.workspace).toBe(gone);
    const { parsed } = await written(notebook);
    expect(parsed.metadata.workspace).toBe("gone");
    await expect(
      runNotebook(notebook, { agent: createScriptedAgent([]).create }),
    ).rejects.toMatchObject({ kind: "workspace" });
  });
});

describe("an imported notebook", () => {
  it("round-trips byte for byte, as any notebook must", async () => {
    const { file } = chatIn(dir, [
      user("Rename {{ target }}:\n```\nmv a b\n```"),
      assistant("Done."),
      ran("ls", "b\n", 0),
      user("Line one\r\nline two, from a Windows terminal"),
      assistant("Noted."),
    ]);
    const notebook = join(dir, "chat.md");

    await importSession({ session: file, notebook });

    const { source, parsed } = await written(notebook);
    expect(serialiseNotebook(parsed)).toBe(source);
  });

  it("runs like any other, each cell asked as it was typed and each command run again", async () => {
    const { file } = chatIn(dir, [
      user("Say hello."),
      assistant("Hello."),
      ran("printf imported", "imported", 0),
      user("Say goodbye."),
      assistant("Goodbye."),
    ]);
    const notebook = join(dir, "chat.md");
    await importSession({ session: file, notebook });
    const agent = createScriptedAgent([{ text: "Hi again." }, { text: "Bye again." }]);

    const record = await runNotebook(notebook, { agent: agent.create });

    expect(agent.prompts).toEqual(["Say hello.", "Say goodbye."]);
    expect(record.cells).toEqual([
      expect.objectContaining({ id: "cell-1", type: "prompt", status: "ok", text: "Hi again." }),
      expect.objectContaining({ id: "cell-2", type: "bash", status: "ok", stdout: "imported" }),
      expect.objectContaining({ id: "cell-3", type: "prompt", status: "ok", text: "Bye again." }),
    ]);
    expect(record.environment.workspace).toBe(dir);
  });
});

describe("what an import never does", () => {
  it("writes nothing to pi's session file, even one pi would migrate on opening", async () => {
    const { file } = chatIn(dir, [user("Hello."), assistant("Hi.")]);
    // An older session, which pi brings up to date — and rewrites — when it opens one.
    const older = (await readFile(file, "utf8")).replace('"version":3', '"version":2');
    await writeFile(file, older, "utf8");
    const before = await stat(file);
    const notebook = join(dir, "chat.md");

    const { record } = succeeded(await importSession({ session: file, notebook }));

    expect(await readFile(file, "utf8")).toBe(older);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    // The copy is what pi brought up to date, and what a later Run reopens.
    expect(await readFile(record.agentSession ?? "", "utf8")).toContain('"version":3');
    expect(record.cells).toEqual([expect.objectContaining({ id: "cell-1", status: "ok" })]);
  });
});

describe("what an import refuses", () => {
  it("a session file that is not there, leaving nothing behind", async () => {
    const notebook = join(dir, "chat.md");

    const imported = await importSession({ session: join(dir, "missing.jsonl"), notebook });

    expect(imported).toEqual({ kind: "absent" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("a file that is not a pi session, leaving nothing behind", async () => {
    const file = join(dir, "notes.txt");
    await writeFile(file, "not a session\n", "utf8");
    const notebook = join(dir, "chat.md");

    const imported = await importSession({ session: file, notebook });

    expect(imported).toEqual({ kind: "invalid", problem: `${file} is not a pi session file.` });
    expect(await readdir(dir)).toEqual(["notes.txt"]);
  });

  it("a session nothing was asked in, since there would be no cell to make", async () => {
    const { file } = chatIn(dir, [assistant("Hello?")]);
    // Under a directory that is not there yet, which a refusal takes back too.
    const notebook = join(dir, "notes", "chat.md");

    const imported = await importSession({ session: file, notebook });

    expect(imported).toEqual({
      kind: "invalid",
      problem: "Nothing was asked in this session, so there is no cell to make of it.",
    });
    expect(await readdir(dir)).toEqual(["pi-sessions"]);
  });

  it("a notebook that is already there, which it never writes over", async () => {
    const { file } = chatIn(dir, [user("Hello."), assistant("Hi.")]);
    const notebook = join(dir, "chat.md");
    await writeFile(notebook, "# Mine\n", "utf8");

    const imported = await importSession({ session: file, notebook });

    expect(imported).toEqual({ kind: "exists" });
    expect(await readFile(notebook, "utf8")).toBe("# Mine\n");
    expect(await readdir(dir)).toEqual(["chat.md", "pi-sessions"]);
  });
});
