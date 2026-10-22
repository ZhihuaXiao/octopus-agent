/**
 * The model rounds of one Prompt Cell's turn, read back from the Agent Session
 * the Run left them in.
 *
 * A turn is one user message — the Cell's body — and then as many provider
 * requests as the agent took: an assistant message, the tool results it asked
 * for, and another assistant message, until it stopped. Those messages sit in
 * the session between the Anchor the previous Cell ended on and the Anchor
 * this Cell ended on. An Isolated Cell leaves no Anchor, and a Bash Cell never
 * enters the session, so neither has rounds here.
 */

import { existsSync } from "node:fs";

import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

import type { Cell } from "../notebook/notebook.js";
import { textBlocksOf, thinkingBlocksOf } from "../pi/turn.js";
import { isRecord } from "../util/guards.js";
import { anchorBefore, type Anchors } from "./anchor.js";
import type { PromptCellRecord } from "./record.js";

/** How long one piece of a round may be. Past that, the rest is left off. */
const LONGEST = 20_000;

export interface RoundTool {
  readonly name: string;
  readonly input: unknown;
  /** What the tool returned, once it had. */
  readonly result?: string;
  readonly isError?: boolean;
}

/** One provider reply, or a further message from the user in the same turn. */
export interface ModelRound {
  readonly kind: "model" | "you";
  readonly text: string;
  /** What the model thought, when it recorded any. */
  readonly thinking?: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly toolCalls: readonly RoundTool[];
}

/** The Cell's question, then each model round that followed. */
export interface CellRounds {
  readonly query: string;
  /**
   * The prompts other than the system prompt: the Cell's question, any further
   * message the user sent in the turn, and any prompt an extension injected.
   */
  readonly prompts: readonly string[];
  /** The system prompt the turn was given, when the Run recorded one. */
  readonly systemPrompt?: string;
  /**
   * The tool calls as the Run recorded them, when the Agent Session itself
   * cannot be read. Absent when `rounds` holds them, results included.
   */
  readonly toolCalls?: readonly RoundTool[];
  /**
   * Why the model rounds themselves could not be read. The prompts and tool
   * calls above are what the Run recorded anyway.
   */
  readonly roundsProblem?: string;
  readonly rounds: readonly ModelRound[];
}

export type RoundsResult =
  | { readonly ok: true; readonly value: CellRounds }
  | { readonly ok: false; readonly problem: string };

const clip = (text: string) => (text.length <= LONGEST ? text : `${text.slice(0, LONGEST)}\n…`);

interface DraftTool {
  name: string;
  input: unknown;
  id?: string;
  result?: string;
  isError?: boolean;
}

interface DraftRound {
  kind: "model" | "you";
  text: string;
  thinking?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls: DraftTool[];
}

function toolCallsOf(message: Record<string, unknown>): DraftTool[] {
  if (!Array.isArray(message.content)) return [];
  return (message.content as unknown[]).filter(isRecord).flatMap((block) => {
    if (block.type !== "toolCall") return [];
    const call: DraftTool = {
      name: typeof block.name === "string" ? block.name : "",
      input: block.arguments ?? null,
      ...(typeof block.id === "string" ? { id: block.id } : {}),
    };
    return [call];
  });
}

function modelOf(message: Record<string, unknown>): string {
  const served = message.responseModel ?? message.model;
  const name = typeof served === "string" ? served : "";
  const provider = typeof message.provider === "string" ? message.provider : "";
  if (name === "") return "";
  return provider === "" ? name : `${provider}/${name}`;
}

function tokensOf(message: Record<string, unknown>): {
  inputTokens?: number;
  outputTokens?: number;
} {
  if (!isRecord(message.usage)) return {};
  const input = message.usage.input;
  const output = message.usage.output;
  return {
    ...(typeof input === "number" ? { inputTokens: input } : {}),
    ...(typeof output === "number" ? { outputTokens: output } : {}),
  };
}

function roundOf(message: Record<string, unknown>, kind: "model" | "you"): DraftRound {
  const text = clip(textBlocksOf(message.content));
  const thinking = clip(thinkingBlocksOf(message.content));
  const model = kind === "model" ? modelOf(message) : "";
  return {
    kind,
    text,
    ...(thinking !== "" ? { thinking } : {}),
    ...(model !== "" ? { model } : {}),
    ...tokensOf(message),
    toolCalls: kind === "model" ? toolCallsOf(message) : [],
  };
}

function published(round: DraftRound): ModelRound {
  return {
    kind: round.kind,
    text: round.text,
    ...(round.thinking !== undefined ? { thinking: round.thinking } : {}),
    ...(round.model !== undefined ? { model: round.model } : {}),
    ...(round.inputTokens !== undefined ? { inputTokens: round.inputTokens } : {}),
    ...(round.outputTokens !== undefined ? { outputTokens: round.outputTokens } : {}),
    toolCalls: round.toolCalls.map((call) => ({
      name: call.name,
      input: call.input,
      ...(call.result !== undefined ? { result: call.result } : {}),
      ...(call.isError === true ? { isError: true } : {}),
    })),
  };
}

/**
 * The messages of the Cell's turn: the path from the session's root to the
 * Anchor the turn ended on, after the Anchor the Cell began from.
 */
function turnEntries(
  manager: SessionManager,
  anchor: string,
  before: string | undefined,
): SessionEntry[] | undefined {
  const branch = manager.getBranch(anchor);
  const end = branch.findIndex((entry) => entry.id === anchor);
  if (end < 0) return undefined;
  if (before === undefined) return branch.slice(0, end + 1);
  const start = branch.findIndex((entry) => entry.id === before);
  if (start < 0) return undefined;
  return branch.slice(start + 1, end + 1);
}

/**
 * The model rounds of `cellId` in the Agent Session `sessionFile`, between the
 * Anchors `anchors` records. `cells` is the Notebook's, so the Anchor the Cell
 * began from is the one the Run order says came before it.
 */
export function readCellRounds(
  sessionFile: string,
  anchors: Anchors,
  cellId: string,
  cells: readonly Cell[],
): RoundsResult {
  const anchor = anchors[cellId];
  if (anchor === undefined) {
    return { ok: false, problem: "This cell left no model rounds." };
  }

  if (!existsSync(sessionFile)) {
    return { ok: false, problem: "The agent session for this cell is not on disk." };
  }
  let manager: SessionManager;
  try {
    manager = SessionManager.open(sessionFile);
  } catch {
    return { ok: false, problem: "The agent session for this cell is not on disk." };
  }

  const before = anchorBefore(anchors, cells, cellId);
  const entries = turnEntries(manager, anchor, before);
  if (entries === undefined) {
    return { ok: false, problem: "The session no longer holds this cell's turn." };
  }

  let query = "";
  const prompts: string[] = [];
  const rounds: DraftRound[] = [];
  for (const entry of entries) {
    if (entry.type === "custom_message") {
      const text = clip(
        typeof entry.content === "string" ? entry.content : textBlocksOf(entry.content),
      );
      if (text !== "") prompts.push(text);
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    // Pi's message roles other than `toolResult` are interfaces, so `isRecord`
    // would discard them. The fields below are read as plain data.
    const fields = message as unknown as Record<string, unknown>;

    if (message.role === "user") {
      const text = clip(textBlocksOf(message.content));
      if (text !== "") prompts.push(text);
      if (query === "" && rounds.length === 0) query = text;
      else rounds.push(roundOf(fields, "you"));
      continue;
    }
    if (message.role === "assistant") {
      rounds.push(roundOf(fields, "model"));
      continue;
    }
    if (message.role !== "toolResult") continue;

    const current = rounds.at(-1);
    if (current === undefined || current.kind !== "model") continue;
    const name = typeof message.toolName === "string" ? message.toolName : "";
    const result = clip(textBlocksOf(message.content));
    const isError = message.isError === true;
    const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
    const call = id === undefined ? undefined : current.toolCalls.find((item) => item.id === id);
    if (call !== undefined) {
      call.result = result;
      if (isError) call.isError = true;
    } else {
      current.toolCalls.push({
        name,
        input: null,
        result,
        ...(isError ? { isError: true } : {}),
      });
    }
  }

  return { ok: true, value: { query, prompts, rounds: rounds.map(published) } };
}

/**
 * The round a Cell's turn leaves when its Agent Session cannot be read, made
 * from what the Run Record kept.
 *
 * One round rather than several, because the record keeps what the turn said
 * and thought as a whole and not message by message: a turn that replied
 * around three tool calls is one reply here, with the calls in the order they
 * were made. Tool results are the Agent Session's and are not in the record,
 * so the calls carry their arguments and nothing else.
 *
 * Nothing at all when the record has nothing to say: a turn that failed before
 * the model answered left no reply to stand in for the one it never gave.
 */
export function roundFromRecord(record: PromptCellRecord): ModelRound | undefined {
  const text = clip(record.text);
  const thinking = clip(record.thinking ?? "");
  if (text === "" && thinking === "" && record.toolCalls.length === 0) return undefined;
  return {
    kind: "model",
    text,
    ...(thinking !== "" ? { thinking } : {}),
    ...(record.model !== "" ? { model: record.model } : {}),
    ...(record.usage.inputTokens > 0 ? { inputTokens: record.usage.inputTokens } : {}),
    ...(record.usage.outputTokens > 0 ? { outputTokens: record.usage.outputTokens } : {}),
    toolCalls: record.toolCalls.map((call) => ({ name: call.name, input: call.input })),
  };
}

/**
 * The rounds with the system prompt the Run recorded for the Cell, clipped the
 * same way a round's text is. A Run that recorded none leaves the rounds as
 * they were.
 */
export function attachSystemPrompt(
  value: CellRounds,
  systemPrompt: string | undefined,
): CellRounds {
  if (systemPrompt === undefined || systemPrompt === "") return value;
  return { ...value, systemPrompt: clip(systemPrompt) };
}
