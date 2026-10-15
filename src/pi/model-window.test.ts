import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONTEXT_WINDOW, customContextWindow } from "./model-window.js";

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
