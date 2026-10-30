/**
 * The server: owns Notebook Sessions, serves the browser client, streams events
 * and handles auth. This is where the launcher's web flags arrive.
 *
 * It binds to loopback, serves the client, lists the Notebooks under the
 * directory it was started in, and opens them into Notebook Sessions that it
 * owns: a Run started from a browser carries on when the browser has gone.
 * Commands — open, run, interrupt, save, create, duplicate, promote, export, the model settings, a one-token check that a configured model answers, the model a Notebook names, the mode a Notebook names, the modes a user writes, and the Skills installed for the user and for a Workspace — are HTTP
 * requests, each with an answer; what a Run produces is a stream, and goes to
 * the browser over a WebSocket; what a Run leaves — its Artifacts, its record
 * — is served from under the Run's directory, so the browser can show a file
 * where the record names it. An Export is the Notebook and a Run as one
 * document to download and send on. A file the directory column lists can be
 * downloaded, and a file can be uploaded into a folder that column shows,
 * never over one already there. A save writes the Notebook's file, and only
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
import { isIP } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { basename, extname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { WebSocketServer } from "ws";

import type { AgentFactory } from "../agent/agent.js";
import {
  type Mode,
  availableModes,
  createUserMode,
  removeUserMode,
  replaceUserMode,
  resolveMode,
  userModes,
  userModesDirectory,
} from "../mode/mode.js";
import type { CellEdit, SegmentEdit } from "../notebook/edit.js";
import {
  THINKING_LEVELS,
  formatDiagnostics,
  parseNotebook,
  workspaceOf,
} from "../notebook/notebook.js";
import { type CellAccess, cellAccess, cellAccessAllows } from "../run/access.js";
import { DOWNLOAD, runFileType } from "../run/store.js";
import { isRecord } from "../util/guards.js";
import { within } from "../util/paths.js";
import { type Attempt, type Auth, type Credential, createAuth } from "./auth.js";
import { type ChatsOptions, deleteChat, getChat, listChats, promoteChat } from "./chats.js";
import {
  type DefaultEdit,
  type ProviderEdit,
  isConfiguredModel,
  readModelPage,
  removeProviderKey,
  saveDefaultModel,
  saveModelEnabled,
  saveProviderKey,
  saveProviders,
  testConfiguredModel,
} from "./models.js";
import {
  branchNotebook,
  copyNotebook,
  createNotebook,
  fileWithin,
  listNotebooks,
  listTree,
  LONGEST_UPLOAD,
  readWorkspaceFile,
  removeWorkspaceFile,
  storeWorkspaceFile,
} from "./notebooks.js";
import { readTextFile, writeTextFile } from "./text-files.js";
import { listInstalledSkills } from "./skills.js";
import {
  type NotebookSessions,
  type RunRequest,
  type SaveRequest,
  createNotebookSessions,
} from "./notebook-session.js";

/** The address the server listens on: this machine, and nothing beyond it. */
const LOOPBACK = "127.0.0.1";

/** Names that mean this machine's loopback, whichever way a browser spells it. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const isLoopbackHost = (host: string) => LOOPBACK_HOSTS.has(host.toLowerCase());

/** Binds that listen on every interface. A public address in front of the machine is not one of those interfaces. */
const EVERY_INTERFACE_BIND = new Set(["0.0.0.0", "::"]);

/**
 * The Host names a server bound to `bind` will answer. Loopback answers
 * `localhost` as well as the two loopback addresses, because that is what a
 * browser types. Every interface answers those, each address this machine
 * has, and any other IP address, because the public address in front of a
 * cloud machine is not one of its interfaces. One named address answers only
 * that address. A name that is not an address is not answered, so a name that
 * merely resolves here is not this server.
 */
function allowedHosts(bind: string): ReadonlySet<string> {
  const hosts = new Set<string>();
  const add = (value: string) => hosts.add(value.toLowerCase());
  if (bind === "0.0.0.0" || bind === "::") {
    for (const name of LOOPBACK_HOSTS) add(name);
    for (const list of Object.values(networkInterfaces())) {
      for (const address of list ?? []) add(address.address);
    }
    return hosts;
  }
  if (isLoopbackHost(bind)) {
    for (const name of LOOPBACK_HOSTS) add(name);
    return hosts;
  }
  add(bind);
  return hosts;
}

/** The host a Host header names, without a port and without the brackets around an IPv6 address. */
function requestHost(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const value = header.trim().toLowerCase();
  if (value === "") return undefined;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? undefined : value.slice(1, end);
  }
  const colon = value.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(value.slice(colon + 1))) return value.slice(0, colon);
  return value;
}

/** Whether `name` is an address a browser may use to open a server bound to every interface. */
const publicAddress = (bind: string, name: string) =>
  EVERY_INTERFACE_BIND.has(bind) && isIP(name) !== 0;

const hostAllowed = (bind: string, hosts: ReadonlySet<string>, header: string | undefined) => {
  const host = requestHost(header);
  return host !== undefined && (hosts.has(host) || publicAddress(bind, host));
};

/**
 * Whether an Origin header names this server. Absent is allowed: a script
 * opening a socket does not send one, and a browser does. An address is
 * allowed on the same terms as a Host header.
 */
function originAllowed(
  bind: string,
  hosts: ReadonlySet<string>,
  header: string | undefined,
): boolean {
  if (header === undefined || header === "") return true;
  try {
    const name = new URL(header).hostname.toLowerCase();
    return hosts.has(name) || publicAddress(bind, name);
  } catch {
    return false;
  }
}

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
/** One text file under the served directory, for a subtab to show. */
const TEXT_ROUTE = "/api/text";
/** Skills installed for the user and, when a Notebook is named, for its Workspace. */
const SKILLS_ROUTE = "/api/skills";
/** A Notebook's file renamed, Runs included, the session following when one holds it. */
const RENAME_ROUTE = "/api/notebooks/rename";
/** A file that is not a Notebook, renamed in place. */
const FILE_RENAME_ROUTE = "/api/files/rename";
/** A file under the served directory: downloaded, or uploaded into a folder. */
const FILES_ROUTE = "/api/files";
/** A new Notebook that keeps another through one Cell and drops what follows. */
const BRANCH_ROUTE = "/api/notebooks/branch";
/** The model a Notebook names, chosen from the models the user can already call. */
const NOTEBOOK_MODEL_ROUTE = "/api/notebooks/model";
/** The mode a Notebook names, chosen from the modes available here. */
const NOTEBOOK_MODE_ROUTE = "/api/notebooks/mode";
/** The modes a Notebook can be set to: the ones octo ships, and the user's own. */
const MODES_ROUTE = "/api/modes";
/** One mode of the user's own, to be rewritten or removed. */
const MODE_ROUTE = /^\/api\/modes\/([^/]+)$/;
/** Pi's model settings: the default, and the custom providers. */
const MODELS_ROUTE = "/api/models";
const MODELS_DEFAULT_ROUTE = "/api/models/default";
const MODELS_KEY_ROUTE = "/api/models/key";
const MODELS_ENABLED_ROUTE = "/api/models/enabled";
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
/** One of them, to be viewed or removed: its session file, and nothing already made from it. */
const CHAT_ROUTE = /^\/api\/chats\/([^/]+)$/;
/** A Notebook Session by id, and what may be asked of it. */
const SESSION_ROUTE = /^\/api\/sessions\/([^/]+)(?:\/(run|interrupt|save|events|export|text))?$/;
/** The model rounds of one Cell that has run, read from the Agent Session. */
const ROUNDS_ROUTE = /^\/api\/sessions\/([^/]+)\/cells\/([^/]+)\/rounds$/;
/** Stops one Cell's turn or command, or the service that command left running. */
const STOP_ROUTE = /^\/api\/sessions\/([^/]+)\/cells\/([^/]+)\/stop$/;
/** The query naming which Run an export is of, when not the latest. */
const RUN_QUERY = "run";
/** The query naming HTML or Markdown. Absent is HTML. */
const FORMAT_QUERY = "format";
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

/** As much as a request's body may be: a Notebook being saved, which is Markdown (including pasted images), not its Artifacts. */
const LONGEST_BODY = 10 * 1024 * 1024;

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
  /**
   * Where a user's own modes are, one `<name>.md` each. `~/.octo/modes` when
   * absent; named by a test, so that none reads the machine's.
   */
  readonly modesDirectory?: string;
  /**
   * The home directory, for Skills installed under `~/.agents/skills`. The
   * account's home when absent; named by a test, so that none reads the machine's.
   */
  readonly home?: string;
  /**
   * Where a notebook's cells may operate. Absent keeps each workspace under
   * the served directory. `cellAccess("user")` allows any path the account
   * can already reach, and `cellAccess([dir, ...])` names the range.
   */
  readonly access?: CellAccess;
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

/** One text file, as a subtab reads it. The path is the query `path`. */
async function serveText(
  directory: string,
  searchParams: URLSearchParams,
  response: ServerResponse,
): Promise<void> {
  const name = searchParams.get("path");
  if (name === null || name === "") {
    reply(response, 400, "The request must name a text file.\n");
    return;
  }
  const read = await readTextFile(directory, name);
  switch (read.kind) {
    case "text":
      json(response, 200, { path: read.path, text: read.text });
      return;
    case "absent":
      notFound(response);
      return;
    case "too-large":
      reply(response, 422, "That file is too large to open here.\n");
      return;
    case "invalid":
      reply(response, 400, "That is not a text file under this directory.\n");
      return;
  }
}

/** Replaces a text file the notebook has open. The path and the new text are the body. */
async function saveText(
  served: Served,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request);
  if (
    !isRecord(body) ||
    !hasKeys(body, ["path", "text"]) ||
    typeof body.path !== "string" ||
    typeof body.text !== "string"
  ) {
    reply(response, 400, "The request must name a text file and its new text, as JSON.\n");
    return;
  }
  const written = await writeTextFile(served.directory, body.path, body.text);
  switch (written.kind) {
    case "saved": {
      // A Notebook a session holds is that session's file. Saving it here
      // still has to show up there, when the result can be opened.
      await served.sessions.held(written.path)?.reread();
      json(response, 200, { path: written.path });
      return;
    }
    case "absent":
      notFound(response);
      return;
    case "too-large":
      reply(response, 422, "That file is too large to save here.\n");
      return;
    case "invalid":
      reply(response, 400, "That is not a text file under this directory.\n");
      return;
  }
}

/**
 * One file the directory column lists: downloaded, uploaded into a folder, or
 * deleted. A download is never a page: the file shares an origin with the
 * client, and a page served as one could read whatever the client holds.
 */
async function serveWorkspaceFile(
  served: Served,
  searchParams: URLSearchParams,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const name = searchParams.get("path");
  if (name === null || name === "") {
    reply(response, 400, "The request must name a file under this directory.\n");
    return;
  }
  if (request.method === "DELETE") {
    await deleteWorkspaceFile(served, name, response);
    return;
  }
  if (WRITES.includes(request.method ?? "")) {
    await uploadWorkspaceFile(served.directory, name, request, response);
    return;
  }
  await downloadWorkspaceFile(served.directory, name, response);
}

/**
 * Removes the file `name` names. A Notebook a Run is busy with is left until
 * that Run stops. A review of the file is dropped, and a session that held
 * the Notebook no longer answers for that path.
 */
async function deleteWorkspaceFile(
  served: Served,
  name: string,
  response: ServerResponse,
): Promise<void> {
  if (served.sessions.held(name)?.state().running) {
    reply(response, 409, "This notebook is running; interrupt it or wait, then delete it.\n");
    return;
  }
  const removed = await removeWorkspaceFile(served.directory, name);
  switch (removed.kind) {
    case "removed":
      await served.sessions.dropFile(removed.path);
      response.writeHead(204);
      response.end();
      return;
    case "absent":
      notFound(response);
      return;
    case "invalid":
      reply(response, 400, `${removed.problem}\n`);
      return;
  }
}

/** The file `name` names, offered for download under its own name. */
async function downloadWorkspaceFile(
  directory: string,
  name: string,
  response: ServerResponse,
): Promise<void> {
  const read = await readWorkspaceFile(directory, name);
  switch (read.kind) {
    case "invalid":
      reply(response, 400, "That is not a file under this directory.\n");
      return;
    case "absent":
      notFound(response);
      return;
    case "file":
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
        "content-disposition": attachment(read.name),
      });
      response.end(read.bytes);
      return;
  }
}

/** Writes the body to `name`, when that name is a file the column could list. */
async function uploadWorkspaceFile(
  directory: string,
  name: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const bytes = await readLimited(request, LONGEST_UPLOAD);
  if (bytes === undefined) {
    reply(response, 413, "That file is too large to upload here.\n");
    return;
  }
  const stored = await storeWorkspaceFile(directory, name, bytes);
  switch (stored.kind) {
    case "saved":
      json(response, 201, { path: stored.path });
      return;
    case "exists":
      reply(response, 409, `There is already a file named ${stored.path}.\n`);
      return;
    case "too-large":
      reply(response, 413, "That file is too large to upload here.\n");
      return;
    case "invalid":
      reply(response, 400, `${stored.problem}\n`);
      return;
  }
}

/**
 * The Workspace a skills list is for: the served directory, or the Workspace
 * the named Notebook declares. A name that is not a Notebook here is absent.
 */
async function skillWorkspace(
  directory: string,
  notebook: string | null,
  access: CellAccess,
): Promise<
  | { readonly kind: "ready"; readonly workspace: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly problem: string }
> {
  if (notebook === null || notebook === "") {
    return cellAccessAllows(access, directory, directory)
      ? { kind: "ready", workspace: directory }
      : {
          kind: "unreadable",
          problem: `The served directory is outside the directories cells may use.`,
        };
  }
  const file = fileWithin(directory, notebook);
  if (file === undefined) return { kind: "absent" };
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return { kind: "absent" };
    throw cause;
  }
  const parsed = parseNotebook(source);
  if (!parsed.ok) return { kind: "unreadable", problem: formatDiagnostics(parsed.errors) };
  const workspace = workspaceOf(parsed.notebook, file);
  if (!cellAccessAllows(access, directory, workspace)) {
    return {
      kind: "unreadable",
      problem: `Its workspace ${workspace} is outside the directories cells may use.`,
    };
  }
  return { kind: "ready", workspace };
}

/** Skills installed globally and in a Workspace, so a Prompt Cell can offer them. */
async function serveSkills(
  served: Served,
  searchParams: URLSearchParams,
  response: ServerResponse,
): Promise<void> {
  const resolved = await skillWorkspace(
    served.directory,
    searchParams.get("notebook"),
    served.access,
  );
  switch (resolved.kind) {
    case "absent":
      notFound(response);
      return;
    case "unreadable":
      reply(
        response,
        422,
        `Cannot list skills for ${searchParams.get("notebook")}:\n${resolved.problem}\n`,
      );
      return;
    case "ready":
      json(response, 200, {
        skills: listInstalledSkills({
          workspace: resolved.workspace,
          agentDir: served.agentDirectory,
          home: served.home,
        }),
      });
      return;
  }
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
    !hasKeys(body, ["provider"], ["apiKey", "clearApiKey"]) ||
    typeof body.provider !== "string"
  ) {
    reply(response, 400, "The request must name a provider, as JSON.\n");
    return;
  }
  if (
    body.clearApiKey === true ||
    request.method === "DELETE" ||
    (typeof body.apiKey === "string" && body.apiKey.trim() === "")
  ) {
    const removed = await removeProviderKey(agentDirectory, body.provider);
    if (!removed.ok) {
      reply(response, 422, `${removed.problem}\n`);
      return;
    }
    response.writeHead(204);
    response.end();
    return;
  }
  if (typeof body.apiKey !== "string") {
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

async function saveModelEnabledSetting(
  agentDirectory: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request);
  if (
    !isRecord(body) ||
    !hasKeys(body, ["provider", "model", "enabled"]) ||
    typeof body.provider !== "string" ||
    typeof body.model !== "string" ||
    typeof body.enabled !== "boolean"
  ) {
    reply(response, 400, "The request must name a provider and a model, and say enabled.\n");
    return;
  }
  const saved = await saveModelEnabled(agentDirectory, body.provider, body.model, body.enabled);
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

/** A model id, or `{ id, contextWindow, enabled }`. Anything else is not a model edit. */
function modelEditsOf(value: unknown): ProviderEdit["models"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models: ProviderEdit["models"][number][] = [];
  for (const item of value) {
    if (typeof item === "string") {
      models.push({ id: item });
      continue;
    }
    if (!isRecord(item) || typeof item.id !== "string") return undefined;
    if (item.contextWindow !== undefined && typeof item.contextWindow !== "number")
      return undefined;
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") return undefined;
    models.push({
      id: item.id,
      ...(typeof item.contextWindow === "number" ? { contextWindow: item.contextWindow } : {}),
      ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
    });
  }
  return models;
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
  const models = modelEditsOf(value.models);
  if (models === undefined) return undefined;
  if (value.apiKey !== undefined && typeof value.apiKey !== "string") return undefined;
  if (value.clearApiKey !== undefined && typeof value.clearApiKey !== "boolean") return undefined;
  return {
    id: value.id,
    baseUrl: value.baseUrl,
    api: value.api,
    models,
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

/** Renames a file that is not a Notebook. A review of that file follows it. */
async function renameOther(
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
    reply(response, 400, "The request must name the file and the new name, as JSON.\n");
    return;
  }

  const renamed = await served.sessions.renameFile(body.from, body.to);
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
    case "notebook":
      reply(response, 400, "A notebook is renamed from its own page.\n");
      return;
    case "renamed":
      json(response, 200, { path: renamed.path });
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
  answerAssignment(assigned, response);
}

/** The modes a notebook can be set to, and the user's own as the page edits them. */
async function serveModeList(directory: string, response: ServerResponse): Promise<void> {
  json(response, 200, {
    modes: await availableModes(directory),
    own: await userModes(directory),
  });
}

/**
 * The mode a request describes. `name` is required when creating; a rewrite
 * names the mode in the URL and may carry a new name. Tools or skills left
 * null stay pi's own; a list, even an empty one, is what the mode allows.
 */
function requestedMode(body: unknown, current: string | undefined): Mode | undefined {
  const creating = current === undefined;
  if (
    !isRecord(body) ||
    !hasKeys(
      body,
      creating
        ? ["name", "prompt", "model", "tools", "skills"]
        : ["prompt", "model", "tools", "skills"],
      creating ? ["bare"] : ["name", "bare"],
    ) ||
    typeof body.prompt !== "string" ||
    typeof body.model !== "string" ||
    ((creating || body.name !== undefined) && typeof body.name !== "string")
  ) {
    return undefined;
  }
  const tools = requestedList(body.tools);
  const skills = requestedList(body.skills);
  if (tools === undefined || skills === undefined) return undefined;
  const prompt = body.prompt.trim();
  const model = body.model.trim();
  const name = typeof body.name === "string" ? body.name.trim() : current;
  if (name === undefined) return undefined;
  if (body.bare !== undefined && typeof body.bare !== "boolean") return undefined;
  // A prompt and bare together would be two instructions. Bare means there is
  // no system prompt, so the text has to be empty.
  if (body.bare === true && prompt !== "") return undefined;
  return {
    name,
    ...(body.bare === true ? { bare: true } : {}),
    ...(prompt === "" ? {} : { prompt }),
    ...(model === "" ? {} : { model }),
    ...(tools === null ? {} : { tools }),
    ...(skills === null ? {} : { skills }),
  };
}

/** A list of strings, null when the field is left to pi, or nothing when it is neither. */
function requestedList(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "" || item.includes("\n")) return undefined;
    items.push(item.trim());
  }
  return items;
}

/** Writes a new mode of the user's own. */
async function createMode(
  directory: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const mode = requestedMode(await readJson(request), undefined);
  if (mode === undefined) {
    reply(
      response,
      400,
      "The request must name the mode and give its prompt, model, tools, and skills, as JSON. An empty prompt or model sets none. Null tools or skills leaves pi's own; a list is only those. bare: true, with an empty prompt, sends no system prompt.\n",
    );
    return;
  }
  answerMode(await createUserMode(directory, mode), response, 201);
}

/** Rewrites or removes the user's mode named in the URL. */
async function changeMode(
  directory: string,
  matched: RegExpExecArray,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!permitted(["POST", "DELETE"], request, response)) return;
  const name = decoded(matched[1] ?? "");
  if (name === undefined) {
    reply(response, 400, "The mode's name is not a URL.\n");
    return;
  }
  if (request.method === "DELETE") {
    answerMode(await removeUserMode(directory, name), response, 204);
    return;
  }
  const mode = requestedMode(await readJson(request), name);
  if (mode === undefined) {
    reply(
      response,
      400,
      "The request must give the mode's prompt, model, tools, and skills, as JSON, and may give it a new name. An empty prompt or model sets none. Null tools or skills leaves pi's own; a list is only those. bare: true, with an empty prompt, sends no system prompt.\n",
    );
    return;
  }
  answerMode(await replaceUserMode(directory, name, mode), response, 200);
}

/** The answer to creating, rewriting, or removing a user's mode. */
function answerMode(
  written: Awaited<ReturnType<typeof createUserMode>>,
  response: ServerResponse,
  saved: number,
): void {
  switch (written.kind) {
    case "saved":
      json(response, saved, modeJson(written.mode));
      return;
    case "removed":
      response.writeHead(saved);
      response.end();
      return;
    case "invalid":
      reply(response, 400, `${written.problem}\n`);
      return;
    case "shipped":
      reply(response, 422, `${written.problem}\n`);
      return;
    case "exists":
      reply(response, 409, `${written.problem}\n`);
      return;
    case "absent":
      notFound(response);
      return;
  }
}

/** A mode as JSON, with only the fields it has. */
function modeJson(mode: Mode): {
  name: string;
  bare?: true;
  prompt?: string;
  model?: string;
  tools?: readonly string[];
  skills?: readonly string[];
} {
  return {
    name: mode.name,
    ...(mode.bare === true ? { bare: true } : {}),
    ...(mode.prompt !== undefined ? { prompt: mode.prompt } : {}),
    ...(mode.model !== undefined ? { model: mode.model } : {}),
    ...(mode.tools !== undefined ? { tools: mode.tools } : {}),
    ...(mode.skills !== undefined ? { skills: mode.skills } : {}),
  };
}

/**
 * Sets the mode a Notebook names, from the modes available here. An empty mode
 * clears it, so the notebook runs on pi's defaults.
 */
async function assignMode(
  served: Served,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request);
  if (
    !isRecord(body) ||
    !hasKeys(body, ["notebook", "mode"]) ||
    typeof body.notebook !== "string" ||
    typeof body.mode !== "string"
  ) {
    reply(
      response,
      400,
      "The request must name the notebook and the mode, as JSON. An empty mode clears it.\n",
    );
    return;
  }

  const mode = body.mode.trim();
  if (mode !== "") {
    const resolved = await resolveMode(mode, served.modesDirectory);
    if (!resolved.ok) {
      reply(response, 422, `${resolved.problems.join("\n")}\n`);
      return;
    }
  }

  const assigned = await served.sessions.setMode(body.notebook, mode === "" ? undefined : mode);
  answerAssignment(assigned, response);
}

/** The answer to setting a notebook's model or its mode. */
function answerAssignment(
  assigned: Awaited<ReturnType<NotebookSessions["setModel"]>>,
  response: ServerResponse,
): void {
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

/**
 * Writes a Notebook that keeps another through one Cell, under a new name, so
 * the rest of the original can stay while the branch is taken somewhere else.
 */
async function branchFromCell(
  directory: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJson(request);
  if (
    !isRecord(body) ||
    !hasKeys(body, ["from", "cell", "to"]) ||
    typeof body.from !== "string" ||
    typeof body.cell !== "string" ||
    typeof body.to !== "string"
  ) {
    reply(
      response,
      400,
      "The request must name the notebook, the cell to branch from, and the new notebook, as JSON.\n",
    );
    return;
  }

  const branched = await branchNotebook(directory, body.from, body.cell, body.to);
  switch (branched.kind) {
    case "absent":
      notFound(response);
      return;
    case "missing-cell":
      reply(response, 404, `There is no cell ${body.cell} in ${body.from}.\n`);
      return;
    case "invalid":
      reply(response, 400, `${branched.problem}\n`);
      return;
    case "exists":
      reply(response, 409, `There is already a file named ${body.to}.\n`);
      return;
    case "unreadable":
      reply(response, 422, `${branched.problem}\n`);
      return;
    case "branched":
      json(response, 201, branched.entry);
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

/** Serves the details of one Chat: its executed commands, results, prompts and tool calls. */
async function serveChat(
  served: Served,
  matched: RegExpExecArray,
  response: ServerResponse,
): Promise<void> {
  const id = decoded(matched[1] ?? "");
  const chat = await getChat(served.directory, id ?? "", served.chats);
  if (chat === undefined) {
    notFound(response);
    return;
  }
  json(response, 200, chat);
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

/**
 * The body, or nothing when it is longer than `longest`. Either way the body
 * is read to the end, so the connection is not left waiting on the rest.
 */
async function readLimited(request: IncomingMessage, longest: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  let over = false;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    length += buffer.length;
    if (over || length > longest) over = true;
    else chunks.push(buffer);
  }
  return over ? undefined : Buffer.concat(chunks);
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
  if (
    !hasKeys(
      value,
      ["kind", "id", "type", "body", "uses", "isolated"],
      ["model", "timeout", "approach", "thinking"],
    )
  ) {
    return undefined;
  }
  const { id, type, body, uses, isolated, model, timeout, approach, thinking } = value;
  if (typeof id !== "string" || typeof body !== "string" || typeof isolated !== "boolean") {
    return undefined;
  }
  if (type !== "prompt" && type !== "bash") return undefined;
  if (!isStrings(uses)) return undefined;
  if (model !== undefined && typeof model !== "string") return undefined;
  if (
    thinking !== undefined &&
    (typeof thinking !== "string" || !THINKING_LEVELS.includes(thinking as any))
  ) {
    return undefined;
  }
  if (timeout !== undefined && typeof timeout !== "string") return undefined;
  if (
    approach !== undefined &&
    (type !== "prompt" || (approach !== "agent" && approach !== "plan" && approach !== "ask"))
  ) {
    return undefined;
  }
  const cell: CellEdit = { kind: "cell", id, type, body, uses, isolated };
  return {
    ...cell,
    ...(approach === "agent" || approach === "plan" || approach === "ask" ? { approach } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
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

/** Stops a Cell's turn or command, or a service that command left running. */
async function serveStop(
  sessions: NotebookSessions,
  matched: RegExpExecArray,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!permitted(WRITES, request, response)) return;
  const session = sessions.get(matched[1] ?? "");
  const cell = decoded(matched[2] ?? "");
  if (session === undefined || cell === undefined) {
    notFound(response);
    return;
  }
  const stopped = await session.stop(cell);
  if (!stopped.ok) {
    reply(response, stopped.status, `${stopped.problem}\n`);
    return;
  }
  response.writeHead(204);
  response.end();
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
    action === "text"
      ? WRITES
      : action === undefined || action === "events" || action === "export"
        ? READS
        : WRITES;
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
      const journal = await session.ensureJournal();
      if (journal !== undefined) {
        reply(response, 422, `${journal}\n`);
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
    case "text": {
      const body = await readJson(request);
      if (
        !isRecord(body) ||
        !hasKeys(body, ["path", "decision"], ["lines"]) ||
        typeof body.path !== "string" ||
        (body.decision !== "accept" && body.decision !== "reject") ||
        ("lines" in body &&
          (!Array.isArray(body.lines) ||
            !body.lines.every((line) => typeof line === "number" && Number.isInteger(line))))
      ) {
        reply(
          response,
          400,
          'The request must name a text file and a decision of "accept" or "reject", as JSON.\n',
        );
        return;
      }
      const lines = Array.isArray(body.lines) ? (body.lines as number[]) : undefined;
      const decided = await session.decideText(body.path, body.decision, lines);
      switch (decided.kind) {
        case "invalid":
          reply(response, 400, "That is not a text file under this directory.\n");
          return;
        case "absent":
          reply(response, 404, "That file is not waiting to be accepted or rejected.\n");
          return;
        case "refused":
          reply(response, 422, `${decided.problem}\n`);
          return;
        case "decided":
          json(response, 200, session.state());
          return;
      }
    }
    case "export": {
      const asked = searchParams.get(RUN_QUERY);
      const run = asked === null || asked === "" ? undefined : asked;
      const format = searchParams.get(FORMAT_QUERY);
      if (format !== null && format !== "" && format !== "html" && format !== "markdown") {
        reply(response, 400, "Export format must be html or markdown.\n");
        return;
      }
      const exported = await session.export(
        run,
        format === "markdown" ? "markdown" : format === "html" ? "html" : undefined,
      );
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
          // of one Notebook do not land on each other. `attachment` keeps the
          // browser from opening it in this origin.
          const { notebook } = session.state();
          const markdown = format === "markdown";
          const name = `${basename(notebook, extname(notebook))}-${exported.run}.${markdown ? "md" : "html"}`;
          response.writeHead(200, {
            "content-type": `${markdown ? "text/markdown" : "text/html"}; charset=utf-8`,
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
  /** Where a user's own modes are, one `<name>.md` each. */
  readonly modesDirectory: string;
  /** The home directory Skills under `~/.agents/skills` are read from. */
  readonly home: string;
  /** The address this server bound, which is what a request's Host is checked against. */
  readonly host: string;
  /** Host names a request may name. Anything else is not this server. */
  readonly hosts: ReadonlySet<string>;
  /** Where a notebook's cells may operate. */
  readonly access: CellAccess;
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
  if (!hostAllowed(served.host, served.hosts, request.headers.host)) {
    reply(response, 421, "This server does not answer for that host.\n");
    return;
  }
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

  const stop = STOP_ROUTE.exec(pathname);
  if (stop !== null) {
    await serveStop(served.sessions, stop, request, response);
    return;
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
  if (pathname === FILE_RENAME_ROUTE) {
    if (permitted(WRITES, request, response)) await renameOther(served, request, response);
    return;
  }
  if (pathname === BRANCH_ROUTE) {
    if (permitted(WRITES, request, response))
      await branchFromCell(served.directory, request, response);
    return;
  }
  if (pathname === NOTEBOOK_MODEL_ROUTE) {
    if (permitted(WRITES, request, response)) await assignModel(served, request, response);
    return;
  }
  if (pathname === NOTEBOOK_MODE_ROUTE) {
    if (permitted(WRITES, request, response)) await assignMode(served, request, response);
    return;
  }
  if (pathname === MODES_ROUTE) {
    if (!permitted([...READS, ...WRITES], request, response)) return;
    if (WRITES.includes(request.method ?? "")) {
      await createMode(served.modesDirectory, request, response);
    } else await serveModeList(served.modesDirectory, response);
    return;
  }
  const modeItem = MODE_ROUTE.exec(pathname);
  if (modeItem !== null) {
    await changeMode(served.modesDirectory, modeItem, request, response);
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
    if (permitted([...WRITES, "DELETE"], request, response)) {
      await saveModelKey(served.agentDirectory, request, response);
    }
    return;
  }
  if (pathname === MODELS_ENABLED_ROUTE) {
    if (permitted(WRITES, request, response)) {
      await saveModelEnabledSetting(served.agentDirectory, request, response);
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
  if (pathname === FILES_ROUTE) {
    if (permitted([...READS, ...WRITES, "DELETE"], request, response)) {
      await serveWorkspaceFile(served, searchParams, request, response);
    }
    return;
  }
  if (pathname === TREE_ROUTE) {
    if (permitted(READS, request, response)) await serveTree(served.directory, response);
    return;
  }
  if (pathname === TEXT_ROUTE) {
    if (!permitted([...READS, ...WRITES], request, response)) return;
    if (WRITES.includes(request.method ?? "")) await saveText(served, request, response);
    else await serveText(served.directory, searchParams, response);
    return;
  }
  if (pathname === SKILLS_ROUTE) {
    if (permitted(READS, request, response)) await serveSkills(served, searchParams, response);
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
  const chatRoute = CHAT_ROUTE.exec(pathname);
  if (chatRoute !== null) {
    if (request.method === "DELETE") {
      await removeChat(served, chatRoute, request, response);
      return;
    }
    if (permitted(READS, request, response)) {
      await serveChat(served, chatRoute, response);
      return;
    }
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
  if (!isLoopbackHost(host) && options.storedPassword === undefined) {
    throw new Error(
      `Refusing to listen on ${host} without a password. A startup token on a cleartext address would stay valid for this process. Set one with \`octo password\` and start with --password.`,
    );
  }
  const directory = resolve(options.directory ?? process.cwd());
  const access = options.access ?? cellAccess("served");
  // Recovered before anything can be asked for, so that a browser coming back
  // as the server does finds its session rather than a second one opened
  // beside it.
  const sessions = await createNotebookSessions({ directory, agent: options.agent, access });
  const auth = createAuth(
    options.storedPassword !== undefined ? { storedPassword: options.storedPassword } : {},
  );
  const served: Served = {
    directory,
    sessions,
    auth,
    chats: options.chatDirectory !== undefined ? { chatDirectory: options.chatDirectory } : {},
    agentDirectory: options.agentDirectory ?? getAgentDir(),
    modesDirectory: options.modesDirectory ?? userModesDirectory(),
    home: options.home ?? homedir(),
    host,
    hosts: allowedHosts(host),
    access,
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
    if (
      !hostAllowed(served.host, served.hosts, request.headers.host) ||
      !originAllowed(served.host, served.hosts, request.headers.origin)
    ) {
      refuseUpgrade(socket, "421 Misdirected Request");
      return;
    }
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
