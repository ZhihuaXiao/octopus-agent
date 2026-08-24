/**
 * Narrowing helpers for values coming out of pi.
 *
 * Pi's event and message unions are large and move between releases, so we
 * narrow the few fields we depend on rather than typing against all of them.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
