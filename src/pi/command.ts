import { spawn } from "node:child_process";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PI_PACKAGE } from "./version-pin.js";

/** What to start, and the arguments that go before the user's own. */
export interface PiCommand {
  readonly command: string;
  readonly prefix: readonly string[];
}

/**
 * The `pi` command as the pinned package ships it, run by the Node this runs on.
 *
 * Found beside the package's entry point rather than through `node_modules/.bin`,
 * which exists only where npm was asked to link it and points at whichever pi
 * is nearest rather than the one pinned here. The layout of pi's `dist` is not
 * part of its exported surface, which is why the live check that this resolves
 * to something answering for the pinned version is a test rather than a hope.
 */
export function piCommand(): PiCommand {
  const entry = fileURLToPath(import.meta.resolve(PI_PACKAGE));
  return { command: process.execPath, prefix: [join(dirname(entry), "cli.js")] };
}

/**
 * The signals the terminal itself sends — Ctrl-C, and the terminal closing.
 * They reach pi already, since pi shares this process's terminal and process
 * group; all this process has to do is not die of them first.
 */
const TERMINALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGHUP"];

/** The signal a supervisor sends this process by its id, which pi never sees unless it is passed on. */
const FORWARDED: NodeJS.Signals = "SIGTERM";

/**
 * Hands the terminal to pi, and reports how pi ended.
 *
 * Node cannot replace the running process the way `exec` would, so the nearest
 * thing: pi is started on this process's own stdin, stdout and stderr, so its
 * interactive mode draws and reads the terminal directly; a signal from the
 * terminal is left to reach pi as it already does, with this process waiting
 * rather than dying of it, and a signal aimed at this process alone is passed
 * on, so that stopping the launcher either way stops pi and nothing is left
 * running behind an empty prompt; and pi's exit status is this process's, in
 * the shell's convention for a process that a signal ended.
 */
export function handToPi(userArguments: readonly string[]): Promise<number> {
  const { command, prefix } = piCommand();

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...userArguments], { stdio: "inherit" });

    const wait = () => undefined;
    const forward = () => child.kill(FORWARDED);
    for (const signal of TERMINALS) process.on(signal, wait);
    process.on(FORWARDED, forward);
    const release = () => {
      for (const signal of TERMINALS) process.off(signal, wait);
      process.off(FORWARDED, forward);
    };

    child.once("error", (cause) => {
      release();
      reject(cause);
    });
    child.once("exit", (code, signal) => {
      release();
      resolve(code ?? 128 + (signal === null ? 0 : constants.signals[signal]));
    });
  });
}
