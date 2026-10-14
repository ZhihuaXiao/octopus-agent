/**
 * Exporting: a Notebook and a Run's results made into one document that can be
 * handed to someone who will never run it.
 *
 * The other half of ADR-0005. Results live outside the Notebook, so sharing a
 * Notebook shares the program and not the answer; an Export puts the two back
 * together, in a file of its own, and leaves the Notebook exactly as it was.
 *
 * The document is one HTML file with everything it shows inside it: the
 * Notebook's Prose and Cells in order, what each Cell thought, said, did, ran
 * on and cost as of the Run chosen, and the files the Cells left — images
 * drawn, text shown, the rest offered for download — carried as data URLs rather than
 * linked, so the file stands alone wherever it is sent (ADR-0023). Nothing in
 * it runs: everything an agent wrote is text, a Content-Security-Policy in
 * the head permits no script and no fetch, and the credentials the machine
 * holds are struck out wherever a Cell repeated one (`credentials.ts`).
 */

import { readFile } from "node:fs/promises";

import type { ToolCall } from "../agent/agent.js";
import {
  type Cell,
  formatDiagnostics,
  formatDuration,
  isCellSegment,
  parseNotebook,
  titleOf,
} from "../notebook/notebook.js";
import type { CellRecord, CellStatus, PromptCellRecord, RunRecord } from "../run/record.js";
import { isImage, isText, latestRunId, readRunRecord, runFile, runFileType } from "../run/store.js";
import { isRecord } from "../util/guards.js";
import {
  type CredentialSources,
  credentialsHeld,
  holdsCredential,
  redactor,
} from "./credentials.js";

export interface ExportRequest extends CredentialSources {
  /** The Notebook, as an absolute path. Read, never written. */
  readonly notebook: string;
  /** The Run whose results are exported, by id; the latest to have finished when absent. */
  readonly run?: string;
}

/** How exporting went. Nothing is written either way: the document is the caller's to put somewhere. */
export type Exported =
  | {
      readonly kind: "exported";
      /** One HTML document, with everything it shows inside it. */
      readonly document: string;
      /** The Run whose results it holds. */
      readonly run: string;
    }
  /** No file at the Notebook's path. */
  | { readonly kind: "absent" }
  /** A file that is not a Notebook. */
  | { readonly kind: "invalid"; readonly problem: string }
  /** No Run to export: the Notebook has never been run, or no Run has the id named. */
  | { readonly kind: "no-run" };

/**
 * What the document may do when opened: show what is inside it and nothing
 * else. No script from anywhere, so nothing an agent wrote can run; no fetch
 * from anywhere, so the document reads the same offline and tells nobody it
 * was opened; its own styles and its own embedded images, and only those.
 */
const POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/**
 * How the document reads, in the Author View's own colours: a Cell is a card
 * with its status on its left edge, its body and output in monospace, and the
 * Prose around it as the author wrote it. Inline, since the document carries
 * everything it needs.
 */
const STYLE = `:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
body { max-width: 56rem; margin: 2rem auto; padding: 0 1rem; }
h1 { font-size: 1.6rem; }
pre { font-family: ui-monospace, monospace; font-size: 0.9rem; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
.account { display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 1rem; font-size: 0.85rem; opacity: 0.8; }
.account dt { font-weight: 600; } .account dd { margin: 0; font-family: ui-monospace, monospace; }
.prose { white-space: pre-wrap; margin: 1.5rem 0; }
.cell { border: 1px solid #8884; border-left: 4px solid #8888; border-radius: 4px; padding: 0.75rem 1rem; margin: 1rem 0; }
.cell.ok { border-left-color: #22c55e; } .cell.error, .cell.timeout { border-left-color: #ef4444; }
.cell.interrupted { border-left-color: #f59e0b; } .cell.stale { border-left-color: #a855f7; }
.cell header { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; font-size: 0.85rem; margin-bottom: 0.5rem; }
.cell-id { font-family: ui-monospace, monospace; font-weight: 600; }
.cell-type, .cell-attribute, .cell-from { font-family: ui-monospace, monospace; opacity: 0.7; }
.cell-status { margin-left: auto; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; }
.cell.error .cell-status, .cell.timeout .cell-status, .cell-error { opacity: 1; color: #ef4444; }
.cell.stale .cell-status { opacity: 1; color: #a855f7; } .cell.interrupted .cell-status { opacity: 1; color: #f59e0b; }
.body { padding: 0.5rem; background: #8881; border-radius: 3px; }
.output, .stderr, .thinking { margin-top: 0.75rem; } .output:empty { display: none; } .stderr { color: #ef4444; }
.thinking summary { cursor: pointer; }
.usage { font-size: 0.8rem; opacity: 0.7; font-family: ui-monospace, monospace; margin: 0.5rem 0 0; }
.tool-calls { list-style: none; padding: 0; margin: 0.75rem 0 0; font-size: 0.85rem; }
.tool-calls summary { cursor: pointer; } .tool-name { font-family: ui-monospace, monospace; font-weight: 600; }
.tool-gist { font-family: ui-monospace, monospace; opacity: 0.7; } .tool-calls pre { padding: 0.5rem; background: #8881; }
.artifacts { list-style: none; padding: 0; margin: 0.75rem 0 0; display: flex; flex-wrap: wrap; gap: 1rem; }
.artifact { font-size: 0.85rem; } .artifact.text { flex-basis: 100%; }
.artifact img { max-width: 100%; display: block; border: 1px solid #8884; }
.artifact-name { display: block; font-family: ui-monospace, monospace; opacity: 0.7; }
.withheld, .missing { color: #f59e0b; }`;

/** The keys a tool's input is best summed up by, in order of preference, as the Author View has them. */
const GIST_KEYS = ["command", "path", "file_path", "filePath", "pattern", "query", "url"];
const GIST_LENGTH = 100;
/** As much of one string of a tool's input as is shown: a `write` call's whole file need not be. */
const INPUT_STRING_LENGTH = 400;

/**
 * The one line a tool call is best summed up by: the command run, the path
 * read, or the first string it was given. Passed through `hide` whole before
 * it is cut, so a credential cannot survive by straddling the cut.
 */
function gistOf(input: unknown, hide: (text: string) => string): string {
  let gist: unknown = input;
  if (isRecord(input)) {
    const preferred = GIST_KEYS.find((key) => typeof input[key] === "string");
    gist =
      preferred !== undefined
        ? input[preferred]
        : Object.values(input).find((value) => typeof value === "string");
  }
  if (typeof gist !== "string") return "";
  const shown = hide(gist);
  const line = shown.split("\n")[0] ?? "";
  return line.length > GIST_LENGTH || line !== shown ? `${line.slice(0, GIST_LENGTH)}…` : line;
}

/**
 * A tool's input as JSON, its long strings cut short: what was invoked, not
 * everything it carried. Each string is passed through `hide` whole before it
 * is cut, for the same reason as the gist.
 */
const abridged = (input: unknown, hide: (text: string) => string) =>
  JSON.stringify(
    input,
    (_key, value: unknown) => {
      if (typeof value !== "string") return value;
      const shown = hide(value);
      return shown.length > INPUT_STRING_LENGTH
        ? `${shown.slice(0, INPUT_STRING_LENGTH)}… (${shown.length - INPUT_STRING_LENGTH} more characters)`
        : shown;
    },
    2,
  ) ?? "";

/** What a Prompt Cell ran on and spent, for a reader wondering why its reply is what it is. */
function usageOf(record: PromptCellRecord): string {
  const { inputTokens, outputTokens, cost } = record.usage;
  return `${record.model} · ${inputTokens} tokens in, ${outputTokens} out · $${cost.toFixed(4)}`;
}

/**
 * One Artifact as the record names it, with its bytes read from under the
 * Run's directory, or none when the file is no longer there to read.
 */
interface Artifact {
  /** The path as the record names it, relative to the Run's directory. */
  readonly path: string;
  readonly bytes?: Buffer;
}

/** A file's bytes as a URL the document carries inside itself, typed without the parameters a URL has no room for. */
const dataUrl = (type: string, bytes: Buffer) =>
  `data:${type.split(";")[0]};base64,${bytes.toString("base64")}`;

/**
 * Where a Cell stands in the Run exported: what its last Run recorded, Stale
 * because a Cell it uses has run again since, or never run at all.
 */
type Standing = CellStatus | "stale" | "not run";

/** The status in the words the Author View uses for it. */
const STANDING_WORDS: Readonly<Record<Standing, string>> = {
  ok: "ok",
  error: "error",
  timeout: "timed out",
  interrupted: "interrupted",
  stale: "stale",
  "not run": "not run",
};

/** A Cell's last record as of the Run exported, and the Run that recorded it. */
interface Recorded {
  readonly record: CellRecord;
  readonly run: string;
}

/** What the document shows of one Cell beside its declaration. */
interface Shown {
  readonly standing: Standing;
  /** Its last record, when it has one. */
  readonly record?: CellRecord;
  /** The Run that recorded it, when that is not the Run exported. */
  readonly from?: string;
  readonly artifacts: readonly Artifact[];
}

/**
 * Makes the pieces of the document, every piece of text it shows passed
 * through `hide` on its way to being escaped: what a Cell said or printed,
 * what a tool was given, a file's name, the Prose, the title. One place, so
 * that no piece can be added later that forgets to.
 */
function redactingRenderer(credentials: readonly string[]) {
  const hide = redactor(credentials);
  const show = (text: string) =>
    hide(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const toolCall = (call: ToolCall) =>
    `<li><details><summary><span class="tool-name">${show(call.name)}</span> <span class="tool-gist">${show(gistOf(call.input, hide))}</span></summary><pre>${show(abridged(call.input, hide))}</pre></details></li>`;

  /**
   * An Artifact embedded: an image drawn, a text file shown and offered under
   * its own name, anything else offered and never shown — the same reading the
   * server gives a file, and for the same reason: nothing an agent wrote is
   * run. A text file is struck through like any text, in the copy offered as
   * much as the one shown; a file that is not text and holds a credential
   * cannot be struck through without breaking it, so it is withheld and said
   * to be. One the record names that is gone is said to be gone.
   */
  const artifact = ({ path, bytes }: Artifact) => {
    const name = path.split("/").at(-1) ?? path;
    if (bytes === undefined) {
      return `<li class="artifact missing"><span class="artifact-name">${show(name)}</span> <span class="missing">no longer there</span></li>`;
    }
    const type = runFileType(name);
    if (isText(type)) {
      const text = hide(bytes.toString("utf8"));
      return `<li class="artifact text"><a href="${dataUrl(type, Buffer.from(text, "utf8"))}" download="${show(name)}">${show(name)}</a><pre>${show(text)}</pre></li>`;
    }
    if (holdsCredential(bytes, credentials)) {
      return `<li class="artifact withheld"><span class="artifact-name">${show(name)}</span> <span class="withheld">withheld: it holds a credential</span></li>`;
    }
    const url = dataUrl(type, bytes);
    if (isImage(type)) {
      return `<li class="artifact image"><img src="${url}" alt="${show(name)}"><span class="artifact-name">${show(name)}</span></li>`;
    }
    return `<li class="artifact"><a href="${url}" download="${show(name)}">${show(name)}</a></li>`;
  };

  const cell = (declared: Cell, shown: Shown) => {
    const { record, from, artifacts, standing } = shown;
    const attributes = [
      declared.isolated ? "isolated" : undefined,
      declared.uses.length > 0 ? `uses ${declared.uses.join(", ")}` : undefined,
      declared.model,
      declared.timeout !== undefined ? `timeout ${formatDuration(declared.timeout)}` : undefined,
    ]
      .filter((attribute) => attribute !== undefined)
      .map((attribute) => `<span class="cell-attribute">${show(attribute)}</span>`);
    const origin =
      from === undefined ? "" : ` <span class="cell-from">from run ${show(from)}</span>`;
    const parts = [
      `<header><span class="cell-id">${show(declared.id)}</span> <span class="cell-type">${declared.type}</span> ${attributes.join(" ")}${origin} <span class="cell-status">${STANDING_WORDS[standing]}</span></header>`,
      `<pre class="body">${show(declared.body)}</pre>`,
    ];
    if (record?.type === "prompt") {
      if (record.toolCalls.length > 0) {
        parts.push(`<ol class="tool-calls">${record.toolCalls.map(toolCall).join("")}</ol>`);
      }
      if (record.thinking !== undefined && record.thinking !== "") {
        parts.push(
          `<details class="thinking" open><summary>Thinking</summary>` +
            `<pre>${show(record.thinking)}</pre></details>`,
        );
      }
      parts.push(`<pre class="output">${show(record.text)}</pre>`);
      parts.push(`<p class="usage">${show(usageOf(record))}</p>`);
    }
    if (record?.type === "bash") {
      parts.push(`<pre class="output">${show(record.stdout)}</pre>`);
      if (record.stderr !== "") parts.push(`<pre class="stderr">${show(record.stderr)}</pre>`);
    }
    if (record?.error !== undefined) parts.push(`<p class="cell-error">${show(record.error)}</p>`);
    if (artifacts.length > 0) {
      parts.push(`<ul class="artifacts">${artifacts.map(artifact).join("\n")}</ul>`);
    }
    return `<section class="cell ${standing.replace(" ", "-")}">\n${parts.join("\n")}\n</section>`;
  };

  /**
   * Prose as written, less the blank lines at its edges, which around a Cell
   * are the file's spacing rather than anything to read. Prose that is only
   * spacing shows nothing at all.
   */
  const prose = (text: string) => {
    const shown = text.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
    return shown === "" ? undefined : `<div class="prose">${show(shown)}</div>`;
  };

  /**
   * The Run's own account, for a reader wondering when this happened and what
   * it cost: the id, so it can be found again beside the Notebook; the span;
   * and the cost of the records shown, which is what the work the reader is
   * looking at cost, across the chain when the Run continued one. Nothing of
   * the machine it ran on — no Workspace, no path — since the reader has none
   * of it.
   */
  const account = (record: RunRecord, shown: readonly Recorded[]) => {
    const cost = shown.reduce((sum, recorded) => sum + recorded.record.usage.cost, 0);
    const rows: [string, string][] = [
      ["Run", record.id],
      ["Ran", `${record.startedAt} to ${record.endedAt}`],
      ["Cost", `$${cost.toFixed(4)}`],
    ];
    return `<dl class="account">${rows.map(([term, detail]) => `<dt>${show(term)}</dt><dd>${show(detail)}</dd>`).join("")}</dl>`;
  };

  const document = (title: string, body: readonly string[]) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${POLICY}">
<title>${show(title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<h1>${show(title)}</h1>
${body.join("\n")}
</body>
</html>
`;

  return { cell, prose, account, document };
}

/**
 * What each Cell last recorded as of the Run exported, and in which Run: the
 * Run's own Cells, and for the rest the nearest Run back along the chain it
 * continues that ran them (ADR-0004 keeps a partial Run's record to the Cells
 * it ran). A Run in the chain whose record is gone ends the walk — what it
 * held cannot be shown, and is shown as never run — as does a Run met twice,
 * which only a record edited by hand could make.
 */
async function recordedAsOf(notebook: string, record: RunRecord): Promise<Map<string, Recorded>> {
  const recorded = new Map<string, Recorded>();
  const walked = new Set<string>();
  let current: RunRecord | undefined = record;
  while (current !== undefined && !walked.has(current.id)) {
    walked.add(current.id);
    for (const cell of current.cells) {
      if (!recorded.has(cell.id)) recorded.set(cell.id, { record: cell, run: current.id });
    }
    current =
      current.continues === undefined
        ? undefined
        : await readRunRecord(notebook, current.continues);
  }
  return recorded;
}

/**
 * The Artifacts a Cell's record names, read from under the Run's directory as
 * `runFile` finds them. One that is not there — or that leads out of the Run's
 * directory — has no bytes, and the document says it is gone.
 */
async function artifactsOf(notebook: string, recorded: Recorded): Promise<Artifact[]> {
  const found: Artifact[] = [];
  for (const path of recorded.record.artifacts) {
    const file = await runFile(notebook, recorded.run, path);
    found.push(file === undefined ? { path } : { path, bytes: await readFile(file) });
  }
  return found;
}

export async function exportNotebook(request: ExportRequest): Promise<Exported> {
  const { notebook } = request;
  let source: string;
  try {
    source = await readFile(notebook, "utf8");
  } catch (cause) {
    const { code } = cause as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return { kind: "absent" };
    throw cause;
  }
  const parsed = parseNotebook(source);
  if (!parsed.ok) {
    return {
      kind: "invalid",
      problem: `${notebook} is not a notebook:\n${formatDiagnostics(parsed.errors)}`,
    };
  }
  const run = request.run ?? (await latestRunId(notebook));
  const record = run === undefined ? undefined : await readRunRecord(notebook, run);
  if (run === undefined || record === undefined) return { kind: "no-run" };

  const render = redactingRenderer(await credentialsHeld(request));
  const recorded = await recordedAsOf(notebook, record);
  const stale = new Set(record.stale);
  const shownRecords: Recorded[] = [];
  const body: string[] = [];
  for (const segment of parsed.notebook.segments) {
    if (!isCellSegment(segment)) {
      const shown = render.prose(segment.text);
      if (shown !== undefined) body.push(shown);
      continue;
    }
    const { cell } = segment;
    const found = recorded.get(cell.id);
    if (found !== undefined) shownRecords.push(found);
    body.push(
      render.cell(cell, {
        standing:
          found === undefined ? "not run" : stale.has(cell.id) ? "stale" : found.record.status,
        ...(found !== undefined ? { record: found.record } : {}),
        ...(found !== undefined && found.run !== record.id ? { from: found.run } : {}),
        artifacts: found === undefined ? [] : await artifactsOf(notebook, found),
      }),
    );
  }
  return {
    kind: "exported",
    document: render.document(titleOf(parsed.notebook, notebook), [
      render.account(record, shownRecords),
      ...body,
    ]),
    run,
  };
}
