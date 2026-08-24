import { createAgentSession } from "@earendil-works/pi-coding-agent";

import { createAssistantTextStream } from "../pi/streaming.js";
import { isRecord } from "../util/guards.js";
import { type Agent, type CellResult, type ToolCall, type Usage } from "./agent.js";

export interface PiAgentOptions {
  /** The Workspace the Notebook operates on. */
  cwd?: string;
  /** Called with each fragment of text as it arrives, for streaming output. */
  onText?: (text: string) => void;
}

/**
 * Reads what one turn cost and did.
 *
 * A turn is several messages, not one: pi appends an assistant message per
 * provider request and a `toolResult` between them, so the tool calls and most
 * of the tokens are in messages *before* the closing one. Fields are narrowed
 * here rather than typed against pi's own union, matching `pi/streaming.ts`;
 * the live suite is what proves these names still hold.
 */
function summariseTurn(turn: readonly unknown[]): Omit<CellResult, "text"> {
  const assistantMessages = turn.filter(isRecord).filter((message) => message.role === "assistant");

  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls: ToolCall[] = [];

  for (const message of assistantMessages) {
    if (isRecord(message.usage)) {
      const { input, output } = message.usage;
      if (typeof input === "number") usage.inputTokens += input;
      if (typeof output === "number") usage.outputTokens += output;
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
  // providers rotate versions under a stable name.
  const last = assistantMessages.at(-1);
  const responseModel = last?.responseModel ?? last?.model;

  return { toolCalls, usage, model: typeof responseModel === "string" ? responseModel : "" };
}

/**
 * The agent boundary over pi's SDK, embedded in-process per ADR-0001.
 *
 * One session serves the whole Notebook, which is what gives Cells the shared
 * context a later Cell relies on when it says "now do the same for the others".
 * Ticket 08 adds Anchors and isolated Cells on top of this.
 */
export async function createPiAgent(options: PiAgentOptions = {}): Promise<Agent> {
  const { session } = await createAgentSession(
    options.cwd === undefined ? {} : { cwd: options.cwd },
  );

  return {
    async prompt(body: string): Promise<CellResult> {
      const stream = createAssistantTextStream();
      const unsubscribe = session.subscribe((event) => {
        const revealed = stream.accept(event);
        if (revealed) options.onText?.(revealed);
      });

      const before = session.messages.length;
      try {
        await session.prompt(body);
      } finally {
        unsubscribe();
      }

      return { text: stream.text(), ...summariseTurn(session.messages.slice(before)) };
    },

    async dispose(): Promise<void> {
      session.dispose();
    },
  };
}
