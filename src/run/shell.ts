/**
 * Running a Bash Cell's body.
 *
 * The deterministic counterpart to the agent boundary. Nothing here needs a
 * test double: a Bash Cell exists precisely because it does the same thing
 * every time, so the tests above it run real commands.
 */

import { spawn } from "node:child_process";

export interface ShellResult {
  readonly stdout: string;
  /** What the command itself wrote, and only that. */
  readonly stderr: string;
  /** Null when the command never got as far as exiting on its own. */
  readonly exitCode: number | null;
  /** The signal that killed the command, if one did. */
  readonly signal: NodeJS.Signals | null;
  /**
   * Why the command never started, when it never did. Kept apart from `stderr`
   * so that what the Run records as the command's output is only ever the
   * command's own, never something said on its behalf.
   */
  readonly startupError: string | null;
}

/**
 * Runs a command in `workspace` and resolves with everything it produced.
 *
 * Never rejects. A command that could not be started is reported the same way
 * as one that ran and failed, because either way the caller has to record the
 * outcome against the Cell rather than abandon the Run.
 *
 * @param signal stops the command where it is. Everything it started is killed
 *   with it, so a script's own children cannot outlive the Cell — or hold its
 *   output open, which is what would keep this from ever resolving.
 */
export function runShellCommand(
  command: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<ShellResult> {
  return new Promise((settle) => {
    // `bash` rather than `sh`: the fence tag names the shell, so a body written
    // in bash's own syntax has to work.
    const child = spawn("bash", ["-c", command], {
      cwd: workspace,
      // Nothing to read from: a Run is headless, so a command that waits on
      // input would otherwise wedge it forever rather than see end of file.
      stdio: ["ignore", "pipe", "pipe"],
      // A process group of its own, so that stopping the command can stop the
      // processes it started as well: `bash -c` forks a child per command of a
      // multi-line body, and killing bash alone would leave them running.
      detached: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString("utf8");
    const captured = () => ({ stdout: text(stdout), stderr: text(stderr) });

    const stop = () => {
      // The whole group, by the negative of its leader's id. SIGKILL rather than
      // SIGTERM, because a command that has already outrun its time is not owed
      // a chance to ignore the request.
      if (child.pid !== undefined) killGroup(child.pid);
    };
    signal?.addEventListener("abort", stop, { once: true });

    child.on("error", (cause) => {
      signal?.removeEventListener("abort", stop);
      settle({ ...captured(), exitCode: null, signal: null, startupError: cause.message });
    });

    child.on("close", (exitCode, killedBy) => {
      signal?.removeEventListener("abort", stop);
      settle({ ...captured(), exitCode, signal: killedBy, startupError: null });
    });
  });
}

function killGroup(leader: number): void {
  try {
    process.kill(-leader, "SIGKILL");
  } catch {
    // Already gone, which is the outcome being asked for.
  }
}
