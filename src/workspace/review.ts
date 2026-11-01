/**
 * Workspace Review: tracks text file modifications relative to a baseline taken
 * before a Run, computes line-by-line diffs, and applies partial or complete
 * decisions (accept / reject) to resolve reviews.
 *
 * Scoped per Notebook Session run lifecycle, with internal serialization so
 * concurrent file inspections and decision writes never race.
 */

import { parseNotebook } from "../notebook/notebook.js";
import { applyDecision } from "./diff.js";
import {
  type ReadText,
  type TextReview,
  type WrittenText,
  baselineUnder,
  isTextFile,
  readTextFile,
  readTextFiles,
  revertText,
  reviewsBetween,
  textPath,
  writeTextFile,
} from "./text-files.js";

export type { TextReview };

export interface ReviewDecisionResult {
  readonly kind: "decided" | "invalid" | "absent";
  readonly changed: boolean;
  readonly reviews: readonly TextReview[];
  readonly newText?: string | undefined;
}

export interface WorkspaceReview {
  /** The directory this review is observing. */
  readonly directory: string;
  /** Restores the review list, e.g. from journal replay. */
  restore(reviews: readonly TextReview[]): void;
  /** The current active reviews, sorted by path. */
  snapshot(): readonly TextReview[];
  /** Captures the current text files on disk as the baseline for an upcoming run. */
  takeBaseline(): Promise<void>;
  /** Compares current disk against baseline and returns the new review list if changed. */
  publish(): Promise<{ changed: boolean; reviews: readonly TextReview[] }>;
  /**
   * Applies an accept or reject decision to a reviewed text file.
   * If validateNewText is provided, it can reject the decision before disk/state changes.
   */
  decide(
    name: string,
    decision: "accept" | "reject",
    lines?: readonly number[],
    validateNewText?: (newText: string) => { ok: true } | { ok: false; problem: string },
  ): Promise<ReviewDecisionResult | { kind: "refused"; problem: string }>;
  /** Retargets a review and its baseline entry when a file is renamed. */
  retarget(from: string, to: string): Promise<{ changed: boolean; reviews: readonly TextReview[] }>;
  /** Forgets a review and its baseline entry when a file is removed. */
  forget(name: string): Promise<{ changed: boolean; reviews: readonly TextReview[] }>;
}

const sameReviewList = (a: readonly TextReview[], b: readonly TextReview[]): boolean =>
  a.length === b.length &&
  a.every((review, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      review.path === other.path &&
      review.kind === other.kind &&
      review.before === other.before
    );
  });

export function createWorkspaceReview(directory: string): WorkspaceReview {
  let baseline: Map<string, string> | undefined;
  let reviews = new Map<string, TextReview>();
  let lock: Promise<unknown> = Promise.resolve();

  const withLock = <T>(work: () => Promise<T>): Promise<T> => {
    const run = lock.then(work, work);
    lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const listedReviews = (): TextReview[] =>
    [...reviews.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    directory,

    restore(restored: readonly TextReview[]): void {
      reviews = new Map(restored.map((review) => [review.path, review]));
    },

    snapshot(): readonly TextReview[] {
      return listedReviews();
    },

    takeBaseline(): Promise<void> {
      return withLock(async () => {
        baseline = baselineUnder(await readTextFiles(directory), listedReviews());
      });
    },

    publish(): Promise<{ changed: boolean; reviews: readonly TextReview[] }> {
      return withLock(async () => {
        if (baseline === undefined) {
          return { changed: false, reviews: listedReviews() };
        }
        const next = reviewsBetween(baseline, await readTextFiles(directory));
        const current = listedReviews();
        if (sameReviewList(current, next)) {
          return { changed: false, reviews: current };
        }
        reviews = new Map(next.map((review) => [review.path, review]));
        return { changed: true, reviews: next };
      });
    },

    decide(
      name: string,
      decision: "accept" | "reject",
      lines?: readonly number[],
      validateNewText?: (newText: string) => { ok: true } | { ok: false; problem: string },
    ): Promise<ReviewDecisionResult | { kind: "refused"; problem: string }> {
      return withLock(async () => {
        const named = textPath(directory, name);
        if (named === undefined) {
          return { kind: "invalid", changed: false, reviews: listedReviews() };
        }
        const review = reviews.get(named);
        if (review === undefined) {
          return { kind: "absent", changed: false, reviews: listedReviews() };
        }

        if (lines !== undefined) {
          const read = await readTextFile(directory, named);
          if (read.kind !== "text") {
            return { kind: "invalid", changed: false, reviews: listedReviews() };
          }
          const diskText = read.text;
          const beforeText = review.before ?? "";

          let applied;
          try {
            applied = applyDecision(beforeText, diskText, decision, lines);
          } catch {
            return { kind: "invalid", changed: false, reviews: listedReviews() };
          }

          if (validateNewText !== undefined) {
            const check = validateNewText(applied.newAfter);
            if (!check.ok) {
              return { kind: "refused", problem: check.problem };
            }
          }

          if (applied.newAfter !== diskText) {
            const written = await writeTextFile(directory, named, applied.newAfter);
            if (written.kind !== "saved") {
              return { kind: "invalid", changed: false, reviews: listedReviews() };
            }
          }

          if (applied.resolved) {
            reviews.delete(named);
            if (baseline !== undefined) {
              if (decision === "reject" && review.kind === "created" && applied.newAfter === "") {
                baseline.delete(named);
                await revertText(directory, review);
              } else {
                baseline.set(named, applied.newAfter);
              }
            }
          } else {
            reviews.set(named, { path: named, kind: "modified", before: applied.newBefore });
            if (baseline !== undefined) {
              baseline.set(named, applied.newBefore);
            }
          }

          return {
            kind: "decided",
            changed: true,
            reviews: listedReviews(),
            newText: applied.newAfter,
          };
        }

        // Full file decision
        let newTextForValidation: string | undefined;
        if (decision === "accept") {
          const read = await readTextFile(directory, named);
          if (read.kind === "text") newTextForValidation = read.text;
        } else if (decision === "reject") {
          newTextForValidation = review.kind === "created" ? undefined : review.before;
        }

        if (validateNewText !== undefined && newTextForValidation !== undefined) {
          const check = validateNewText(newTextForValidation);
          if (!check.ok) {
            return { kind: "refused", problem: check.problem };
          }
        }

        if (decision === "reject") {
          const reverted = await revertText(directory, review);
          if (reverted === "invalid") {
            return { kind: "invalid", changed: false, reviews: listedReviews() };
          }
        }

        if (baseline !== undefined) {
          if (decision === "accept") {
            const read = await readTextFile(directory, named);
            if (read.kind === "text") baseline.set(named, read.text);
            else baseline.delete(named);
          } else if (review.kind === "created") {
            baseline.delete(named);
          } else if (review.before !== undefined) {
            baseline.set(named, review.before);
          }
        }
        reviews.delete(named);

        return {
          kind: "decided",
          changed: true,
          reviews: listedReviews(),
          newText: newTextForValidation,
        };
      });
    },

    retarget(
      from: string,
      to: string,
    ): Promise<{ changed: boolean; reviews: readonly TextReview[] }> {
      return withLock(async () => {
        const review = reviews.get(from);
        if (review !== undefined) {
          reviews.delete(from);
          if (isTextFile(to)) reviews.set(to, { ...review, path: to });
        }
        if (baseline !== undefined && baseline.has(from)) {
          const bytes = baseline.get(from);
          baseline.delete(from);
          if (bytes !== undefined && isTextFile(to)) baseline.set(to, bytes);
        }
        if (review !== undefined) {
          return { changed: true, reviews: listedReviews() };
        }
        return { changed: false, reviews: listedReviews() };
      });
    },

    forget(name: string): Promise<{ changed: boolean; reviews: readonly TextReview[] }> {
      return withLock(async () => {
        const review = reviews.get(name);
        baseline?.delete(name);
        if (review === undefined) {
          return { changed: false, reviews: listedReviews() };
        }
        reviews.delete(name);
        return { changed: true, reviews: listedReviews() };
      });
    },
  };
}
