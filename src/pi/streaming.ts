import { isRecord } from "../util/guards.js";

import { thinkingBlocksOf } from "./turn.js";

/**
 * The part of pi's assistant message we read. Pi mixes text, thinking and tool
 * calls in one array, so the block type stays open. Thinking is read beside
 * the text and kept apart from it: it is not part of the reply.
 */
export interface AssistantContentLike {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** What one event newly revealed. Either string is empty when that event carried none. */
export interface Revealed {
  readonly text: string;
  readonly thinking: string;
}

const nothing: Revealed = { text: "", thinking: "" };

export interface AssistantTextStream {
  /** Feed one of pi's session events, returning the text and thinking it newly revealed. */
  accept(event: unknown): Revealed;
  /**
   * The reply assembled so far, or the final message's text once one has
   * arrived. `message_end` carries the authoritative content and wins.
   */
  text(): string;
}

function textOf(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return "";

  return (message.content as unknown[])
    .filter((block): block is AssistantContentLike => isRecord(block) && block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

/** Thinking blocks assembled the same way `thinkingBlocksOf` joins a message's. */
function joined(blocks: Map<number, string>): string {
  return [...blocks.keys()]
    .sort((a, b) => a - b)
    .map((index) => blocks.get(index) ?? "")
    .join("\n\n");
}

/**
 * Assembles an assistant reply from pi's streamed events, and the thinking
 * beside it.
 *
 * Events are accepted as `unknown` and narrowed here rather than typed against
 * pi's own event union. That union is large and changes between releases, so
 * depending on all of it would make every upstream addition our problem — and
 * taking `unknown` lets pi's real events be passed without a cast, so the live
 * suite genuinely proves they still fit.
 */
export function createAssistantTextStream(): AssistantTextStream {
  const blocks = new Map<number, string>();
  const thoughts = new Map<number, string>();
  let settled: string | undefined;

  const assembled = () =>
    [...blocks.keys()]
      .sort((a, b) => a - b)
      .map((index) => blocks.get(index) ?? "")
      .join("");

  return {
    accept(event) {
      if (!isRecord(event)) return nothing;

      if (event.type === "message_end") {
        const previous = assembled();
        settled = textOf(event.message);
        const previousThought = joined(thoughts);
        const thought = thinkingBlocksOf(
          isRecord(event.message) ? event.message.content : undefined,
        );
        // The next message numbers its blocks from the start again. Kept
        // here, a later thought would be glued onto this one.
        thoughts.clear();
        // Only emit a tail we can prove was missed. A message that diverges
        // otherwise is a correction, not new output, and re-emitting it would
        // duplicate text the caller has already streamed.
        return {
          text: settled.startsWith(previous) ? settled.slice(previous.length) : "",
          thinking: thought.startsWith(previousThought)
            ? thought.slice(previousThought.length)
            : "",
        };
      }

      if (event.type !== "message_update") return nothing;

      const inner = event.assistantMessageEvent;
      if (!isRecord(inner)) return nothing;

      const delta = typeof inner.delta === "string" ? inner.delta : "";
      const index = typeof inner.contentIndex === "number" ? inner.contentIndex : 0;
      if (inner.type === "thinking_delta") {
        thoughts.set(index, (thoughts.get(index) ?? "") + delta);
        return { text: "", thinking: delta };
      }
      if (inner.type !== "text_delta") return nothing;

      blocks.set(index, (blocks.get(index) ?? "") + delta);
      return { text: delta, thinking: "" };
    },

    text() {
      return settled ?? assembled();
    },
  };
}
