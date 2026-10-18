import { resolve } from "node:path";

import { within } from "../util/paths.js";

/**
 * Where a notebook's cells may operate: the workspace they are given, which is
 * the directory a Bash Cell runs in and the directory the agent is pointed at.
 *
 * `served` keeps that workspace under the directory the server was started in
 * (or, for a headless run, the notebook's own directory). `user` leaves it
 * wherever the notebook names, which is any path the account can already
 * reach. `roots` keeps it under the directories named here, and nowhere else.
 *
 * This is not a sandbox. A Bash Cell in an allowed workspace can still name
 * another path in its command. `user` is what a run did before this choice
 * existed, and it remains the way to ask for that.
 */
export type CellAccess =
  | { readonly kind: "served" }
  | { readonly kind: "user" }
  | { readonly kind: "roots"; readonly roots: readonly string[] };

/**
 * The access a caller asked for. `served` and `user` are the two named modes.
 * A list of directories is a range, and it has to name somewhere.
 */
export function cellAccess(setting: "served" | "user"): CellAccess;
export function cellAccess(roots: readonly string[]): CellAccess;
export function cellAccess(setting: "served" | "user" | readonly string[]): CellAccess {
  if (setting === "served" || setting === "user") return { kind: setting };
  if (setting.length === 0) throw new Error("A directory range needs at least one directory.");
  return { kind: "roots", roots: [...setting] };
}

/**
 * What `--cell-access` said, or nothing when it was not said. `served` and
 * `user` stand alone. Anything else is a directory, and the flag may name
 * more than one. Mixing a mode with a directory is a mistake, said here so
 * the command line and a caller report it the same way.
 */
export function cellAccessFrom(
  values: readonly string[],
): { readonly access: CellAccess } | { readonly problem: string } | undefined {
  if (values.length === 0) return undefined;
  const [only] = values;
  if (values.length === 1 && (only === "user" || only === "served")) {
    return { access: cellAccess(only) };
  }
  if (values.some((value) => value === "user" || value === "served")) {
    return {
      problem: "Pass --cell-access as served, as user, or as one or more directories, not mixed.",
    };
  }
  return { access: cellAccess(values) };
}

/**
 * Whether `candidate` is a workspace `access` allows, given the directory
 * `served` names when the mode is `served`. A workspace equal to an allowed
 * directory is inside it. `user` allows every path.
 */
export function cellAccessAllows(access: CellAccess, served: string, candidate: string): boolean {
  if (access.kind === "user") return true;
  const roots = (access.kind === "served" ? [served] : access.roots).map((root) => resolve(root));
  const path = resolve(candidate);
  return roots.some((root) => path === root || within(root, path));
}
