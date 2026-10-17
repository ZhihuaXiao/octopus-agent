import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTEXT_WINDOW,
  customContextWindow,
  customThinking,
  enableCustomThinking,
} from "./model-window.js";

describe("custom context window", () => {
  it("uses 200,000 when a custom model leaves the window unset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "octo-window-"));
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({ providers: { ollama: { models: [{ id: "llama" }] } } }),
    );
    expect(await customContextWindow(dir, "ollama", "llama")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(200_000);
    expect(await customContextWindow(dir, "ollama", "other")).toBeUndefined();
    expect(await customContextWindow(dir, "anthropic", "claude")).toBeUndefined();
  });

  it("uses the size the model names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "octo-window-"));
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: { ollama: { models: [{ id: "llama", contextWindow: 100_000 }] } },
      }),
    );
    expect(await customContextWindow(dir, "ollama", "llama")).toBe(100_000);
  });

  it("is absent when there is no models file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "octo-window-"));
    expect(await customContextWindow(dir, "ollama", "llama")).toBeUndefined();
  });
});

describe("custom model thinking", () => {
  it("reads whether the entry allows thinking, and nothing when it is not custom", async () => {
    const dir = await mkdtemp(join(tmpdir(), "octo-thinking-"));
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          panel: {
            models: [
              { id: "luna" },
              { id: "quiet", reasoning: false },
              { id: "loud", reasoning: true },
            ],
          },
        },
      }),
    );

    expect(await customThinking(dir, "panel", "luna")).toEqual({ custom: true });
    expect(await customThinking(dir, "panel", "quiet")).toEqual({ custom: true, reasoning: false });
    expect(await customThinking(dir, "panel", "loud")).toEqual({ custom: true, reasoning: true });
    expect(await customThinking(dir, "panel", "other")).toEqual({ custom: false });
    expect(await customThinking(dir, "anthropic", "claude")).toEqual({ custom: false });
  });

  it("lets a custom model think at the level that was set, and leaves a refusal off", () => {
    const model = { reasoning: false };
    enableCustomThinking(model, { custom: true }, "high");
    expect(model.reasoning).toBe(true);

    const refused = { reasoning: true };
    enableCustomThinking(refused, { custom: true, reasoning: false }, "high");
    expect(refused.reasoning).toBe(false);

    const quiet = { reasoning: false };
    enableCustomThinking(quiet, { custom: true }, "off");
    enableCustomThinking(quiet, { custom: true }, undefined);
    enableCustomThinking(quiet, { custom: false }, "high");
    expect(quiet.reasoning).toBe(false);
  });
});
