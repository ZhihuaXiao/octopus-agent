import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createScriptedAgent } from "../agent/scripted.js";
import { cellAccess, cellAccessAllows, cellAccessFrom } from "./access.js";
import { runNotebook } from "./runner.js";
import { recordPath } from "./store.js";

describe("cellAccess", () => {
  const served = "/work/notes";

  it("allows every path for the account, which is what a run does by default", () => {
    expect(cellAccessAllows(cellAccess("user"), served, "/etc")).toBe(true);
    expect(cellAccessAllows(cellAccess("user"), served, served)).toBe(true);
  });

  it("keeps a workspace under the served directory, including that directory itself", () => {
    const access = cellAccess("served");
    expect(cellAccessAllows(access, served, served)).toBe(true);
    expect(cellAccessAllows(access, served, "/work/notes/drafts")).toBe(true);
    expect(cellAccessAllows(access, served, "/work/notes-other")).toBe(false);
    expect(cellAccessAllows(access, served, "/tmp")).toBe(false);
  });

  it("keeps a workspace under the directories that were named", () => {
    const access = cellAccess(["/data", "/work/notes"]);
    expect(cellAccessAllows(access, served, "/data/sets")).toBe(true);
    expect(cellAccessAllows(access, served, "/work/notes")).toBe(true);
    expect(cellAccessAllows(access, served, "/tmp")).toBe(false);
  });

  it("reads the flag as one mode or a list of directories", () => {
    expect(cellAccessFrom([])).toBeUndefined();
    expect(cellAccessFrom(["served"])).toEqual({ access: { kind: "served" } });
    expect(cellAccessFrom(["/data", "/work"])).toEqual({
      access: { kind: "roots", roots: ["/data", "/work"] },
    });
    expect(cellAccessFrom(["served", "/data"])).toMatchObject({ problem: expect.any(String) });
  });
});

describe("a run obeying that choice", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("refuses a workspace outside the served directory, and runs one inside it", async () => {
    const served = await realpath(await mkdtemp(join(tmpdir(), "octo-access-")));
    directories.push(served);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "octo-access-out-")));
    directories.push(outside);
    const notebook = join(served, "notes.md");
    await writeFile(
      notebook,
      `---\nworkspace: ${JSON.stringify(outside)}\n---\n\n\`\`\`bash id=step\npwd\n\`\`\`\n`,
      "utf8",
    );

    await expect(
      runNotebook(notebook, {
        agent: createScriptedAgent([]).create,
        access: cellAccess("served"),
        servedDirectory: served,
      }),
    ).rejects.toThrow(/outside the directories/);

    await mkdir(join(served, "inside"));
    await writeFile(
      notebook,
      `---\nworkspace: inside\n---\n\n\`\`\`bash id=step\npwd\n\`\`\`\n`,
      "utf8",
    );
    const record = await runNotebook(notebook, {
      agent: createScriptedAgent([]).create,
      access: cellAccess("served"),
      servedDirectory: served,
    });
    expect(record.cells[0]).toMatchObject({ status: "ok" });
    expect((await stat(recordPath(notebook, record.id))).mode & 0o777).toBe(0o600);
    expect((await stat(join(served, ".octo"))).mode & 0o777).toBe(0o700);
  });
});
