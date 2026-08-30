import { resolve } from "node:path";

import { createPiAgent } from "../agent/pi.js";
import { recordPath } from "../run/store.js";
import { runNotebook } from "../run/runner.js";
import { readArguments } from "./arguments.js";

/**
 * Runs a Notebook headlessly against a real agent.
 *
 * The thinnest entry point that makes the tracer bullet reachable from a
 * terminal. Ticket 13 replaces it with the real launcher, whose run subcommand
 * is this behaviour behind proper argument parsing.
 */
async function main(): Promise<void> {
  const args = readArguments(process.argv.slice(2));
  if (!args.ok) {
    process.stderr.write(`${args.error}\n`);
    process.exitCode = 1;
    return;
  }

  const path = resolve(args.notebook);

  try {
    const record = await runNotebook(path, {
      // How the agent is set up is the Notebook's to say, so the Run decides it
      // and this supplies only what a terminal adds: somewhere to stream to.
      agent: (setup) => createPiAgent({ ...setup, onText: (text) => process.stdout.write(text) }),
      inputs: args.inputs,
      ...(args.trust !== undefined ? { trust: args.trust } : {}),
    });
    process.stdout.write(`\n\nRun ${record.id} → ${recordPath(path, record.id)}\n`);

    const failed = record.cells.filter((cell) => cell.status === "error");
    for (const cell of failed) {
      process.stderr.write(`Cell "${cell.id}" failed: ${cell.error}\n`);
      // A bash cell's output never streamed past, so the account of what went
      // wrong is in the record and nowhere the reader has already seen.
      if (cell.type === "bash" && cell.stderr !== "") process.stderr.write(cell.stderr);
    }
    if (failed.length > 0) process.exitCode = 1;
  } catch (cause) {
    // Mostly a refusal to run at all — a malformed notebook, missing inputs, an
    // undecided workspace, or an environment that is not the declared one — and
    // each of those is a sentence the reader is about to go and act on rather
    // than a stack trace. A genuine bug in here would be printed the same way
    // and read worse for it, which is the price of the common case reading well.
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}

await main();
