import { isAbsolute, relative } from "node:path";

/**
 * Whether `inside` lies strictly under `directory`, both already resolved.
 *
 * The one check behind every path the server takes from a request — a
 * Notebook to open, a client file, a file of a Run — so that a climb out of
 * the directory, however it is spelt, is refused the same way everywhere.
 */
export function within(directory: string, inside: string): boolean {
  const between = relative(directory, inside);
  return between !== "" && !between.startsWith("..") && !isAbsolute(between);
}
