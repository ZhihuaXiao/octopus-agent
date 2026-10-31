import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { zipSync, strToU8 } from "fflate";

import { exportNotebookBundle, importNotebookBundle, inspectNotebookBundle } from "./bundle.js";

const sampleNotebook = `---
title: Demo Notebook
---

\`\`\`prompt id=cell-1
Say hello.
\`\`\`

\`\`\`prompt id=cell-2 isolated
Say goodbye.
\`\`\`
`;

describe("notebook bundle export and import", () => {
  it("exports a notebook with no runs into a valid zip bundle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "octo-bundle-"));
    const notebookPath = join(dir, "demo.md");
    await writeFile(notebookPath, sampleNotebook, "utf8");

    const exported = await exportNotebookBundle({ notebook: notebookPath });
    expect(exported.kind).toBe("exported");
    if (exported.kind !== "exported") return;

    expect(exported.manifest).toEqual({
      formatVersion: 1,
      octoVersion: "0.0.0",
      createdAt: expect.any(String),
      originalNotebook: "demo.md",
      title: "Demo Notebook",
      runCount: 0,
    });

    const inspected = inspectNotebookBundle(exported.bytes);
    expect(inspected).toEqual(exported.manifest);
  });

  it("exports and imports runs, shared sessions, isolated sessions, and artifacts", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "octo-src-"));
    const notebookPath = join(sourceDir, "demo.md");
    await writeFile(notebookPath, sampleNotebook, "utf8");

    // Create a mock run directory with session files and artifacts
    const runId = "2026-10-31T00-00-00-000Z-test1";
    const runDir = join(sourceDir, ".octo", "runs", "demo", runId);
    await mkdir(join(runDir, "artifacts", "cell-1"), { recursive: true });
    await mkdir(join(sourceDir, "pi-sessions"), { recursive: true });

    const sharedSession = join(sourceDir, "pi-sessions", "shared.jsonl");
    await writeFile(sharedSession, '{"type":"session","id":"shared"}\n', "utf8");

    const isolatedSession = join(sourceDir, "pi-sessions", "isolated.jsonl");
    await writeFile(isolatedSession, '{"type":"session","id":"isolated"}\n', "utf8");

    await writeFile(join(runDir, "artifacts", "cell-1", "output.txt"), "chart data", "utf8");

    const originalRecord = {
      id: runId,
      notebook: notebookPath,
      environment: { workspace: sourceDir, trusted: false, piVersion: "", tools: [] },
      agentSession: sharedSession,
      startedAt: "2026-10-31T00:00:00.000Z",
      endedAt: "2026-10-31T00:00:01.000Z",
      cells: [
        {
          id: "cell-1",
          type: "prompt",
          status: "ok",
          text: "Hello!",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
          model: "claude",
          retries: [],
          artifacts: ["artifacts/cell-1/output.txt"],
        },
        {
          id: "cell-2",
          type: "prompt",
          status: "ok",
          agentSession: isolatedSession,
          text: "Goodbye!",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
          model: "claude",
          retries: [],
          artifacts: [],
        },
      ],
      stale: [],
      anchors: { "cell-1": "anchor-1" },
    };

    await writeFile(join(runDir, "record.json"), JSON.stringify(originalRecord, null, 2), "utf8");

    // Export bundle
    const exported = await exportNotebookBundle({ notebook: notebookPath });
    expect(exported.kind).toBe("exported");
    if (exported.kind !== "exported") return;
    expect(exported.manifest.runCount).toBe(1);

    // Import into a target workspace
    const targetDir = await mkdtemp(join(tmpdir(), "octo-dest-"));
    const imported = await importNotebookBundle({
      bundle: exported.bytes,
      directory: targetDir,
    });

    expect(imported).toEqual({
      kind: "imported",
      path: "demo.md",
      title: "Demo Notebook",
      runs: 1,
    });

    // Verify extracted files and rewritten record.json
    expect(await readFile(join(targetDir, "demo.md"), "utf8")).toBe(sampleNotebook);

    const destRunsDir = join(targetDir, ".octo", "runs", "demo", runId);
    expect(await readFile(join(destRunsDir, "artifacts", "cell-1", "output.txt"), "utf8")).toBe(
      "chart data",
    );

    const destRecord = JSON.parse(await readFile(join(destRunsDir, "record.json"), "utf8"));
    expect(destRecord.notebook).toBe(join(targetDir, "demo.md"));
    expect(destRecord.agentSession).toBe(join(destRunsDir, "session.jsonl"));
    expect(destRecord.cells[1].agentSession).toBe(join(destRunsDir, "sessions", "cell-2.jsonl"));

    // Verify session contents are preserved
    expect(await readFile(destRecord.agentSession, "utf8")).toContain('"id":"shared"');
    expect(await readFile(destRecord.cells[1].agentSession, "utf8")).toContain('"id":"isolated"');
  });

  it("imports under an overridden filename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "octo-bundle-override-"));
    const notebookPath = join(dir, "original.md");
    await writeFile(notebookPath, sampleNotebook, "utf8");

    const exported = await exportNotebookBundle({ notebook: notebookPath });
    if (exported.kind !== "exported") throw new Error("export failed");

    const targetDir = await mkdtemp(join(tmpdir(), "octo-dest-override-"));
    const imported = await importNotebookBundle({
      bundle: exported.bytes,
      directory: targetDir,
      to: "custom/renamed.md",
    });

    expect(imported).toEqual({
      kind: "imported",
      path: "custom/renamed.md",
      title: "Demo Notebook",
      runs: 0,
    });
    expect(await readFile(join(targetDir, "custom", "renamed.md"), "utf8")).toBe(sampleNotebook);
  });

  it("refuses to overwrite an existing notebook unless forced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "octo-bundle-collision-"));
    const notebookPath = join(dir, "exists.md");
    await writeFile(notebookPath, sampleNotebook, "utf8");

    const exported = await exportNotebookBundle({ notebook: notebookPath });
    if (exported.kind !== "exported") throw new Error("export failed");

    const targetDir = await mkdtemp(join(tmpdir(), "octo-dest-collision-"));
    await writeFile(join(targetDir, "exists.md"), "already here", "utf8");

    const refused = await importNotebookBundle({
      bundle: exported.bytes,
      directory: targetDir,
    });
    expect(refused).toEqual({ kind: "exists", path: "exists.md" });
    expect(await readFile(join(targetDir, "exists.md"), "utf8")).toBe("already here");

    const forced = await importNotebookBundle({
      bundle: exported.bytes,
      directory: targetDir,
      force: true,
    });
    expect(forced.kind).toBe("imported");
    expect(await readFile(join(targetDir, "exists.md"), "utf8")).toBe(sampleNotebook);
  });

  it("rejects malicious archives attempting zip slip", async () => {
    const targetDir = await mkdtemp(join(tmpdir(), "octo-dest-slip-"));

    const badZip = zipSync({
      "manifest.json": strToU8(
        JSON.stringify({
          formatVersion: 1,
          octoVersion: "0.0.0",
          createdAt: new Date().toISOString(),
          originalNotebook: "safe.md",
          title: "Safe",
          runCount: 0,
        }),
      ),
      "notebook.md": strToU8(sampleNotebook),
      "runs/../../escape.txt": strToU8("malicious"),
    });

    const result = await importNotebookBundle({
      bundle: badZip,
      directory: targetDir,
    });

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.problem).toContain("Unsafe path");
    }
  });
});
