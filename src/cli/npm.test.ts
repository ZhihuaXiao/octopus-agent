import { describe, expect, it } from "vitest";

import { fromNpm } from "./npm.js";

describe("a command line npm has read", () => {
  it("is left alone when it came after a `--`", () => {
    const argv = ["--web", "--host", "0.0.0.0", "--port", "9000"];
    expect(fromNpm(argv, {})).toEqual(argv);
    expect(fromNpm(["run", "examples/hello.md"], {})).toEqual(["run", "examples/hello.md"]);
  });

  it("gets back the web flags npm kept, with the values it left behind", () => {
    const env = { npm_config_web: "true", npm_config_host: "true", npm_config_port: "true" };
    expect(fromNpm(["0.0.0.0", "9000"], env)).toEqual([
      "--web",
      "--host",
      "0.0.0.0",
      "--port",
      "9000",
    ]);
  });

  it("tells the port from the host whichever order they were written in", () => {
    const env = { npm_config_web: "true", npm_config_host: "true", npm_config_port: "true" };
    expect(fromNpm(["9000", "0.0.0.0"], env)).toEqual([
      "--web",
      "--host",
      "0.0.0.0",
      "--port",
      "9000",
    ]);
  });

  it("takes a value npm was given with an equals sign as it stands", () => {
    const env = { npm_config_web: "true", npm_config_host: "::", npm_config_port: "true" };
    expect(fromNpm(["9000"], env)).toEqual(["--web", "--host", "::", "--port", "9000"]);
  });

  it("gets back an option npm took as the value of its own --password", () => {
    const env = { npm_config_web: "true", npm_config_password: "--port=9000" };
    expect(fromNpm([], env)).toEqual(["--web", "--password", "--port=9000"]);
    expect(fromNpm([], { npm_config_web: "true", npm_config_password: "true" })).toEqual([
      "--web",
      "--password",
    ]);
  });

  it("leaves a registry password from npm's configuration out of it", () => {
    expect(fromNpm(["run", "a.md"], { npm_config_password: "hunter2" })).toEqual(["run", "a.md"]);
  });

  it("leaves a missing value missing, for the launcher to say so", () => {
    expect(fromNpm([], { npm_config_web: "true", npm_config_host: "true" })).toEqual([
      "--web",
      "--host",
    ]);
  });

  it("keeps what came after a `--` after what npm kept", () => {
    expect(fromNpm(["--port", "9000"], { npm_config_web: "true" })).toEqual([
      "--web",
      "--port",
      "9000",
    ]);
  });
});
