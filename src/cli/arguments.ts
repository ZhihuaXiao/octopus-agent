/**
 * The command line of the headless runner: a Notebook, and a value for any of
 * the Inputs it declares.
 *
 * An Input is written as a long option named after it, `--target docs`, so the
 * command line reads as the Notebook's own vocabulary rather than a generic
 * `--input target=docs`. Ticket 13 folds this into the real launcher; what it
 * should keep is that a mistake here is reported rather than guessed at, since
 * a stray argument silently ignored is a run against the wrong values.
 */

import { isName } from "../notebook/name.js";

const USAGE = "usage: npm run notebook -- <notebook.md> [--input value]...";

export type Arguments =
  | {
      readonly ok: true;
      readonly notebook: string;
      /** Values as written, for the Run to read against the declared types. */
      readonly inputs: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly error: string };

const isOption = (argument: string) => argument.startsWith("-");

export function readArguments(argv: readonly string[]): Arguments {
  const inputs: Record<string, string> = {};
  let notebook: string | undefined;

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
  return { ok: true, notebook, inputs };
}
