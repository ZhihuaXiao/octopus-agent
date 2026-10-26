/**
 * Line-by-line diffing, hunk extraction, and partial decision application
 * for text file reviews.
 */

export interface DiffRow {
  readonly index: number;
  readonly kind: "same" | "add" | "del";
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface DiffHunk {
  readonly hunkIndex: number;
  readonly lineIndices: readonly number[];
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

export interface DecisionResult {
  readonly newBefore: string;
  readonly newAfter: string;
  readonly resolved: boolean;
}

export function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split("\n");
}

export function joinLines(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return lines.join("\n");
}

/**
 * Computes the longest common subsequence of two line slices.
 */
function diffMiddle(
  older: readonly string[],
  newer: readonly string[],
): { kind: "same" | "add" | "del"; text: string }[] {
  const n = older.length;
  const m = newer.length;
  if (n === 0) return newer.map((text) => ({ kind: "add", text }));
  if (m === 0) return older.map((text) => ({ kind: "del", text }));

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    const oLine = older[i - 1]!;
    const prevRow = dp[i - 1]!;
    const currRow = dp[i]!;
    for (let j = 1; j <= m; j++) {
      if (oLine === newer[j - 1]!) {
        currRow[j] = prevRow[j - 1]! + 1;
      } else {
        const left = currRow[j - 1]!;
        const up = prevRow[j]!;
        currRow[j] = left > up ? left : up;
      }
    }
  }

  const result: { kind: "same" | "add" | "del"; text: string }[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && older[i - 1]! === newer[j - 1]!) {
      result.push({ kind: "same", text: older[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.push({ kind: "add", text: newer[j - 1]! });
      j--;
    } else {
      result.push({ kind: "del", text: older[i - 1]! });
      i--;
    }
  }

  result.reverse();
  return result;
}

/**
 * Produces diff rows comparing before and after texts line by line.
 */
export function diffLines(before: string, after: string): DiffRow[] {
  const older = splitLines(before);
  const newer = splitLines(after);

  let start = 0;
  while (start < older.length && start < newer.length && older[start] === newer[start]) {
    start++;
  }

  let endOlder = older.length - 1;
  let endNewer = newer.length - 1;
  while (endOlder >= start && endNewer >= start && older[endOlder] === newer[endNewer]) {
    endOlder--;
    endNewer--;
  }

  const rawRows: { kind: "same" | "add" | "del"; text: string }[] = [];

  for (let index = 0; index < start; index++) {
    rawRows.push({ kind: "same", text: older[index]! });
  }

  const midOlder = older.slice(start, endOlder + 1);
  const midNewer = newer.slice(start, endNewer + 1);
  const middle = diffMiddle(midOlder, midNewer);
  for (const row of middle) {
    rawRows.push(row);
  }

  for (let index = endOlder + 1; index < older.length; index++) {
    rawRows.push({ kind: "same", text: older[index]! });
  }

  let oldLine = 1;
  let newLine = 1;
  return rawRows.map((row, index) => {
    if (row.kind === "same") {
      return { index, kind: row.kind, text: row.text, oldLine: oldLine++, newLine: newLine++ };
    } else if (row.kind === "del") {
      return { index, kind: row.kind, text: row.text, oldLine: oldLine++ };
    } else {
      return { index, kind: row.kind, text: row.text, newLine: newLine++ };
    }
  });
}

/**
 * Groups consecutive change lines into hunks.
 */
export function diffHunks(rows: readonly DiffRow[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentChangeIndices: number[] = [];
  let hunkIndex = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.kind !== "same") {
      currentChangeIndices.push(row.index);
    } else if (currentChangeIndices.length > 0) {
      const firstRow = rows[currentChangeIndices[0]!]!;
      const delRows = currentChangeIndices.map((idx) => rows[idx]!).filter((r) => r.kind === "del");
      const addRows = currentChangeIndices.map((idx) => rows[idx]!).filter((r) => r.kind === "add");

      const oldStart = delRows[0]?.oldLine ?? firstRow.oldLine ?? 1;
      const newStart = addRows[0]?.newLine ?? firstRow.newLine ?? 1;

      hunks.push({
        hunkIndex: hunkIndex++,
        lineIndices: currentChangeIndices,
        oldStart,
        oldCount: delRows.length,
        newStart,
        newCount: addRows.length,
      });
      currentChangeIndices = [];
    }
  }

  if (currentChangeIndices.length > 0) {
    const firstRow = rows[currentChangeIndices[0]!]!;
    const delRows = currentChangeIndices.map((idx) => rows[idx]!).filter((r) => r.kind === "del");
    const addRows = currentChangeIndices.map((idx) => rows[idx]!).filter((r) => r.kind === "add");

    const oldStart = delRows[0]?.oldLine ?? firstRow.oldLine ?? 1;
    const newStart = addRows[0]?.newLine ?? firstRow.newLine ?? 1;

    hunks.push({
      hunkIndex: hunkIndex++,
      lineIndices: currentChangeIndices,
      oldStart,
      oldCount: delRows.length,
      newStart,
      newCount: addRows.length,
    });
  }

  return hunks;
}

/**
 * Applies a decision ("accept" or "reject") to whole file or specific diff lines.
 *
 * Accepting an addition incorporates it into baseline (newBefore gains the line).
 * Accepting a deletion removes it from baseline (newBefore drops the line).
 * Rejecting an addition reverts disk (newAfter drops the line).
 * Rejecting a deletion restores disk (newAfter gains the line).
 */
export function applyDecision(
  before: string,
  after: string,
  decision: "accept" | "reject",
  lines?: readonly number[],
): DecisionResult {
  if (lines === undefined) {
    if (decision === "accept") {
      return { newBefore: after, newAfter: after, resolved: true };
    } else {
      return { newBefore: before, newAfter: before, resolved: true };
    }
  }

  const rows = diffLines(before, after);
  const selected = new Set(lines);

  for (const idx of selected) {
    if (idx < 0 || idx >= rows.length) {
      throw new Error(`Line index ${idx} out of range [0, ${rows.length - 1}].`);
    }
    const row = rows[idx]!;
    if (row.kind === "same") {
      throw new Error(`Cannot decide unchanged line at index ${idx}.`);
    }
  }

  const newAfterLines: string[] = [];
  const newBeforeLines: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const isSelected = selected.has(i);

    if (row.kind === "same") {
      newAfterLines.push(row.text);
      newBeforeLines.push(row.text);
    } else if (row.kind === "add") {
      if (!(decision === "reject" && isSelected)) {
        newAfterLines.push(row.text);
      }
      if (decision === "accept" && isSelected) {
        newBeforeLines.push(row.text);
      }
    } else if (row.kind === "del") {
      if (decision === "reject" && isSelected) {
        newAfterLines.push(row.text);
      }
      if (!(decision === "accept" && isSelected)) {
        newBeforeLines.push(row.text);
      }
    }
  }

  const newAfter = joinLines(newAfterLines);
  const newBefore = joinLines(newBeforeLines);

  return {
    newBefore,
    newAfter,
    resolved: newBefore === newAfter,
  };
}
