/**
 * The server: owns Notebook Sessions, serves the browser client, streams events
 * and handles auth. This is where the launcher's web flags arrive.
 *
 * It binds to loopback, serves the client, lists the Notebooks under the
 * directory it was started in, and opens them into Notebook Sessions that it
 * owns: a Run started from a browser carries on when the browser has gone.
 * Commands — open, run, interrupt, save, create, duplicate, promote, export, the model settings, a one-token check that a configured model answers, and the model a Notebook names — are HTTP
 * requests, each with an answer; what a Run produces is a stream, and goes to
 * the browser over a WebSocket; what a Run leaves — its Artifacts, its record
 * — is served from under the Run's directory, so the browser can show a file
 * where the record names it. An Export is the Notebook and a Run as one
 * document to download and send on. A save writes the Notebook's file, and only
 * the bytes the edit changed, so a diff of the file shows what the author did
 * and no more.
 * Loopback unless told otherwise, because starting it must never expose the
 * machine by accident (ADR-0006); and everything that does or shows anything
 * — the API, and the socket the events come over — takes only a request the
 * account has authenticated (`auth.ts`). The shell itself is served to anyone
 * who asks, since it is where a browser authenticates and holds nothing.
 */

import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { basename, extname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { WebSocketServer } from "ws";

import type { AgentFactory } from "../agent/agent.js";
import type { CellEdit, SegmentEdit } from "../notebook/edit.js";
import { DOWNLOAD, runFileType } from "../run/store.js";
import { isRecord } from "../util/guards.js";
import { within } from "../util/paths.js";
import { type Attempt, type Auth, type Credential, createAuth } from "./auth.js";
import { type ChatsOptions, deleteChat, listChats, promoteChat } from "./chats.js";
import {
  type DefaultEdit,
  type ProviderEdit,
  isConfiguredModel,
  readModelPage,
  saveDefaultModel,
  saveProviderKey,
  saveProviders,
  testConfiguredModel,
} from "./models.js";
import { copyNotebook, createNotebook, listNotebooks, listTree } from "./notebooks.js";
import {
  type NotebookSessions,
  type RunRequest,
  type SaveRequest,
  createNotebookSessions,
} from "./notebook-session.js";

/** The address the server listens on: this machine, and nothing beyond it. */
const LOOPBACK = "127.0.0.1";

/**
 * The port when none is asked for. Fixed rather than left to the operating
 * system, so the URL is the same every morning and a bookmark keeps working;
 * one already in use is reported rather than quietly worked around.
 */
export const DEFAULT_PORT = 8008;

/**
 * The client, served as the files it is written as. They sit beside `src` and
 * `dist` rather than inside either, so the same relative path finds them from
 * the source under test and from the build the command runs.
 */
const CLIENT_DIRECTORY = fileURLToPath(new URL("../../client/", import.meta.url));
const CLIENT_ROUTE = "/client/";
const SHELL = "index.html";
/** Everything that does or shows anything, and so takes only an authenticated request. */
const API_ROUTE = "/api/";
/** Where the shell presents the password, or a pasted token, to open a Connection; the one thing under the API that needs none. */
const CONNECT_ROUTE = "/api/connect";
const NOTEBOOKS_ROUTE = "/api/notebooks";
/** The served directory as folders and files, for the sidebar. */
const TREE_ROUTE = "/api/tree";
/** A Notebook's file renamed, Runs included, the session following when one holds it. */
const RENAME_ROUTE = "/api/notebooks/rename";
/** The model a Notebook names, chosen from the models the user can already call. */
const NOTEBOOK_MODEL_ROUTE = "/api/notebooks/model";
/** Pi's model settings: the default, and the custom providers. */
const MODELS_ROUTE = "/api/models";
const MODELS_DEFAULT_ROUTE = "/api/models/default";
const MODELS_KEY_ROUTE = "/api/models/key";
const MODELS_PROVIDERS_ROUTE = "/api/models/providers";
/** One token sent to a configured model, to see whether it answers. */
const MODELS_TEST_ROUTE = "/api/models/test";
/** The query the startup URL carries the token in, and the cookie a browser carries its Connection in. */
const TOKEN_QUERY = "token";
const CONNECTION_COOKIE = "octo_connection";
const SESSIONS_ROUTE = "/api/sessions";
/** The chats pi has had in the served directory. */
const CHATS_ROUTE = "/api/chats";
/** One of them, to be promoted into a Notebook. */
const PROMOTE_ROUTE = /^\/api\/chats\/([^/]+)\/promote$/;
/** One of them, to be removed: its session file, and nothing already made from it. */
const DELETE_CHAT_ROUTE = /^\/api\/chats\/([^/]+)$/;
/** A Notebook Session by id, and what may be asked of it. */
const SESSION_ROUTE = /^\/api\/sessions\/([^/]+)(?:\/(run|interrupt|save|events|export))?$/;
/** The model rounds of one Cell that has run, read from the Agent Session. */
const ROUNDS_ROUTE = /^\/api\/sessions\/([^/]+)\/cells\/([^/]+)\/rounds$/;
/** The query naming which Run an export is of, when not the latest. */
const RUN_QUERY = "run";
/** A file of one of a Notebook Session's Runs: an Artifact, or the Run's record. */
const RUN_FILE_ROUTE = /^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/(.+)$/;

/** The kinds of file the client is made of; anything else under `/client/` is not served. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** What a browser fetches a page and its assets with; Node itself leaves a HEAD's body out. */
const READS: readonly string[] = ["GET", "HEAD"];
const WRITES: readonly string[] = ["POST"];

/** As much as a request's body may be: a Notebook being saved, which is Markdown, not its Artifacts. */
const LONGEST_BODY = 1024 * 1024;

export interface ServerOptions {
  /**
   * The port to listen on; `DEFAULT_PORT` when absent. Zero asks the operating
   * system for a free one, which is what a test wants and nobody else does.
   */
  readonly port?: number;
  /**
   * The address to bind; loopback when absent. Naming one is the deliberate
   * act ADR-0006 asks for: anyone who reaches the port and authenticates can
   * run code as the server's user, so nothing binds beyond loopback unasked.
   */
  readonly host?: string;
  /** The directory whose Notebooks are served; the working directory when absent. */
  readonly directory?: string;
  /** Makes the agent each Run's Prompt Cells go to: pi's, or a scripted one under test. */
  readonly agent: AgentFactory;
  /**
   * The password as `password.ts` stored it — its hash, never the password —
   * when that is what the account authenticates with; absent, a token is
   * generated for this start and carried in the URL.
   */
  readonly storedPassword?: string;
  /**
   * Where pi keeps the served directory's chats, for promoting one into a
   * Notebook. Pi's own place for them when absent; named by a test, so that
   * none reads what pi has on the machine it runs on.
   */
  readonly chatDirectory?: string;
  /**
   * Where pi keeps its settings and custom models. Pi's own place when
   * absent; named by a test, so that none reads or writes the machine's.
   */
  readonly agentDirectory?: string;
}

export interface RunningServer {
  /** Where a browser opens it. */
  readonly url: string;
  /** The directory whose Notebooks it serves, resolved. */
  readonly directory: string;
  close(): Promise<void>;
}

function reply(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  response.end(body);
}

const notFound = (response: ServerResponse) => reply(response, 404, "Not found\n");

/**
 * The client file a path names, or nothing when it names none — including a
 * path that climbs out of the client directory, however it spells the climb,
 * and one no file system would accept as a name.
 */
function clientFile(pathname: string): string | undefined {
  let name: string;
  try {
    name = pathname === "/" ? SHELL : decodeURIComponent(pathname.slice(CLIENT_ROUTE.length));
  } catch {
    return undefined; // A percent sign that escapes nothing names no file.
  }
  if (name.includes("\0")) return undefined;
  const file = resolve(CLIENT_DIRECTORY, name);
  return within(CLIENT_DIRECTORY, file) ? file : undefined;
}

async function serveClient(pathname: string, response: ServerResponse): Promise<void> {
  const file = clientFile(pathname);
  const type = file === undefined ? undefined : CONTENT_TYPES[extname(file)];
  if (file === undefined || type === undefined) {
    notFound(response);
    return;
  }

  try {
    const contents = await readFile(file);
    response.writeHead(200, { "content-type": type });
    response.end(contents);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") notFound(response);
    else throw cause;
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function serveNotebooks(directory: string, response: ServerResponse): Promise<void> {
  const notebooks = await listNotebooks(directory);
  json(response, 200, { directory, notebooks });
}

/** The served directory as folders and the files in them, so the sidebar can open a folder. */
async function serveTree(directory: string, response: ServerResponse): Promise<void> {
  json(response, 200, { directory, entries: await listTree(directory) });
}

/** Pi's models and the default a Run uses when a Notebook does not name one. */
async function serveModels(agentDirectory: string, response: ServerResponse): Promise<void> {
  const read = await readModelPage(agentDirectory);
  if (!read.ok) {
    reply(response, 422, `${read.problem}\n`);
    return;
  }
  json(response, 200, read.value);
}

async function saveModelsDefault(
  agentDirectory: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const edit = defaultEditOf(await readJson(request));
  if (edit === undefined) {
    reply(
      response,
      400,
      "The request must name a provider and a model, and may name a thinking level, as JSON.\n",
    );
    return;
  }
  const saved = await saveDefaultModel(agentDirectory, edit);
  if (!saved.ok) {
    reply(response, 422, `${saved.problem}\n`);
    return;
  }
  response.writeHead(204);
  response.end();
}

async function saveModelProviders(
  agentDirectory: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const edits = providerEditsOf(await readJson(request));
  if (edits === undefined) {
    reply(response, 400, "The request must list the providers, as JSON.\n");
    return;
  }
  const saved = await saveProviders(agentDirectory, edits);
  if (!saved.ok) {
    reply(response, 422, `${saved.problem}\n`);
    return;
  }
  response.writeHead(204);
  response.end();
}

/** Asks a configured model for one token and reports whether it answered. */
async function testModel(
  agentDirectory: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request);
  if (
    !isRecord(body) ||
    !hasKeys(body, ["provider", "model"]) ||
    typeof body.provider !== "string" ||
    typeof body.model !== "string"
  ) {
    reply(response, 400, "The request must name a provider and a model, as JSON.\n");
    return;
  }
  const tested = await testConfiguredModel(agentDirectory, body.provider, body.model);
  if (!tested.ok) {
    reply(response, 422, `${tested.problem}\n`);
    return;
  }
  json(response, 200, tested.value);
}

async function saveModelKey(
  agentDirectory: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request);
  if (
    !isRecord(body) ||
    !hasKeys(body, ["provider", "apiKey"]) ||
    typeof body.provider !== "string" ||
    typeof body.apiKey !== "string"
  ) {
    reply(response, 400, "The request must name a provider and a key, as JSON.\n");
    return;
  }
  const saved = await saveProviderKey(agentDirectory, body.provider, body.apiKey);
  if (!saved.ok) {
    reply(response, 422, `${saved.problem}\n`);
    return;
  }
  response.writeHead(204);
  response.end();
}

function defaultEditOf(body: unknown): DefaultEdit | undefined {
  if (!isRecord(body) || !hasKeys(body, ["provider", "model"], ["thinking"])) return undefined;
  if (typeof body.provider !== "string" || typeof body.model !== "string") return undefined;
  if (body.thinking !== undefined && typeof body.thinking !== "string") return undefined;
  return {
    provider: body.provider,
    model: body.model,
    ...(body.thinking !== undefined ? { thinking: body.thinking } : {}),
  };
}

function providerEditsOf(body: unknown): ProviderEdit[] | undefined {
  if (!isRecord(body) || !hasKeys(body, ["providers"]) || !Array.isArray(body.providers)) {
    return undefined;
  }
  const edits: ProviderEdit[] = [];
  for (const value of body.providers) {
    const edit = providerEditOf(value);
    if (edit === undefined) return undefined;
    edits.push(edit);
  }
  return edits;
}

function providerEditOf(value: unknown): ProviderEdit | undefined {
  if (!isRecord(value)) return undefined;
  if (!hasKeys(value, ["id", "baseUrl", "api", "models"], ["apiKey", "clearApiKey"]))
    return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.baseUrl !== "string" ||
    typeof value.api !== "string"
  ) {
    return undefined;
  }
  if (!Array.isArray(value.models) || value.models.some((id) => typeof id !== "string"))
    return undefined;
  if (value.apiKey !== undefined && typeof value.apiKey !== "string") return undefined;
  if (value.clearApiKey !== undefined && typeof value.clearApiKey !== "boolean") return undefined;
  return {
    id: value.id,
    baseUrl: value.baseUrl,
    api: value.api,
    models: value.models as string[],
    ...(value.apiKey !== undefined ? { apiKey: value.apiKey } : {}),
    ...(value.clearApiKey !== undefined ? { clearApiKey: value.clearApiKey } : {}),
  };
}

/** Renames a Notebook, and the session that holds it when one does. */
async function renameOpen(
  served: Served,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request);
  if (
    !isRecord(body) ||
    !hasKeys(body, ["from", "to"]) ||
    typeof body.from !== "string" ||
    typeof body.to !== "string"
  ) {
    reply(response, 400, "The request must name the notebook and the new name, as JSON.\n");
    return;
  }

  const renamed = await served.sessions.rename(body.from, body.to);
  switch (renamed.kind) {
    case "absent":
      notFound(response);
      return;
    case "invalid":
      reply(response, 400, `${renamed.problem}\n`);
      return;
    case "exists":
      reply(response, 409, `There is already a file named ${body.to}.\n`);
      return;
    case "runs":
      reply(response, 409, `There are already runs stored for ${body.to}.\n`);
      return;
    case "running":
      reply(response, 409, "This notebook is running; interrupt it or wait, then rename it.\n");
      return;
    case "renamed":
      json(response, 200, renamed.entry);
      return;
  }
}

/**
 * The model a request names, `provider/id`, or nothing when it is not one.
 * An empty string is a request to clear the Notebook's model.
 */
function requestedModel(model: string): { provider: string; id: string } | "" | undefined {
  if (model === "") return "";
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  const provider = model.slice(0, slash);
  const id = model.slice(slash + 1);
  // The id is whatever the provider lists, which may contain a space. The
  // provider name is the part pi uses to find a credential, and that does not.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider) || id.trim() === "" || id !== id.trim()) {
    return undefined;
  }
  return { provider, id };
}

/** Sets the model a Notebook names, from the models the user can already call. */
async function assignModel(
  served: Served,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request);
  if (
    !isRecord(body) ||
    !hasKeys(body, ["notebook", "model"]) ||
    typeof body.notebook !== "string" ||
    typeof body.model !== "string"
  ) {
    reply(
      response,
      400,
      "The request must name the notebook and the model, as JSON. An empty model clears it.\n",
    );
    return;
  }

  const named = requestedModel(body.model.trim());
  if (named === undefined) {
    reply(response, 400, "Name the model as provider/model.\n");
    return;
  }
  if (named !== "") {
    const configured = await isConfiguredModel(served.agentDirectory, named.provider, named.id);
    if (!configured.ok) {
      reply(response, 422, `${configured.problem}\n`);
      return;
    }
    if (!configured.value) {
      reply(
        response,
        422,
        `No configured model ${named.provider}/${named.id}. Choose one whose provider has a stored key, or a custom provider.\n`,
      );
      return;
    }
  }

  const assigned = await served.sessions.setModel(
    body.notebook,
    named === "" ? undefined : `${named.provider}/${named.id}`,
  );
  switch (assigned.kind) {
    case "absent":
      notFound(response);
      return;
    case "refused":
      reply(response, 422, `${assigned.problem}\n`);
      return;
    case "saved":
      json(response, 200, assigned.entry);
      return;
  }
}

/**
 * Writes a Notebook under a new name: a copy of one named `from`, so it can be
 * adapted rather than written from nothing; or, named nothing to copy, a new
 * one to be written from nothing.
 */
async function addNotebook(
  directory: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request);
  if (!isRecord(body) || typeof body.to !== "string" || !hasKeys(body, ["to"], ["from"])) {
    reply(
      response,
      400,
      "The request must name the new notebook, and the notebook to copy when it is a copy, as JSON.\n",
    );
    return;
  }
  if (body.from === undefined) {
    await newNotebook(directory, body.to, response);
    return;
  }
  if (typeof body.from !== "string") {
    reply(response, 400, "The notebook to copy must be named as a string.\n");
    return;
  }

  const copied = await copyNotebook(directory, body.from, body.to);
  switch (copied.kind) {
    case "absent":
      notFound(response);
      return;
    case "invalid":
      reply(response, 400, `${copied.problem}\n`);
      return;
    case "exists":
      reply(response, 409, `There is already a file named ${body.to}.\n`);
      return;
    case "copied":
      json(response, 201, copied.entry);
      return;
  }
}

async function newNotebook(directory: string, to: string, response: ServerResponse): Promise<void> {
  const created = await createNotebook(directory, to);
  switch (created.kind) {
    case "invalid":
      reply(response, 400, `${created.problem}\n`);
      return;
    case "exists":
      reply(response, 409, `There is already a file named ${to}.\n`);
      return;
    case "created":
      json(response, 201, created.entry);
      return;
  }
}

/** The chats pi has had in the served directory, for the browser to offer promoting. */
async function serveChats(served: Served, response: ServerResponse): Promise<void> {
  json(response, 200, { chats: await listChats(served.directory, served.chats) });
}

/** Promotes a chat into a Notebook under a new name, so ad-hoc work becomes repeatable after the fact. */
async function promote(
  served: Served,
  matched: RegExpExecArray,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!permitted(WRITES, request, response)) return;
  const id = decoded(matched[1] ?? "");
  const body = await readJson(request);
  if (!isRecord(body) || !hasKeys(body, ["to"]) || typeof body.to !== "string") {
    reply(response, 400, "The request must name the notebook to write the chat to, as JSON.\n");
    return;
  }

  const promoted = await promoteChat(served.directory, id ?? "", body.to, served.chats);
  switch (promoted.kind) {
    case "absent":
      notFound(response);
      return;
    case "invalid":
      reply(response, 400, `${promoted.problem}\n`);
      return;
    case "exists":
      reply(response, 409, `There is already a file named ${body.to}.\n`);
      return;
    case "promoted":
      json(response, 201, promoted.entry);
      return;
  }
}

/** Removes a chat the reader named: the session file pi listed, after they asked. */
async function removeChat(
  served: Served,
  matched: RegExpExecArray,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!permitted(["DELETE"], request, response)) return;
  const id = decoded(matched[1] ?? "");
  const removed = await deleteChat(served.directory, id ?? "", served.chats);
  switch (removed.kind) {
    case "absent":
      notFound(response);
      return;
    case "refused":
      reply(response, 422, `${removed.problem}\n`);
      return;
    case "removed":
      response.writeHead(204);
      response.end();
      return;
  }
}

/** A request's body read as JSON, or nothing when it is not JSON. Too long a body is a mistake too. */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    length += buffer.length;
    if (length > LONGEST_BODY) return undefined;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** The Run a body asks for, or nothing when the body is not one: unknown keys are a mistake. */
function runRequestOf(body: unknown): RunRequest | undefined {
  if (!isRecord(body)) return undefined;
  const request: { cells?: string[]; inputs?: Record<string, string> } = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "cells" && isStrings(value)) request.cells = value;
    else if (
      key === "inputs" &&
      isRecord(value) &&
      Object.values(value).every((item) => typeof item === "string")
    ) {
      request.inputs = value as Record<string, string>;
    } else return undefined;
  }
  return request;
}

/** Whether `value` is a record with exactly the keys named, some of them optional. */
function hasKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

/** One segment of a Notebook as a request describes it, or nothing when it is not one. */
function segmentEditOf(value: unknown): SegmentEdit | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "prose") {
    return hasKeys(value, ["kind", "text"]) && typeof value.text === "string"
      ? { kind: "prose", text: value.text }
      : undefined;
  }
  if (value.kind !== "cell") return undefined;
  if (!hasKeys(value, ["kind", "id", "type", "body", "uses", "isolated"], ["model", "timeout"])) {
    return undefined;
  }
  const { id, type, body, uses, isolated, model, timeout } = value;
  if (typeof id !== "string" || typeof body !== "string" || typeof isolated !== "boolean") {
    return undefined;
  }
  if (type !== "prompt" && type !== "bash") return undefined;
  if (!isStrings(uses)) return undefined;
  if (model !== undefined && typeof model !== "string") return undefined;
  if (timeout !== undefined && typeof timeout !== "string") return undefined;
  const cell: CellEdit = { kind: "cell", id, type, body, uses, isolated };
  return {
    ...cell,
    ...(model !== undefined ? { model } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

/** The save a body asks for, or nothing when the body is not one. */
function saveRequestOf(body: unknown): SaveRequest | undefined {
  if (!isRecord(body) || !hasKeys(body, ["base", "segments"], ["frontmatter"])) return undefined;
  const { base, segments, frontmatter } = body;
  if (typeof base !== "string" || !Array.isArray(segments)) return undefined;
  if (frontmatter !== undefined && typeof frontmatter !== "string") return undefined;
  const read = segments.map(segmentEditOf);
  const edits = read.filter((segment) => segment !== undefined);
  if (edits.length !== read.length) return undefined;
  return { base, segments: edits, ...(frontmatter !== undefined ? { frontmatter } : {}) };
}

async function openSession(
  sessions: NotebookSessions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request);
  if (!isRecord(body) || typeof body.notebook !== "string") {
    reply(response, 400, "The request must name a notebook to open, as JSON.\n");
    return;
  }

  const opened = await sessions.open(body.notebook);
  switch (opened.kind) {
    case "absent":
      notFound(response);
      return;
    case "refused":
      reply(response, 422, `${opened.problem}\n`);
      return;
    case "opened":
      json(response, opened.created ? 201 : 200, opened.session.state());
      return;
  }
}

/** The model rounds of one Cell, as JSON, once that Cell has run. */
async function serveRounds(
  sessions: NotebookSessions,
  matched: RegExpExecArray,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!permitted(READS, request, response)) return;
  const session = sessions.get(matched[1] ?? "");
  const cell = decoded(matched[2] ?? "");
  if (session === undefined || cell === undefined) {
    notFound(response);
    return;
  }
  const read = await session.rounds(cell);
  if (!read.ok) {
    reply(response, 422, `${read.problem}\n`);
    return;
  }
  json(response, 200, read.value);
}

async function serveSession(
  sessions: NotebookSessions,
  matched: RegExpExecArray,
  request: IncomingMessage,
  response: ServerResponse,
  searchParams: URLSearchParams,
): Promise<void> {
  const [, id = "", action] = matched;
  // The state, the events and an export are read; a run and an interrupt change things.
  const allowed =
    action === undefined || action === "events" || action === "export" ? READS : WRITES;
  if (!permitted(allowed, request, response)) return;

  const session = sessions.get(id);
  if (session === undefined) {
    notFound(response);
    return;
  }

  switch (action) {
    case undefined:
      json(response, 200, session.state());
      return;
    case "run": {
      const asked = runRequestOf(await readJson(request));
      if (asked === undefined) {
        reply(response, 400, "The request may name cells to run and values for inputs, as JSON.\n");
        return;
      }
      if (!session.run(asked)) {
        reply(response, 409, "This notebook is already running; interrupt it or wait.\n");
        return;
      }
      json(response, 202, session.state());
      return;
    }
    case "interrupt":
      // Answered once the Run has stopped, so the answer means what it says:
      // nothing is running now, and the next `run` will be taken.
      await session.interrupt();
      response.writeHead(204);
      response.end();
      return;
    case "save": {
      const asked = saveRequestOf(await readJson(request));
      if (asked === undefined) {
        reply(
          response,
          400,
          "The request must carry the notebook's segments and the revision it was based on, as JSON.\n",
        );
        return;
      }
      const saved = await session.save(asked);
      switch (saved.kind) {
        case "changed":
          reply(response, 409, `${saved.problem}\n`);
          return;
        case "refused":
          reply(response, 422, `${saved.problem}\n`);
          return;
        case "saved":
          json(response, 200, session.state());
          return;
      }
    }
    case "events":
      // A plain read of the events: the WebSocket handshake is an upgrade and
      // never arrives here, so whoever did is told what to connect with.
      reply(response, 426, "Connect to the events with a WebSocket.\n", { upgrade: "websocket" });
      return;
    case "export": {
      const asked = searchParams.get(RUN_QUERY);
      const run = asked === null || asked === "" ? undefined : asked;
      const exported = await session.export(run);
      switch (exported.kind) {
        case "absent":
          notFound(response);
          return;
        case "invalid":
          reply(response, 422, `${exported.problem}\n`);
          return;
        case "no-run":
          reply(
            response,
            404,
            run === undefined
              ? "This notebook has no finished run to export; run it first.\n"
              : `This notebook has no run "${run}".\n`,
          );
          return;
        case "exported": {
          // A download under the Notebook's name and the Run's, so two exports
          // of one Notebook do not land on each other; as HTML, since it is one,
          // and never run in this origin, which `attachment` sees to.
          const { notebook } = session.state();
          const name = `${basename(notebook, extname(notebook))}-${exported.run}.html`;
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "x-content-type-options": "nosniff",
            "content-disposition": attachment(name),
          });
          response.end(exported.document);
          return;
        }
      }
    }
  }
}

/** A path's segments as written in the URL, decoded; nothing when a percent sign escapes nothing. */
function decoded(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

async function serveRunFile(
  sessions: NotebookSessions,
  matched: RegExpExecArray,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!permitted(READS, request, response)) return;
  const [, id = "", run = "", path = ""] = matched;
  const session = sessions.get(id);
  const file = await session?.runFile(decoded(run) ?? "\0", decoded(path) ?? "\0");
  if (file === undefined) {
    notFound(response);
    return;
  }

  let contents: Buffer;
  try {
    contents = await readFile(file);
  } catch (cause) {
    const { code } = cause as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") notFound(response);
    else throw cause;
    return;
  }

  // What a file is served as is what `store.ts` says it is: an image drawn, text
  // shown, anything else a download, since the files a Run leaves share an
  // origin with the client and a page served as one could read whatever the
  // client holds.
  const type = runFileType(file);
  response.writeHead(200, {
    "content-type": type,
    // Served as what its name says and nothing else, whatever its bytes look like.
    "x-content-type-options": "nosniff",
    ...(type === DOWNLOAD ? { "content-disposition": attachment(basename(file)) } : {}),
  });
  response.end(contents);
}

/**
 * A Content-Disposition offering the file for download under `name`. A header
 * carries only Latin-1 as written, so the name is spelt out UTF-8-encoded as
 * `filename*` (RFC 6266) beside a `filename` browsers without it fall back on,
 * with whatever cannot be written there replaced.
 */
function attachment(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Whether the request's method is one the route takes; a 405 saying which are, when not. */
function permitted(
  allowed: readonly string[],
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  if (allowed.includes(request.method ?? "")) return true;
  reply(response, 405, "Method not allowed\n", { allow: allowed.join(", ") });
  return false;
}

interface Served {
  readonly directory: string;
  readonly sessions: NotebookSessions;
  readonly auth: Auth;
  /** Where the served directory's chats are, when not where pi keeps them. */
  readonly chats: ChatsOptions;
  /** Where pi keeps its settings and custom models. */
  readonly agentDirectory: string;
}

/** The value of one cookie among those a request carries, or nothing. */
function cookie(request: IncomingMessage, name: string): string | undefined {
  for (const pair of (request.headers.cookie ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator !== -1 && pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/** The bearer a request presents in its Authorization header, or nothing. */
function bearer(request: IncomingMessage): string | undefined {
  const matched = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "");
  return matched?.[1];
}

/**
 * Whether the request is the account's: it carries a Connection the server
 * opened, or the token itself. A bearer that is not the token is a guess,
 * and is counted as one; a cookie the server does not know is not, and is
 * simply refused.
 */
async function authenticate(auth: Auth, request: IncomingMessage): Promise<Attempt> {
  const connection = cookie(request, CONNECTION_COOKIE);
  if (connection !== undefined && auth.connected(connection)) return { kind: "accepted" };
  const token = bearer(request);
  if (token === undefined) return { kind: "refused" };
  return auth.attempt({ kind: "token", value: token });
}

/** Refuses a request whose credential was not accepted, as its attempt deserves. */
function refuse(
  auth: Auth,
  attempt: Exclude<Attempt, { kind: "accepted" }>,
  response: ServerResponse,
): void {
  if (attempt.kind === "wait") tooSoon(attempt.seconds, response);
  else unauthenticated(auth, response);
}

/** How a Connection is handed to the browser: to be sent back on every request, and to no other site. */
const connectionCookie = (id: string) =>
  `${CONNECTION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict`;

/** Refuses an unauthenticated request, saying which credential this server takes. */
const unauthenticated = (auth: Auth, response: ServerResponse) =>
  json(response, 401, { authenticate: auth.method });

/** Refuses to look at a credential so soon after a wrong one, saying when to try again. */
const tooSoon = (seconds: number, response: ServerResponse) =>
  reply(
    response,
    429,
    `Too soon after a wrong attempt: wait ${seconds} ${seconds === 1 ? "second" : "seconds"} before trying again.\n`,
    { "retry-after": String(seconds) },
  );

/**
 * The browser following the URL the server printed: the token in the query
 * opens a Connection, and the browser is sent on to the shell, so the token
 * is out of its address bar and its history. A token that is not this
 * server's — the URL of a start before this one — sends the browser on with
 * nothing, and the shell says what to do.
 */
async function arriveWithToken(auth: Auth, token: string, response: ServerResponse): Promise<void> {
  const attempt = await auth.attempt({ kind: "token", value: token });
  const headers: Record<string, string> = { location: "/" };
  if (attempt.kind === "accepted") headers["set-cookie"] = connectionCookie(auth.connect());
  reply(response, 303, "", headers);
}

/** The credential a body presents — exactly one — or nothing when the body is not one. */
function credentialOf(body: unknown): Credential | undefined {
  if (!isRecord(body)) return undefined;
  for (const kind of ["token", "password"] as const) {
    if (hasKeys(body, [kind]) && typeof body[kind] === "string") {
      return { kind, value: body[kind] };
    }
  }
  return undefined;
}

/**
 * The shell presenting what the account authenticates with: the password, or
 * a token pasted from the URL. Right, it opens a Connection the browser
 * carries from here on; wrong, it is refused and the next attempt made to wait.
 */
async function openConnection(
  auth: Auth,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const credential = credentialOf(await readJson(request));
  if (credential === undefined) {
    reply(response, 400, "The request must present a password or a token, as JSON.\n");
    return;
  }
  const attempt = await auth.attempt(credential);
  if (attempt.kind !== "accepted") {
    refuse(auth, attempt, response);
    return;
  }
  response.writeHead(204, { "set-cookie": connectionCookie(auth.connect()) });
  response.end();
}

async function handle(
  served: Served,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const { pathname, searchParams } = new URL(request.url ?? "/", `http://${LOOPBACK}`);

  if (pathname === "/" && searchParams.has(TOKEN_QUERY) && READS.includes(request.method ?? "")) {
    await arriveWithToken(served.auth, searchParams.get(TOKEN_QUERY) ?? "", response);
    return;
  }
  if (pathname === CONNECT_ROUTE) {
    if (permitted(WRITES, request, response)) await openConnection(served.auth, request, response);
    return;
  }
  if (pathname.startsWith(API_ROUTE)) {
    const attempt = await authenticate(served.auth, request);
    if (attempt.kind !== "accepted") {
      refuse(served.auth, attempt, response);
      return;
    }
  }

  const rounds = ROUNDS_ROUTE.exec(pathname);
  if (rounds !== null) {
    await serveRounds(served.sessions, rounds, request, response);
    return;
  }
  const matched = SESSION_ROUTE.exec(pathname);
  if (matched !== null) {
    await serveSession(served.sessions, matched, request, response, searchParams);
    return;
  }
  const runFile = RUN_FILE_ROUTE.exec(pathname);
  if (runFile !== null) {
    await serveRunFile(served.sessions, runFile, request, response);
    return;
  }
  if (pathname === SESSIONS_ROUTE) {
    if (permitted(WRITES, request, response)) await openSession(served.sessions, request, response);
    return;
  }
  if (pathname === RENAME_ROUTE) {
    if (permitted(WRITES, request, response)) await renameOpen(served, request, response);
    return;
  }
  if (pathname === NOTEBOOK_MODEL_ROUTE) {
    if (permitted(WRITES, request, response)) await assignModel(served, request, response);
    return;
  }
  if (pathname === MODELS_ROUTE) {
    if (permitted(READS, request, response)) await serveModels(served.agentDirectory, response);
    return;
  }
  if (pathname === MODELS_DEFAULT_ROUTE) {
    if (permitted(WRITES, request, response)) {
      await saveModelsDefault(served.agentDirectory, request, response);
    }
    return;
  }
  if (pathname === MODELS_KEY_ROUTE) {
    if (permitted(WRITES, request, response)) {
      await saveModelKey(served.agentDirectory, request, response);
    }
    return;
  }
  if (pathname === MODELS_PROVIDERS_ROUTE) {
    if (permitted(WRITES, request, response)) {
      await saveModelProviders(served.agentDirectory, request, response);
    }
    return;
  }
  if (pathname === MODELS_TEST_ROUTE) {
    if (permitted(WRITES, request, response)) {
      await testModel(served.agentDirectory, request, response);
    }
    return;
  }
  if (pathname === TREE_ROUTE) {
    if (permitted(READS, request, response)) await serveTree(served.directory, response);
    return;
  }
  if (pathname === NOTEBOOKS_ROUTE) {
    // Read, the Notebooks under the directory; written to, a new one or a copy of one of them.
    if (!permitted([...READS, ...WRITES], request, response)) return;
    if (WRITES.includes(request.method ?? "")) {
      await addNotebook(served.directory, request, response);
    } else await serveNotebooks(served.directory, response);
    return;
  }
  if (pathname === CHATS_ROUTE) {
    if (permitted(READS, request, response)) await serveChats(served, response);
    return;
  }
  const promoting = PROMOTE_ROUTE.exec(pathname);
  if (promoting !== null) {
    await promote(served, promoting, request, response);
    return;
  }
  const deleting = DELETE_CHAT_ROUTE.exec(pathname);
  if (deleting !== null) {
    await removeChat(served, deleting, request, response);
    return;
  }

  if (!permitted(READS, request, response)) return;
  if (pathname === "/" || pathname.startsWith(CLIENT_ROUTE)) {
    await serveClient(pathname, response);
    return;
  }
  notFound(response);
}

/**
 * The addresses that mean every interface, which no browser can open: the URL
 * names this machine's loopback instead, and another machine puts its own name
 * for this one in its place.
 */
const EVERY_INTERFACE: Readonly<Record<string, string>> = { "0.0.0.0": LOOPBACK, "::": "::1" };

/**
 * Where a browser opens a server bound to `host`, carrying the token when
 * there is one, so that following the URL is all the authenticating there is.
 * An IPv6 address goes in brackets, as a URL spells one.
 */
function urlOf(host: string, port: number, token: string | undefined): string {
  const named = EVERY_INTERFACE[host] ?? host;
  const address = named.includes(":") ? `[${named}]` : named;
  const url = new URL(`http://${address}:${port}/`);
  if (token !== undefined) url.searchParams.set(TOKEN_QUERY, token);
  return url.href;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? LOOPBACK;
  const directory = resolve(options.directory ?? process.cwd());
  // Recovered before anything can be asked for, so that a browser coming back
  // as the server does finds its session rather than a second one opened
  // beside it.
  const sessions = await createNotebookSessions({ directory, agent: options.agent });
  const auth = createAuth(
    options.storedPassword !== undefined ? { storedPassword: options.storedPassword } : {},
  );
  const served: Served = {
    directory,
    sessions,
    auth,
    chats: options.chatDirectory !== undefined ? { chatDirectory: options.chatDirectory } : {},
    agentDirectory: options.agentDirectory ?? getAgentDir(),
  };

  const server = createServer((request, response) => {
    handle(served, request, response).catch((cause: unknown) => {
      if (!response.headersSent) reply(response, 500, "Something went wrong\n");
      else response.destroy();
      process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
    });
  });

  // The events of a Notebook Session, streamed to each browser watching it.
  // The WebSocket is `ws`'s: a framing protocol is the point at which a
  // dependency earns its place over Node's own `http`, which speaks none.
  const sockets = new WebSocketServer({ noServer: true });
  const refuseUpgrade = (socket: Duplex, status: string, headers: string[] = []) => {
    socket.write(`HTTP/1.1 ${status}\r\n${["connection: close", ...headers].join("\r\n")}\r\n\r\n`);
    socket.destroy();
  };
  server.on("upgrade", (request, socket, head) => {
    // A socket that fails while being refused is one already gone; unheard,
    // Node would make it the end of the process.
    socket.on("error", () => socket.destroy());
    authenticate(auth, request).then(
      (attempt) => {
        if (attempt.kind === "accepted") upgrade(request, socket, head);
        else if (attempt.kind === "wait")
          refuseUpgrade(socket, "429 Too Many Requests", [`retry-after: ${attempt.seconds}`]);
        else refuseUpgrade(socket, "401 Unauthorized");
      },
      () => refuseUpgrade(socket, "500 Internal Server Error"),
    );
  });
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname, searchParams } = new URL(request.url ?? "/", `http://${LOOPBACK}`);
    const matched = SESSION_ROUTE.exec(pathname);
    const session = matched?.[2] === "events" ? sessions.get(matched[1] ?? "") : undefined;
    if (session === undefined) {
      refuseUpgrade(socket, "404 Not Found");
      return;
    }
    // A browser coming back says the number of the last event it heard, and
    // is told what happened since; one arriving fresh says nothing, and is
    // told what the Notebook Session stands at now. Anything that is not a
    // number — an empty `since` included, which `Number` would read as zero —
    // is a browser that must start over, as the Notebook Session decides.
    const asked = searchParams.get("since");
    const since = asked === null ? undefined : asked.trim() === "" ? NaN : Number(asked);
    sockets.handleUpgrade(request, socket, head, (client) => {
      // A socket's failure is the end of that browser's watching and nothing
      // more; unheard, Node would make it the end of the process.
      client.on("error", () => client.terminate());
      const unsubscribe = session.subscribe((event) => {
        if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
      }, since);
      client.on("close", unsubscribe);
    });
  };

  return new Promise((started, failed) => {
    server.once("error", (cause: NodeJS.ErrnoException) => {
      failed(
        cause.code === "EADDRINUSE"
          ? new Error(
              `Something is already listening on port ${port}; pass --port to choose another.`,
            )
          : cause,
      );
    });
    server.listen(port, host, () => {
      const address = server.address();
      const bound = address !== null && typeof address === "object" ? address.port : port;
      started({
        url: urlOf(host, bound, auth.token),
        directory,
        close: async () => {
          // Nothing outlives the server: the Runs in progress are interrupted
          // and their records written, then the browsers watching are cut off.
          await sessions.close();
          for (const client of sockets.clients) client.terminate();
          await new Promise<void>((done, fail) => {
            server.close((cause) => (cause ? fail(cause) : done()));
            // Keep-alive connections would otherwise hold the close open until they idle out.
            server.closeAllConnections();
          });
        },
      });
    });
  });
}
