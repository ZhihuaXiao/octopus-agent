import { describe, expect, it } from "vitest";

import { type TrustQuestion, decideTrust } from "./trust.js";

/** A workspace with project resources and nothing decided about them. */
const asking = (question: Partial<TrustQuestion> = {}): TrustQuestion => ({
  workspace: "/work/service",
  recorded: null,
  standing: "ask",
  gated: true,
  ...question,
});

describe("decideTrust", () => {
  it("takes what the run was told, and records it for the next one", () => {
    expect(decideTrust(asking({ asked: true }))).toEqual({ ok: true, trusted: true, record: true });
  });

  it("records a refusal as readily as a grant", () => {
    expect(decideTrust(asking({ asked: false }))).toEqual({
      ok: true,
      trusted: false,
      record: true,
    });
  });

  it("prefers what this run was told over what was recorded before", () => {
    const decision = decideTrust(asking({ asked: false, recorded: true }));

    expect(decision).toEqual({ ok: true, trusted: false, record: true });
  });

  it("takes the recorded decision, which needs no recording again", () => {
    expect(decideTrust(asking({ recorded: true }))).toEqual({
      ok: true,
      trusted: true,
      record: false,
    });
  });

  it("takes a recorded refusal rather than asking again", () => {
    expect(decideTrust(asking({ recorded: false }))).toEqual({
      ok: true,
      trusted: false,
      record: false,
    });
  });

  it("needs no decision for a workspace with nothing to gate", () => {
    expect(decideTrust(asking({ gated: false }))).toEqual({
      ok: true,
      trusted: true,
      record: false,
    });
  });

  it("records nothing about a workspace it was told to trust but pi never gated", () => {
    expect(decideTrust(asking({ asked: true, gated: false }))).toMatchObject({ record: false });
  });

  it("takes a standing decision from pi's own settings", () => {
    expect(decideTrust(asking({ standing: "always" }))).toMatchObject({ trusted: true });
    expect(decideTrust(asking({ standing: "never" }))).toMatchObject({ trusted: false });
  });

  it("prefers what pi recorded for this workspace over a standing setting", () => {
    expect(decideTrust(asking({ recorded: false, standing: "always" }))).toMatchObject({
      trusted: false,
    });
  });

  it("refuses to guess, naming the workspace and how to decide it", () => {
    const decision = decideTrust(asking({ workspace: "/work/service" }));

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.problem).toContain("/work/service");
    expect(decision.problem).toContain("--trust");
    expect(decision.problem).toContain("--no-trust");
  });
});
