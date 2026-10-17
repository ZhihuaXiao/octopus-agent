/**
 * What a custom model's entry in `models.json` decides for a run.
 *
 * Pi treats a model that leaves `contextWindow` unset as 128,000 tokens. A
 * custom model here is 200,000 unless its entry names another size. That size
 * is what a run records, and what the ring measures against.
 *
 * Pi also treats a missing `reasoning` flag as false, and then clamps the
 * thinking level to off. A turn taken that way records no thought, so a round
 * has none to show. An entry that sets `reasoning` to false has refused, and
 * is left off. Any other custom model may think at the level the user set.
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

/** What `models.json` says about one custom model, or that the pair is not one. */
export interface CustomModelThinking {
  readonly custom: boolean;
  /** Set only when the entry itself says yes or no. Absent when it says nothing. */
  readonly reasoning?: boolean;
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
  const model = await customModel(agentDirectory, provider, id);
  if (model === undefined) return undefined;
  return contextWindowTokens(model.contextWindow) ?? DEFAULT_CONTEXT_WINDOW;
}

/** Whether `provider`/`id` is a custom model, and whether its entry allows thinking. */
export async function customThinking(
  agentDirectory: string,
  provider: string,
  id: string,
): Promise<CustomModelThinking> {
  const model = await customModel(agentDirectory, provider, id);
  if (model === undefined) return { custom: false };
  return {
    custom: true,
    ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
  };
}

/**
 * Lets `model` think at `thinking`, when its entry has not refused.
 *
 * A model that already thinks is left as it is, unless the entry says
 * `reasoning: false`, which turns that back off. A model that is not custom is
 * left to pi. Thinking left unset, or set to off, does not turn a model on:
 * off is the user asking for none.
 */
export function enableCustomThinking(
  model: { reasoning: boolean },
  stated: CustomModelThinking,
  thinking: string | undefined,
): void {
  if (!stated.custom) return;
  if (stated.reasoning === false) {
    model.reasoning = false;
    return;
  }
  if (model.reasoning || thinking === undefined || thinking === "off") return;
  model.reasoning = true;
}

/** The custom model's entry, when `provider`/`id` is one. */
async function customModel(
  agentDirectory: string,
  provider: string,
  id: string,
): Promise<Record<string, unknown> | undefined> {
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
  return isRecord(model) ? model : undefined;
}
