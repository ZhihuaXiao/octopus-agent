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
import { textBlocksOf } from "../pi/turn.js";
import { isRecord } from "../util/guards.js";
import { anchorBefore, type Anchors } from "./anchor.js";

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
  readonly rounds: readonly ModelRound[];
}

export type RoundsResult =
  | { readonly ok: true; readonly value: CellRounds }
  | { readonly ok: false; readonly problem: string };

const clip = (text: string) => (text.length <= LONGEST ? text : `${text.slice(0, LONGEST)}\n…`);

function thinkingOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as unknown[])
    .filter(isRecord)
    .filter((block) => block.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking as string)
    .join("\n\n");
}

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
  const thinking = clip(thinkingOf(message.content));
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
  const rounds: DraftRound[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message) || typeof message.role !== "string") continue;

    if (message.role === "user") {
      const text = clip(textBlocksOf(message.content));
      if (query === "" && rounds.length === 0) query = text;
      else rounds.push(roundOf(message, "you"));
      continue;
    }
    if (message.role === "assistant") {
      rounds.push(roundOf(message, "model"));
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

  return { ok: true, value: { query, rounds: rounds.map(published) } };
}
