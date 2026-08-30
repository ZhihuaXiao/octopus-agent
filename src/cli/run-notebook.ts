import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createPiAgent } from "../agent/pi.js";
import { formatDiagnostics, parseNotebook, workspaceOf } from "../notebook/notebook.js";
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
  // Parsed here only to resolve the Workspace, which the agent needs before the
  // run starts. Ticket 06 owns the declared environment properly.
  const parsed = parseNotebook(await readFile(path, "utf8"));
  if (!parsed.ok) {
    process.stderr.write(`${path} cannot be parsed:\n${formatDiagnostics(parsed.errors)}\n`);
    process.exitCode = 1;
    return;
  }
  const workspace = workspaceOf(parsed.notebook, path);

  const agent = await createPiAgent({
    cwd: workspace,
    onText: (text) => process.stdout.write(text),
  });

  try {
    const record = await runNotebook(path, { agent, inputs: args.inputs });
    process.stdout.write(`\n\nRun ${record.id} → ${recordPath(path, record.id)}\n`);

    const failed = record.cells.filter((cell) => cell.status === "error");
    for (const cell of failed) {
      process.stderr.write(`Cell "${cell.id}" failed: ${cell.error}\n`);
      // A bash cell's output never streamed past, so the account of what went
      // wrong is in the record and nowhere the reader has already seen.
      if (cell.type === "bash" && cell.stderr !== "") process.stderr.write(cell.stderr);
    }
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await agent.dispose();
  }
}

await main();
