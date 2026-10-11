/**
 * How full the model's window was at the end of a turn, split the way the
 * request is built: the system prompt, the project rules and skills pi folds
 * into it, the tool definitions, and the conversation.
 *
 * The provider's own count is the total when the session still holds it. A
 * compaction replaces that history, and the usage kept on the messages from
 * before it is the old, larger window, so a compacted session is measured from
 * the text instead. The split is always by size. The rows add up to the total.
 */

import type { ContextPart, ContextPartName, ContextUsage } from "../agent/agent.js";
import { isRecord } from "../util/guards.js";

/** Pi's own estimate: four characters to a token, and an image as this many characters. */
const CHARS_PER_TOKEN = 4;
const IMAGE_CHARS = 4800;

const PARTS: readonly ContextPartName[] = ["system", "tools", "rules", "skills", "conversation"];

export interface ContextTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

/** What a turn left in the session, which is the window the next turn would send. */
export interface ContextSource {
  readonly systemPrompt: string;
  readonly tools: readonly ContextTool[];
  readonly messages: readonly unknown[];
  /** The model's context window, when the session was on a model that has one. */
  readonly window?: number;
}

const tokensOf = (chars: number) => (chars <= 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN));

const jsonChars = (value: unknown) => {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
};

/**
 * Lifts one marked stretch out of a prompt. The marks are the ones pi writes:
 * a project-context block, and the skills preamble through its closing tag.
 * Absent marks leave the prompt whole.
 */
function cut(text: string, startMark: string, endMark: string): { piece: string; rest: string } {
  const start = text.indexOf(startMark);
  const end = start < 0 ? -1 : text.indexOf(endMark, start + startMark.length);
  if (start < 0 || end < 0) return { piece: "", rest: text };
  const to = end + endMark.length;
  return { piece: text.slice(start, to), rest: text.slice(0, start) + text.slice(to) };
}

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") chars += block.text.length;
    else if (block.type === "thinking" && typeof block.thinking === "string")
      chars += block.thinking.length;
    else if (block.type === "image") chars += IMAGE_CHARS;
    else if (block.type === "toolCall") {
      chars += typeof block.name === "string" ? block.name.length : 0;
      chars += jsonChars(block.arguments);
    }
  }
  return chars;
}

function messageChars(message: unknown): number {
  if (!isRecord(message)) return 0;
  if (
    (message.role === "compactionSummary" || message.role === "branchSummary") &&
    typeof message.summary === "string"
  ) {
    return message.summary.length;
  }
  return contentChars(message.content);
}

/**
 * The provider's count of the window, from the last assistant message.
 * Undefined once a compaction or a branch summary has replaced part of the
 * history: the usage those kept messages still carry is the size from before.
 */
function countedContext(messages: readonly unknown[]): number | undefined {
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.role === "compactionSummary" || message.role === "branchSummary") return undefined;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) continue;
    const { usage } = message;
    if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) return usage.totalTokens;
    const sum = ["input", "output", "cacheRead", "cacheWrite"].reduce((total, key) => {
      const value = usage[key];
      return total + (typeof value === "number" ? value : 0);
    }, 0);
    return sum > 0 ? sum : undefined;
  }
  return undefined;
}

/** Spreads `total` across the parts in proportion to their estimates, summing exactly to it. */
function scale(parts: readonly ContextPart[], total: number): ContextPart[] {
  const estimated = parts.reduce((sum, part) => sum + part.tokens, 0);
  if (estimated <= 0) return [{ name: "conversation", tokens: total }];
  const exact = parts.map((part) => (part.tokens / estimated) * total);
  const floors = exact.map((value) => Math.floor(value));
  let left = total - floors.reduce((sum, value) => sum + value, 0);
  const byFraction = exact
    .map((value, index) => ({ index, fraction: value - (floors[index] ?? 0) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of byFraction) {
    if (left <= 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    left -= 1;
  }
  return parts.flatMap((part, index) => {
    const tokens = floors[index] ?? 0;
    return tokens > 0 ? [{ name: part.name, tokens }] : [];
  });
}

/**
 * The window a turn ended in.
 * Undefined when there is nothing in it: a turn that never reached the model
 * and left no prompt behind.
 */
export function contextUsage(source: ContextSource): ContextUsage | undefined {
  const rules = cut(source.systemPrompt, "<project_context>", "</project_context>");
  const skills = cut(
    rules.rest,
    "The following skills provide specialized instructions",
    "</available_skills>",
  );
  const sizes = new Map<ContextPartName, number>([
    ["system", tokensOf(skills.rest.length)],
    ["rules", tokensOf(rules.piece.length)],
    ["skills", tokensOf(skills.piece.length)],
    [
      "tools",
      tokensOf(
        source.tools.reduce(
          (chars, tool) =>
            chars + tool.name.length + (tool.description?.length ?? 0) + jsonChars(tool.parameters),
          0,
        ),
      ),
    ],
    [
      "conversation",
      tokensOf(
        source.messages.reduce<number>((chars, message) => chars + messageChars(message), 0),
      ),
    ],
  ]);
  const estimatedParts = PARTS.flatMap((name) => {
    const tokens = sizes.get(name) ?? 0;
    return tokens > 0 ? [{ name, tokens }] : [];
  });
  if (estimatedParts.length === 0) return undefined;

  const counted = countedContext(source.messages);
  const parts = counted === undefined ? estimatedParts : scale(estimatedParts, counted);
  const tokens = parts.reduce((sum, part) => sum + part.tokens, 0);
  if (tokens <= 0) return undefined;
  return {
    tokens,
    ...(source.window !== undefined && source.window > 0 ? { window: source.window } : {}),
    estimated: counted === undefined,
    parts,
  };
}
