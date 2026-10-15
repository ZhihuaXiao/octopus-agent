/**
 * The context window a custom model is given.
 *
 * Pi treats a model that leaves `contextWindow` unset as 128,000 tokens. A
 * custom model here is 200,000 unless its entry names another size. That size
 * is what a run records, and what the ring measures against.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isRecord } from "../util/guards.js";

/** Tokens, when a custom model does not name its own window. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

const MODELS_FILE = "models.json";

/** A whole number of tokens, or nothing when `value` is not one. */
export function contextWindowTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * The window `provider`/`id` should run with, when that pair is a custom model.
 * Undefined when it is not one of the models in `models.json`.
 */
export async function customContextWindow(
  agentDirectory: string,
  provider: string,
  id: string,
): Promise<number | undefined> {
  let text: string;
  try {
    text = await readFile(join(agentDirectory, MODELS_FILE), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) return undefined;
  const providerValue = parsed.providers[provider];
  if (!isRecord(providerValue) || !Array.isArray(providerValue.models)) return undefined;
  const model = providerValue.models.find((item) => isRecord(item) && item.id === id);
  if (!isRecord(model)) return undefined;
  return contextWindowTokens(model.contextWindow) ?? DEFAULT_CONTEXT_WINDOW;
}
