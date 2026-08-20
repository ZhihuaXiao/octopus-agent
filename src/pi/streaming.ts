/**
 * The part of pi's assistant message we read: its text content blocks. Pi mixes
 * text, thinking and tool calls in one array, so the block type stays open.
 */
export interface AssistantContentLike {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface AssistantTextStream {
  /** Feed one of pi's session events, returning the text it newly revealed. */
  accept(event: unknown): string;
  /**
   * The reply assembled so far, or the final message's text once one has
   * arrived. `message_end` carries the authoritative content and wins.
   */
  text(): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textOf(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return "";

  return (message.content as unknown[])
    .filter((block): block is AssistantContentLike => isRecord(block) && block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

/**
 * Assembles an assistant reply from pi's streamed events.
 *
 * Events are accepted as `unknown` and narrowed here rather than typed against
 * pi's own event union. That union is large and changes between releases, so
 * depending on all of it would make every upstream addition our problem — and
 * taking `unknown` lets pi's real events be passed without a cast, so the live
 * suite genuinely proves they still fit.
 */
export function createAssistantTextStream(): AssistantTextStream {
  const blocks = new Map<number, string>();
  let settled: string | undefined;

  const assembled = () =>
    [...blocks.keys()]
      .sort((a, b) => a - b)
      .map((index) => blocks.get(index) ?? "")
      .join("");

  return {
    accept(event) {
      if (!isRecord(event)) return "";

      if (event.type === "message_end") {
        const previous = assembled();
        settled = textOf(event.message);
        // Only emit a tail we can prove was missed. A message that diverges
        // otherwise is a correction, not new output, and re-emitting it would
        // duplicate text the caller has already streamed.
        return settled.startsWith(previous) ? settled.slice(previous.length) : "";
      }

      if (event.type !== "message_update") return "";

      const inner = event.assistantMessageEvent;
      if (!isRecord(inner) || inner.type !== "text_delta") return "";

      const delta = typeof inner.delta === "string" ? inner.delta : "";
      const index = typeof inner.contentIndex === "number" ? inner.contentIndex : 0;
      blocks.set(index, (blocks.get(index) ?? "") + delta);
      return delta;
    },

    text() {
      return settled ?? assembled();
    },
  };
}
