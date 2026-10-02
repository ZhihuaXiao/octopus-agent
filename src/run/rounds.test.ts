import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { Cell } from "../notebook/notebook.js";
import { attachSystemPrompt, readCellRounds } from "./rounds.js";

type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];

const cell = (id: string): Cell => ({
  id,
  type: "prompt",
  body: "",
  uses: [],
  isolated: false,
});

const userMessage = (content: string): AppendableMessage => ({
  role: "user",
  content,
  timestamp: Date.now(),
});

const assistant = (text: string, extra: Record<string, unknown> = {}): AppendableMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    ...extra,
  }) as AppendableMessage;

describe("a cell's model rounds", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "octo-rounds-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the rounds of one cell and not the cell before it", () => {
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage(userMessage("first"));
    const first = manager.appendMessage(assistant("First done."));
    manager.appendMessage(userMessage("what's there"));
    manager.appendMessage(
      assistant("Looking.", {
        content: [
          { type: "text", text: "Looking." },
          { type: "thinking", thinking: "list the files" },
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
        ],
        stopReason: "toolUse",
        usage: {
          input: 3,
          output: 4,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 7,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    );
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "a.txt" }],
      isError: false,
      timestamp: Date.now(),
    });
    const second = manager.appendMessage(
      assistant("One file.", {
        usage: {
          input: 8,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 10,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    );
    const file = manager.getSessionFile();
    expect(file).toBeDefined();

    const anchors = { first, second };
    const cells = [cell("first"), cell("second")];
    const read = readCellRounds(file ?? "", anchors, "second", cells);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.query).toBe("what's there");
    expect(read.value.prompts).toEqual(["what's there"]);
    expect(read.value.rounds).toEqual([
      {
        kind: "model",
        text: "Looking.",
        thinking: "list the files",
        model: "anthropic/test-model",
        inputTokens: 3,
        outputTokens: 4,
        toolCalls: [{ name: "bash", input: { command: "ls" }, result: "a.txt" }],
      },
      {
        kind: "model",
        text: "One file.",
        model: "anthropic/test-model",
        inputTokens: 8,
        outputTokens: 2,
        toolCalls: [],
      },
    ]);

    const earlier = readCellRounds(file ?? "", anchors, "first", cells);
    expect(earlier.ok).toBe(true);
    if (!earlier.ok) return;
    expect(earlier.value).toEqual({
      query: "first",
      prompts: ["first"],
      rounds: [
        {
          kind: "model",
          text: "First done.",
          model: "anthropic/test-model",
          inputTokens: 1,
          outputTokens: 2,
          toolCalls: [],
        },
      ],
    });
  });

  it("refuses a cell that left no anchor, and a session that is not on disk", () => {
    const cells = [cell("greet")];
    expect(readCellRounds("/no/such/session.jsonl", {}, "greet", cells)).toEqual({
      ok: false,
      problem: "This cell left no model rounds.",
    });
    expect(readCellRounds("/no/such/session.jsonl", { greet: "entry-1" }, "greet", cells)).toEqual({
      ok: false,
      problem: "The agent session for this cell is not on disk.",
    });
  });

  it("counts an injected prompt among the prompts, and keeps a recorded system prompt", () => {
    const manager = SessionManager.create(dir, dir);
    manager.appendCustomMessageEntry("skill", "Follow the house style.", false);
    const anchor = manager.appendMessage(userMessage("Say hello."));
    manager.appendMessage(assistant("Hello."));
    const file = manager.getSessionFile() ?? "";

    const read = readCellRounds(file, { greet: anchor }, "greet", [cell("greet")]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.prompts).toEqual(["Follow the house style.", "Say hello."]);

    const noted = attachSystemPrompt(read.value, "You are a careful assistant.");
    expect(noted.systemPrompt).toBe("You are a careful assistant.");
    expect(attachSystemPrompt(read.value, undefined).systemPrompt).toBeUndefined();
  });
});
