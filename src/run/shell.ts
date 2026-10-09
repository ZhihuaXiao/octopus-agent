/**
 * Running a Bash Cell's body.
 *
 * The deterministic counterpart to the agent boundary. Nothing here needs a
 * test double: a Bash Cell exists precisely because it does the same thing
 * every time, so the tests above it run real commands.
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

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
  /**
   * Whether the command was stopped through the signal, rather than ending on
   * its own. False for a command that had already exited when the signal fired,
   * whose exit stands: a signal that stopped nothing is not what ended it.
   */
  readonly stopped: boolean;
  /**
   * Processes the command left running after its shell exited: a service it
   * started that did not end with it. Absent when it left none. Stopping the
   * Cell, or stopping the service later, ends these.
   */
  readonly servicePids?: readonly number[];
}

/**
 * Runs a command in `workspace` and resolves with everything it produced.
 *
 * Never rejects. A command that could not be started is reported the same way
 * as one that ran and failed, because either way the caller has to record the
 * outcome against the Cell rather than abandon the Run.
 *
 * @param signal stops the command where it is. Everything it started in its
 *   process group is killed with it. A service that has left that group is
 *   named on the result instead, so it can be stopped afterwards rather than
 *   holding the Cell open.
 */
export function runShellCommand(
  command: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<ShellResult> {
  return new Promise((settle) => {
    // A signal that has already fired stops the command before it starts, as
    // the agents stop a turn asked for after the fact: nothing is spawned, and
    // the result says it was stopped and nothing else.
    if (signal?.aborted) {
      settle({
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        startupError: null,
        stopped: true,
      });
      return;
    }

    // `bash` rather than `sh`: the fence tag names the shell, so a body written
    // in bash's own syntax has to work.
    const child = spawn("bash", ["-c", command], {
      cwd: workspace,
      // Nothing to read from: a Run is headless, so a command that waits on
      // input would otherwise wedge it forever rather than see end of file.
      stdio: ["ignore", "pipe", "pipe"],
      // A process group of its own, so the processes this command starts can
      // be told from everything else and stopped with it. A service that
      // leaves the group is still noticed, and named on the result.
      detached: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString("utf8");
    const captured = () => ({ stdout: text(stdout), stderr: text(stderr) });

    // Processes seen in this command's group, or as its children, while it
    // runs. A service that calls setsid leaves the group; having seen it is
    // what lets it be named after the shell has gone.
    const seen = new Set<number>();
    const note = () => {
      if (child.pid === undefined) return;
      for (const pid of relatedTo(child.pid)) seen.add(pid);
    };
    const watch = setInterval(note, 50);
    watch.unref();

    let settled = false;
    const finish = (exitCode: number | null, killedBy: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      signal?.removeEventListener("abort", stop);
      note();
      const servicePids = [...seen].filter((pid) => pid !== child.pid && processAlive(pid));
      // A service left running keeps the pipes open, which would keep this
      // from resolving and the process from exiting. The Cell has its output;
      // the service is stopped later, on its own.
      if (servicePids.length > 0) {
        for (const stream of [child.stdout, child.stderr]) {
          if (stream !== null && "unref" in stream && typeof stream.unref === "function") {
            stream.unref();
          }
        }
        child.unref();
      }
      settle({
        ...captured(),
        exitCode,
        signal: killedBy,
        startupError: null,
        stopped,
        ...(servicePids.length > 0 ? { servicePids } : {}),
      });
    };

    let stopped = false;
    const stop = () => {
      // Only a command still running is stopped; one that has exited already
      // has its exit, and the signal changes nothing about it.
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      stopped = true;
      // The whole group, by the negative of its leader's id. SIGKILL rather than
      // SIGTERM, because a command that has already outrun its time is not owed
      // a chance to ignore the request.
      killGroup(child.pid);
    };
    signal?.addEventListener("abort", stop, { once: true });

    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      signal?.removeEventListener("abort", stop);
      settle({
        ...captured(),
        exitCode: null,
        signal: null,
        startupError: cause.message,
        stopped,
      });
    });

    child.on("exit", (exitCode, killedBy) => {
      note();
      const leader = child.pid;
      const left = leader === undefined ? [] : relatedTo(leader).filter((pid) => pid !== leader);
      // Nothing outlived the shell: wait for its output to finish draining.
      // Something did: give it a moment to exec, then end the Cell and name it.
      if (left.length === 0) return;
      setTimeout(() => {
        note();
        const still =
          leader === undefined
            ? []
            : [...seen].filter((pid) => pid !== leader && processAlive(pid));
        // They exited with the shell after all; let its output finish draining.
        if (still.length > 0) finish(exitCode, killedBy);
      }, 50).unref();
    });

    child.on("close", (exitCode, killedBy) => {
      finish(exitCode, killedBy);
    });
  });
}

/**
 * Ends processes a Bash Cell left running. The group each one leads or belongs
 * to goes with it, so a service's own children do not outlive the stop. Never
 * this process, and never its group.
 */
export function stopService(pids: readonly number[]): void {
  const own = procOf(process.pid)?.pgrp;
  const groups = new Set<number>();
  for (const pid of pids) {
    if (pid <= 1 || pid === process.pid) continue;
    const proc = procOf(pid);
    if (proc === undefined || proc.state === "Z") continue;
    if (proc.pgrp > 1 && proc.pgrp !== own) groups.add(proc.pgrp);
  }
  for (const group of groups) killGroup(group);
  for (const pid of pids) {
    if (pid <= 1 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is the outcome being asked for.
    }
  }
}

/** Whether `pid` is a process that is still running. */
export function serviceAlive(pids: readonly number[]): boolean {
  return pids.some((pid) => processAlive(pid));
}

/** Processes in `leader`'s group, and those descended from it, besides itself. */
function relatedTo(leader: number): number[] {
  const procs = processes();
  const ids = new Set<number>();
  for (const proc of procs) if (proc.pgrp === leader) ids.add(proc.pid);
  let grew = true;
  while (grew) {
    grew = false;
    for (const proc of procs) {
      if (ids.has(proc.ppid) && !ids.has(proc.pid)) {
        ids.add(proc.pid);
        grew = true;
      }
    }
  }
  ids.delete(leader);
  return [...ids];
}

function processAlive(pid: number): boolean {
  const proc = procOf(pid);
  return proc !== undefined && proc.state !== "Z";
}

interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly pgrp: number;
  readonly state: string;
}

function procOf(pid: number): Proc | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (end < 0) return undefined;
    const rest = stat.slice(end + 2).split(" ");
    const state = rest[0];
    const ppid = Number(rest[1]);
    const pgrp = Number(rest[2]);
    if (state === undefined || !Number.isInteger(ppid) || !Number.isInteger(pgrp)) return undefined;
    return { pid, ppid, pgrp, state };
  } catch {
    return undefined;
  }
}

function processes(): Proc[] {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  const found: Proc[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const proc = procOf(Number(name));
    if (proc !== undefined) found.push(proc);
  }
  return found;
}

function killGroup(leader: number): void {
  try {
    process.kill(-leader, "SIGKILL");
  } catch {
    // Already gone, which is the outcome being asked for.
  }
}
