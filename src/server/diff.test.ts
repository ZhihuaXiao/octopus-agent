import { describe, expect, it } from "vitest";
import {
  applyDecision as clientApplyDecision,
  diffHunks as clientDiffHunks,
  diffLines as clientDiffLines,
} from "../../client/diff.js";
import { applyDecision, diffHunks, diffLines, joinLines, splitLines } from "./diff.js";

describe("splitLines and joinLines", () => {
  it("handles empty string", () => {
    expect(splitLines("")).toEqual([]);
    expect(joinLines([])).toBe("");
  });

  it("handles single line without newline", () => {
    expect(splitLines("hello")).toEqual(["hello"]);
    expect(joinLines(["hello"])).toBe("hello");
  });

  it("handles single line with newline", () => {
    expect(splitLines("hello\n")).toEqual(["hello", ""]);
    expect(joinLines(["hello", ""])).toBe("hello\n");
  });

  it("handles multiple lines", () => {
    expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
    expect(joinLines(["a", "b", "c"])).toBe("a\nb\nc");
  });
});

describe("diffLines", () => {
  it("reports same for identical texts", () => {
    const text = "alpha\nbeta\ngamma\n";
    const rows = diffLines(text, text);
    expect(rows.every((r) => r.kind === "same")).toBe(true);
    expect(rows.map((r) => r.text)).toEqual(["alpha", "beta", "gamma", ""]);
  });

  it("detects single line modification", () => {
    const before = "alpha\nbeta\ngamma\n";
    const after = "alpha\nBETA\ngamma\n";
    const rows = diffLines(before, after);
    expect(rows).toEqual([
      { index: 0, kind: "same", text: "alpha", oldLine: 1, newLine: 1 },
      { index: 1, kind: "del", text: "beta", oldLine: 2 },
      { index: 2, kind: "add", text: "BETA", newLine: 2 },
      { index: 3, kind: "same", text: "gamma", oldLine: 3, newLine: 3 },
      { index: 4, kind: "same", text: "", oldLine: 4, newLine: 4 },
    ]);
  });

  it("detects added line", () => {
    const before = "alpha\ngamma\n";
    const after = "alpha\nbeta\ngamma\n";
    const rows = diffLines(before, after);
    expect(rows).toEqual([
      { index: 0, kind: "same", text: "alpha", oldLine: 1, newLine: 1 },
      { index: 1, kind: "add", text: "beta", newLine: 2 },
      { index: 2, kind: "same", text: "gamma", oldLine: 2, newLine: 3 },
      { index: 3, kind: "same", text: "", oldLine: 3, newLine: 4 },
    ]);
  });

  it("detects deleted line", () => {
    const before = "alpha\nbeta\ngamma\n";
    const after = "alpha\ngamma\n";
    const rows = diffLines(before, after);
    expect(rows).toEqual([
      { index: 0, kind: "same", text: "alpha", oldLine: 1, newLine: 1 },
      { index: 1, kind: "del", text: "beta", oldLine: 2 },
      { index: 2, kind: "same", text: "gamma", oldLine: 3, newLine: 2 },
      { index: 3, kind: "same", text: "", oldLine: 4, newLine: 3 },
    ]);
  });

  it("separates multiple disjoint changes with unchanged lines", () => {
    const before = "one\ntwo\nthree\nfour\nfive\n";
    const after = "one\nTWO\nthree\nFOUR\nfive\n";
    const rows = diffLines(before, after);
    expect(rows.map((r) => [r.kind, r.text])).toEqual([
      ["same", "one"],
      ["del", "two"],
      ["add", "TWO"],
      ["same", "three"],
      ["del", "four"],
      ["add", "FOUR"],
      ["same", "five"],
      ["same", ""],
    ]);
  });
});

describe("diffHunks", () => {
  it("groups consecutive changes into a hunk", () => {
    const before = "one\ntwo\nthree\nfour\nfive\n";
    const after = "one\nTWO\nthree\nFOUR\nfive\n";
    const rows = diffLines(before, after);
    const hunks = diffHunks(rows);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toEqual({
      hunkIndex: 0,
      lineIndices: [1, 2],
      oldStart: 2,
      oldCount: 1,
      newStart: 2,
      newCount: 1,
    });
    expect(hunks[1]).toEqual({
      hunkIndex: 1,
      lineIndices: [4, 5],
      oldStart: 4,
      oldCount: 1,
      newStart: 4,
      newCount: 1,
    });
  });
});

describe("applyDecision", () => {
  const before = "one\ntwo\nthree\nfour\n";
  const after = "one\nTWO\nthree\nFOUR\n";

  it("accepts entire file when lines is undefined", () => {
    const result = applyDecision(before, after, "accept");
    expect(result.resolved).toBe(true);
    expect(result.newAfter).toBe(after);
    expect(result.newBefore).toBe(after);
  });

  it("rejects entire file when lines is undefined", () => {
    const result = applyDecision(before, after, "reject");
    expect(result.resolved).toBe(true);
    expect(result.newAfter).toBe(before);
    expect(result.newBefore).toBe(before);
  });

  it("rejects one hunk/lines, restoring only those lines on disk", () => {
    // diff rows:
    // 0: same one
    // 1: del two
    // 2: add TWO
    // 3: same three
    // 4: del four
    // 5: add FOUR
    // 6: same ""
    // Reject lines [1, 2] (the change from two -> TWO)
    const result = applyDecision(before, after, "reject", [1, 2]);
    expect(result.resolved).toBe(false);
    expect(result.newAfter).toBe("one\ntwo\nthree\nFOUR\n");
    expect(result.newBefore).toBe("one\ntwo\nthree\nfour\n");

    // Remaining diff between newBefore and newAfter should only be four -> FOUR
    const remaining = diffLines(result.newBefore, result.newAfter);
    const changes = remaining.filter((r) => r.kind !== "same");
    expect(changes.map((r) => [r.kind, r.text])).toEqual([
      ["del", "four"],
      ["add", "FOUR"],
    ]);
  });

  it("accepts one hunk/lines, incorporating only those lines into baseline", () => {
    // Accept lines [1, 2] (the change from two -> TWO)
    const result = applyDecision(before, after, "accept", [1, 2]);
    expect(result.resolved).toBe(false);
    expect(result.newAfter).toBe(after); // disk unchanged on accept
    expect(result.newBefore).toBe("one\nTWO\nthree\nfour\n"); // baseline incorporated TWO

    // Remaining diff between newBefore and newAfter should only be four -> FOUR
    const remaining = diffLines(result.newBefore, result.newAfter);
    const changes = remaining.filter((r) => r.kind !== "same");
    expect(changes.map((r) => [r.kind, r.text])).toEqual([
      ["del", "four"],
      ["add", "FOUR"],
    ]);
  });

  it("resolves the review when all remaining lines are decided", () => {
    // Step 1: reject lines [1, 2]
    const step1 = applyDecision(before, after, "reject", [1, 2]);
    expect(step1.resolved).toBe(false);

    // Step 2: accept the remaining change [4, 5] from step 1's state
    const remaining = diffLines(step1.newBefore, step1.newAfter);
    const remainingIndices = remaining.filter((r) => r.kind !== "same").map((r) => r.index);
    const step2 = applyDecision(step1.newBefore, step1.newAfter, "accept", remainingIndices);

    expect(step2.resolved).toBe(true);
    expect(step2.newAfter).toBe("one\ntwo\nthree\nFOUR\n");
    expect(step2.newBefore).toBe("one\ntwo\nthree\nFOUR\n");
  });

  it("throws when line index is out of bounds", () => {
    expect(() => applyDecision(before, after, "accept", [999])).toThrow(/out of range/);
  });

  it("throws when attempting to decide a same line", () => {
    expect(() => applyDecision(before, after, "accept", [0])).toThrow(/unchanged line/);
  });

  it("produces identical results between client/diff.js and src/server/diff.ts", () => {
    const b = "first\nsecond\nthird\nfourth\n";
    const a = "first\nSECOND\nthird\nFOURTH\nfifth\n";
    const serverRows = diffLines(b, a);
    const clientRows = clientDiffLines(b, a);
    expect(clientRows).toEqual(serverRows);

    const serverHunks = diffHunks(serverRows);
    const clientHunks = clientDiffHunks(clientRows);
    expect(clientHunks).toEqual(serverHunks);

    expect(clientApplyDecision(b, a, "reject", [1, 2])).toEqual(
      applyDecision(b, a, "reject", [1, 2]),
    );
    expect(clientApplyDecision(b, a, "accept", [1, 2])).toEqual(
      applyDecision(b, a, "accept", [1, 2]),
    );
  });
});
