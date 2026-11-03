import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorkspace, type Workspace } from "./workspace.js";

describe("Workspace", () => {
  let tempDir: string;
  let workspace: Workspace;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "octo-workspace-test-"));
    workspace = createWorkspace({ directory: tempDir });
  });

  afterEach(async () => {
    try {
      await chmod(join(tempDir, "restricted"), 0o755);
    } catch {
      // ignore
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("path containment", () => {
    it("safeguards against directory traversal", () => {
      expect(workspace.fileWithin("../outside.txt")).toBeUndefined();
      expect(workspace.fileWithin("nested/../../outside.txt")).toBeUndefined();
      expect(workspace.fileWithin("valid/sub/file.txt")).toBe(
        join(tempDir, "valid", "sub", "file.txt"),
      );
    });

    it("rejects null byte injections", () => {
      expect(workspace.fileWithin("file\0.txt")).toBeUndefined();
    });

    it("normalizes pathWithin with forward slashes", () => {
      const full = join(tempDir, "folder", "sub", "doc.md");
      expect(workspace.pathWithin(full)).toBe("folder/sub/doc.md");
    });
  });

  describe("file and directory operations", () => {
    it("lists folder tree and categorizes entries", async () => {
      await mkdir(join(tempDir, "src"), { recursive: true });
      await writeFile(join(tempDir, "src", "index.ts"), "export const x = 1;", "utf8");
      await writeFile(join(tempDir, "notes.txt"), "hello", "utf8");
      await writeFile(
        join(tempDir, "my-notebook.md"),
        `# Title\n\n\`\`\`prompt id="cell-1"\nwhat is 2+2?\n\`\`\`\n`,
        "utf8",
      );

      const tree = await workspace.listTree();
      expect(tree.length).toBe(3);
      // Directory first
      expect(tree[0]?.kind).toBe("directory");
      expect(tree[0]?.name).toBe("src");

      // Notebook
      const nbEntry = tree.find((t) => t.name === "my-notebook.md");
      expect(nbEntry?.kind).toBe("notebook");

      // Text file
      const txtEntry = tree.find((t) => t.name === "notes.txt");
      expect(txtEntry?.kind).toBe("text");
    });

    it("reads and stores workspace files with size enforcement", async () => {
      const stored = await workspace.storeFile("test.bin", Buffer.from([1, 2, 3, 4]));
      expect(stored.kind).toBe("saved");

      const read = await workspace.readFile("test.bin");
      expect(read.kind).toBe("file");
      if (read.kind === "file") {
        expect(read.bytes).toEqual(Buffer.from([1, 2, 3, 4]));
      }

      // Rejects duplicate storage without overwrite
      const dup = await workspace.storeFile("test.bin", Buffer.from([5, 6]));
      expect(dup.kind).toBe("exists");

      // Rejects oversized file (> 8MB)
      const huge = Buffer.alloc(8 * 1024 * 1024 + 1);
      const tooLarge = await workspace.storeFile("huge.bin", huge);
      expect(tooLarge.kind).toBe("too-large");
    });

    it("reads and writes text files", async () => {
      await writeFile(join(tempDir, "data.csv"), "a,b,c\n1,2,3\n", "utf8");

      const read = await workspace.readText("data.csv");
      expect(read.kind).toBe("text");
      if (read.kind === "text") {
        expect(read.text).toBe("a,b,c\n1,2,3\n");
      }

      const written = await workspace.writeText("data.csv", "a,b,c\n4,5,6\n");
      expect(written.kind).toBe("saved");

      const readAfter = await workspace.readText("data.csv");
      if (readAfter.kind === "text") {
        expect(readAfter.text).toBe("a,b,c\n4,5,6\n");
      }
    });

    it("renames non-notebook files and rejects renaming notebooks via renameFile", async () => {
      await writeFile(join(tempDir, "old.txt"), "text", "utf8");
      await writeFile(join(tempDir, "nb.md"), `\`\`\`prompt id="c1"\nhello\n\`\`\`\n`, "utf8");

      const renamedTxt = await workspace.renameFile("old.txt", "new.txt");
      expect(renamedTxt.kind).toBe("renamed");

      // Attempting to rename a notebook via renameFile is refused
      const nbRename = await workspace.renameFile("nb.md", "renamed-nb.md");
      expect(nbRename.kind).toBe("notebook");
    });
  });

  describe("notebook lifecycle", () => {
    it("creates, copies, branches, and lists notebooks", async () => {
      // Create new notebook
      const created = await workspace.createNotebook("analysis.md");
      expect(created.kind).toBe("created");
      if (created.kind !== "created") throw new Error("Expected created");
      expect(created.entry.path).toBe("analysis.md");

      // List notebooks
      const list = await workspace.listNotebooks();
      expect(list.length).toBe(1);
      expect(list[0]?.path).toBe("analysis.md");

      // Copy notebook
      const copied = await workspace.copyNotebook("analysis.md", "copied.md");
      expect(copied.kind).toBe("copied");
      if (copied.kind !== "copied") throw new Error("Expected copied");
      expect(copied.entry.path).toBe("copied.md");

      // Branch notebook
      const branched = await workspace.branchNotebook("analysis.md", "cell-1", "branch.md");
      expect(branched.kind).toBe("branched");
      if (branched.kind !== "branched") throw new Error("Expected branched");
      expect(branched.entry.path).toBe("branch.md");
    });

    it("assigns notebook model and mode on disk", async () => {
      await workspace.createNotebook("test.md");

      const setModel = await workspace.assignNotebookModel(
        "test.md",
        "anthropic/claude-3-5-sonnet",
      );
      expect(setModel.kind).toBe("saved");
      if (setModel.kind === "saved") {
        expect(setModel.entry.model).toBe("anthropic/claude-3-5-sonnet");
      }

      const setMode = await workspace.assignNotebookMode("test.md", "code");
      expect(setMode.kind).toBe("saved");
      if (setMode.kind === "saved") {
        expect(setMode.entry.mode).toBe("code");
      }
    });

    it("atomically renames a notebook and relocates its run records", async () => {
      await workspace.createNotebook("nb1.md");

      // Set up a mock .octo/runs/nb1 directory with a record.json
      const runsDir = join(tempDir, ".octo", "runs", "nb1", "run-1");
      await mkdir(runsDir, { recursive: true });
      await writeFile(
        join(runsDir, "record.json"),
        JSON.stringify({ id: "run-1", notebook: join(tempDir, "nb1.md") }),
        "utf8",
      );

      const renamed = await workspace.renameNotebook("nb1.md", "nb2.md");
      expect(renamed.kind).toBe("renamed");

      // Verify that run directory was moved to .octo/runs/nb2/run-1
      const newRecFile = join(tempDir, ".octo", "runs", "nb2", "run-1", "record.json");
      const updatedRec = JSON.parse(await readFile(newRecFile, "utf8"));
      expect(updatedRec.notebook).toBe(join(tempDir, "nb2.md"));
    });

    it("atomically removes a notebook and cleans up runs and journals", async () => {
      await workspace.createNotebook("deleted.md");

      // Create run record directory
      const runsDir = join(tempDir, ".octo", "runs", "deleted", "run-1");
      await mkdir(runsDir, { recursive: true });
      await writeFile(join(runsDir, "record.json"), JSON.stringify({ id: "run-1" }), "utf8");

      // Create matching journal
      const journalDir = join(tempDir, ".octo", "journals");
      await mkdir(journalDir, { recursive: true });
      await writeFile(
        join(journalDir, "j1.jsonl"),
        JSON.stringify({ type: "opened", notebook: "deleted.md" }) + "\n",
        "utf8",
      );

      const removed = await workspace.removeNotebook("deleted.md");
      expect(removed.kind).toBe("removed");

      // File is gone
      await expect(readFile(join(tempDir, "deleted.md"), "utf8")).rejects.toThrow();

      // Runs directory is cleaned up
      await expect(readFile(join(runsDir, "record.json"), "utf8")).rejects.toThrow();

      // Matching journal is cleaned up
      await expect(readFile(join(journalDir, "j1.jsonl"), "utf8")).rejects.toThrow();
    });

    it("tolerates permission-denied directories without failing listing or tree operations", async () => {
      await workspace.createNotebook("accessible.md");
      const restrictedDir = join(tempDir, "restricted");
      await mkdir(restrictedDir, { recursive: true });
      await writeFile(
        join(restrictedDir, "secret.md"),
        `# Secret\n\n\`\`\`prompt id="cell-1"\nhidden\n\`\`\`\n`,
        "utf8",
      );

      await chmod(restrictedDir, 0o000);

      // listNotebooks should not throw and should list accessible notebooks
      const notebooks = await workspace.listNotebooks();
      expect(notebooks.map((n) => n.path)).toEqual(["accessible.md"]);

      // listTree should not throw and should list accessible files and empty restricted dir
      const tree = await workspace.listTree();
      const names = tree.map((t) => t.name);
      expect(names).toContain("accessible.md");
      expect(names).toContain("restricted");
      const restrictedEntry = tree.find((t) => t.name === "restricted");
      expect(restrictedEntry).toEqual({
        kind: "directory",
        name: "restricted",
        path: "restricted",
        children: [],
      });

      // readFile on a file in the restricted dir returns absent rather than throwing
      const readResult = await workspace.readFile("restricted/secret.md");
      expect(readResult).toEqual({ kind: "absent" });
    });
  });
});
