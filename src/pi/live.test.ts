import { describe, expect, it } from "vitest";

import { ModelRuntime, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";

import { createPiAgent } from "../agent/pi.js";
import { createAssistantTextStream } from "./streaming.js";

/**
 * The standing early-warning system for pi upgrades.
 *
 * Pi ships breaking changes in minor releases and never publishes a major, so
 * the pin in package.json defers that cost rather than removing it. This suite
 * exercises the SDK surface we actually depend on, against a real provider, so
 * that raising the pin fails here rather than somewhere subtle later.
 *
 * Nothing here is wrapped in a catch: `ModelRuntime.create()` resolves without
 * credentials and simply reports no available models, so an exception from it
 * means the SDK moved and should fail the suite rather than skip it.
 *
 * It is slow and occasionally flaky by nature. That is an acceptable price for
 * what it buys, provided it stays small.
 */
const availableModels = await (await ModelRuntime.create()).getAvailable();

describe.skipIf(availableModels.length === 0)("pi's SDK against a real provider", () => {
  it("creates a session, streams a reply, and reports token usage and cost", async () => {
    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      noTools: "all",
    });

    const stream = createAssistantTextStream();
    let sawMessageEnd = false;

    const unsubscribe = session.subscribe((event) => {
      stream.accept(event);
      if (event.type === "message_end") sawMessageEnd = true;
    });

    try {
      await session.prompt("Reply with exactly the word: pong");

      expect(sawMessageEnd, "message_end should terminate the stream").toBe(true);
      expect(stream.text().toLowerCase()).toContain("pong");

      const reply = session.messages.at(-1);
      expect(reply?.role).toBe("assistant");

      // Named fields rather than presence: ticket 12's run record reports token
      // counts and cost, so a rename upstream must fail here.
      const usage = (reply as { usage?: Record<string, unknown> }).usage;
      expect(usage).toMatchObject({
        input: expect.any(Number),
        output: expect.any(Number),
      });
      expect(usage?.cost).toMatchObject({ total: expect.any(Number) });

      // The agent boundary reports the model that actually served the turn,
      // because providers rotate versions under a stable name.
      expect(typeof (reply as { model?: unknown }).model).toBe("string");
    } finally {
      unsubscribe();
      session.dispose();
    }
  });

  it("spans a turn across several messages, with tool calls in the earlier ones", async () => {
    const agent = await createPiAgent({ cwd: process.cwd() });

    try {
      const result = await agent.prompt(
        "Run the shell command `echo pong` using the bash tool, then reply with its output.",
      );

      // The agent boundary sums usage across the turn and collects tool calls
      // from every assistant message in it. Reading only the final message —
      // which is what an earlier version did — silently loses both.
      expect(result.toolCalls.map((call) => call.name)).toContain("bash");
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
      expect(result.model).not.toBe("");

      const [call] = result.toolCalls;
      expect(call?.input, "pi names the tool's arguments `arguments`").toMatchObject({
        command: expect.stringContaining("echo"),
      });
    } finally {
      await agent.dispose();
    }
  });
});
