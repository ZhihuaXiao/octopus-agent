// @ts-check

/**
 * Line-by-line diffing, hunk extraction, and partial decision application
 * for text file reviews.
 */

/**
 * @typedef {{
 *   index: number,
 *   kind: "same" | "add" | "del",
 *   text: string,
 *   oldLine?: number,
 *   newLine?: number
 * }} DiffRow
 */

/**
 * @typedef {{
 *   hunkIndex: number,
 *   lineIndices: number[],
 *   oldStart: number,
 *   oldCount: number,
 *   newStart: number,
 *   newCount: number
 * }} DiffHunk
 */

/**
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  if (text === "") return [];
  return text.split("\n");
}

/**
 * @param {readonly string[]} lines
 * @returns {string}
 */
export function joinLines(lines) {
  if (lines.length === 0) return "";
  return lines.join("\n");
}

/**
 * Computes the longest common subsequence of two line slices.
 * @param {readonly string[]} older
 * @param {readonly string[]} newer
 * @returns {{ kind: "same" | "add" | "del", text: string }[]}
 */
function diffMiddle(older, newer) {
  const n = older.length;
  const m = newer.length;
  if (n === 0) return newer.map((text) => ({ kind: /** @type {const} */ ("add"), text }));
  if (m === 0) return older.map((text) => ({ kind: /** @type {const} */ ("del"), text }));

  /** @type {number[][]} */
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    const oLine = older[i - 1] ?? "";
    const prevRow = dp[i - 1];
    const currRow = dp[i];
    if (prevRow === undefined || currRow === undefined) continue;
    for (let j = 1; j <= m; j++) {
      if (oLine === newer[j - 1]) {
        currRow[j] = (prevRow[j - 1] ?? 0) + 1;
      } else {
        const left = currRow[j - 1] ?? 0;
        const up = prevRow[j] ?? 0;
        currRow[j] = left > up ? left : up;
      }
    }
  }

  /** @type {{ kind: "same" | "add" | "del", text: string }[]} */
  const result = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    const iRow = dp[i];
    const prevRow = dp[i - 1];
    if (i > 0 && j > 0 && older[i - 1] === newer[j - 1]) {
      result.push({ kind: "same", text: older[i - 1] ?? "" });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || (iRow?.[j - 1] ?? 0) >= (prevRow?.[j] ?? 0))) {
      result.push({ kind: "add", text: newer[j - 1] ?? "" });
      j--;
    } else {
      result.push({ kind: "del", text: older[i - 1] ?? "" });
      i--;
    }
  }

  result.reverse();
  return result;
}

/**
 * Produces diff rows comparing before and after texts line by line.
 * @param {string} before
 * @param {string} after
 * @returns {DiffRow[]}
 */
export function diffLines(before, after) {
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

  /** @type {{ kind: "same" | "add" | "del", text: string }[]} */
  const rawRows = [];

  for (let index = 0; index < start; index++) {
    rawRows.push({ kind: "same", text: older[index] ?? "" });
  }

  const midOlder = older.slice(start, endOlder + 1);
  const midNewer = newer.slice(start, endNewer + 1);
  const middle = diffMiddle(midOlder, midNewer);
  for (const row of middle) {
    rawRows.push(row);
  }

  for (let index = endOlder + 1; index < older.length; index++) {
    rawRows.push({ kind: "same", text: older[index] ?? "" });
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
 * @param {readonly DiffRow[]} rows
 * @returns {DiffHunk[]}
 */
export function diffHunks(rows) {
  /** @type {DiffHunk[]} */
  const hunks = [];
  /** @type {number[]} */
  let currentChangeIndices = [];
  let hunkIndex = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    if (row.kind !== "same") {
      currentChangeIndices.push(row.index);
    } else if (currentChangeIndices.length > 0) {
      const firstIdx = currentChangeIndices[0];
      const firstRow = firstIdx !== undefined ? rows[firstIdx] : undefined;
      const delRows = currentChangeIndices.map((idx) => rows[idx]).filter((r) => r?.kind === "del");
      const addRows = currentChangeIndices.map((idx) => rows[idx]).filter((r) => r?.kind === "add");

      const oldStart = delRows[0]?.oldLine ?? firstRow?.oldLine ?? 1;
      const newStart = addRows[0]?.newLine ?? firstRow?.newLine ?? 1;

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
    const firstIdx = currentChangeIndices[0];
    const firstRow = firstIdx !== undefined ? rows[firstIdx] : undefined;
    const delRows = currentChangeIndices.map((idx) => rows[idx]).filter((r) => r?.kind === "del");
    const addRows = currentChangeIndices.map((idx) => rows[idx]).filter((r) => r?.kind === "add");

    const oldStart = delRows[0]?.oldLine ?? firstRow?.oldLine ?? 1;
    const newStart = addRows[0]?.newLine ?? firstRow?.newLine ?? 1;

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
 * @param {string} before
 * @param {string} after
 * @param {"accept" | "reject"} decision
 * @param {readonly number[]} [lines]
 * @returns {{ newBefore: string, newAfter: string, resolved: boolean }}
 */
export function applyDecision(before, after, decision, lines) {
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
    const row = rows[idx];
    if (row === undefined || row.kind === "same") {
      throw new Error(`Cannot decide unchanged line at index ${idx}.`);
    }
  }

  /** @type {string[]} */
  const newAfterLines = [];
  /** @type {string[]} */
  const newBeforeLines = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
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
