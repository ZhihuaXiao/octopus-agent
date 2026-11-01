import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorkspaceReview, type WorkspaceReview } from "./review.js";

describe("WorkspaceReview", () => {
  let tempDir: string;
  let review: WorkspaceReview;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "octo-review-test-"));
    review = createWorkspaceReview(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("takes baseline and detects created and modified files on publish", async () => {
    // Initial file
    await writeFile(join(tempDir, "existing.txt"), "line 1\nline 2\n", "utf8");
    await review.takeBaseline();

    // No changes yet
    const initialPublish = await review.publish();
    expect(initialPublish.changed).toBe(false);
    expect(initialPublish.reviews).toEqual([]);

    // Modify existing file and create new file
    await writeFile(join(tempDir, "existing.txt"), "line 1\nline 2 modified\n", "utf8");
    await writeFile(join(tempDir, "new.txt"), "brand new\n", "utf8");

    const afterChanges = await review.publish();
    expect(afterChanges.changed).toBe(true);
    expect(afterChanges.reviews).toEqual([
      { path: "existing.txt", kind: "modified", before: "line 1\nline 2\n" },
      { path: "new.txt", kind: "created" },
    ]);
    expect(review.snapshot()).toEqual(afterChanges.reviews);
  });

  it("accepts a full file modification", async () => {
    await writeFile(join(tempDir, "file.txt"), "before\n", "utf8");
    await review.takeBaseline();
    await writeFile(join(tempDir, "file.txt"), "after\n", "utf8");
    await review.publish();

    const decision = await review.decide("file.txt", "accept");
    expect(decision.kind).toBe("decided");
    if (decision.kind !== "decided") throw new Error("Expected decided");
    expect(decision.changed).toBe(true);
    expect(decision.reviews).toEqual([]);
    expect(review.snapshot()).toEqual([]);

    // File on disk remains 'after'
    const content = await readFile(join(tempDir, "file.txt"), "utf8");
    expect(content).toBe("after\n");
  });

  it("rejects a modified file and reverts to baseline", async () => {
    await writeFile(join(tempDir, "file.txt"), "original\n", "utf8");
    await review.takeBaseline();
    await writeFile(join(tempDir, "file.txt"), "modified\n", "utf8");
    await review.publish();

    const decision = await review.decide("file.txt", "reject");
    expect(decision.kind).toBe("decided");
    if (decision.kind !== "decided") throw new Error("Expected decided");
    expect(decision.changed).toBe(true);
    expect(decision.reviews).toEqual([]);
    expect(review.snapshot()).toEqual([]);

    // File on disk is reverted to original
    const content = await readFile(join(tempDir, "file.txt"), "utf8");
    expect(content).toBe("original\n");
  });

  it("rejects a created file and removes it from disk", async () => {
    await review.takeBaseline();
    await writeFile(join(tempDir, "created.txt"), "content\n", "utf8");
    await review.publish();

    const decision = await review.decide("created.txt", "reject");
    expect(decision.kind).toBe("decided");
    if (decision.kind !== "decided") throw new Error("Expected decided");
    expect(decision.changed).toBe(true);
    expect(decision.reviews).toEqual([]);

    // File should no longer exist
    await expect(readFile(join(tempDir, "created.txt"), "utf8")).rejects.toThrow();
  });

  it("supports partial line-level decisions", async () => {
    await writeFile(join(tempDir, "lines.txt"), "one\ntwo\nthree\nfour\n", "utf8");
    await review.takeBaseline();
    await writeFile(join(tempDir, "lines.txt"), "one\nTWO\nthree\nFOUR\n", "utf8");
    await review.publish();

    // Reject lines [1, 2] (the change from two -> TWO)
    const partial = await review.decide("lines.txt", "reject", [1, 2]);
    expect(partial.kind).toBe("decided");
    if (partial.kind !== "decided") throw new Error("Expected decided");
    expect(partial.changed).toBe(true);
    // Review remains open for remaining change (four -> FOUR)
    expect(review.snapshot().length).toBe(1);
    expect(review.snapshot()[0]?.path).toBe("lines.txt");

    // File on disk should now have 'two' reverted, but 'FOUR' kept
    const content = await readFile(join(tempDir, "lines.txt"), "utf8");
    expect(content).toBe("one\ntwo\nthree\nFOUR\n");
  });

  it("refuses decision when validator rejects candidate text", async () => {
    await writeFile(join(tempDir, "doc.txt"), "valid\n", "utf8");
    await review.takeBaseline();
    await writeFile(join(tempDir, "doc.txt"), "invalid content\n", "utf8");
    await review.publish();

    const result = await review.decide("doc.txt", "accept", undefined, (text) =>
      text.includes("invalid") ? { ok: false, problem: "Corrupted text" } : { ok: true },
    );

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.problem).toBe("Corrupted text");
    }
    // Review stays open
    expect(review.snapshot().length).toBe(1);
  });

  it("retargets review on file rename and forgets on removal", async () => {
    await writeFile(join(tempDir, "old.txt"), "foo\n", "utf8");
    await review.takeBaseline();
    await writeFile(join(tempDir, "old.txt"), "foo modified\n", "utf8");
    await review.publish();

    expect(review.snapshot()[0]?.path).toBe("old.txt");

    const retargetResult = await review.retarget("old.txt", "new.txt");
    expect(retargetResult.changed).toBe(true);
    expect(retargetResult.reviews[0]?.path).toBe("new.txt");

    const forgetResult = await review.forget("new.txt");
    expect(forgetResult.changed).toBe(true);
    expect(forgetResult.reviews).toEqual([]);
    expect(review.snapshot()).toEqual([]);
  });

  it("restores review state accurately", () => {
    const list = [{ path: "test.md", kind: "created" as const }];
    review.restore(list);
    expect(review.snapshot()).toEqual(list);
  });
});
