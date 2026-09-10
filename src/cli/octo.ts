#!/usr/bin/env node
import { resolve } from "node:path";

import { createPiAgent } from "../agent/pi.js";
import { handToPi } from "../pi/command.js";
import { recordPath } from "../run/store.js";
import { runNotebook } from "../run/runner.js";
import { startServer } from "../server/server.js";
import { type Command, readCommand } from "./launcher.js";

/** Runs a Notebook headlessly against a real agent, reporting to the terminal. */
async function run(command: Extract<Command, { kind: "run" }>): Promise<void> {
  const path = resolve(command.notebook);

  const record = await runNotebook(path, {
    // How the agent is set up is the Notebook's to say, so the Run decides it
    // and this supplies only what a terminal adds: somewhere to stream to.
    agent: (setup) => createPiAgent({ ...setup, onText: (text) => process.stdout.write(text) }),
    inputs: command.inputs,
    ...(command.trust !== undefined ? { trust: command.trust } : {}),
  });
  process.stdout.write(`\n\nRun ${record.id} → ${recordPath(path, record.id)}\n`);

  // Anything short of ok, since a timed-out cell is no more to be built on
  // than an errored one; the two are named apart because their remedies are.
  const failed = record.cells.filter((cell) => cell.status !== "ok");
  for (const cell of failed) {
    const what = cell.status === "timeout" ? "timed out" : "failed";
    process.stderr.write(`Cell "${cell.id}" ${what}: ${cell.error}\n`);
    if (cell.type === "prompt" && cell.retries.length > 0) {
      const times = cell.retries.length === 1 ? "once" : `${cell.retries.length} times`;
      process.stderr.write(`  (retried ${times} before that)\n`);
    }
    // A bash cell's output never streamed past, so the account of what went
    // wrong is in the record and nowhere the reader has already seen.
    if (cell.type === "bash" && cell.stderr !== "") process.stderr.write(cell.stderr);
  }
  if (failed.length > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const command = readCommand(process.argv.slice(2));

  switch (command.kind) {
    case "pi":
      process.exitCode = await handToPi(command.arguments);
      return;
    case "help":
      process.stdout.write(`${command.usage}\n`);
      return;
    case "mistake":
      process.stderr.write(`${command.error}\n`);
      process.exitCode = 2;
      return;
    case "web":
      await startServer({ ...(command.port !== undefined ? { port: command.port } : {}) });
      return;
    case "run":
      await run(command);
      return;
  }
}

try {
  await main();
} catch (cause) {
  // Mostly a refusal to run at all — a malformed notebook, missing inputs, an
  // undecided workspace, or an environment that is not the declared one — and
  // each of those is a sentence the reader is about to go and act on rather
  // than a stack trace. A genuine bug in here would be printed the same way
  // and read worse for it, which is the price of the common case reading well.
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}
