import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PI_PACKAGE, isExactVersionSpec } from "./version-pin.js";

describe("isExactVersionSpec", () => {
  it("accepts a fully pinned version", () => {
    expect(isExactVersionSpec("0.84.2")).toBe(true);
  });

  it.each(["^0.84.2", "~0.84.2", ">=0.84.2", "0.84.x", "*", "latest", ""])(
    "rejects %o, which would let a breaking pi release in unannounced",
    (spec) => {
      expect(isExactVersionSpec(spec)).toBe(false);
    },
  );
});

describe("this repository's dependency on pi", () => {
  it("is pinned to an exact version", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const spec = manifest.dependencies?.[PI_PACKAGE];

    expect(spec, `${PI_PACKAGE} should be a runtime dependency`).toBeDefined();
    expect(isExactVersionSpec(spec)).toBe(true);
  });
});
