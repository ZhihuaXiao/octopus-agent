import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { VERSION } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { piCommand } from "./command.js";

const run = promisify(execFile);

describe("pi's own command", () => {
  it("is the pinned package's, and answers for the pinned version", async () => {
    const { command, prefix } = piCommand();

    const { stdout } = await run(command, [...prefix, "--version"]);

    expect(stdout.trim()).toBe(VERSION);
  });
});
