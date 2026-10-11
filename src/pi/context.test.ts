import { describe, expect, it } from "vitest";

import { contextUsage } from "./context.js";

const assistant = (text: string, totalTokens: number) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  usage: {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

describe("context usage", () => {
  it("splits the system prompt into the prompt, the project rules, and the skills", () => {
    const usage = contextUsage({
      systemPrompt: [
        "AAAA",
        "<project_context>",
        "BBBB",
        "</project_context>",
        "The following skills provide specialized instructions for a task.",
        "<available_skills>",
        "CCCC",
        "</available_skills>",
      ].join("\n"),
      tools: [{ name: "read", description: "look", parameters: { type: "object" } }],
      messages: [{ role: "user", content: "DDDD" }],
      window: 200_000,
    });

    expect(usage?.estimated).toBe(true);
    expect(usage?.window).toBe(200_000);
    expect(usage?.parts.map((part) => part.name)).toEqual([
      "system",
      "tools",
      "rules",
      "skills",
      "conversation",
    ]);
    expect(usage?.parts.reduce((sum, part) => sum + part.tokens, 0)).toBe(usage?.tokens);
    const rules = usage?.parts.find((part) => part.name === "rules");
    const skills = usage?.parts.find((part) => part.name === "skills");
    expect(rules?.tokens).toBeGreaterThan(0);
    expect(skills?.tokens).toBeGreaterThan(0);
  });

  it("uses the provider's count as the total and keeps the rows adding up to it", () => {
    const usage = contextUsage({
      systemPrompt: "AAAA",
      tools: [],
      messages: [{ role: "user", content: "BBBB" }, assistant("CCCC", 10)],
      window: 100,
    });

    expect(usage?.estimated).toBe(false);
    expect(usage?.tokens).toBe(10);
    expect(usage?.parts.reduce((sum, part) => sum + part.tokens, 0)).toBe(10);
  });

  it("estimates after a compaction, because the kept usage is the size from before it", () => {
    const usage = contextUsage({
      systemPrompt: "AAAA",
      tools: [],
      messages: [{ role: "compactionSummary", summary: "DDDDDDDD" }, assistant("CCCC", 999)],
    });

    expect(usage?.estimated).toBe(true);
    expect(usage?.tokens).toBeLessThan(999);
    expect(usage?.window).toBeUndefined();
  });

  it("is absent when the turn left nothing to measure", () => {
    expect(contextUsage({ systemPrompt: "", tools: [], messages: [] })).toBeUndefined();
  });
});
