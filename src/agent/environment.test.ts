import { describe, expect, it } from "vitest";

import { type Environment, checkEnvironment } from "./environment.js";

/** An environment providing nothing, so a test names only what it is about. */
const providing = (provided: Partial<Environment> = {}): Environment => ({
  piVersion: "0.84.2",
  tools: [],
  skills: [],
  packages: [],
  trusted: true,
  ...provided,
});

describe("checkEnvironment", () => {
  it("is satisfied by anything when the notebook declares nothing", () => {
    expect(checkEnvironment({}, providing())).toEqual([]);
  });

  it("is satisfied when everything declared is provided", () => {
    const declared = {
      piVersion: "0.84.2",
      tools: ["read", "bash"],
      skills: ["review"],
      packages: ["npm:@acme/skills@1.0.0"],
    };

    expect(checkEnvironment(declared, providing(declared))).toEqual([]);
  });

  it("names a declared tool the environment does not offer", () => {
    const problems = checkEnvironment({ tools: ["read", "grep"] }, providing({ tools: ["read"] }));

    expect(problems).toEqual([expect.stringContaining(`"grep"`)]);
  });

  it("names a declared skill that is not installed", () => {
    const problems = checkEnvironment(
      { skills: ["review", "release"] },
      providing({ skills: ["review"] }),
    );

    expect(problems).toEqual([expect.stringContaining(`"release"`)]);
  });

  it("names a declared package that is not installed", () => {
    const problems = checkEnvironment(
      { packages: ["npm:@acme/skills@1.0.0"] },
      providing({ packages: ["npm:@acme/other@1.0.0"] }),
    );

    expect(problems).toEqual([expect.stringContaining("npm:@acme/skills@1.0.0")]);
  });

  it("reports a declared pi version that is not the one running", () => {
    const problems = checkEnvironment({ piVersion: "0.83.0" }, providing({ piVersion: "0.84.2" }));

    expect(problems).toEqual([expect.stringMatching(/0\.83\.0[\s\S]*0\.84\.2/)]);
  });

  it("says nothing about a pi version the notebook does not pin", () => {
    expect(checkEnvironment({}, providing({ piVersion: "0.84.2" }))).toEqual([]);
  });

  it("explains an untrusted workspace when a declared skill is missing", () => {
    const [problem] = checkEnvironment({ skills: ["review"] }, providing({ trusted: false }));

    expect(problem).toContain("not trusted");
  });

  it("says nothing about trust when the workspace is trusted", () => {
    const [problem] = checkEnvironment({ skills: ["review"] }, providing({ trusted: true }));

    expect(problem).not.toContain("trust");
  });

  it("reports everything missing at once, so one run names the whole gap", () => {
    const problems = checkEnvironment(
      {
        piVersion: "0.83.0",
        tools: ["grep"],
        skills: ["review"],
        packages: ["npm:@acme/skills@1.0.0"],
      },
      providing(),
    );

    expect(problems).toHaveLength(4);
  });
});
