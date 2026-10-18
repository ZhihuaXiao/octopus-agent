import { chmodSync, mkdirSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";

/** A file only its owner can read. The password file is the pattern. */
export const OWNER_FILE = 0o600;
/** A directory only its owner can traverse. */
export const OWNER_DIR = 0o700;

/**
 * The `.octo` directory that holds `file`, when the file lives under one.
 * Tightening that directory keeps a record that was created world-readable
 * from staying reachable after the file itself is fixed.
 */
function octoOf(file: string): string | undefined {
  let dir = dirname(file);
  for (;;) {
    if (basename(dir) === ".octo") return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Makes `dir`, and the last directory created, owner-only. */
export function mkdirOwnerSync(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: OWNER_DIR });
}

/** Makes `dir`, and the last directory created, owner-only. */
export async function mkdirOwner(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: OWNER_DIR });
}

/** Makes `file` owner-only, and the `.octo` directory above it when it has one. */
export function protectOwnerSync(file: string): void {
  chmodSync(file, OWNER_FILE);
  const octo = octoOf(file);
  if (octo !== undefined) chmodSync(octo, OWNER_DIR);
}

/** Makes `file` owner-only, and the `.octo` directory above it when it has one. */
export async function protectOwner(file: string): Promise<void> {
  await chmod(file, OWNER_FILE);
  const octo = octoOf(file);
  if (octo !== undefined) await chmod(octo, OWNER_DIR);
}
