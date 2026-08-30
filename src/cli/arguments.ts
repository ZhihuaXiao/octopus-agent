/**
 * The command line of the headless runner: a Notebook, a value for any of the
 * Inputs it declares, and the Workspace's trust decision.
 *
 * An Input is written as a long option named after it, `--target docs`, so the
 * command line reads as the Notebook's own vocabulary rather than a generic
 * `--input target=docs`. Ticket 13 folds this into the real launcher; what it
 * should keep is that a mistake here is reported rather than guessed at, since
 * a stray argument silently ignored is a run against the wrong values.
 */

import { isName } from "../notebook/name.js";

const USAGE = "usage: npm run notebook -- <notebook.md> [--trust|--no-trust] [--input value]...";

/** The flags that decide a Workspace's trust, and what deciding it means. */
const TRUST_FLAGS: Readonly<Record<string, boolean>> = { trust: true, "no-trust": false };

export type Arguments =
  | {
      readonly ok: true;
      readonly notebook: string;
      /** Values as written, for the Run to read against the declared types. */
      readonly inputs: Readonly<Record<string, string>>;
      /** Absent when neither flag was given, leaving the decision to what pi has recorded. */
      readonly trust?: boolean;
    }
  | { readonly ok: false; readonly error: string };

const isOption = (argument: string) => argument.startsWith("-");

export function readArguments(argv: readonly string[]): Arguments {
  const inputs: Record<string, string> = {};
  let notebook: string | undefined;
  let trust: boolean | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    if (!isOption(argument)) {
      if (notebook !== undefined) {
        return {
          ok: false,
          error: `Only one notebook can be run, so "${argument}" is a stray argument.`,
        };
      }
      notebook = argument;
      continue;
    }

    if (!argument.startsWith("--")) {
      return { ok: false, error: `Unknown option "${argument}". ${USAGE}` };
    }

    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument.slice(2) : argument.slice(2, separator);

    if (!isName(name)) {
      return { ok: false, error: `Unknown option "${argument}". ${USAGE}` };
    }

    // Read before the inputs, so the trust decision is never left to a name
    // collision. The cost is that `trust` and `no-trust` are the two Input
    // names this command line cannot pass a value for, which is one more thing
    // ticket 13's launcher should settle when it takes this over.
    const decision = TRUST_FLAGS[name];
    if (decision !== undefined) {
      if (separator !== -1) {
        return { ok: false, error: `Option "--${name}" takes no value.` };
      }
      if (trust !== undefined && trust !== decision) {
        return { ok: false, error: "Either trust the workspace or don't, not both." };
      }
      trust = decision;
      continue;
    }
    if (Object.hasOwn(inputs, name)) {
      return { ok: false, error: `Input "${name}" was given twice.` };
    }

    if (separator !== -1) {
      inputs[name] = argument.slice(separator + 1);
      continue;
    }

    // Another option where the value should be is a forgotten value rather
    // than a real one; `--name=--value` says it deliberately. A single dash
    // is not an option here, so `--retries -1` is the negative number it looks
    // like rather than a mistake.
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `Input "--${name}" needs a value.` };
    }
    inputs[name] = value;
    index += 1;
  }

  if (notebook === undefined) return { ok: false, error: USAGE };
  return { ok: true, notebook, inputs, ...(trust !== undefined ? { trust } : {}) };
}
