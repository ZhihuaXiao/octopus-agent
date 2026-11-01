import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LONGEST_TEXT,
  baselineUnder,
  isTextFile,
  readTextFile,
  readTextFiles,
  reviewsBetween,
  writeTextFile,
} from "./text-files.js";

describe("text files", () => {
  it("names the extensions a notebook opens, and no others", () => {
    expect(
      [
        "a.txt",
        "a.ts",
        "a.tsx",
        "a.py",
        "a.js",
        "a.mjs",
        "a.cjs",
        "a.jsx",
        "a.java",
        "a.go",
        "a.rs",
        "a.csv",
        "a.tsv",
        "a.json",
        "a.yaml",
        "a.yml",
        "a.md",
        "a.html",
        "a.css",
        "a.sh",
      ].map(isTextFile),
    ).toEqual(Array(20).fill(true));
    expect(isTextFile("A.PY")).toBe(true);
    expect(isTextFile("vitest.config.ts")).toBe(true);
    expect(isTextFile("chart.png")).toBe(false);
    expect(isTextFile("Makefile")).toBe(false);
  });

  it("reviews a file that appeared or whose bytes changed, and not one that is the same or gone", () => {
    const before = new Map([
      ["keep.py", "same\n"],
      ["data.csv", "a,1\n"],
      ["gone.js", "old\n"],
    ]);
    const after = new Map([
      ["keep.py", "same\n"],
      ["data.csv", "b,2\n"],
      ["made.py", "print(1)\n"],
    ]);

    expect(reviewsBetween(before, after)).toEqual([
      { path: "data.csv", kind: "modified", before: "a,1\n" },
      { path: "made.py", kind: "created" },
    ]);
  });

  it("keeps an open review's original bytes as the baseline", () => {
    const disk = new Map([
      ["made.py", "print(1)\n"],
      ["data.csv", "b,2\n"],
      ["other.md", "notes\n"],
    ]);

    expect(
      baselineUnder(disk, [
        { path: "made.py", kind: "created" },
        { path: "data.csv", kind: "modified", before: "a,1\n" },
      ]),
    ).toEqual(
      new Map([
        ["data.csv", "a,1\n"],
        ["other.md", "notes\n"],
      ]),
    );
  });

  it("reads a text file under the directory, and refuses what is not one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-text-"));
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src/app.py"), "print(1)\n", "utf8");
    await writeFile(join(directory, "src/app.ts"), "export {}\n", "utf8");
    await writeFile(join(directory, "notes.txt"), "hello\n", "utf8");
    await writeFile(join(directory, "chart.png"), "no\n", "utf8");
    await mkdir(join(directory, ".hidden"));
    await writeFile(join(directory, ".hidden/secret.py"), "hidden\n", "utf8");
    await mkdir(join(directory, "node_modules"));
    await writeFile(join(directory, "node_modules/pkg.js"), "pkg\n", "utf8");
    await writeFile(join(directory, "binary.py"), Buffer.from([0x70, 0x00, 0x79]));
    await symlink(join(directory, "src/app.py"), join(directory, "linked.py"));

    expect(await readTextFile(directory, "src/app.py")).toEqual({
      kind: "text",
      path: "src/app.py",
      text: "print(1)\n",
    });
    expect(await readTextFile(directory, "src/../src/app.py")).toEqual({
      kind: "text",
      path: "src/app.py",
      text: "print(1)\n",
    });
    expect(await readTextFile(directory, "notes.txt")).toEqual({
      kind: "text",
      path: "notes.txt",
      text: "hello\n",
    });
    expect(await readTextFile(directory, "src/app.ts")).toEqual({
      kind: "text",
      path: "src/app.ts",
      text: "export {}\n",
    });
    expect(await readTextFile(directory, "../app.py")).toEqual({ kind: "invalid" });
    expect(await readTextFile(directory, "chart.png")).toEqual({ kind: "invalid" });
    expect(await readTextFile(directory, "missing.py")).toEqual({ kind: "absent" });
    expect(await readTextFile(directory, "linked.py")).toEqual({ kind: "absent" });
    expect(await readTextFile(directory, "binary.py")).toEqual({ kind: "invalid" });

    expect([...(await readTextFiles(directory)).entries()].sort()).toEqual([
      ["notes.txt", "hello\n"],
      ["src/app.py", "print(1)\n"],
      ["src/app.ts", "export {}\n"],
    ]);
  });

  it("replaces a text file, and refuses a link, a missing file, or a file that is not text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-text-"));
    await writeFile(join(directory, "note.txt"), "before\n", "utf8");
    await symlink(join(directory, "note.txt"), join(directory, "linked.txt"));

    expect(await writeTextFile(directory, "note.txt", "after\n")).toEqual({
      kind: "saved",
      path: "note.txt",
    });
    expect(await readTextFile(directory, "note.txt")).toEqual({
      kind: "text",
      path: "note.txt",
      text: "after\n",
    });
    expect(await writeTextFile(directory, "missing.txt", "x\n")).toEqual({ kind: "absent" });
    expect(await writeTextFile(directory, "linked.txt", "x\n")).toEqual({ kind: "absent" });
    expect(await writeTextFile(directory, "note.png", "x\n")).toEqual({ kind: "invalid" });
    expect(await writeTextFile(directory, "../note.txt", "x\n")).toEqual({ kind: "invalid" });
    expect(await writeTextFile(directory, "note.txt", "a\0b")).toEqual({ kind: "invalid" });
    expect(await readTextFile(directory, "note.txt")).toMatchObject({ text: "after\n" });
  });

  it("leaves out a file too long to review", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-text-"));
    await writeFile(join(directory, "big.py"), Buffer.alloc(LONGEST_TEXT + 1, 0x61));
    await writeFile(join(directory, "small.py"), "x\n", "utf8");

    expect(await readTextFile(directory, "big.py")).toEqual({ kind: "too-large" });
    expect([...(await readTextFiles(directory)).keys()]).toEqual(["small.py"]);
  });
});
