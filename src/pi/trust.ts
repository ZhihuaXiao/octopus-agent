/**
 * Whether a Run trusts the Workspace it operates on.
 *
 * Pi gates a project's own settings, skills and extensions behind a trust
 * decision, and in a non-interactive mode it never asks — it assumes no. A
 * headless Run would therefore load none of a Workspace's skills and say
 * nothing about it, which is the silently degraded environment the declared
 * environment exists to prevent. So the decision is made here, in the open,
 * and a Run with no way to make it stops rather than guessing.
 *
 * Nothing about it is a security control: pi ships no sandbox, and ADR-0006
 * says why nothing here pretends otherwise. It decides what pi loads, and the
 * reason to be strict is a wrong answer rather than a compromised machine.
 *
 * Pure, and separate from the pi call that supplies its inputs, because the
 * order these four things settle each other in is the whole decision.
 */

/** What is known about a Workspace when the question is put. */
export interface TrustQuestion {
  readonly workspace: string;
  /** What this Run was told on its command line, when it was told anything. */
  readonly asked?: boolean;
  /** What pi has recorded for this Workspace, or null when nothing. */
  readonly recorded: boolean | null;
  /** Pi's standing answer for workspaces with nothing recorded. */
  readonly standing: "ask" | "always" | "never";
  /** Whether the Workspace has anything pi gates behind trust at all. */
  readonly gated: boolean;
}

export type TrustDecision =
  | {
      readonly ok: true;
      readonly trusted: boolean;
      /** Whether pi should be told to remember this, for the next Run. */
      readonly record: boolean;
    }
  | { readonly ok: false; readonly problem: string };

export function decideTrust(question: TrustQuestion): TrustDecision {
  // What the Run was told wins, and is remembered — the way a Workspace stops
  // needing the flag is by having been run with it once. Remembered only when
  // there was something to gate, so an answer to a question pi never asked
  // leaves nothing behind in a store shared with pi's own command.
  if (question.asked !== undefined) {
    return { ok: true, trusted: question.asked, record: question.gated };
  }

  // A Workspace with no project resources has nothing for trust to gate, so
  // there is nothing to decide and nothing worth recording.
  if (!question.gated) return { ok: true, trusted: true, record: false };

  if (question.recorded !== null) {
    return { ok: true, trusted: question.recorded, record: false };
  }
  if (question.standing !== "ask") {
    return { ok: true, trusted: question.standing === "always", record: false };
  }

  return {
    ok: false,
    problem:
      `The workspace ${question.workspace} has project skills, settings or extensions that pi ` +
      `loads only for a workspace you trust, and nothing has decided whether to trust it. ` +
      `Run again with --trust or --no-trust, which is remembered.`,
  };
}
