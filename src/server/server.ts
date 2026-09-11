/**
 * The server: owns Notebook Sessions, serves the browser client, streams events
 * and handles auth. This is where the launcher's web flags arrive.
 *
 * Today it is the shell the rest is built inside: it binds to loopback, serves
 * the client, and lists the Notebooks under the directory it was started in.
 * Loopback only, because starting it must never expose the machine by accident
 * (ADR-0006); reaching it from elsewhere is a deliberate act that ticket 19 owns.
 */

import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listNotebooks } from "./notebooks.js";

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
const NOTEBOOKS_ROUTE = "/api/notebooks";

/** The kinds of file the client is made of; anything else under `/client/` is not served. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** What a browser fetches a page and its assets with; Node itself leaves a HEAD's body out. */
const READS: readonly string[] = ["GET", "HEAD"];

export interface ServerOptions {
  /**
   * The port to listen on; `DEFAULT_PORT` when absent. Zero asks the operating
   * system for a free one, which is what a test wants and nobody else does.
   */
  readonly port?: number;
  /** The directory whose Notebooks are served; the working directory when absent. */
  readonly directory?: string;
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
  const inside = relative(CLIENT_DIRECTORY, file);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return undefined;
  return file;
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

async function serveNotebooks(directory: string, response: ServerResponse): Promise<void> {
  const notebooks = await listNotebooks(directory);
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ directory, notebooks }));
}

async function handle(
  directory: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!READS.includes(request.method ?? "")) {
    reply(response, 405, "Method not allowed\n", { allow: READS.join(", ") });
    return;
  }

  const { pathname } = new URL(request.url ?? "/", `http://${LOOPBACK}`);
  if (pathname === "/" || pathname.startsWith(CLIENT_ROUTE)) {
    await serveClient(pathname, response);
    return;
  }
  if (pathname === NOTEBOOKS_ROUTE) {
    await serveNotebooks(directory, response);
    return;
  }
  notFound(response);
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const port = options.port ?? DEFAULT_PORT;
  const directory = resolve(options.directory ?? process.cwd());
  const server = createServer((request, response) => {
    handle(directory, request, response).catch((cause: unknown) => {
      if (!response.headersSent) reply(response, 500, "Something went wrong\n");
      else response.destroy();
      process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
    });
  });

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
    server.listen(port, LOOPBACK, () => {
      const address = server.address();
      const bound = address !== null && typeof address === "object" ? address.port : port;
      started({
        url: `http://${LOOPBACK}:${bound}/`,
        directory,
        close: () =>
          new Promise((done, fail) => {
            server.close((cause) => (cause ? fail(cause) : done()));
            // Keep-alive connections would otherwise hold the close open until they idle out.
            server.closeAllConnections();
          }),
      });
    });
  });
}
