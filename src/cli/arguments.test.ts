import { describe, expect, it } from "vitest";

import { readArguments } from "./arguments.js";

/** Reads arguments the test expects to be well-formed, reporting why if not. */
function valid(argv: readonly string[]) {
  const result = readArguments(argv);
  if (!result.ok) throw new Error(`expected well-formed arguments, got: ${result.error}`);
  return result;
}

/** The complaint about arguments the test expects to be rejected. */
function rejected(argv: readonly string[]): string {
  const result = readArguments(argv);
  if (result.ok) throw new Error("expected the arguments to be rejected");
  return result.error;
}

describe("reading command line arguments", () => {
  it("reads the notebook to run", () => {
    expect(valid(["audit.md"])).toEqual({ ok: true, notebook: "audit.md", inputs: {} });
  });

  it("reads an input value written after its name", () => {
    expect(valid(["audit.md", "--target", "docs"]).inputs).toEqual({ target: "docs" });
  });

  it("reads an input value written with an equals sign", () => {
    expect(valid(["audit.md", "--target=docs"]).inputs).toEqual({ target: "docs" });
  });

  it("reads a value that would otherwise look like an option", () => {
    expect(valid(["audit.md", "--flags=--verbose"]).inputs).toEqual({ flags: "--verbose" });
  });

  it("reads a negative number as the value it looks like", () => {
    expect(valid(["audit.md", "--offset", "-1"]).inputs).toEqual({ offset: "-1" });
  });

  it("reads inputs written before the notebook", () => {
    expect(valid(["--target", "docs", "audit.md"])).toEqual({
      ok: true,
      notebook: "audit.md",
      inputs: { target: "docs" },
    });
  });

  it("reports no notebook to run", () => {
    expect(rejected(["--target", "docs"])).toContain("usage");
  });

  it("reports a second notebook, which is more likely a stray argument", () => {
    expect(rejected(["audit.md", "review.md"])).toContain('"review.md"');
  });

  it("reports an input with no value after it", () => {
    expect(rejected(["audit.md", "--target"])).toContain('"--target" needs a value');
  });

  it("reports an input followed by another option rather than its value", () => {
    expect(rejected(["audit.md", "--target", "--strict=true"])).toContain(
      '"--target" needs a value',
    );
  });

  it("reports the same input given twice rather than choosing between them", () => {
    expect(rejected(["audit.md", "--target=docs", "--target=src"])).toContain("twice");
  });

  it("reports a single-dash option, which is not how inputs are written", () => {
    expect(rejected(["audit.md", "-t", "docs"])).toContain('"-t"');
  });

  it("reports an option whose name no input could have", () => {
    expect(rejected(["audit.md", "--the target=docs"])).toContain("the target");
  });
});
