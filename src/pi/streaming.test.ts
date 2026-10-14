import { describe, expect, it } from "vitest";

import { createAssistantTextStream } from "./streaming.js";

const delta = (contentIndex: number, text: string) => ({
  type: "message_update" as const,
  assistantMessageEvent: { type: "text_delta" as const, contentIndex, delta: text },
});

describe("createAssistantTextStream", () => {
  it("concatenates deltas belonging to one content block", () => {
    const stream = createAssistantTextStream();

    stream.accept(delta(0, "Hello, "));
    stream.accept(delta(0, "world"));

    expect(stream.text()).toBe("Hello, world");
  });

  it("returns the newly revealed text so callers can stream it", () => {
    const stream = createAssistantTextStream();

    expect(stream.accept(delta(0, "Hello, ")).text).toBe("Hello, ");
    expect(stream.accept(delta(0, "world")).text).toBe("world");
  });

  it("orders content blocks by index rather than by arrival", () => {
    const stream = createAssistantTextStream();

    stream.accept(delta(1, "second"));
    stream.accept(delta(0, "first "));

    expect(stream.text()).toBe("first second");
  });

  it("ignores thinking deltas, which are not part of the reply", () => {
    const stream = createAssistantTextStream();

    stream.accept({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" },
    });
    stream.accept(delta(1, "answer"));

    expect(stream.text()).toBe("answer");
  });

  it("is empty before anything arrives", () => {
    expect(createAssistantTextStream().text()).toBe("");
  });

  it("prefers the final message over assembled deltas, which can drop one", () => {
    const stream = createAssistantTextStream();
    stream.accept(delta(0, "Hello, wor"));

    const revealed = stream.accept({
      type: "message_end",
      message: { content: [{ type: "text", text: "Hello, world" }] },
    });

    expect(revealed.text).toBe("ld");
    expect(revealed.thinking).toBe("");
    expect(stream.text()).toBe("Hello, world");
  });

  it("reveals nothing further when the final message contradicts the deltas", () => {
    const stream = createAssistantTextStream();
    stream.accept(delta(0, "something else"));

    const revealed = stream.accept({
      type: "message_end",
      message: { content: [{ type: "text", text: "Hello, world" }] },
    });

    expect(revealed.text).toBe("");
    expect(revealed.thinking).toBe("");
    expect(stream.text()).toBe("Hello, world");
  });

  it("takes only text content from the final message, skipping thinking and tool calls", () => {
    const stream = createAssistantTextStream();

    stream.accept({
      type: "message_end",
      message: {
        content: [
          { type: "thinking", thinking: "deliberating" },
          { type: "text", text: "the " },
          { type: "toolCall", name: "bash" },
          { type: "text", text: "answer" },
        ],
      },
    });

    expect(stream.text()).toBe("the answer");
  });

  it("returns thinking deltas apart from the reply", () => {
    const stream = createAssistantTextStream();

    expect(
      stream.accept({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" },
      }),
    ).toEqual({ text: "", thinking: "hmm" });
    expect(stream.accept(delta(1, "answer"))).toEqual({ text: "answer", thinking: "" });
    expect(stream.text()).toBe("answer");
  });

  it("reveals thinking from the final message without mixing it into the reply", () => {
    const stream = createAssistantTextStream();

    const revealed = stream.accept({
      type: "message_end",
      message: {
        content: [
          { type: "thinking", thinking: "one" },
          { type: "thinking", thinking: "two" },
          { type: "text", text: "the answer" },
        ],
      },
    });

    expect(revealed).toEqual({ text: "the answer", thinking: "one\n\ntwo" });
    expect(stream.text()).toBe("the answer");
  });

  it("reveals only the thinking the deltas missed", () => {
    const stream = createAssistantTextStream();
    stream.accept({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "deliber" },
    });

    const revealed = stream.accept({
      type: "message_end",
      message: {
        content: [
          { type: "thinking", thinking: "deliberating" },
          { type: "text", text: "ok" },
        ],
      },
    });

    expect(revealed).toEqual({ text: "ok", thinking: "ating" });
  });

  it("starts the next message's thinking fresh", () => {
    const stream = createAssistantTextStream();
    stream.accept({
      type: "message_end",
      message: { content: [{ type: "thinking", thinking: "first" }] },
    });

    expect(
      stream.accept({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "sec" },
      }).thinking,
    ).toBe("sec");
  });

  it("reveals no thinking when the final message contradicts the deltas", () => {
    const stream = createAssistantTextStream();
    stream.accept({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "nope" },
    });

    const revealed = stream.accept({
      type: "message_end",
      message: { content: [{ type: "thinking", thinking: "actually" }] },
    });

    expect(revealed.thinking).toBe("");
  });
});
