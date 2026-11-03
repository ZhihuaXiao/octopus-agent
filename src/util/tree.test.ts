import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isSkipped, markdownFiles } from "./tree.js";

describe("tree", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "octo-tree-test-"));
  });

  afterEach(async () => {
    // Restore permissions in case any child folder was set to 0000
    try {
      await chmod(join(tempDir, "restricted"), 0o755);
    } catch {
      // ignore if not created
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("identifies skipped directory names", () => {
    expect(isSkipped("node_modules")).toBe(true);
    expect(isSkipped(".git")).toBe(true);
    expect(isSkipped(".octo")).toBe(true);
    expect(isSkipped("src")).toBe(false);
    expect(isSkipped("notes")).toBe(false);
  });

  it("finds markdown files recursively and skips node_modules and dot-directories", async () => {
    await mkdir(join(tempDir, "sub"), { recursive: true });
    await mkdir(join(tempDir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(tempDir, ".git"), { recursive: true });

    await writeFile(join(tempDir, "root.md"), "# Root");
    await writeFile(join(tempDir, "sub", "child.md"), "# Child");
    await writeFile(join(tempDir, "sub", "ignore.txt"), "text");
    await writeFile(join(tempDir, "node_modules", "pkg", "readme.md"), "# Pkg");
    await writeFile(join(tempDir, ".git", "commit.md"), "# Git");

    const found = await markdownFiles(tempDir);
    expect(found.sort()).toEqual(
      [join(tempDir, "root.md"), join(tempDir, "sub", "child.md")].sort(),
    );
  });

  it("gracefully ignores directories without read permission (EACCES)", async () => {
    const restrictedDir = join(tempDir, "restricted");
    await mkdir(restrictedDir, { recursive: true });
    await writeFile(join(restrictedDir, "secret.md"), "# Secret");
    await writeFile(join(tempDir, "accessible.md"), "# Accessible");

    await chmod(restrictedDir, 0o000);

    const found = await markdownFiles(tempDir);
    expect(found).toEqual([join(tempDir, "accessible.md")]);
  });
});
