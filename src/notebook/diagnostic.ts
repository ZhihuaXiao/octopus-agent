/**
 * Problems found while reading a Notebook.
 *
 * Reported rather than thrown, so an author can be shown everything wrong with
 * their Notebook at once instead of only whatever went wrong first.
 */

export interface Diagnostic {
  /** The 1-based line of the Notebook the problem is on. */
  readonly line: number;
  readonly message: string;
}

/** Renders diagnostics for a caller that reports them as a single error. */
export function formatDiagnostics(errors: readonly Diagnostic[]): string {
  return errors.map((error) => `line ${error.line}: ${error.message}`).join("\n");
}

/**
 * How many lines past the start of `text` the character at `offset` sits, so a
 * problem found in a fragment can be reported against the whole Notebook.
 */
export function lineOffset(text: string, offset: number): number {
  let count = 0;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") count += 1;
  }
  return count;
}
