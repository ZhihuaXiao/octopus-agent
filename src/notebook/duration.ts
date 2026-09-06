/**
 * Durations as a Notebook writes them: a number and a unit, `30s` or `5m`.
 *
 * A unit is required rather than assumed, because a bare `30` reads as seconds
 * to one author and milliseconds to another, and a timeout is the wrong place
 * to be off by a thousand.
 */

const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

/**
 * The longest duration a timer can hold, which is Node's own bound: a longer
 * one is quietly clamped to a millisecond, and a Cell allowed a month would
 * time out at once.
 */
const LONGEST = 2 ** 31 - 1;

export const DURATION_RULE = "must be a duration such as 30s, 5m or 1h, and under 25 days";

/**
 * Reads a duration to a whole number of milliseconds, or nothing when the text
 * is not one: no unit, no time at all, a fraction of a millisecond, or longer
 * than a timer can hold.
 */
export function parseDuration(text: string): number | undefined {
  const match = DURATION.exec(text.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof UNITS;
  const milliseconds = amount * UNITS[unit];
  const whole = Number.isInteger(milliseconds) && milliseconds >= 1 && milliseconds <= LONGEST;
  return whole ? milliseconds : undefined;
}

/** Writes milliseconds back in the largest unit that says it exactly. */
export function formatDuration(milliseconds: number): string {
  for (const unit of ["h", "m", "s"] as const) {
    if (milliseconds % UNITS[unit] === 0) return `${milliseconds / UNITS[unit]}${unit}`;
  }
  return `${milliseconds}ms`;
}
