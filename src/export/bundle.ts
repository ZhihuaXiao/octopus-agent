/**
 * Exporting a Notebook and its runs as a self-contained .octo.zip bundle,
 * and importing one into a workspace.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { formatDiagnostics } from "../notebook/diagnostic.js";
import { parseNotebook, titleOf } from "../notebook/notebook.js";
import type { RunRecord } from "../run/record.js";
import { runsDirectory } from "../run/store.js";
import { notebookTarget, pathWithin } from "../server/notebooks.js";

export interface BundleManifest {
  readonly formatVersion: 1;
  readonly octoVersion: string;
  readonly createdAt: string;
  readonly originalNotebook: string;
  readonly title: string;
  readonly runCount: number;
}

export interface ExportBundleOptions {
  /** The path to the notebook file to export. */
  readonly notebook: string;
}

export type ExportBundleResult =
  | { readonly kind: "exported"; readonly bytes: Uint8Array; readonly manifest: BundleManifest }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly problem: string };

/**
 * Packages a Notebook, its run records, artifacts, and all associated session files
 * into a self-contained zip archive.
 */
export async function exportNotebookBundle(
  options: ExportBundleOptions,
): Promise<ExportBundleResult> {
  const resolvedNotebook = resolve(options.notebook);
  if (!existsSync(resolvedNotebook)) {
    return { kind: "absent" };
  }

  let notebookContent: string;
  try {
    notebookContent = await readFile(resolvedNotebook, "utf8");
  } catch (cause) {
    return { kind: "invalid", problem: `Cannot read notebook: ${String(cause)}` };
  }

  const parsed = parseNotebook(notebookContent);
  if (!parsed.ok) {
    return { kind: "invalid", problem: formatDiagnostics(parsed.errors) };
  }

  const zipFiles: Record<string, Uint8Array> = {};
  zipFiles["notebook.md"] = strToU8(notebookContent);

  const runsDir = runsDirectory(resolvedNotebook);
  let runCount = 0;

  if (existsSync(runsDir)) {
    const runDirs = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      const runId = runDir.name;
      const singleRunDir = join(runsDir, runId);
      const recPath = join(singleRunDir, "record.json");
      if (!existsSync(recPath)) continue;

      let recordText: string;
      let record: RunRecord;
      try {
        recordText = await readFile(recPath, "utf8");
        record = JSON.parse(recordText) as RunRecord;
      } catch {
        continue;
      }
      runCount++;

      // Shared agent session
      if (record.agentSession !== undefined && existsSync(record.agentSession)) {
        try {
          const sessionBytes = await readFile(record.agentSession);
          zipFiles[`runs/${runId}/session.jsonl`] = sessionBytes;
        } catch {
          // Leave if unreadable
        }
      }

      // Isolated cell sessions
      if (record.cells !== undefined) {
        for (const cell of record.cells) {
          if ("agentSession" in cell && typeof cell.agentSession === "string") {
            if (existsSync(cell.agentSession)) {
              try {
                const sessionBytes = await readFile(cell.agentSession);
                zipFiles[`runs/${runId}/sessions/${cell.id}.jsonl`] = sessionBytes;
              } catch {
                // Leave if unreadable
              }
            }
          }
        }
      }

      // Artifacts
      const artifactsDir = join(singleRunDir, "artifacts");
      if (existsSync(artifactsDir)) {
        const entries = await readdir(artifactsDir, { recursive: true, withFileTypes: true }).catch(
          () => [],
        );
        for (const entry of entries) {
          if (entry.isFile()) {
            const parent = entry.parentPath ?? artifactsDir;
            const fullPath = join(parent, entry.name);
            const rel = relative(artifactsDir, fullPath).split("\\").join("/");
            try {
              zipFiles[`runs/${runId}/artifacts/${rel}`] = await readFile(fullPath);
            } catch {
              // Ignore unreadable artifact
            }
          }
        }
      }

      // record.json
      zipFiles[`runs/${runId}/record.json`] = strToU8(recordText);
    }
  }

  const manifest: BundleManifest = {
    formatVersion: 1,
    octoVersion: "0.0.0",
    createdAt: new Date().toISOString(),
    originalNotebook: basename(resolvedNotebook),
    title: titleOf(parsed.notebook, resolvedNotebook),
    runCount,
  };

  zipFiles["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

  const bytes = zipSync(zipFiles);
  return { kind: "exported", bytes, manifest };
}

/**
 * Inspects the manifest inside a .octo.zip bundle without extracting it.
 */
export function inspectNotebookBundle(bundle: Uint8Array): BundleManifest {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bundle);
  } catch {
    throw new Error("The bundle is not a valid zip archive.");
  }

  const manifestBytes = unzipped["manifest.json"];
  if (!manifestBytes) {
    throw new Error("The bundle does not contain a manifest.json.");
  }

  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes)) as BundleManifest;
  } catch {
    throw new Error("The bundle manifest.json is invalid JSON.");
  }

  if (manifest.formatVersion !== 1) {
    throw new Error(`Unsupported bundle format version ${manifest.formatVersion}.`);
  }

  return manifest;
}

export interface ImportBundleOptions {
  /** The raw bytes of the .octo.zip file. */
  readonly bundle: Uint8Array;
  /** The served directory / workspace where the notebook should be imported. */
  readonly directory: string;
  /** Optional target path (relative to directory). Defaults to originalNotebook in manifest. */
  readonly to?: string;
  /** Whether to overwrite existing files. Defaults to false. */
  readonly force?: boolean;
}

export type ImportBundleResult =
  | {
      readonly kind: "imported";
      readonly path: string;
      readonly title: string;
      readonly runs: number;
    }
  | { readonly kind: "exists"; readonly path: string }
  | { readonly kind: "invalid"; readonly problem: string };

/**
 * Unpacks an .octo.zip bundle into the target directory, rewriting all run records
 * and session paths to be self-contained in the destination workspace.
 */
export async function importNotebookBundle(
  options: ImportBundleOptions,
): Promise<ImportBundleResult> {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(options.bundle);
  } catch {
    return { kind: "invalid", problem: "The bundle is not a valid zip archive." };
  }

  const manifestBytes = unzipped["manifest.json"];
  if (!manifestBytes) {
    return { kind: "invalid", problem: "The bundle does not contain a manifest.json." };
  }

  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes)) as BundleManifest;
  } catch {
    return { kind: "invalid", problem: "The bundle manifest.json is invalid JSON." };
  }

  if (manifest.formatVersion !== 1) {
    return {
      kind: "invalid",
      problem: `Unsupported bundle format version ${manifest.formatVersion}.`,
    };
  }

  const notebookBytes = unzipped["notebook.md"];
  if (!notebookBytes) {
    return { kind: "invalid", problem: "The bundle does not contain notebook.md." };
  }

  const targetName = options.to ?? manifest.originalNotebook;
  const targetResult = notebookTarget(options.directory, targetName);
  if ("problem" in targetResult) {
    return { kind: "invalid", problem: targetResult.problem };
  }
  const targetFile = targetResult.file;
  const targetRuns = runsDirectory(targetFile);

  if (!options.force) {
    if (existsSync(targetFile)) {
      return { kind: "exists", path: pathWithin(options.directory, targetFile) };
    }
    if (existsSync(targetRuns)) {
      return { kind: "exists", path: pathWithin(options.directory, targetRuns) };
    }
  }

  // Security: strict sandbox validation against Zip Slip
  for (const key of Object.keys(unzipped)) {
    if (key === "manifest.json" || key === "notebook.md") continue;
    if (!key.startsWith("runs/")) {
      return { kind: "invalid", problem: `Unsafe or unrecognized entry in bundle: ${key}` };
    }
    const parts = key.split("/");
    if (parts.some((p) => p === ".." || p === "." || p === "")) {
      return { kind: "invalid", problem: `Unsafe path in bundle entry: ${key}` };
    }
  }

  let createdFile = false;
  let createdRuns = false;

  try {
    await mkdir(dirname(targetFile), { recursive: true });
    await writeFile(targetFile, notebookBytes);
    createdFile = true;

    const runsKeys = Object.keys(unzipped).filter((k) => k.startsWith("runs/"));
    const runIds = new Set<string>();

    if (runsKeys.length > 0) {
      createdRuns = !existsSync(targetRuns);
      for (const k of runsKeys) {
        const sub = k.slice("runs/".length);
        const runId = sub.split("/")[0];
        if (runId) runIds.add(runId);
        const filePath = join(targetRuns, sub);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, unzipped[k]!);
      }

      // Rewrite record.json for all extracted runs
      for (const runId of runIds) {
        const recPath = join(targetRuns, runId, "record.json");
        if (!existsSync(recPath)) continue;
        try {
          const recText = await readFile(recPath, "utf8");
          const rec = JSON.parse(recText) as RunRecord;
          rec.notebook = targetFile;

          const localSharedSession = join(targetRuns, runId, "session.jsonl");
          if (existsSync(localSharedSession)) {
            rec.agentSession = resolve(localSharedSession);
          }

          if (rec.cells !== undefined) {
            for (const cell of rec.cells) {
              const localCellSession = join(targetRuns, runId, "sessions", `${cell.id}.jsonl`);
              if (existsSync(localCellSession)) {
                (cell as any).agentSession = resolve(localCellSession);
              } else if (rec.agentSession !== undefined && "agentSession" in cell) {
                (cell as any).agentSession = rec.agentSession;
              }
            }
          }

          await writeFile(recPath, JSON.stringify(rec, null, 2), "utf8");
        } catch {
          // If a record fails to parse, leave as is
        }
      }
    }

    const notebookText = strFromU8(notebookBytes);
    const parsed = parseNotebook(notebookText);
    const title = parsed.ok ? titleOf(parsed.notebook, targetFile) : manifest.title;

    return {
      kind: "imported",
      path: pathWithin(options.directory, targetFile),
      title,
      runs: manifest.runCount,
    };
  } catch (cause) {
    // Clean up partial extractions on failure
    if (createdFile && !options.force) {
      await rm(targetFile, { force: true }).catch(() => undefined);
    }
    if (createdRuns && !options.force) {
      await rm(targetRuns, { recursive: true, force: true }).catch(() => undefined);
    }
    return { kind: "invalid", problem: `Failed to unpack bundle: ${String(cause)}` };
  }
}
