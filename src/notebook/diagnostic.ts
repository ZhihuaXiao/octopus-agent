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
