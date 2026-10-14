/**
 * Reading one turn off pi's messages: what it cost, what tools it called, what
 * model served it, and whether it ended in failure.
 *
 * Shared between the live agent, which reads the messages a turn has just
 * appended to the Agent Session, and an import, which reads the same messages
 * out of a session file pi wrote at the terminal. One reading, so a Cell that
 * was imported is recorded exactly as one that ran.
 *
 * Fields are narrowed here rather than typed against pi's own union, matching
 * `streaming.ts`; the live suite is what proves these names still hold.
 */

import type { CellResult, ToolCall, Usage } from "../agent/agent.js";
import { isRecord } from "../util/guards.js";

/** The assistant messages among a turn's, which are where everything read here is. */
const assistantMessagesOf = (turn: readonly unknown[]) =>
  turn.filter(isRecord).filter((message) => message.role === "assistant");

/**
 * Reads what one turn cost and did.
 *
 * A turn is several messages, not one: pi appends an assistant message per
 * provider request and a `toolResult` between them, so the tool calls and most
 * of the tokens are in messages *before* the closing one.
 */
export function summariseTurn(turn: readonly unknown[]): Omit<CellResult, "text" | "retries"> {
  const assistantMessages = assistantMessagesOf(turn);

  const usage: Usage = { inputTokens: 0, outputTokens: 0, cost: 0 };
  const toolCalls: ToolCall[] = [];

  for (const message of assistantMessages) {
    if (isRecord(message.usage)) {
      const { input, output, cost } = message.usage;
      if (typeof input === "number") usage.inputTokens += input;
      if (typeof output === "number") usage.outputTokens += output;
      // Pi's total for the message, which is its input and output priced at the
      // model's rates, cache reads and writes included.
      if (isRecord(cost) && typeof cost.total === "number") usage.cost += cost.total;
    }

    if (!Array.isArray(message.content)) continue;
    for (const block of (message.content as unknown[]).filter(isRecord)) {
      if (block.type !== "toolCall") continue;
      toolCalls.push({
        name: typeof block.name === "string" ? block.name : "",
        input: block.arguments ?? null,
      });
    }
  }

  // `responseModel` is what the provider actually served, which is the point:
  // providers rotate versions under a stable name. Named with its provider, as a
  // Notebook names the model it asks for, so the two read side by side.
  const last = assistantMessages.at(-1);
  const responseModel = last?.responseModel ?? last?.model;
  const served = typeof responseModel === "string" ? responseModel : "";
  const provider = typeof last?.provider === "string" ? last.provider : "";
  const model = served === "" ? "" : provider === "" ? served : `${provider}/${served}`;

  return { toolCalls, usage, model };
}

/**
 * Why the turn failed, or undefined when it did not.
 *
 * Pi does not throw when a provider fails: `prompt` resolves and the turn's
 * last assistant message says `stopReason: "error"`, after pi's own retries
 * are spent. Left unread, a Cell whose provider was down would be recorded as
 * having succeeded with nothing to say.
 */
export function failureOf(turn: readonly unknown[]): string | undefined {
  const ended = assistantMessagesOf(turn).at(-1);
  if (ended === undefined) return "The turn produced no reply";

  if (ended.stopReason === "aborted") return "The turn was aborted";
  if (ended.stopReason !== "error") return undefined;
  return typeof ended.errorMessage === "string" && ended.errorMessage !== ""
    ? ended.errorMessage
    : "The provider returned an error";
}

/** Whether the turn's messages say somebody stopped it, rather than it finishing or failing on its own. */
export const wasStopped = (turn: readonly unknown[]) =>
  assistantMessagesOf(turn).at(-1)?.stopReason === "aborted";

/**
 * The text of a message's content: what was typed or said, with the images,
 * thinking and tool calls pi keeps beside it left out. Pi writes a user's
 * content as a string or as blocks and an assistant's always as blocks; this
 * reads either.
 */
export function textBlocksOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as unknown[])
    .filter(isRecord)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/**
 * The thinking in a message's content, one block after another. A blank line
 * between them, as one message's text is set apart from the next's: two
 * thoughts are two thoughts. Empty when the message recorded none.
 */
export function thinkingBlocksOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as unknown[])
    .filter(isRecord)
    .filter((block) => block.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking as string)
    .join("\n\n");
}

/**
 * Everything the turn's assistant messages said, in order, blank lines between
 * one message's text and the next: a turn that called a tool speaks once before
 * it and once after, and both were said.
 */
export function saidIn(turn: readonly unknown[]): string {
  return assistantMessagesOf(turn)
    .map((message) => textBlocksOf(message.content))
    .filter((text) => text !== "")
    .join("\n\n");
}

/**
 * Everything the turn's assistant messages thought, in order, blank lines
 * between one message's thinking and the next. Kept apart from `saidIn`: a
 * thought is not something the turn said.
 */
export function thoughtIn(turn: readonly unknown[]): string {
  return assistantMessagesOf(turn)
    .map((message) => thinkingBlocksOf(message.content))
    .filter((text) => text !== "")
    .join("\n\n");
}
