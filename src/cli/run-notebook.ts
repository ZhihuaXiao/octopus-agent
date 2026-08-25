import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createPiAgent } from "../agent/pi.js";
import { formatDiagnostics, parseNotebook } from "../notebook/notebook.js";
import { recordPath } from "../run/store.js";
import { runNotebook } from "../run/runner.js";

/**
 * Runs a Notebook headlessly against a real agent.
 *
 * The thinnest entry point that makes the tracer bullet reachable from a
 * terminal. Ticket 13 replaces it with the real launcher, whose run subcommand
 * is this behaviour behind proper argument parsing.
 */
async function main(): Promise<void> {
  const [notebookArg] = process.argv.slice(2);
  if (!notebookArg) {
    process.stderr.write("usage: npm run notebook -- <notebook.md>\n");
    process.exitCode = 1;
    return;
  }

  const path = resolve(notebookArg);
  // Parsed here only to resolve the Workspace, which the agent needs before the
  // run starts. Ticket 06 owns the declared environment properly.
  const parsed = parseNotebook(await readFile(path, "utf8"));
  if (!parsed.ok) {
    process.stderr.write(`${path} cannot be parsed:\n${formatDiagnostics(parsed.errors)}\n`);
    process.exitCode = 1;
    return;
  }
  const workspace = resolve(dirname(path), parsed.notebook.metadata.workspace ?? ".");

  const agent = await createPiAgent({
    cwd: workspace,
    onText: (text) => process.stdout.write(text),
  });

  try {
    const record = await runNotebook(path, { agent });
    process.stdout.write(`\n\nRun ${record.id} → ${recordPath(path, record.id)}\n`);

    const failed = record.cells.filter((cell) => cell.status === "error");
    for (const cell of failed) {
      process.stderr.write(`Cell "${cell.id}" failed: ${cell.error}\n`);
    }
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await agent.dispose();
  }
}

await main();
