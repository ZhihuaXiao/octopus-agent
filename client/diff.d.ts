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

export function splitLines(text: string): string[];
export function joinLines(lines: readonly string[]): string;
export function diffLines(before: string, after: string): DiffRow[];
export function diffHunks(rows: readonly DiffRow[]): DiffHunk[];
export function applyDecision(
  before: string,
  after: string,
  decision: "accept" | "reject",
  lines?: readonly number[],
): DecisionResult;
