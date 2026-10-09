import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request } from "node:http";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { type ScriptedAgent, createScriptedAgent } from "../agent/scripted.js";
import { hashPassword } from "./password.js";
import { type RunningServer, type ServerOptions, startServer } from "./server.js";

const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

/** No turns scripted, so a test that never runs a cell fails loudly if one is run. */
const unusedAgent = () => createScriptedAgent([]);

/** A server over a fresh directory holding the given files, closed when the test ends. */
async function serve(
  files: Readonly<Record<string, string>> = {},
  agent: ScriptedAgent = unusedAgent(),
  options: Omit<ServerOptions, "port" | "directory" | "agent"> = {},
): Promise<RunningServer> {
  const directory = await mkdtemp(join(tmpdir(), "octo-serve-"));
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), contents, "utf8");
  }
  // Port 0 asks the operating system for a free one, so tests never collide.
  const server = await startServer({ ...options, port: 0, directory, agent: agent.create });
  running.push(server);
  return server;
}

/** The token the server generated at startup, read off the URL it says to open. */
const tokenOf = (server: RunningServer) => new URL(server.url).searchParams.get("token") ?? "";

/** The headers that make a request the account's: the token, presented as a script would. */
const authorized = (server: RunningServer): Record<string, string> => ({
  authorization: `Bearer ${tokenOf(server)}`,
});

/** A request to one of the server's paths, authenticated as every request of the client's is. */
const get = (server: RunningServer, path: string, init: RequestInit = {}) =>
  fetch(new URL(path, server.url), {
    ...init,
    headers: { ...authorized(server), ...(init.headers as Record<string, string> | undefined) },
  });

/** A port nothing is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") reject(new Error("no port"));
        else resolve(address.port);
      });
    });
  });
}

/** An address of this machine that is not loopback, when it has one. */
function externalAddress(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((address) => address !== undefined && address.family === "IPv4" && !address.internal)
    ?.address;
}

describe("starting the server", () => {
  it("binds to loopback, on the port asked for", async () => {
    const port = await freePort();

    const server = await startServer({ port, directory: tmpdir(), agent: unusedAgent().create });
    running.push(server);

    expect(server.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?token=[0-9a-f]+$`));
  });

  it("answers on loopback", async () => {
    const server = await serve();

    const response = await fetch(new URL("/", server.url));

    expect(response.status).toBe(200);
  });

  it.skipIf(externalAddress() === undefined)("cannot be reached from beyond loopback", async () => {
    const server = await serve();
    const port = new URL(server.url).port;

    await expect(fetch(`http://${externalAddress()}:${port}/`)).rejects.toMatchObject({
      cause: { code: "ECONNREFUSED" },
    });
  });

  it.skipIf(externalAddress() === undefined)(
    "binds beyond loopback only when asked to, and then says so in its URL",
    async () => {
      const host = externalAddress() ?? "";

      const server = await startServer({
        port: 0,
        host,
        directory: tmpdir(),
        agent: unusedAgent().create,
      });
      running.push(server);

      expect(new URL(server.url).hostname).toBe(host);
      expect((await fetch(new URL("/", server.url))).status).toBe(200);
    },
  );

  it.skipIf(externalAddress() === undefined)(
    "bound to every interface, names loopback in its URL, since no browser opens 0.0.0.0",
    async () => {
      const server = await startServer({
        port: 0,
        host: "0.0.0.0",
        directory: tmpdir(),
        agent: unusedAgent().create,
      });
      running.push(server);

      const { hostname, port } = new URL(server.url);
      expect(hostname).toBe("127.0.0.1");
      expect((await fetch(new URL("/", server.url))).status).toBe(200);
      expect((await fetch(`http://${externalAddress()}:${port}/`)).status).toBe(200);
    },
  );

  it("writes an IPv6 address in its URL as a browser reads one", async () => {
    const server = await startServer({
      port: 0,
      host: "::1",
      directory: tmpdir(),
      agent: unusedAgent().create,
    });
    running.push(server);

    expect(new URL(server.url).host).toMatch(/^\[::1\]:\d+$/);
    expect((await fetch(new URL("/", server.url))).status).toBe(200);
  });

  it("says which directory it serves", async () => {
    const server = await startServer({ port: 0, directory: tmpdir(), agent: unusedAgent().create });
    running.push(server);

    expect(server.directory).toBe(tmpdir());
  });

  it("reports a port already in use rather than starting on another", async () => {
    const first = await serve();
    const port = new URL(first.url).port;

    await expect(
      startServer({ port: Number(port), directory: tmpdir(), agent: unusedAgent().create }),
    ).rejects.toThrow(`port ${port}`);
  });
});

/** The URLs a page loads besides itself: its scripts, styles and the like. */
function assetsOf(html: string): string[] {
  return [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(([, url]) => url ?? "");
}

/** A request with the path sent as written, which `fetch` would tidy up first. */
function rawRequest(
  url: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    request({ hostname, port, path, method: "GET", headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    })
      .once("error", reject)
      .end();
  });
}

describe("the client shell", () => {
  it("is what a browser loads at the root", async () => {
    const server = await serve();

    const response = await fetch(new URL("/", server.url));

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("<title>");
  });

  it("finds every script and style it refers to", async () => {
    const server = await serve();
    const assets = assetsOf(await (await fetch(new URL("/", server.url))).text());

    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      const response = await fetch(new URL(asset, server.url));
      expect(response.status, asset).toBe(200);
      expect(response.headers.get("content-type"), asset).not.toBeNull();
    }
  });

  it("does not exist at a path the server was never asked to serve", async () => {
    const server = await serve();

    expect((await fetch(new URL("/nothing-here", server.url))).status).toBe(404);
    expect((await fetch(new URL("/client/missing.js", server.url))).status).toBe(404);
  });

  it("serves nothing from outside its own directory", async () => {
    const server = await serve();

    expect(await rawRequest(server.url, "/client/../package.json")).toBe(404);
    expect(await rawRequest(server.url, "/client/%2e%2e/package.json")).toBe(404);
  });

  it("has no file at a name no file system would accept", async () => {
    const server = await serve();

    expect(await rawRequest(server.url, "/client/%00main.js")).toBe(404);
    expect(await rawRequest(server.url, "/client/%zz")).toBe(404);
  });

  it("answers a HEAD as it would the GET, without the body", async () => {
    const server = await serve();

    const response = await fetch(new URL("/client/main.js", server.url), { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(await response.text()).toBe("");
  });

  it("takes nothing but a read", async () => {
    const server = await serve();

    const response = await fetch(new URL("/", server.url), { method: "POST", body: "x" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});

const hello = `---
title: Hello
---

\`\`\`prompt id=greet
Say hello.
\`\`\`
`;

const audit = `---
title: Audit
---

\`\`\`bash id=scope
ls
\`\`\`
`;

/** Two Prompt Cells, the second built on the first. */
const chain = "```prompt id=a\nDo a.\n```\n\n```prompt id=b uses=a\nDo b.\n```\n";

/** A Notebook that cannot run until its one Input is given a value. */
const greet = `---
inputs:
  - name: name
    type: string
---

\`\`\`prompt id=greet
Greet {{name}}.
\`\`\`
`;

/** Markdown with a fenced snippet in it, which is documentation rather than a Notebook. */
const readme = `# A project

Build it with:

\`\`\`bash
npm run build
\`\`\`
`;

describe("the notebooks the server lists", () => {
  const listed = async (server: RunningServer) => {
    const response = await get(server, "/api/notebooks");
    expect(response.headers.get("content-type")).toContain("application/json");
    return (await response.json()) as { directory: string; notebooks: unknown[] };
  };

  it("are those under the served directory, however deep, in path order", async () => {
    const server = await serve({ "hello.md": hello, "reports/weekly/audit.md": audit });

    expect((await listed(server)).notebooks).toEqual([
      { path: "hello.md", title: "Hello" },
      { path: "reports/weekly/audit.md", title: "Audit" },
    ]);
  });

  it("say which directory was searched", async () => {
    const server = await serve({ "hello.md": hello });

    expect((await listed(server)).directory).toMatch(/octo-serve-/);
  });

  it("leave out Markdown that has no Cells, and files that are not Markdown", async () => {
    const server = await serve({
      "README.md": readme,
      "notes.txt": hello,
      "hello.md": hello,
    });

    expect((await listed(server)).notebooks).toEqual([{ path: "hello.md", title: "Hello" }]);
  });

  it("leave out what is installed, hidden or a run record", async () => {
    const server = await serve({
      "node_modules/some-package/hello.md": hello,
      ".git/hello.md": hello,
      ".octo/runs/hello/2026/hello.md": hello,
      "hello.md": hello,
    });

    expect((await listed(server)).notebooks).toEqual([{ path: "hello.md", title: "Hello" }]);
  });

  it("name a Notebook with no title after its file", async () => {
    const server = await serve({ "weekly-report.md": "```prompt id=go\nGo.\n```\n" });

    expect((await listed(server)).notebooks).toEqual([
      { path: "weekly-report.md", title: "weekly-report" },
    ]);
  });

  it("leave out a Notebook that does not parse, rather than failing the list", async () => {
    const server = await serve({
      "broken.md": "```prompt id=go\nnever closed\n",
      "hello.md": hello,
    });

    expect((await listed(server)).notebooks).toEqual([{ path: "hello.md", title: "Hello" }]);
  });

  it("are none, plainly, when the directory has none", async () => {
    const server = await serve({ "README.md": readme });

    expect((await listed(server)).notebooks).toEqual([]);
  });
});

/** A request carrying JSON, as the client sends one. */
const post = (server: RunningServer, path: string, body?: unknown) =>
  get(server, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

/** One Cell as a Notebook Session shows it, with as much of its shape as the tests read. */
interface CellView {
  id: string;
  type: string;
  body: string;
  uses: string[];
  isolated: boolean;
  model?: string;
  timeout?: number;
  status: string;
  text: string;
  toolCalls: { name: string; input: unknown }[];
  artifacts: string[];
  run?: string;
  error?: string;
  service?: boolean;
}

/** The document's layout: its Prose, and where each Cell sits among it. */
type SegmentView = { kind: "prose"; text: string } | { kind: "cell"; id: string };

/** What a Notebook Session says of itself, as the server reports it. */
interface NotebookSessionState {
  id: string;
  notebook: string;
  title: string;
  model?: string;
  mode?: string;
  revision: string;
  frontmatter?: string;
  inputs: { name: string; type: string; description?: string; default?: unknown }[];
  segments: SegmentView[];
  running: boolean;
  run?: string;
  sequence: number;
  cells: CellView[];
  reviews?: { path: string; kind: string; before?: string }[];
}

/** Opens a Notebook into a Notebook Session and returns what the server said of it. */
async function open(server: RunningServer, notebook: string): Promise<NotebookSessionState> {
  const response = await post(server, "/api/sessions", { notebook });
  if (!response.ok) throw new Error(`opening ${notebook} answered ${response.status}`);
  return (await response.json()) as NotebookSessionState;
}

const stateOf = async (server: RunningServer, id: string): Promise<NotebookSessionState> => {
  const response = await get(server, `/api/sessions/${id}`);
  if (!response.ok) throw new Error(`session ${id} answered ${response.status}`);
  return (await response.json()) as NotebookSessionState;
};

/** The cookie a browser is given, as the browser would send it back. */
function cookieOf(response: Response): string {
  const set = response.headers.get("set-cookie") ?? "";
  return set.split(";")[0] ?? "";
}

describe("authenticating with the token", () => {
  it("is generated for this start, and printed as the URL to open", async () => {
    const one = await serve();
    const other = await serve();

    expect(tokenOf(one)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenOf(other)).not.toBe(tokenOf(one));
  });

  it("is what a request to the API must carry: without it, the request is refused", async () => {
    const server = await serve({ "hello.md": hello });

    const read = await fetch(new URL("/api/notebooks", server.url));
    const written = await fetch(new URL("/api/sessions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notebook: "hello.md" }),
    });

    expect(read.status).toBe(401);
    // Told how to authenticate, since the shell has to know what to ask for.
    expect(await read.json()).toEqual({ authenticate: "token" });
    expect(written.status).toBe(401);
    // Refused before anything was done, or looked at.
    expect((await get(server, "/api/sessions/nothing")).status).toBe(404);
  });

  it("is taken as a bearer, as a script presents it", async () => {
    const server = await serve({ "hello.md": hello });

    expect((await get(server, "/api/notebooks")).status).toBe(200);
  });

  it("refuses a token that is not this server's", async () => {
    const server = await serve();
    const other = await serve();

    const response = await fetch(new URL("/api/notebooks", server.url), {
      headers: { authorization: `Bearer ${tokenOf(other)}` },
    });

    expect(response.status).toBe(401);
  });

  it("opens a connection for the browser that follows the URL, and sends it on to the shell", async () => {
    const server = await serve({ "hello.md": hello });

    const followed = await fetch(server.url, { redirect: "manual" });

    // The token leaves the address bar, and the browser carries a cookie instead.
    expect(followed.status).toBe(303);
    expect(followed.headers.get("location")).toBe("/");
    expect(followed.headers.get("set-cookie")).toMatch(
      /^octo_connection=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict$/,
    );
    const asBrowser = await fetch(new URL("/api/notebooks", server.url), {
      headers: { cookie: cookieOf(followed) },
    });
    expect(asBrowser.status).toBe(200);
  });

  it("sends a browser following an old URL on to the shell with no connection", async () => {
    const server = await serve();
    const url = new URL(server.url);
    url.searchParams.set("token", "0".repeat(64));

    const followed = await fetch(url, { redirect: "manual" });

    expect(followed.status).toBe(303);
    expect(followed.headers.get("set-cookie")).toBeNull();
  });

  it("does not make a wrong token hold up the printed URL, nor a bearer that follows", async () => {
    const server = await serve({ "hello.md": hello });
    const stale = new URL(server.url);
    stale.searchParams.set("token", "0".repeat(64));
    await fetch(stale, { redirect: "manual" });
    await fetch(new URL("/api/notebooks", server.url), {
      headers: { authorization: "Bearer wrong" },
    });

    const followed = await fetch(server.url, { redirect: "manual" });
    expect(followed.status).toBe(303);
    expect(followed.headers.get("set-cookie")).toMatch(/^octo_connection=/);
    expect((await get(server, "/api/notebooks")).status).toBe(200);
  });

  it("knows no connection it did not open", async () => {
    const server = await serve();

    const response = await fetch(new URL("/api/notebooks", server.url), {
      headers: { cookie: `octo_connection=${"0".repeat(64)}` },
    });

    expect(response.status).toBe(401);
  });

  it("refuses a WebSocket that does not authenticate, and takes one that does", async () => {
    const server = await serve({ "hello.md": hello });
    const session = await open(server, "hello.md");
    const followed = await fetch(server.url, { redirect: "manual" });

    await expect(watch(server, session.id, undefined, {})).rejects.toThrow();
    await expect(
      watch(server, session.id, undefined, { authorization: "Bearer wrong" }),
    ).rejects.toThrow();
    const browser = await watch(server, session.id, undefined, { cookie: cookieOf(followed) });
    expect((await browser.next("notebook-session")).session?.id).toBe(session.id);
    await browser.close();
  });

  it("opens a connection for a token pasted into the shell", async () => {
    const server = await serve();

    const response = await connect(server, { token: tokenOf(server) });

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toMatch(/^octo_connection=/);
    expect(
      (
        await fetch(new URL("/api/notebooks", server.url), {
          headers: { cookie: cookieOf(response) },
        })
      ).status,
    ).toBe(200);
  });

  it("serves the shell to anyone, since the shell is where one authenticates, and it holds nothing", async () => {
    const server = await serve();

    expect((await fetch(new URL("/", server.url))).status).toBe(200);
    expect((await fetch(new URL("/client/main.js", server.url))).status).toBe(200);
  });

  it("the shell presents a credential to the route that opens a Connection, naming the panel the page has", async () => {
    const server = await serve();
    const [page, script] = await Promise.all([
      (await fetch(new URL("/", server.url))).text(),
      (await fetch(new URL("/client/main.js", server.url))).text(),
    ]);

    expect(page).toContain('id="connect"');
    expect(page).toContain('id="connect-form"');
    expect(script).toContain('"/api/connect"');
    expect(script).toContain('element("connect")');
    expect(script).toContain('element("connect-form")');
  });
});

/** Presents a credential the way the shell's form does. */
const connect = (server: RunningServer, body: unknown) =>
  fetch(new URL("/api/connect", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("authenticating with the password", () => {
  /** The stored password `secret`, hashed once: a hash is made to take a moment. */
  let stored: string;
  beforeAll(async () => {
    stored = await hashPassword("secret");
  });
  const servePassword = () =>
    serve({ "hello.md": hello }, unusedAgent(), { storedPassword: stored });

  it("prints a URL with no token in it, since the browser asks for the password instead", async () => {
    const server = await servePassword();

    expect(new URL(server.url).search).toBe("");
    expect((await fetch(new URL("/api/notebooks", server.url))).status).toBe(401);
  });

  it("says a password is what to present", async () => {
    const server = await servePassword();

    const response = await fetch(new URL("/api/notebooks", server.url));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ authenticate: "password" });
  });

  it("opens a connection for the password, which the browser then carries", async () => {
    const server = await servePassword();

    const response = await connect(server, { password: "secret" });

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toMatch(
      /^octo_connection=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict$/,
    );
    const cookie = cookieOf(response);
    const opened = await fetch(new URL("/api/sessions", server.url), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ notebook: "hello.md" }),
    });
    expect(opened.status).toBe(201);
    const session = (await opened.json()) as NotebookSessionState;
    const browser = await watch(server, session.id, undefined, { cookie });
    expect((await browser.next("notebook-session")).session?.id).toBe(session.id);
    await browser.close();
  });

  it("refuses a wrong password", async () => {
    const server = await servePassword();

    const response = await connect(server, { password: "secrat" });

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("takes no token in the password's place", async () => {
    const server = await servePassword();

    expect((await connect(server, { token: "secret" })).status).toBe(401);
  });

  it("takes no bearer either", async () => {
    const server = await servePassword();

    const response = await fetch(new URL("/api/notebooks", server.url), {
      headers: { authorization: "Bearer secret" },
    });

    expect(response.status).toBe(401);
  });

  it("makes a wrong guess wait before the next is looked at, and longer each time", async () => {
    const server = await servePassword();

    expect((await connect(server, { password: "wrong" })).status).toBe(401);
    const tooSoon = await connect(server, { password: "secret" });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.headers.get("retry-after")).toBe("1");
    expect(await tooSoon.text()).toMatch(/1 second/);

    await new Promise((tick) => setTimeout(tick, 1100));
    expect((await connect(server, { password: "wrong again" })).status).toBe(401);
    const longer = await connect(server, { password: "secret" });
    expect(longer.status).toBe(429);
    expect(longer.headers.get("retry-after")).toBe("2");
  });

  it("looks at a burst of guesses one at a time, so only the first is tried", async () => {
    const server = await servePassword();

    // Fired inside the moment the first takes to hash; each is refused for
    // being a guess or for being too soon, never tried.
    const answers = await Promise.all(
      ["one", "two", "three", "four", "secret"].map((guess) =>
        connect(server, { password: guess }),
      ),
    );

    expect(answers.map((answer) => answer.status).sort()).toEqual([401, 429, 429, 429, 429]);
  });

  it("looks at the next attempt once the wait is over, and the right password ends the waiting", async () => {
    const server = await servePassword();
    expect((await connect(server, { password: "wrong" })).status).toBe(401);
    await new Promise((tick) => setTimeout(tick, 1100));

    expect((await connect(server, { password: "secret" })).status).toBe(204);

    // Back to the first wait: the failures before the success are forgotten.
    expect((await connect(server, { password: "wrong" })).status).toBe(401);
    expect((await connect(server, { password: "secret" })).headers.get("retry-after")).toBe("1");
  });

  it("takes only a request presenting the one credential", async () => {
    const server = await servePassword();

    expect((await connect(server, {})).status).toBe(400);
    expect((await connect(server, { password: 1 })).status).toBe(400);
    expect((await connect(server, { password: "secret", token: "x" })).status).toBe(400);
    expect((await connect(server, { password: "secret", remember: true })).status).toBe(400);
  });

  it("is asked for, never read", async () => {
    const server = await servePassword();

    const response = await fetch(new URL("/api/connect", server.url));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("opening a notebook", () => {
  it("creates a notebook session the server owns, with the notebook's cells in it", async () => {
    const server = await serve({ "hello.md": hello });

    const response = await post(server, "/api/sessions", { notebook: "hello.md" });

    expect(response.status).toBe(201);
    const session = (await response.json()) as NotebookSessionState;
    expect(session).toEqual({
      id: expect.any(String),
      notebook: "hello.md",
      title: "Hello",
      revision: expect.any(String),
      frontmatter: "title: Hello\n",
      inputs: [],
      segments: [
        { kind: "prose", text: "\n" },
        { kind: "cell", id: "greet" },
      ],
      running: false,
      sequence: 0,
      cells: [
        {
          id: "greet",
          type: "prompt",
          body: "Say hello.\n",
          uses: [],
          isolated: false,
          status: "idle",
          text: "",
          toolCalls: [],
          artifacts: [],
        },
      ],
    });
    // Kept by the server, not by whoever asked: found again by its id alone.
    expect(await stateOf(server, session.id)).toEqual(session);
  });

  it("shows each cell as the notebook declares it, so the browser can draw the notebook", async () => {
    const server = await serve({
      "declared.md": [
        "```bash id=count timeout=30s",
        "ls | wc -l",
        "```",
        "",
        "```prompt id=summary uses=count isolated=true model=anthropic/claude-haiku-4-5",
        "Summarise.",
        "```",
        "",
      ].join("\n"),
    });

    const session = await open(server, "declared.md");

    expect(session.cells).toMatchObject([
      {
        id: "count",
        type: "bash",
        body: "ls | wc -l\n",
        uses: [],
        isolated: false,
        timeout: 30_000,
      },
      {
        id: "summary",
        type: "prompt",
        body: "Summarise.\n",
        uses: ["count"],
        isolated: true,
        model: "anthropic/claude-haiku-4-5",
      },
    ]);
    expect(session.cells[0]).not.toHaveProperty("model");
    expect(session.cells[1]).not.toHaveProperty("timeout");
  });

  it("opens the same notebook into the session already open for it", async () => {
    const server = await serve({ "hello.md": hello });
    const first = await open(server, "hello.md");

    const response = await post(server, "/api/sessions", { notebook: "hello.md" });

    expect(response.status).toBe(200);
    expect(((await response.json()) as NotebookSessionState).id).toBe(first.id);
  });

  it("says which inputs the notebook declares, so the run view can draw its form", async () => {
    const server = await serve({
      "report.md": [
        "---",
        "inputs:",
        "  - name: target",
        "    type: string",
        "    default: src",
        "    description: The directory to report on",
        "  - name: depth",
        "    default: 3",
        "  - name: verbose",
        "    type: boolean",
        "---",
        "",
        "```bash id=count",
        "find {{target}} -maxdepth {{depth}} | wc -l",
        "```",
        "",
      ].join("\n"),
    });

    const session = await open(server, "report.md");

    // As declared, the type read off the default where none is written, and no
    // default where the notebook gives none: that is what makes an input required.
    expect(session.inputs).toEqual([
      { name: "target", type: "string", default: "src", description: "The directory to report on" },
      { name: "depth", type: "number", default: 3 },
      { name: "verbose", type: "boolean" },
    ]);
  });

  it("gives each notebook a session of its own", async () => {
    const server = await serve({ "hello.md": hello, "audit.md": audit });

    const one = await open(server, "hello.md");
    const other = await open(server, "audit.md");

    expect(other.id).not.toBe(one.id);
    expect(other.cells).toMatchObject([{ id: "scope", type: "bash", status: "idle", text: "" }]);
  });

  it("opens nothing outside the served directory, and nothing that is not there", async () => {
    const server = await serve({ "hello.md": hello });

    expect((await post(server, "/api/sessions", { notebook: "../hello.md" })).status).toBe(404);
    expect((await post(server, "/api/sessions", { notebook: "/etc/passwd" })).status).toBe(404);
    expect((await post(server, "/api/sessions", { notebook: "missing.md" })).status).toBe(404);
  });

  it("refuses a notebook that does not parse, saying why", async () => {
    const server = await serve({ "broken.md": "```prompt id=go\nnever closed\n" });

    const response = await post(server, "/api/sessions", { notebook: "broken.md" });

    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/broken\.md/);
  });

  it("takes only a request that names a notebook", async () => {
    const server = await serve({ "hello.md": hello });

    expect((await post(server, "/api/sessions", { path: "hello.md" })).status).toBe(400);
    expect(
      (
        await get(server, "/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not json",
        })
      ).status,
    ).toBe(400);
  });

  it("has no session under an id it never gave out", async () => {
    const server = await serve({ "hello.md": hello });

    expect((await get(server, "/api/sessions/nothing")).status).toBe(404);
  });

  it("is asked for, never read: opening is a change to what the server holds", async () => {
    const server = await serve({ "hello.md": hello });

    const response = await get(server, "/api/sessions");

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

/** An event as the server sends it, with as much of its shape as the tests read. */
interface Event {
  type: string;
  sequence?: number;
  run?: string;
  cells?: string[];
  cell?: string;
  text?: string;
  call?: { name: string; input: unknown };
  session?: NotebookSessionState;
  record?: {
    id?: string;
    status?: string;
    artifacts?: string[];
    cells?: { id: string; status: string }[];
  };
  error?: string;
  refusal?: { kind: string; problems: string[] };
}

/** A browser's view of a Notebook Session: the events, as they arrive. */
interface Watching {
  readonly socket: WebSocket;
  readonly events: Event[];
  /** Resolves with the next event of the kind not yet waited for, now or when it arrives. */
  next(type: string): Promise<Event>;
  close(): Promise<void>;
}

/**
 * Connects to a Notebook Session's events the way the browser does: fresh, or
 * — given `since` — as one reconnecting that has heard everything up to there;
 * authenticated as the browser is, unless other headers are given.
 */
function watch(
  server: RunningServer,
  id: string,
  since?: number | string,
  headers: Record<string, string> = authorized(server),
): Promise<Watching> {
  const url = new URL(`/api/sessions/${id}/events`, server.url);
  url.protocol = "ws:";
  url.search = "";
  if (since !== undefined) url.searchParams.set("since", String(since));
  const socket = new WebSocket(url, { headers });
  const events: Event[] = [];
  const waiting: { type: string; settle: (event: Event) => void }[] = [];
  /** How far `next` has read. */
  let read = 0;

  socket.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data)) as Event;
    events.push(event);
    const waiter = waiting.find((candidate) => candidate.type === event.type);
    if (waiter !== undefined) {
      waiting.splice(waiting.indexOf(waiter), 1);
      read = events.length;
      waiter.settle(event);
    }
  });

  const watching: Watching = {
    socket,
    events,
    next: (type) =>
      new Promise((settle) => {
        const index = events.findIndex((event, at) => at >= read && event.type === type);
        if (index !== -1) {
          read = index + 1;
          settle(events[index] as Event);
        } else waiting.push({ type, settle });
      }),
    close: () =>
      new Promise((closed) => {
        socket.addEventListener("close", () => closed(), { once: true });
        socket.close();
      }),
  };

  return new Promise((connected, failed) => {
    socket.addEventListener("open", () => connected(watching), { once: true });
    socket.addEventListener("error", () => failed(new Error("could not connect")), {
      once: true,
    });
  });
}

/** Asks a Notebook Session to run, and returns the status the server answered. */
const run = async (server: RunningServer, id: string, body?: unknown) =>
  (await post(server, `/api/sessions/${id}/run`, body)).status;

describe("running a notebook in its session", () => {
  it("tells a watching browser what it stands at, then streams the run as it happens", async () => {
    const agent = createScriptedAgent([{ text: "Hello, world" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);

    expect(await run(server, session.id)).toBe(202);
    const ended = await browser.next("run-ended");

    expect(browser.events.map((event) => event.type)).toEqual([
      "notebook-session",
      "run-started",
      "cell-started",
      "cell-text",
      "cell-ended",
      "run-ended",
    ]);
    expect(browser.events[0]?.session).toEqual(session);
    expect(browser.events[3]).toEqual({
      sequence: 3,
      type: "cell-text",
      cell: "greet",
      text: "Hello, world",
    });
    expect(ended.record?.cells).toEqual([expect.objectContaining({ id: "greet", status: "ok" })]);
    await browser.close();
  });

  it("names the run as it starts, by the id its record will carry", async () => {
    const agent = createScriptedAgent([{ text: "Hello, world" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);

    await run(server, session.id);
    const started = await browser.next("run-started");
    const ended = await browser.next("run-ended");

    expect(started).toMatchObject({
      sequence: 1,
      type: "run-started",
      run: ended.record?.id,
      cells: ["greet"],
    });
    // A browser that asks sees which run each cell's result is from, and no run
    // in progress once it is over.
    const state = await stateOf(server, session.id);
    expect(state.cells).toMatchObject([{ id: "greet", run: ended.record?.id }]);
    expect(state).not.toHaveProperty("run");
    await browser.close();
  });

  it("names the run in progress to a browser arriving between cells", async () => {
    // A command slow enough for a browser to arrive while the run is between
    // it and the next cell — no cell running, but a run under way.
    const agent = createScriptedAgent([{ hangs: true }]);
    const server = await serve(
      { "two.md": "```bash id=wait\nsleep 0.3\n```\n\n```prompt id=then uses=wait\nGo.\n```\n" },
      agent,
    );
    const session = await open(server, "two.md");
    const browser = await watch(server, session.id);
    await run(server, session.id);
    const started = await browser.next("run-started");

    const later = await watch(server, session.id);
    const told = await later.next("notebook-session");

    // What a cell that starts from here on is running in, so the files it
    // leaves can be placed before the record naming them arrives.
    expect(told.session).toMatchObject({ running: true, run: started.run });
    await Promise.all([browser.close(), later.close()]);
  });

  it("streams each tool call as the agent makes it, and holds them for a browser that asks", async () => {
    const calls = [
      { name: "read", input: { path: "README.md" } },
      { name: "bash", input: { command: "ls" } },
    ];
    // Invokes both tools, then goes quiet, so the calls are heard mid-cell.
    const agent = createScriptedAgent([{ hangs: true, toolCalls: calls }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);

    await run(server, session.id);
    const first = await browser.next("cell-tool-call");
    const second = await browser.next("cell-tool-call");

    expect(first).toEqual({ sequence: 3, type: "cell-tool-call", cell: "greet", call: calls[0] });
    expect(second).toEqual({ sequence: 4, type: "cell-tool-call", cell: "greet", call: calls[1] });
    expect(await stateOf(server, session.id)).toMatchObject({
      running: true,
      cells: [{ id: "greet", status: "running", toolCalls: calls }],
    });
    await browser.close();
  });

  it("holds a cell's tool calls with its result once the run is over", async () => {
    const calls = [{ name: "bash", input: { command: "ls" } }];
    const agent = createScriptedAgent([{ text: "Listed", toolCalls: calls }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);

    await run(server, session.id);
    await browser.next("run-ended");

    expect((await stateOf(server, session.id)).cells).toMatchObject([
      { id: "greet", status: "ok", text: "Listed", toolCalls: calls },
    ]);
    await browser.close();
  });

  it("streams a cell's text while the cell is still running", async () => {
    const agent = createScriptedAgent([{ hangs: true, text: "Working on it…" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);

    await run(server, session.id);
    const spoken = await browser.next("cell-text");

    expect(spoken).toEqual({
      sequence: 3,
      type: "cell-text",
      cell: "greet",
      text: "Working on it…",
    });
    // Still running, with what it has said so far, to anyone who asks.
    expect(await stateOf(server, session.id)).toMatchObject({
      running: true,
      cells: [{ id: "greet", status: "running", text: "Working on it…" }],
    });
    await browser.close();
  });

  it("holds the result once the run is over, for a browser that asks later", async () => {
    const agent = createScriptedAgent([{ text: "Hello, world" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);

    await run(server, session.id);
    await browser.next("run-ended");

    expect(await stateOf(server, session.id)).toMatchObject({
      running: false,
      cells: [{ id: "greet", status: "ok", text: "Hello, world" }],
    });
    await browser.close();
  });

  it("runs only the cells asked for, and carries on from the run before", async () => {
    const agent = createScriptedAgent([{ text: "a" }, { text: "b" }, { text: "b again" }]);
    const server = await serve({ "chain.md": chain }, agent);
    const session = await open(server, "chain.md");
    const browser = await watch(server, session.id);

    await run(server, session.id);
    await browser.next("run-ended");
    expect(await run(server, session.id, { cells: ["a"] })).toBe(202);
    await browser.next("run-ended");

    // The second run began where the first began, in the first run's Agent
    // Session, and left the cell built on `a` stale rather than rerun.
    expect(agent.prompts).toEqual(["Do a.", "Do b.", "Do a."]);
    expect(agent.resumptions).toEqual([undefined]);
    expect((await stateOf(server, session.id)).cells).toMatchObject([
      { id: "a", type: "prompt", status: "ok", text: "b again" },
      { id: "b", type: "prompt", status: "stale", text: "b" },
    ]);
    await browser.close();
  });

  it("gives a bash cell's output with its record, and its failure with its status", async () => {
    const server = await serve({ "audit.md": "```bash id=scope\necho found\nexit 3\n```\n" });
    const session = await open(server, "audit.md");
    const browser = await watch(server, session.id);

    await run(server, session.id);
    await browser.next("run-ended");

    expect((await stateOf(server, session.id)).cells).toMatchObject([
      {
        id: "scope",
        type: "bash",
        status: "error",
        text: "found\n",
        error: "Command exited with status 3",
      },
    ]);
    await browser.close();
  });

  it("runs one run at a time in a session", async () => {
    const agent = createScriptedAgent([{ hangs: true }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");

    expect(await run(server, session.id)).toBe(202);
    expect(await run(server, session.id)).toBe(409);
  });

  it("reports a run the runner refused, rather than running nothing silently", async () => {
    const server = await serve({ "greet.md": greet });
    const session = await open(server, "greet.md");
    const browser = await watch(server, session.id);

    await run(server, session.id);
    const refused = await browser.next("run-refused");

    expect(refused.error).toMatch(/name/);
    expect((await stateOf(server, session.id)).running).toBe(false);
    await browser.close();
  });

  it("says what kind of thing a refusal was about, and each problem apart, so the run view can explain it", async () => {
    const server = await serve({ "greet.md": greet });
    const session = await open(server, "greet.md");
    const browser = await watch(server, session.id);

    await run(server, session.id, { inputs: { nam: "Ada" } });
    const refused = await browser.next("run-refused");

    // Everything wrong at once, as the runner reports it, and the message the
    // author view shows as before: the problems under the notebook's path.
    expect(refused.refusal).toEqual({
      kind: "inputs",
      problems: [
        'No input named "nam" is declared by this notebook, which declares "name".',
        'No value for the required input "name" (string).',
      ],
    });
    expect(refused.error).toBe(
      `Cannot run ${join(server.directory, "greet.md")}:\n${refused.refusal?.problems.join("\n")}`,
    );
    await browser.close();
  });

  it("refuses a run whose declared skill is missing rather than running degraded, and says so", async () => {
    const agent = createScriptedAgent([{ text: "never reached" }]);
    const server = await serve(
      {
        "review.md": "---\nskills:\n  - review\n---\n\n```prompt id=go\nReview.\n```\n",
      },
      agent,
    );
    const session = await open(server, "review.md");
    const browser = await watch(server, session.id);

    await run(server, session.id);
    const refused = await browser.next("run-refused");

    expect(refused.refusal).toEqual({
      kind: "environment",
      problems: ['This notebook declares the skill "review", which is not available here.'],
    });
    // Nothing ran: no run named itself, and the agent was asked nothing.
    expect(browser.events.map((event) => event.type)).toEqual(["notebook-session", "run-refused"]);
    expect(agent.prompts).toEqual([]);
    expect((await stateOf(server, session.id)).cells).toMatchObject([{ id: "go", status: "idle" }]);
    await browser.close();
  });

  it("takes the values a run needs for the notebook's inputs", async () => {
    const agent = createScriptedAgent([{ text: "Hi, Ada" }]);
    const server = await serve({ "greet.md": greet }, agent);
    const session = await open(server, "greet.md");
    const browser = await watch(server, session.id);

    await run(server, session.id, { inputs: { name: "Ada" } });
    await browser.next("run-ended");

    expect(agent.prompts).toEqual(["Greet Ada."]);
    await browser.close();
  });

  it("reads a number and a yes or no as a form types them", async () => {
    const agent = createScriptedAgent([{ text: "Done" }]);
    const server = await serve(
      {
        "form.md": [
          "---",
          "inputs:",
          "  - name: depth",
          "    type: number",
          "  - name: verbose",
          "    type: boolean",
          "---",
          "",
          "```prompt id=go",
          "Go {{depth}} deep, verbose {{verbose}}.",
          "```",
          "",
        ].join("\n"),
      },
      agent,
    );
    const session = await open(server, "form.md");
    const browser = await watch(server, session.id);

    await run(server, session.id, { inputs: { depth: "3", verbose: "false" } });
    await browser.next("run-ended");

    expect(agent.prompts).toEqual(["Go 3 deep, verbose false."]);
    await browser.close();
  });

  it("takes only a well-formed request to run", async () => {
    const server = await serve({ "hello.md": hello });
    const session = await open(server, "hello.md");

    expect(await run(server, session.id, { cells: "greet" })).toBe(400);
    expect(await run(server, session.id, { notebook: "other.md" })).toBe(400);
  });

  it("tells a plain read of the events what to connect with instead", async () => {
    const server = await serve({ "hello.md": hello });
    const session = await open(server, "hello.md");

    const response = await get(server, `/api/sessions/${session.id}/events`);

    expect(response.status).toBe(426);
    expect(response.headers.get("upgrade")).toBe("websocket");
  });

  it("has no events for a session it never opened", async () => {
    const server = await serve({ "hello.md": hello });

    await expect(watch(server, "nothing")).rejects.toThrow();
  });
});

describe("interrupting a running cell", () => {
  it("stops the cell where it is, and the session records it as interrupted", async () => {
    const agent = createScriptedAgent([{ hangs: true }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);
    await run(server, session.id);
    await browser.next("cell-started");

    const response = await post(server, `/api/sessions/${session.id}/interrupt`);
    await browser.next("run-ended");

    expect(response.status).toBe(204);
    expect(agent.aborted).toEqual(["Say hello."]);
    expect(await stateOf(server, session.id)).toMatchObject({
      running: false,
      cells: [{ id: "greet", status: "interrupted", error: "Interrupted" }],
    });
    await browser.close();
  });

  it("answers once the cell has stopped, so the next run is taken at once", async () => {
    const agent = createScriptedAgent([{ hangs: true }, { text: "Hello, at last" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);
    await run(server, session.id);
    await browser.next("cell-started");

    await post(server, `/api/sessions/${session.id}/interrupt`);

    expect((await stateOf(server, session.id)).running).toBe(false);
    expect(await run(server, session.id)).toBe(202);
    await browser.close();
  });

  it("kills a bash cell where it is", async () => {
    const server = await serve({ "slow.md": "```bash id=wait\necho begun\nsleep 5\n```\n" });
    const session = await open(server, "slow.md");
    const browser = await watch(server, session.id);
    await run(server, session.id);
    await browser.next("cell-started");
    // A moment for the command to have written its first line.
    await new Promise((tick) => setTimeout(tick, 200));
    const began = Date.now();

    await post(server, `/api/sessions/${session.id}/interrupt`);

    expect(Date.now() - began).toBeLessThan(3000);
    expect((await stateOf(server, session.id)).cells).toMatchObject([
      { id: "wait", status: "interrupted", text: "begun\n" },
    ]);
    await browser.close();
  });

  it("is nothing to do when nothing is running", async () => {
    const server = await serve({ "hello.md": hello });
    const session = await open(server, "hello.md");

    expect((await post(server, `/api/sessions/${session.id}/interrupt`)).status).toBe(204);
  });

  it("leaves the session ready to run again", async () => {
    const agent = createScriptedAgent([{ hangs: true }, { text: "Hello, at last" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);
    await run(server, session.id);
    await browser.next("cell-started");
    await post(server, `/api/sessions/${session.id}/interrupt`);
    await browser.next("run-ended");

    expect(await run(server, session.id)).toBe(202);
    await browser.next("run-ended");

    expect((await stateOf(server, session.id)).cells).toMatchObject([
      { id: "greet", status: "ok", text: "Hello, at last" },
    ]);
    await browser.close();
  });

  it("stops a bash cell that is still running its command", async () => {
    const server = await serve({ "slow.md": "```bash id=wait\necho begun\nsleep 30\n```\n" });
    const session = await open(server, "slow.md");
    const browser = await watch(server, session.id);
    await run(server, session.id);
    await browser.next("cell-started");
    await new Promise((tick) => setTimeout(tick, 200));

    expect((await stateOf(server, session.id)).cells[0]).toMatchObject({
      id: "wait",
      status: "running",
      service: true,
    });
    const began = Date.now();
    const response = await post(server, `/api/sessions/${session.id}/cells/wait/stop`);
    await browser.next("run-ended");

    expect(response.status).toBe(204);
    expect(Date.now() - began).toBeLessThan(3000);
    expect((await stateOf(server, session.id)).cells[0]).toMatchObject({
      id: "wait",
      status: "interrupted",
    });
    expect((await stateOf(server, session.id)).cells[0]?.service).toBeUndefined();
    await browser.close();
  });

  it("stops a service a bash cell left running after the shell exited", async () => {
    const server = await serve({
      "serve.md": "```bash id=serve\nsleep 30 &\necho launched\n```\n",
    });
    const session = await open(server, "serve.md");
    const browser = await watch(server, session.id);
    try {
      await run(server, session.id);
      await browser.next("run-ended");

      expect((await stateOf(server, session.id)).cells[0]).toMatchObject({
        id: "serve",
        status: "ok",
        text: "launched\n",
        service: true,
      });
      const response = await post(server, `/api/sessions/${session.id}/cells/serve/stop`);
      expect(response.status).toBe(204);
      expect((await stateOf(server, session.id)).cells[0]?.service).toBeUndefined();
    } finally {
      await post(server, `/api/sessions/${session.id}/cells/serve/stop`).catch(() => undefined);
      await browser.close();
    }
  });

  it("refuses to stop a prompt cell, which has no service", async () => {
    const server = await serve({ "hello.md": hello });
    const session = await open(server, "hello.md");

    const response = await post(server, `/api/sessions/${session.id}/cells/greet/stop`);

    expect(response.status).toBe(422);
  });
});

describe("closing the server", () => {
  it("stops the runs in progress and waits for their records", async () => {
    const agent = createScriptedAgent([{ hangs: true }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);
    await run(server, session.id);
    await browser.next("cell-started");
    const cutOff = new Promise<void>((closed) =>
      browser.socket.addEventListener("close", () => closed()),
    );

    await server.close();
    running.splice(running.indexOf(server), 1);

    expect(agent.aborted).toEqual(["Say hello."]);
    // The record was written before `close` resolved, not left to finish behind it.
    expect(await readdir(join(server.directory, ".octo/runs/hello"))).toHaveLength(1);
    await cutOff;
  });
});

describe("several notebook sessions", () => {
  it("run at the same time, so one long run never holds up another", async () => {
    // One script serves both sessions: the first turn hangs, the second replies.
    const agent = createScriptedAgent([{ hangs: true }, { text: "Audited" }]);
    const server = await serve(
      { "slow.md": hello, "quick.md": "```prompt id=go\nGo.\n```\n" },
      agent,
    );
    const slow = await open(server, "slow.md");
    const quick = await open(server, "quick.md");
    const watchingSlow = await watch(server, slow.id);
    const watchingQuick = await watch(server, quick.id);

    await run(server, slow.id);
    await watchingSlow.next("cell-started");
    await run(server, quick.id);
    await watchingQuick.next("run-ended");

    expect(await stateOf(server, quick.id)).toMatchObject({
      running: false,
      cells: [{ id: "go", status: "ok", text: "Audited" }],
    });
    expect((await stateOf(server, slow.id)).running).toBe(true);
    // Each session hears only its own run: nothing of the quick one reached the slow one.
    expect(watchingSlow.events.map((event) => event.type)).toEqual([
      "notebook-session",
      "run-started",
      "cell-started",
    ]);
    expect(watchingQuick.events.filter((event) => event.type === "cell-text")).toEqual([
      { sequence: 3, type: "cell-text", cell: "go", text: "Audited" },
    ]);
    await Promise.all([watchingSlow.close(), watchingQuick.close()]);
  });
});

/** The session's state once nothing is running in it, asked for as a browser with no socket would. */
async function settled(server: RunningServer, id: string): Promise<NotebookSessionState> {
  for (;;) {
    const state = await stateOf(server, id);
    if (!state.running) return state;
    await new Promise((tick) => setTimeout(tick, 20));
  }
}

describe("a browser that goes away", () => {
  it("leaves the work running: the session is the server's, not the browser's", async () => {
    // Long enough that the browser is gone well before the command is done.
    const server = await serve({ "slow.md": "```bash id=wait\nsleep 0.3\necho survived\n```\n" });
    const session = await open(server, "slow.md");
    const browser = await watch(server, session.id);
    await run(server, session.id);
    await browser.next("cell-started");

    await browser.close();

    expect((await settled(server, session.id)).cells).toMatchObject([
      { id: "wait", status: "ok", text: "survived\n" },
    ]);
  });

  it("leaves a prompt cell's turn running too, and it is heard by the next browser", async () => {
    const agent = createScriptedAgent([{ hangs: true, text: "Still here" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);
    await run(server, session.id);
    await browser.next("cell-text");

    await browser.close();

    // Nothing stopped the turn: the agent was never told to, and the session
    // still says the cell is running with what it has said.
    expect(agent.aborted).toEqual([]);
    const later = await watch(server, session.id);
    expect((await later.next("notebook-session")).session).toMatchObject({
      running: true,
      cells: [{ id: "greet", status: "running", text: "Still here" }],
    });
    await later.close();
  });

  it("is told what happened by a browser that arrives later", async () => {
    const agent = createScriptedAgent([{ text: "Hello, world" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const first = await watch(server, session.id);
    await run(server, session.id);
    await first.next("run-ended");
    await first.close();

    const later = await watch(server, session.id);
    const told = await later.next("notebook-session");

    expect(told.session?.cells).toMatchObject([
      { id: "greet", type: "prompt", status: "ok", text: "Hello, world" },
    ]);
    await later.close();
  });
});

describe("a browser that comes back", () => {
  it("hears every event numbered, and is told in the snapshot which number the session stands at", async () => {
    const agent = createScriptedAgent([{ text: "Hello, world" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);

    await run(server, session.id);
    await browser.next("run-ended");

    const [snapshot, ...events] = browser.events;
    // Nothing has happened yet when the notebook is opened.
    expect(snapshot?.session?.sequence).toBe(0);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    // What a browser that asks now is told it stands at: the last event's number.
    expect((await stateOf(server, session.id)).sequence).toBe(5);
    await browser.close();
  });

  it("is told everything that happened while it was away, as it happened, and nothing twice", async () => {
    const calls = [{ name: "bash", input: { command: "ls" } }];
    const agent = createScriptedAgent([{ text: "Hello, world", toolCalls: calls }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);
    const heard = (await browser.next("notebook-session")).session?.sequence ?? -1;
    await browser.close();
    // The whole run happens with nobody watching.
    await run(server, session.id);
    const ended = await settled(server, session.id);

    const back = await watch(server, session.id, heard);
    const over = await back.next("run-ended");

    // No snapshot to redraw from and then hear the same events over: the
    // events since, in order, which is what the browser would have heard.
    expect(back.events).toEqual([
      expect.objectContaining({ sequence: 1, type: "run-started", run: ended.cells[0]?.run }),
      { sequence: 2, type: "cell-started", cell: "greet" },
      { sequence: 3, type: "cell-tool-call", cell: "greet", call: calls[0] },
      { sequence: 4, type: "cell-text", cell: "greet", text: "Hello, world" },
      { sequence: 5, type: "cell-ended", record: expect.objectContaining({ id: "greet" }) },
      { sequence: 6, type: "run-ended", record: expect.objectContaining({ id: over.record?.id }) },
    ]);
    await back.close();
  });

  it("hears what happens next after what it missed, with no gap between", async () => {
    const agent = createScriptedAgent([{ text: "First" }, { text: "Second" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    await run(server, session.id);
    await settled(server, session.id);

    // Back from having heard the first run's start, and running again at once.
    const back = await watch(server, session.id, 1);
    await run(server, session.id);
    await back.next("run-ended");
    await back.next("run-ended");

    expect(back.events.map((event) => event.sequence)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(back.events.filter((event) => event.type === "cell-text")).toMatchObject([
      { text: "First" },
      { text: "Second" },
    ]);
    await back.close();
  });

  it("has missed nothing when it comes back where it left, and hears only what follows", async () => {
    const agent = createScriptedAgent([{ text: "Hello, world" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");

    const back = await watch(server, session.id, 0);
    await run(server, session.id);
    await back.next("run-ended");

    expect(back.events.map((event) => event.type)).toEqual([
      "run-started",
      "cell-started",
      "cell-text",
      "cell-ended",
      "run-ended",
    ]);
    await back.close();
  });

  it("is given the snapshot instead when it names a number the session does not know", async () => {
    const agent = createScriptedAgent([{ text: "Hello, world" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    await run(server, session.id);
    await settled(server, session.id);

    // From the future, from nowhere, not a number, and nothing at all: none of
    // them a place in this session's events, so each is a browser that must
    // start over.
    for (const since of [99, -1, "soon", ""]) {
      const back = await watch(server, session.id, since);
      const told = await back.next("notebook-session");
      expect(told.session, String(since)).toMatchObject({
        sequence: 5,
        cells: [{ id: "greet", status: "ok", text: "Hello, world" }],
      });
      await back.close();
    }
  });
});

/**
 * Starts a server again over the directory a closed one served, with the
 * agent the new one is to run with — a fresh one, since nothing in memory
 * survives a restart.
 */
async function restart(server: RunningServer, agent: ScriptedAgent = unusedAgent()) {
  await server.close();
  running.splice(running.indexOf(server), 1);
  const again = await startServer({ port: 0, directory: server.directory, agent: agent.create });
  running.push(again);
  return again;
}

describe("a server that restarts", () => {
  it("finds the notebook sessions where it left them, under the ids it gave out", async () => {
    const agent = createScriptedAgent([{ text: "Hello, world" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    await run(server, session.id);
    await settled(server, session.id);

    const again = await restart(server);

    expect(await stateOf(again, session.id)).toMatchObject({
      id: session.id,
      notebook: "hello.md",
      running: false,
      sequence: 5,
      cells: [{ id: "greet", status: "ok", text: "Hello, world" }],
    });
    // Opening the notebook finds that session, not a second one beside it.
    const response = await post(again, "/api/sessions", { notebook: "hello.md" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as NotebookSessionState).id).toBe(session.id);
  });

  it("keeps what each run left, stale cells included, across the restart", async () => {
    const agent = createScriptedAgent([{ text: "a" }, { text: "b" }, { text: "a again" }]);
    const server = await serve({ "chain.md": chain }, agent);
    const session = await open(server, "chain.md");
    await run(server, session.id);
    await settled(server, session.id);
    await run(server, session.id, { cells: ["a"] });
    const before = await settled(server, session.id);

    const again = await restart(server);

    const after = await stateOf(again, session.id);
    expect(after).toEqual(before);
    expect(after.cells).toMatchObject([
      { id: "a", status: "ok", text: "a again" },
      { id: "b", status: "stale", text: "b" },
    ]);
  });

  it("stops a run in progress as it goes down, and comes back with the cell recorded as interrupted", async () => {
    const agent = createScriptedAgent([{ hangs: true, text: "Half way" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    await run(server, session.id);
    const browser = await watch(server, session.id);
    await browser.next("cell-text");
    await browser.close();

    const again = await restart(server);

    expect(await stateOf(again, session.id)).toMatchObject({
      running: false,
      cells: [{ id: "greet", status: "interrupted", text: "", error: "Interrupted" }],
    });
  });

  it("tells a browser coming back after the restart what it missed, from where it left", async () => {
    const agent = createScriptedAgent([{ text: "Hello, world" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);
    const heard = (await browser.next("notebook-session")).session?.sequence ?? -1;
    await browser.close();
    await run(server, session.id);
    await settled(server, session.id);

    const again = await restart(server);
    const back = await watch(again, session.id, heard);
    await back.next("run-ended");

    expect(back.events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "run-started"],
      [2, "cell-started"],
      [3, "cell-text"],
      [4, "cell-ended"],
      [5, "run-ended"],
    ]);
    await back.close();
  });

  it("carries the next run on from the agent session the records name, reopened through the agent", async () => {
    const before = createScriptedAgent([{ text: "a" }, { text: "b" }]);
    const server = await serve({ "chain.md": chain }, before);
    const session = await open(server, "chain.md");
    await run(server, session.id);
    await settled(server, session.id);

    const after = createScriptedAgent([{ text: "a again" }]);
    const again = await restart(server, after);
    expect(await run(again, session.id, { cells: ["a"] })).toBe(202);
    const state = await settled(again, session.id);

    // The new server's agent was asked to reopen the Agent Session the old
    // one's runs were in, and to fork it where `a` began: nothing of pi's was
    // read or written by anything but pi.
    expect(after.setups.map((setup) => setup.agentSession)).toEqual([before.agentSession]);
    expect(after.resumptions).toEqual([undefined]);
    expect(state.cells).toMatchObject([
      { id: "a", status: "ok", text: "a again" },
      { id: "b", status: "stale", text: "b" },
    ]);
  });

  /**
   * Leaves the directory as a server that died mid-run would have: the
   * session's journal cut off after its last event of `type`, with the line
   * it was writing as it died left half-written, and the run's record —
   * written only when a run ends — never written.
   */
  async function crashed(server: RunningServer, session: string, type: string, run: string) {
    await server.close();
    running.splice(running.indexOf(server), 1);
    const journal = join(server.directory, ".octo/journals", `${session}.jsonl`);
    const lines = (await readFile(journal, "utf8")).split("\n").filter((line) => line !== "");
    const cut = lines.findLastIndex((line) => (JSON.parse(line) as Event).type === type);
    const kept = lines.slice(0, cut + 1);
    const halfWritten = (lines[cut + 1] ?? '{"at":"2026-09-17T00:00:00.000Z"').slice(0, 20);
    await writeFile(journal, `${kept.join("\n")}\n${halfWritten}`, "utf8");
    await rm(join(server.directory, ".octo/runs/hello", run, "record.json"));
  }

  it("records a run it died in the middle of as far as it got, the cell in flight interrupted", async () => {
    const calls = [{ name: "bash", input: { command: "ls" } }];
    const agent = createScriptedAgent([{ text: "Hello, wor", toolCalls: calls }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);
    await run(server, session.id);
    const started = await browser.next("run-started");
    await browser.next("run-ended");
    await browser.close();
    await crashed(server, session.id, "cell-text", started.run ?? "");

    const again = await startServer({
      port: 0,
      directory: server.directory,
      agent: unusedAgent().create,
    });
    running.push(again);

    // Not running: nothing is. The cell is interrupted as one stopped from the
    // browser is — half a reply is not what it asked for (ADR-0017) — and the
    // run has a record, so the next run can carry on from it. The cell's end
    // and the run's are two events more than the journal held.
    const recovered = await stateOf(again, session.id);
    expect(recovered).toMatchObject({
      running: false,
      sequence: 6,
      cells: [
        {
          id: "greet",
          status: "interrupted",
          text: "",
          toolCalls: [],
          run: started.run,
          error: "The server stopped while this cell was running",
        },
      ],
    });
    const record = (await (
      await get(again, `/api/sessions/${session.id}/runs/${started.run}/record.json`)
    ).json()) as { cells: unknown[]; agentSession?: string };
    expect(record.cells).toEqual([
      expect.objectContaining({ id: "greet", type: "prompt", status: "interrupted" }),
    ]);
    // No turn ended, so no Anchor stands, so no Agent Session is named: pi
    // may never have written one.
    expect(record).not.toHaveProperty("agentSession");

    // The half-written line was cut off before the recovery wrote after it,
    // so the journal reads whole to the next server too.
    const once = await restart(again);
    expect(await stateOf(once, session.id)).toEqual(recovered);
  });

  it("tells a browser coming back after the crash how the run ended", async () => {
    const agent = createScriptedAgent([{ text: "Hello, world" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);
    await run(server, session.id);
    const started = await browser.next("run-started");
    await browser.next("run-ended");
    await browser.close();
    await crashed(server, session.id, "cell-started", started.run ?? "");

    const again = await startServer({
      port: 0,
      directory: server.directory,
      agent: unusedAgent().create,
    });
    running.push(again);
    const back = await watch(again, session.id, 2);
    const ended = await back.next("run-ended");

    expect(back.events.map((event) => [event.sequence, event.type])).toEqual([
      [3, "cell-ended"],
      [4, "run-ended"],
    ]);
    expect(ended.record).toMatchObject({
      id: started.run,
      cells: [{ id: "greet", status: "interrupted" }],
    });
    await back.close();
  });

  it("carries on from a run it died in, keeping the anchors of the cells that had ended", async () => {
    const before = createScriptedAgent([{ text: "a" }, { text: "b" }]);
    const server = await serve({ "hello.md": chain }, before);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);
    await run(server, session.id);
    const started = await browser.next("run-started");
    await browser.next("run-ended");
    await browser.close();
    // Died after `a` ended and `b` began.
    await crashed(server, session.id, "cell-started", started.run ?? "");

    const after = createScriptedAgent([{ text: "b at last" }]);
    const again = await startServer({ port: 0, directory: server.directory, agent: after.create });
    running.push(again);
    expect(await stateOf(again, session.id)).toMatchObject({
      cells: [
        { id: "a", status: "ok", text: "a" },
        { id: "b", status: "interrupted", text: "" },
      ],
    });
    await run(again, session.id, { cells: ["b"] });
    const state = await settled(again, session.id);

    // `a`'s turn ended and left an Anchor in the Agent Session, so the run
    // that died is what the next one continues, and `b` begins after `a`.
    expect(after.setups.map((setup) => setup.agentSession)).toEqual([before.agentSession]);
    expect(after.resumptions).toEqual([before.anchors[0]]);
    expect(state.cells).toMatchObject([
      { id: "a", status: "ok", text: "a" },
      { id: "b", status: "ok", text: "b at last" },
    ]);
  });

  it("shows a notebook edited while no server ran as it now is, and tells a browser coming back so", async () => {
    const server = await serve({ "hello.md": hello });
    const session = await open(server, "hello.md");
    await server.close();
    running.splice(running.indexOf(server), 1);
    await writeFile(join(server.directory, "hello.md"), hello.replace("Say hello.", "Wave."));

    const again = await startServer({
      port: 0,
      directory: server.directory,
      agent: unusedAgent().create,
    });
    running.push(again);

    const now = await stateOf(again, session.id);
    expect(now.revision).not.toBe(session.revision);
    expect(now.cells).toMatchObject([{ id: "greet", body: "Wave.\n" }]);
    // Said as an event, since a browser that adopts the state it last had
    // would otherwise go on showing the notebook as it was.
    const back = await watch(again, session.id, session.sequence);
    const told = await back.next("notebook-changed");
    expect(told.sequence).toBe(1);
    expect(told.session).toEqual(now);
    await back.close();
  });

  it("finds a notebook that was gone when it started once the notebook is back and opened, as the session it was", async () => {
    const agent = createScriptedAgent([{ text: "Hello, world" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    await run(server, session.id);
    await settled(server, session.id);
    await server.close();
    running.splice(running.indexOf(server), 1);
    await rm(join(server.directory, "hello.md"));

    const again = await startServer({
      port: 0,
      directory: server.directory,
      agent: unusedAgent().create,
    });
    running.push(again);
    expect((await get(again, `/api/sessions/${session.id}`)).status).toBe(404);

    await writeFile(join(server.directory, "hello.md"), hello);
    const response = await post(again, "/api/sessions", { notebook: "hello.md" });

    // The session it was, not a new one beside a journal nobody would read.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: session.id,
      cells: [{ id: "greet", status: "ok", text: "Hello, world" }],
    });
  });

  it("has nothing to find over a directory no server has served", async () => {
    const server = await serve({ "hello.md": hello });

    expect((await get(server, "/api/notebooks")).status).toBe(200);
    expect(await readdir(server.directory)).toEqual(["hello.md"]);
  });
});

/** A one-pixel PNG, which is the smallest image a browser will draw. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A Notebook whose one Cell leaves a picture, a page, a note and a page with a
 * name no Latin-1 header could carry in its artifact directory, and a link
 * pointing out of it at the workspace.
 */
const leaves = [
  "```bash id=make",
  `printf '%s' '${PIXEL.toString("base64")}' | base64 -d > "{{artifacts}}/chart.png"`,
  `printf '<script>alert(1)</script>' > "{{artifacts}}/page.html"`,
  `printf 'noted' > "{{artifacts}}/notes.txt"`,
  `printf '<h1>页面</h1>' > "{{artifacts}}/页面.html"`,
  `ln -s "$(pwd)" "{{artifacts}}/away"`,
  "```",
  "",
].join("\n");

describe("the files a run leaves", () => {
  /** Runs the one-Cell Notebook and returns the session's view of the Cell, the run over. */
  const made = async (server: RunningServer) => {
    const session = await open(server, "leaves.md");
    const browser = await watch(server, session.id);
    await run(server, session.id);
    const ended = await browser.next("run-ended");
    await browser.close();
    const cell = (await stateOf(server, session.id)).cells[0] as CellView;
    return { session, cell, run: ended.record?.id ?? "" };
  };

  /** Fetches one of a run's files from where the browser does. */
  const runFile = (server: RunningServer, session: string, run: string, path: string) =>
    get(server, `/api/sessions/${session}/runs/${run}/${path}`);

  it("are named against the cell with the run they belong to", async () => {
    const server = await serve({ "leaves.md": leaves });

    const { cell, run } = await made(server);

    // The files, and not the link: a link is not something the cell left.
    expect(cell).toMatchObject({
      status: "ok",
      run,
      artifacts: [
        "artifacts/make/chart.png",
        "artifacts/make/notes.txt",
        "artifacts/make/page.html",
        "artifacts/make/页面.html",
      ],
    });
  });

  it("are served from under the run's directory, an image as the image it is", async () => {
    const server = await serve({ "leaves.md": leaves });
    const { session, run } = await made(server);

    const response = await runFile(server, session.id, run, "artifacts/make/chart.png");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).equals(PIXEL)).toBe(true);
  });

  it("serve a text file as text, and the run's own record as JSON", async () => {
    const server = await serve({ "leaves.md": leaves });
    const { session, run } = await made(server);

    const notes = await runFile(server, session.id, run, "artifacts/make/notes.txt");
    const record = await runFile(server, session.id, run, "record.json");

    expect(notes.headers.get("content-type")).toContain("text/plain");
    expect(await notes.text()).toBe("noted");
    expect(record.headers.get("content-type")).toContain("application/json");
    expect(((await record.json()) as { id: string }).id).toBe(run);
  });

  it("never serve a file the browser would run: a page an agent wrote is a download", async () => {
    const server = await serve({ "leaves.md": leaves });
    const { session, run } = await made(server);

    const response = await runFile(server, session.id, run, "artifacts/make/page.html");

    // The client and the files a run leaves share an origin, so a page served
    // as a page could read whatever the client holds.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="page.html"; filename*=UTF-8''page.html`,
    );
  });

  it("offer a download under a name a header cannot carry as written", async () => {
    const server = await serve({ "leaves.md": leaves });
    const { session, run } = await made(server);

    const response = await runFile(server, session.id, run, "artifacts/make/页面.html");

    // The header itself is Latin-1; the name goes encoded, with a fallback the
    // header can spell, rather than the response failing to be written at all.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="__.html"; filename*=UTF-8''${encodeURIComponent("页面.html")}`,
    );
  });

  it("follow no link out of the run's directory", async () => {
    const server = await serve({ "leaves.md": leaves, "hello.md": hello });
    const { session, run } = await made(server);

    // `away` points at the workspace, where `hello.md` is.
    const response = await runFile(server, session.id, run, "artifacts/make/away/hello.md");

    expect(response.status).toBe(404);
  });

  it("are nothing outside the run's directory, and nothing for a run that never was", async () => {
    const server = await serve({ "leaves.md": leaves, "hello.md": hello });
    const { session, run } = await made(server);
    const runs = `/api/sessions/${session.id}/runs`;

    // A climb the URL parser does not fold away, spelt with encoded slashes,
    // in the run's name and in the file's; `hello.md` is there to be reached.
    const raw = (path: string) => rawRequest(server.url, path, authorized(server));
    expect(await raw(`${runs}/..%2F..%2F..%2F..%2Fhello.md/record.json`)).toBe(404);
    expect(await raw(`${runs}/${run}/..%2F..%2F..%2F..%2Fhello.md`)).toBe(404);
    expect(await raw(`${runs}/${run}/%00record.json`)).toBe(404);
    expect((await runFile(server, session.id, "no-such-run", "record.json")).status).toBe(404);
    expect((await runFile(server, session.id, run, "artifacts/make/absent.png")).status).toBe(404);
    // A directory is not a file to serve.
    expect((await runFile(server, session.id, run, "artifacts")).status).toBe(404);
  });

  it("are read, never written", async () => {
    const server = await serve({ "leaves.md": leaves });
    const { session, run } = await made(server);

    const response = await post(server, `/api/sessions/${session.id}/runs/${run}/record.json`);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});

/** A Notebook with Prose around its Cells, as an author would write one. */
const essay = `---
title: Essay
---

# The work

An introduction.

\`\`\`bash id=look
echo before
\`\`\`

Then the agent takes over.

\`\`\`prompt id=think uses=look
Think about it.
\`\`\`
`;

/** One segment of a document as an edit describes it. */
type SegmentEdit =
  | { kind: "prose"; text: string }
  | {
      kind: "cell";
      id: string;
      type: string;
      body: string;
      uses: string[];
      isolated: boolean;
      model?: string;
      timeout?: string;
    };

/** The edit describing a Notebook Session's document exactly as it stands. */
function editOf(state: NotebookSessionState): {
  frontmatter?: string;
  segments: SegmentEdit[];
} {
  return {
    ...(state.frontmatter !== undefined ? { frontmatter: state.frontmatter } : {}),
    segments: state.segments.map((segment): SegmentEdit => {
      if (segment.kind === "prose") return segment;
      const cell = state.cells.find((candidate) => candidate.id === segment.id);
      if (cell === undefined)
        throw new Error(`the layout names a cell "${segment.id}" the state lacks`);
      return {
        kind: "cell",
        id: cell.id,
        type: cell.type,
        body: cell.body.replace(/\r?\n$/, ""),
        uses: cell.uses,
        isolated: cell.isolated,
        ...(cell.model !== undefined ? { model: cell.model } : {}),
        ...(cell.timeout !== undefined ? { timeout: `${cell.timeout}ms` } : {}),
      };
    }),
  };
}

/** Asks the session to save a document, based on the state the browser has, and returns the answer. */
const save = (server: RunningServer, state: NotebookSessionState, edit: unknown) =>
  post(server, `/api/sessions/${state.id}/save`, {
    base: state.revision,
    ...(edit as Record<string, unknown>),
  });

/** The state, with one Cell's declaration changed. */
function withCell(
  state: NotebookSessionState,
  id: string,
  change: (cell: Extract<SegmentEdit, { kind: "cell" }>) => SegmentEdit,
) {
  const edit = editOf(state);
  return {
    ...edit,
    segments: edit.segments.map((segment) =>
      segment.kind === "cell" && segment.id === id ? change(segment) : segment,
    ),
  };
}

describe("editing a notebook in its session", () => {
  it("shows the document around the cells: its frontmatter, and the prose between them", async () => {
    const server = await serve({ "essay.md": essay });

    const session = await open(server, "essay.md");

    expect(session.frontmatter).toBe("title: Essay\n");
    expect(session.segments).toEqual([
      { kind: "prose", text: "\n# The work\n\nAn introduction.\n\n" },
      { kind: "cell", id: "look" },
      { kind: "prose", text: "\nThen the agent takes over.\n\n" },
      { kind: "cell", id: "think" },
    ]);
    expect(session.revision).toMatch(/^[0-9a-f]{16}$/);
  });

  it("has no frontmatter to show for a notebook that has none", async () => {
    const server = await serve({ "chain.md": chain });

    const session = await open(server, "chain.md");

    expect(session).not.toHaveProperty("frontmatter");
  });

  it("saves one cell's body, changing only that cell's bytes on disk", async () => {
    const server = await serve({ "essay.md": essay });
    const session = await open(server, "essay.md");
    const browser = await watch(server, session.id);

    const response = await save(
      server,
      session,
      withCell(session, "look", (cell) => ({ ...cell, body: "echo after" })),
    );

    expect(response.status).toBe(200);
    expect(await readFile(join(server.directory, "essay.md"), "utf8")).toBe(
      essay.replace("echo before\n", "echo after\n"),
    );
    // The session now shows the notebook as saved, under a new revision, and
    // every browser watching hears so.
    const saved = (await response.json()) as NotebookSessionState;
    expect(saved.cells[0]).toMatchObject({ id: "look", body: "echo after\n" });
    expect(saved.revision).not.toBe(session.revision);
    expect(await stateOf(server, session.id)).toEqual(saved);
    const heard = await browser.next("notebook-changed");
    expect(heard.session).toEqual(saved);
    await browser.close();
  });

  it("runs the notebook as saved", async () => {
    const server = await serve({ "essay.md": essay }, createScriptedAgent([{ text: "Thought" }]));
    const session = await open(server, "essay.md");
    await save(
      server,
      session,
      withCell(session, "look", (cell) => ({ ...cell, body: "echo after" })),
    );
    const browser = await watch(server, session.id);

    await run(server, session.id);
    await browser.next("run-ended");

    expect((await stateOf(server, session.id)).cells).toMatchObject([
      { id: "look", status: "ok", text: "after\n" },
      { id: "think", status: "ok", text: "Thought" },
    ]);
    await browser.close();
  });

  it("keeps what each cell last produced across an edit, and forgets a cell that is removed", async () => {
    const server = await serve({ "essay.md": essay }, createScriptedAgent([{ text: "Thought" }]));
    const session = await open(server, "essay.md");
    const browser = await watch(server, session.id);
    await run(server, session.id);
    await browser.next("run-ended");
    const ran = await stateOf(server, session.id);

    const edit = withCell(ran, "look", (cell) => ({ ...cell, body: "echo changed" }));
    const response = await save(server, ran, {
      ...edit,
      segments: edit.segments.filter(
        (segment) => !(segment.kind === "cell" && segment.id === "think"),
      ),
    });

    expect(response.status).toBe(200);
    const saved = (await response.json()) as NotebookSessionState;
    expect(saved.cells).toMatchObject([
      { id: "look", body: "echo changed\n", status: "ok", text: "before\n" },
    ]);
    await browser.close();
  });

  it("adds, removes and reorders cells", async () => {
    const server = await serve({ "essay.md": essay });
    const session = await open(server, "essay.md");
    const edit = editOf(session);
    const [intro, look, between, think] = edit.segments as [
      SegmentEdit,
      SegmentEdit,
      SegmentEdit,
      SegmentEdit,
    ];
    const added: SegmentEdit = {
      kind: "cell",
      id: "report",
      type: "prompt",
      body: "Report.",
      uses: ["look"],
      isolated: true,
      model: "anthropic/claude-haiku-4-5",
      timeout: "5m",
    };

    // `think` moved above `look`, `report` added at the end; nothing depends on
    // `think` any more, so its edge to `look` goes too.
    const response = await save(server, session, {
      ...edit,
      segments: [
        intro,
        { ...(think as Extract<SegmentEdit, { kind: "cell" }>), uses: [] },
        between,
        look,
        { kind: "prose", text: "\n" },
        added,
      ],
    });

    expect(response.status).toBe(200);
    const saved = (await response.json()) as NotebookSessionState;
    expect(saved.segments).toEqual([
      { kind: "prose", text: "\n# The work\n\nAn introduction.\n\n" },
      { kind: "cell", id: "think" },
      { kind: "prose", text: "\nThen the agent takes over.\n\n" },
      { kind: "cell", id: "look" },
      { kind: "prose", text: "\n" },
      { kind: "cell", id: "report" },
    ]);
    expect(saved.cells).toMatchObject([
      { id: "think", uses: [] },
      { id: "look" },
      {
        id: "report",
        type: "prompt",
        body: "Report.\n",
        uses: ["look"],
        isolated: true,
        model: "anthropic/claude-haiku-4-5",
        timeout: 300_000,
        status: "idle",
      },
    ]);
    expect(await readFile(join(server.directory, "essay.md"), "utf8")).toBe(
      [
        "---",
        "title: Essay",
        "---",
        "",
        "# The work",
        "",
        "An introduction.",
        "",
        "```prompt id=think",
        "Think about it.",
        "```",
        "",
        "Then the agent takes over.",
        "",
        "```bash id=look",
        "echo before",
        "```",
        "",
        "```prompt id=report uses=look isolated model=anthropic/claude-haiku-4-5 timeout=5m",
        "Report.",
        "```",
        "",
      ].join("\n"),
    );
  });

  it("edits the frontmatter: a new title is the session's, a new input is the run's to take", async () => {
    const agent = createScriptedAgent([{ text: "Thought" }]);
    const server = await serve({ "essay.md": essay }, agent);
    const session = await open(server, "essay.md");
    const edit = withCell(session, "think", (cell) => ({
      ...cell,
      body: "Think about {{topic}}.",
    }));

    const response = await save(server, session, {
      ...edit,
      frontmatter: "title: An essay\ninputs:\n  - name: topic\n",
    });

    expect(response.status).toBe(200);
    const saved = (await response.json()) as NotebookSessionState;
    expect(saved.title).toBe("An essay");
    expect(saved.frontmatter).toBe("title: An essay\ninputs:\n  - name: topic\n");
    const browser = await watch(server, session.id);
    await run(server, session.id, { inputs: { topic: "fidelity" } });
    await browser.next("run-ended");
    expect(agent.prompts).toEqual(["Think about fidelity."]);
    await browser.close();
  });

  it("edits a cell's dependency edges", async () => {
    const server = await serve({ "essay.md": essay });
    const session = await open(server, "essay.md");

    const response = await save(
      server,
      session,
      withCell(session, "think", (cell) => ({ ...cell, uses: [], isolated: true })),
    );

    expect(response.status).toBe(200);
    const saved = (await response.json()) as NotebookSessionState;
    expect(saved.cells[1]).toMatchObject({ id: "think", uses: [], isolated: true });
    expect(await readFile(join(server.directory, "essay.md"), "utf8")).toBe(
      essay.replace("```prompt id=think uses=look", "```prompt id=think isolated"),
    );
  });

  it("refuses an edit the format cannot read, saying why, and writes nothing", async () => {
    const server = await serve({ "essay.md": essay });
    const session = await open(server, "essay.md");

    const response = await save(
      server,
      session,
      withCell(session, "think", (cell) => ({ ...cell, uses: ["nowhere"] })),
    );

    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/line 15: Cell "think" uses "nowhere"/);
    expect(await readFile(join(server.directory, "essay.md"), "utf8")).toBe(essay);
    expect(await stateOf(server, session.id)).toEqual(session);
  });

  it("refuses to save a notebook with no cells left in it", async () => {
    const server = await serve({ "essay.md": essay });
    const session = await open(server, "essay.md");
    const edit = editOf(session);

    const response = await save(server, session, {
      ...edit,
      segments: edit.segments.filter((segment) => segment.kind === "prose"),
    });

    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/no cells/);
    expect(await readFile(join(server.directory, "essay.md"), "utf8")).toBe(essay);
  });

  it("detects that the notebook changed on disk since it was opened, rather than overwriting it", async () => {
    const server = await serve({ "essay.md": essay });
    const session = await open(server, "essay.md");
    const browser = await watch(server, session.id);
    const onDisk = essay.replace("echo before", "echo elsewhere");
    await writeFile(join(server.directory, "essay.md"), onDisk, "utf8");

    const response = await save(
      server,
      session,
      withCell(session, "look", (cell) => ({ ...cell, body: "echo mine" })),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(/changed on disk/);
    expect(await readFile(join(server.directory, "essay.md"), "utf8")).toBe(onDisk);
    // The session now shows what is on disk, and says so to whoever is watching.
    const now = await stateOf(server, session.id);
    expect(now.cells[0]).toMatchObject({ id: "look", body: "echo elsewhere\n" });
    expect(now.revision).not.toBe(session.revision);
    expect((await browser.next("notebook-changed")).session).toEqual(now);
    // Told, the browser may save over it on purpose, from the revision it now knows.
    const again = await save(
      server,
      now,
      withCell(now, "look", (cell) => ({ ...cell, body: "echo mine" })),
    );
    expect(again.status).toBe(200);
    expect(await readFile(join(server.directory, "essay.md"), "utf8")).toBe(
      essay.replace("echo before", "echo mine"),
    );
    await browser.close();
  });

  it("detects a draft made from a revision another browser has since saved over", async () => {
    const server = await serve({ "essay.md": essay });
    const session = await open(server, "essay.md");

    const first = await save(
      server,
      session,
      withCell(session, "look", (cell) => ({ ...cell, body: "echo first" })),
    );
    const second = await save(
      server,
      session,
      withCell(session, "look", (cell) => ({ ...cell, body: "echo second" })),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.text()).toMatch(/saved since/);
    expect(await readFile(join(server.directory, "essay.md"), "utf8")).toBe(
      essay.replace("echo before", "echo first"),
    );
  });

  it("takes only a document based on a revision, with segments it can read", async () => {
    const server = await serve({ "essay.md": essay });
    const session = await open(server, "essay.md");
    const edit = editOf(session);
    const url = `/api/sessions/${session.id}/save`;

    expect((await post(server, url, edit)).status).toBe(400);
    expect((await post(server, url, { base: session.revision })).status).toBe(400);
    expect(
      (await post(server, url, { base: session.revision, segments: [{ kind: "verse" }] })).status,
    ).toBe(400);
    expect(
      (
        await post(server, url, {
          base: session.revision,
          segments: [{ kind: "cell", id: "a", type: "prompt", body: "x" }],
        })
      ).status,
    ).toBe(400);
    expect((await post(server, url, { ...edit, base: session.revision, extra: 1 })).status).toBe(
      400,
    );
    expect(await readFile(join(server.directory, "essay.md"), "utf8")).toBe(essay);
  });

  it("is a change to the file, never a read", async () => {
    const server = await serve({ "essay.md": essay });
    const session = await open(server, "essay.md");

    const response = await get(server, `/api/sessions/${session.id}/save`);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("duplicating a notebook", () => {
  it("copies the file byte for byte under the new name, which is then a notebook of its own", async () => {
    const server = await serve({ "essay.md": essay });

    const response = await post(server, "/api/notebooks", {
      from: "essay.md",
      to: "drafts/essay-copy.md",
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ path: "drafts/essay-copy.md", title: "Essay" });
    expect(await readFile(join(server.directory, "drafts/essay-copy.md"), "utf8")).toBe(essay);
    const listed = (await (await get(server, "/api/notebooks")).json()) as {
      notebooks: unknown[];
    };
    expect(listed.notebooks).toEqual([
      { path: "drafts/essay-copy.md", title: "Essay" },
      { path: "essay.md", title: "Essay" },
    ]);
  });

  it("is edited independently of the original", async () => {
    const server = await serve({ "essay.md": essay });
    await post(server, "/api/notebooks", { from: "essay.md", to: "copy.md" });
    const original = await open(server, "essay.md");
    const copy = await open(server, "copy.md");
    expect(copy.id).not.toBe(original.id);

    const response = await save(server, copy, {
      ...editOf(copy),
      frontmatter: "title: The copy\n",
    });

    expect(response.status).toBe(200);
    expect(await readFile(join(server.directory, "copy.md"), "utf8")).toBe(
      essay.replace("title: Essay", "title: The copy"),
    );
    expect(await readFile(join(server.directory, "essay.md"), "utf8")).toBe(essay);
    expect(await stateOf(server, original.id)).toEqual(original);
  });

  it("never writes over a notebook that is already there", async () => {
    const server = await serve({ "essay.md": essay, "hello.md": hello });

    const response = await post(server, "/api/notebooks", { from: "essay.md", to: "hello.md" });

    expect(response.status).toBe(409);
    expect(await readFile(join(server.directory, "hello.md"), "utf8")).toBe(hello);
  });

  it("copies only a notebook that is there, to a Markdown name under the served directory", async () => {
    const server = await serve({ "essay.md": essay });
    const copy = (body: unknown) => post(server, "/api/notebooks", body);

    expect((await copy({ from: "missing.md", to: "copy.md" })).status).toBe(404);
    expect((await copy({ from: "../essay.md", to: "copy.md" })).status).toBe(404);
    expect((await copy({ from: "essay.md", to: "../copy.md" })).status).toBe(400);
    expect((await copy({ from: "essay.md", to: "copy.txt" })).status).toBe(400);
    expect((await copy({ from: "essay.md" })).status).toBe(400);
    expect((await copy({ from: "essay.md", to: "copy.md", title: "x" })).status).toBe(400);
    expect(await readdir(server.directory)).toEqual(["essay.md"]);
  });
});

describe("branching a notebook through a cell", () => {
  it("writes a notebook that keeps the original through that cell, and leaves the original", async () => {
    const server = await serve({ "essay.md": essay });

    const response = await post(server, "/api/notebooks/branch", {
      from: "essay.md",
      cell: "look",
      to: "drafts/essay-look.md",
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ path: "drafts/essay-look.md", title: "Essay" });
    const cut = essay.indexOf("\n\nThen the agent");
    expect(await readFile(join(server.directory, "drafts/essay-look.md"), "utf8")).toBe(
      `${essay.slice(0, cut)}\n`,
    );
    expect(await readFile(join(server.directory, "essay.md"), "utf8")).toBe(essay);
    const session = await open(server, "drafts/essay-look.md");
    expect(session.cells.map((cell) => cell.id)).toEqual(["look"]);
    const listed = (await (await get(server, "/api/notebooks")).json()) as {
      notebooks: unknown[];
    };
    expect(listed.notebooks).toEqual([
      { path: "drafts/essay-look.md", title: "Essay" },
      { path: "essay.md", title: "Essay" },
    ]);
  });

  it("keeps the whole notebook when the cell is the last thing in it", async () => {
    const server = await serve({ "essay.md": essay });

    const response = await post(server, "/api/notebooks/branch", {
      from: "essay.md",
      cell: "think",
      to: "essay-think.md",
    });

    expect(response.status).toBe(201);
    expect(await readFile(join(server.directory, "essay-think.md"), "utf8")).toBe(essay);
  });

  it("drops a dependency on a cell the branch does not keep", async () => {
    const ahead =
      "```prompt id=a\nA\n```\n\n```prompt id=b uses=a,c\nB\n```\n\n```prompt id=c\nC\n```\n";
    const server = await serve({ "ahead.md": ahead });

    const response = await post(server, "/api/notebooks/branch", {
      from: "ahead.md",
      cell: "b",
      to: "branch.md",
    });

    expect(response.status).toBe(201);
    expect(await readFile(join(server.directory, "branch.md"), "utf8")).toBe(
      "```prompt id=a\nA\n```\n\n```prompt id=b uses=a\nB\n```\n",
    );
    const session = await open(server, "branch.md");
    expect(session.cells.map((cell) => ({ id: cell.id, uses: cell.uses }))).toEqual([
      { id: "a", uses: [] },
      { id: "b", uses: ["a"] },
    ]);
    expect(await readFile(join(server.directory, "ahead.md"), "utf8")).toBe(ahead);
  });

  it("never writes over a file that is already there", async () => {
    const server = await serve({ "essay.md": essay, "hello.md": hello });

    const response = await post(server, "/api/notebooks/branch", {
      from: "essay.md",
      cell: "look",
      to: "hello.md",
    });

    expect(response.status).toBe(409);
    expect(await readFile(join(server.directory, "hello.md"), "utf8")).toBe(hello);
  });

  it("branches only a notebook that is there, at a cell it has, to a Markdown name", async () => {
    const server = await serve({ "essay.md": essay, "notes.md": "Just notes.\n" });
    const branch = (body: unknown) => post(server, "/api/notebooks/branch", body);

    expect((await branch({ from: "missing.md", cell: "look", to: "copy.md" })).status).toBe(404);
    expect((await branch({ from: "notes.md", cell: "look", to: "copy.md" })).status).toBe(404);
    expect((await branch({ from: "../essay.md", cell: "look", to: "copy.md" })).status).toBe(404);
    const missing = await branch({ from: "essay.md", cell: "absent", to: "copy.md" });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("There is no cell absent in essay.md.\n");
    expect((await branch({ from: "essay.md", cell: "look", to: "../copy.md" })).status).toBe(400);
    expect((await branch({ from: "essay.md", cell: "look", to: "copy.txt" })).status).toBe(400);
    expect((await branch({ from: "essay.md", cell: "look" })).status).toBe(400);
    expect(
      (await branch({ from: "essay.md", cell: "look", to: "copy.md", title: "x" })).status,
    ).toBe(400);
    expect((await get(server, "/api/notebooks/branch")).status).toBe(405);
    expect(await readdir(server.directory)).toEqual(["essay.md", "notes.md"]);
  });
});

describe("creating a notebook", () => {
  it("writes one empty prompt cell under the name, which is then listed and opens", async () => {
    const server = await serve();

    const response = await post(server, "/api/notebooks", { to: "drafts/new.md" });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ path: "drafts/new.md", title: "new" });
    expect(await readFile(join(server.directory, "drafts/new.md"), "utf8")).toBe(
      "```prompt id=cell-1\n```\n",
    );
    const listed = (await (await get(server, "/api/notebooks")).json()) as {
      notebooks: unknown[];
    };
    expect(listed.notebooks).toEqual([{ path: "drafts/new.md", title: "new" }]);
    const session = await open(server, "drafts/new.md");
    expect(session.cells).toMatchObject([{ id: "cell-1", type: "prompt", body: "" }]);
  });

  it("never writes over a file that is already there", async () => {
    const server = await serve({ "notes.md": "Just notes.\n" });

    const response = await post(server, "/api/notebooks", { to: "notes.md" });

    expect(response.status).toBe(409);
    expect(await readFile(join(server.directory, "notes.md"), "utf8")).toBe("Just notes.\n");
  });

  it("takes only a Markdown name under the served directory", async () => {
    const server = await serve();
    const create = (body: unknown) => post(server, "/api/notebooks", body);

    expect((await create({ to: "../new.md" })).status).toBe(400);
    expect((await create({ to: "new.txt" })).status).toBe(400);
    expect((await create({ to: 1 })).status).toBe(400);
    expect((await create({ to: "new.md", title: "x" })).status).toBe(400);
    expect((await create({ to: "new.md", from: 1 })).status).toBe(400);
    expect(await readdir(server.directory)).toEqual([]);
  });
});

describe("the folder tree", () => {
  it("lists folders and the files in them, and marks the notebooks", async () => {
    const server = await serve({
      "essay.md": essay,
      "notes/plain.txt": "hello\n",
      "notes/readme.md": "Just notes.\n",
      "notes/app.py": "print(1)\n",
      "notes/nested/empty.md": "",
      "node_modules/pkg/index.md": essay,
      ".git/config": "",
    });
    await mkdir(join(server.directory, "notes/vacant"), { recursive: true });

    const response = await get(server, "/api/tree");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      directory: server.directory,
      entries: [
        {
          kind: "directory",
          name: "notes",
          path: "notes",
          children: [
            {
              kind: "directory",
              name: "nested",
              path: "notes/nested",
              children: [{ kind: "text", name: "empty.md", path: "notes/nested/empty.md" }],
            },
            { kind: "directory", name: "vacant", path: "notes/vacant", children: [] },
            { kind: "text", name: "app.py", path: "notes/app.py" },
            { kind: "text", name: "plain.txt", path: "notes/plain.txt" },
            { kind: "text", name: "readme.md", path: "notes/readme.md" },
          ],
        },
        { kind: "notebook", name: "essay.md", path: "essay.md", title: "Essay" },
      ],
    });
  });
});

describe("text files", () => {
  const writer = [
    "```bash id=write",
    "printf 'print(1)\\n' > made.py",
    "printf 'console.log(1)\\n' > made.js",
    "printf 'class A {}\\n' > made.java",
    "printf 'b,2\\n' > data.csv",
    "printf 'b\\t2\\n' > made.tsv",
    "printf '{}\\n' > made.json",
    "printf 'a: 1\\n' > made.yaml",
    "printf 'a: 1\\n' > made.yml",
    "printf '# Notes\\n' > made.md",
    "printf 'export {}\\n' > made.ts",
    "printf 'hello\\n' > made.txt",
    "printf 'no\\n' > made.bin",
    "```",
    "",
  ].join("\n");

  it("serves a text file, and reviews the ones a run creates or changes", async () => {
    const server = await serve({ "hello.md": writer, "data.csv": "a,1\n" });
    const session = await open(server, "hello.md");

    expect(await (await get(server, "/api/text?path=data.csv")).json()).toEqual({
      path: "data.csv",
      text: "a,1\n",
    });
    expect((await get(server, "/api/text?path=../made.py")).status).toBe(400);
    expect((await get(server, "/api/text?path=made.bin")).status).toBe(400);
    expect((await get(server, "/api/text?path=missing.py")).status).toBe(404);
    expect((await get(server, "/api/text")).status).toBe(400);

    await run(server, session.id);
    const state = await settled(server, session.id);

    expect(state.reviews).toEqual([
      { path: "data.csv", kind: "modified", before: "a,1\n" },
      { path: "made.java", kind: "created" },
      { path: "made.js", kind: "created" },
      { path: "made.json", kind: "created" },
      { path: "made.md", kind: "created" },
      { path: "made.py", kind: "created" },
      { path: "made.ts", kind: "created" },
      { path: "made.tsv", kind: "created" },
      { path: "made.txt", kind: "created" },
      { path: "made.yaml", kind: "created" },
      { path: "made.yml", kind: "created" },
    ]);
    expect(await readFile(join(server.directory, "made.bin"), "utf8")).toBe("no\n");

    const rejected = await post(server, `/api/sessions/${session.id}/text`, {
      path: "made.py",
      decision: "reject",
    });
    expect(rejected.status).toBe(200);
    await expect(readFile(join(server.directory, "made.py"), "utf8")).rejects.toThrow();

    const restored = await post(server, `/api/sessions/${session.id}/text`, {
      path: "data.csv",
      decision: "reject",
    });
    expect(restored.status).toBe(200);
    expect(await readFile(join(server.directory, "data.csv"), "utf8")).toBe("a,1\n");

    const accepted = await post(server, `/api/sessions/${session.id}/text`, {
      path: "made.js",
      decision: "accept",
    });
    expect(accepted.status).toBe(200);
    expect(await readFile(join(server.directory, "made.js"), "utf8")).toBe("console.log(1)\n");
    expect((await stateOf(server, session.id)).reviews?.map((review) => review.path)).toEqual([
      "made.java",
      "made.json",
      "made.md",
      "made.ts",
      "made.tsv",
      "made.txt",
      "made.yaml",
      "made.yml",
    ]);

    expect(
      (
        await post(server, `/api/sessions/${session.id}/text`, {
          path: "made.py",
          decision: "accept",
        })
      ).status,
    ).toBe(404);
    expect(
      (await post(server, `/api/sessions/${session.id}/text`, { path: "made.java" })).status,
    ).toBe(400);
    expect(
      (
        await post(server, `/api/sessions/${session.id}/text`, {
          path: "made.bin",
          decision: "accept",
        })
      ).status,
    ).toBe(400);
  });

  it("remembers a review after a restart, and reject puts the file back", async () => {
    const server = await serve({
      "hello.md":
        "```bash id=write\nprintf 'after\\n' > note.md\nprintf 'print(1)\\n' > kept.py\n```\n",
      "note.md": "before\n",
    });
    const session = await open(server, "hello.md");
    await run(server, session.id);
    const reviewed = await settled(server, session.id);
    expect(reviewed.reviews).toEqual([
      { path: "kept.py", kind: "created" },
      { path: "note.md", kind: "modified", before: "before\n" },
    ]);

    const again = await restart(server);
    expect((await stateOf(again, session.id)).reviews).toEqual(reviewed.reviews);

    const rejected = await post(again, `/api/sessions/${session.id}/text`, {
      path: "note.md",
      decision: "reject",
    });
    expect(rejected.status).toBe(200);
    expect(await readFile(join(again.directory, "note.md"), "utf8")).toBe("before\n");

    const accepted = await post(again, `/api/sessions/${session.id}/text`, {
      path: "kept.py",
      decision: "accept",
    });
    expect(accepted.status).toBe(200);
    expect(await readFile(join(again.directory, "kept.py"), "utf8")).toBe("print(1)\n");
    expect(await stateOf(again, session.id)).not.toHaveProperty("reviews");
  });

  it("saves a text file, and reads a notebook a session holds again", async () => {
    const server = await serve({ "hello.md": hello, "note.txt": "before\n" });
    const session = await open(server, "hello.md");

    const saved = await post(server, "/api/text", { path: "note.txt", text: "after\n" });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ path: "note.txt" });
    expect(await readFile(join(server.directory, "note.txt"), "utf8")).toBe("after\n");

    const notebook = await post(server, "/api/text", {
      path: "hello.md",
      text: hello.replace("Say hello.", "Say goodbye."),
    });
    expect(notebook.status).toBe(200);
    expect((await stateOf(server, session.id)).cells[0]?.body).toBe("Say goodbye.\n");

    expect((await post(server, "/api/text", { path: "missing.txt", text: "x\n" })).status).toBe(
      404,
    );
    expect((await post(server, "/api/text", { path: "note.txt" })).status).toBe(400);
    expect((await post(server, "/api/text", { path: "../note.txt", text: "x\n" })).status).toBe(
      400,
    );
  });
});

describe("renaming a notebook", () => {
  it("moves the file and the runs stored beside it, and the open session follows", async () => {
    const server = await serve({ "essay.md": essay });
    const session = await open(server, "essay.md");
    const record = join(server.directory, ".octo/runs/essay/run-1/record.json");
    await mkdir(join(server.directory, ".octo/runs/essay/run-1"), { recursive: true });
    await writeFile(record, "{}\n", "utf8");

    const response = await post(server, "/api/notebooks/rename", {
      from: "essay.md",
      to: "notes/piece.md",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "notes/piece.md", title: "Essay" });
    expect(await readFile(join(server.directory, "notes/piece.md"), "utf8")).toBe(essay);
    await expect(readFile(join(server.directory, "essay.md"), "utf8")).rejects.toThrow();
    expect(
      await readFile(join(server.directory, "notes/.octo/runs/piece/run-1/record.json"), "utf8"),
    ).toBe("{}\n");
    expect(await stateOf(server, session.id)).toMatchObject({
      id: session.id,
      notebook: "notes/piece.md",
    });
    const current = await stateOf(server, session.id);
    const saved = await save(server, current, {
      ...editOf(current),
      frontmatter: "title: Piece\n",
    });
    expect(saved.status).toBe(200);
    expect(await readFile(join(server.directory, "notes/piece.md"), "utf8")).toContain(
      "title: Piece",
    );
  });

  it("is found under the new name after a restart, as the same session", async () => {
    const server = await serve({ "essay.md": essay });
    const session = await open(server, "essay.md");
    expect(
      (await post(server, "/api/notebooks/rename", { from: "essay.md", to: "piece.md" })).status,
    ).toBe(200);

    const again = await restart(server);

    expect(await stateOf(again, session.id)).toMatchObject({
      id: session.id,
      notebook: "piece.md",
    });
    expect((await post(again, "/api/sessions", { notebook: "piece.md" })).status).toBe(200);
    expect((await post(again, "/api/sessions", { notebook: "essay.md" })).status).toBe(404);
  });

  it("waits while a run is in progress", async () => {
    const server = await serve({ "essay.md": essay }, createScriptedAgent([{ hangs: true }]));
    const session = await open(server, "essay.md");
    expect(await run(server, session.id)).toBe(202);
    for (;;) {
      if ((await stateOf(server, session.id)).running) break;
      await new Promise((tick) => setTimeout(tick, 20));
    }

    const response = await post(server, "/api/notebooks/rename", {
      from: "essay.md",
      to: "piece.md",
    });

    expect(response.status).toBe(409);
    expect(await readFile(join(server.directory, "essay.md"), "utf8")).toBe(essay);
  });

  it("never writes over a file, or over runs stored for another notebook", async () => {
    const server = await serve({ "essay.md": essay, "hello.md": hello });
    await mkdir(join(server.directory, ".octo/runs/essay/run-1"), { recursive: true });
    await mkdir(join(server.directory, ".octo/runs/kept"), { recursive: true });

    const taken = await post(server, "/api/notebooks/rename", { from: "essay.md", to: "hello.md" });
    expect(taken.status).toBe(409);
    expect(await readFile(join(server.directory, "essay.md"), "utf8")).toBe(essay);

    const blocked = await post(server, "/api/notebooks/rename", {
      from: "essay.md",
      to: "kept.md",
    });
    expect(blocked.status).toBe(409);
    expect(await readFile(join(server.directory, "essay.md"), "utf8")).toBe(essay);
    expect((await readdir(join(server.directory, ".octo/runs"))).sort()).toEqual(["essay", "kept"]);
  });

  it("renames only a notebook that is there, to a Markdown name under the served directory", async () => {
    const server = await serve({ "essay.md": essay, "notes.md": "Just notes.\n" });
    const renameTo = (body: unknown) => post(server, "/api/notebooks/rename", body);

    expect((await renameTo({ from: "missing.md", to: "copy.md" })).status).toBe(404);
    expect((await renameTo({ from: "notes.md", to: "copy.md" })).status).toBe(404);
    expect((await renameTo({ from: "../essay.md", to: "copy.md" })).status).toBe(404);
    expect((await renameTo({ from: "essay.md", to: "../copy.md" })).status).toBe(400);
    expect((await renameTo({ from: "essay.md", to: "copy.txt" })).status).toBe(400);
    expect((await renameTo({ from: "essay.md" })).status).toBe(400);
    expect(await readFile(join(server.directory, "essay.md"), "utf8")).toBe(essay);
  });
});

// Derived from pi's own signature rather than imported: the message types live
// in @earendil-works/pi-ai, which is pi's dependency and not ours to pin.
type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];

/** A chat as pi records one at the terminal: a question, and an answer to it. */
function chat(question: string, answer: string): AppendableMessage[] {
  return [
    { role: "user", content: question, timestamp: Date.now() },
    {
      role: "assistant",
      content: [{ type: "text", text: answer }],
      timestamp: Date.now(),
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
    },
  ];
}

/**
 * A pi session had in the served directory, kept where the server was told pi
 * keeps them; its id, which is what the server lists it under, and its file.
 */
function chatIn(
  server: RunningServer,
  chatDirectory: string,
  messages: readonly AppendableMessage[],
  name?: string,
): { id: string; file: string } {
  const manager = SessionManager.create(server.directory, chatDirectory);
  if (name !== undefined) manager.appendSessionInfo(name);
  for (const message of messages) manager.appendMessage(message);
  return { id: manager.getSessionId(), file: manager.getSessionFile() ?? "" };
}

/** A server whose chats are kept in a directory of the test's own, so pi's are never read. */
async function serveWithChats(files: Readonly<Record<string, string>> = {}) {
  const chatDirectory = await mkdtemp(join(tmpdir(), "octo-chats-"));
  const server = await serve(files, unusedAgent(), { chatDirectory });
  return { server, chatDirectory };
}

describe("promoting a chat", () => {
  it("lists the chats pi had in the served directory, the latest first", async () => {
    const { server, chatDirectory } = await serveWithChats();
    const earlier = chatIn(server, chatDirectory, chat("Count the files.", "Three."));
    await new Promise((done) => setTimeout(done, 20));
    const later = chatIn(server, chatDirectory, chat("Audit it.", "Audited."), "Weekly audit");

    const response = await get(server, "/api/chats");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      chats: [
        {
          id: later.id,
          name: "Weekly audit",
          firstMessage: "Audit it.",
          messages: 2,
          created: expect.any(String),
          modified: expect.any(String),
        },
        {
          id: earlier.id,
          firstMessage: "Count the files.",
          messages: 2,
          created: expect.any(String),
          modified: expect.any(String),
        },
      ],
    });
  });

  it("lists none when pi has had no chat here", async () => {
    const { server } = await serveWithChats();

    expect(await (await get(server, "/api/chats")).json()).toEqual({ chats: [] });
  });

  it("makes a notebook of the chat, which is then a notebook like any other", async () => {
    const { server, chatDirectory } = await serveWithChats();
    const { id, file } = chatIn(server, chatDirectory, chat("Audit it.", "Audited."), "Audit");

    const response = await post(server, `/api/chats/${id}/promote`, { to: "chats/audit.md" });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      path: "chats/audit.md",
      title: "Audit",
      model: "anthropic/claude-sonnet-4-5",
    });
    const listed = (await (await get(server, "/api/notebooks")).json()) as { notebooks: unknown[] };
    expect(listed.notebooks).toEqual([
      { path: "chats/audit.md", title: "Audit", model: "anthropic/claude-sonnet-4-5" },
    ]);

    // Opened into a session of its own, its Cells the chat's messages.
    const opened = await open(server, "chats/audit.md");
    expect(opened.cells).toEqual([
      expect.objectContaining({ id: "cell-1", type: "prompt", body: "Audit it.\n" }),
    ]);

    // With a Run Record of what the chat did beside it, and pi's file untouched.
    const runs = await readdir(join(server.directory, "chats/.octo/runs/audit"));
    expect(runs).toHaveLength(1);
    const record = JSON.parse(
      await readFile(
        join(server.directory, "chats/.octo/runs/audit", runs[0] ?? "", "record.json"),
        "utf8",
      ),
    ) as { imported: string; cells: { text: string }[] };
    expect(record.imported).toBe(file);
    expect(record.cells).toEqual([expect.objectContaining({ text: "Audited." })]);
  });

  it("promotes only a chat that is there, to a Markdown name under the served directory, and never over a notebook", async () => {
    const { server, chatDirectory } = await serveWithChats({ "hello.md": hello });
    const { id } = chatIn(server, chatDirectory, chat("Audit it.", "Audited."));
    const promote = (chatId: string, body: unknown) =>
      post(server, `/api/chats/${chatId}/promote`, body);

    expect((await promote("no-such-chat", { to: "audit.md" })).status).toBe(404);
    expect((await promote(id, { to: "../audit.md" })).status).toBe(400);
    expect((await promote(id, { to: "audit.txt" })).status).toBe(400);
    expect((await promote(id, {})).status).toBe(400);
    expect((await promote(id, { to: "audit.md", title: "x" })).status).toBe(400);
    expect((await promote(id, { to: "hello.md" })).status).toBe(409);
    expect(await readFile(join(server.directory, "hello.md"), "utf8")).toBe(hello);
    expect(await readdir(server.directory)).toEqual(["hello.md"]);
  });

  it("takes only a write to promote, and only a read to list", async () => {
    const { server, chatDirectory } = await serveWithChats();
    const { id } = chatIn(server, chatDirectory, chat("Audit it.", "Audited."));

    expect((await get(server, `/api/chats/${id}/promote`)).status).toBe(405);
    expect((await post(server, "/api/chats", {})).status).toBe(405);
  });

  it("deletes the chat that was named, and leaves the others and any notebook", async () => {
    const { server, chatDirectory } = await serveWithChats({ "hello.md": hello });
    const kept = chatIn(server, chatDirectory, chat("Count the files.", "Three."));
    const gone = chatIn(server, chatDirectory, chat("Audit it.", "Audited."));

    const response = await get(server, `/api/chats/${gone.id}`, { method: "DELETE" });

    expect(response.status).toBe(204);
    await expect(readFile(gone.file, "utf8")).rejects.toThrow();
    expect(await readFile(kept.file, "utf8")).toContain("Count the files.");
    expect(await readFile(join(server.directory, "hello.md"), "utf8")).toBe(hello);
    const listed = (await (await get(server, "/api/chats")).json()) as { chats: { id: string }[] };
    expect(listed.chats.map((entry) => entry.id)).toEqual([kept.id]);

    expect((await get(server, `/api/chats/${gone.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await get(server, `/api/chats/no-such-chat`, { method: "DELETE" })).status).toBe(404);
    expect((await post(server, `/api/chats/${kept.id}`, {})).status).toBe(405);
  });
});

describe("model settings", () => {
  it("lists pi's models and saves a default without returning a stored key", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "octo-models-"));
    const server = await serve({}, unusedAgent(), { agentDirectory });

    const listed = await get(server, "/api/models");
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as {
      models: { provider: string; id: string }[];
      thinkingLevels: string[];
      providers: unknown[];
    };
    expect(page.providers).toEqual([]);
    expect(page.thinkingLevels).toContain("off");
    const model = page.models.find((candidate) => candidate.provider === "anthropic");
    expect(model).toBeDefined();

    const saved = await post(server, "/api/models/default", {
      provider: model?.provider,
      model: model?.id,
      thinking: "low",
    });
    expect(saved.status).toBe(204);
    const again = (await (await get(server, "/api/models")).json()) as {
      defaultProvider: string;
      defaultModel: string;
      defaultThinking: string;
    };
    expect(again).toMatchObject({
      defaultProvider: model?.provider,
      defaultModel: model?.id,
      defaultThinking: "low",
    });
  });

  it("writes a custom provider, keeps a key that was not replaced, and refuses a command", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "octo-models-"));
    const server = await serve({}, unusedAgent(), { agentDirectory });
    const providers = (body: unknown) => post(server, "/api/models/providers", body);
    const provider = {
      id: "ollama",
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      apiKey: "local-secret",
      models: ["llama3.1:8b"],
    };

    expect((await providers({ providers: [provider] })).status).toBe(204);
    const file = JSON.parse(await readFile(join(agentDirectory, "models.json"), "utf8")) as {
      providers: { ollama: { apiKey: string; models: { id: string }[] } };
    };
    expect(file.providers.ollama.apiKey).toBe("local-secret");
    expect(file.providers.ollama.models).toEqual([{ id: "llama3.1:8b" }]);
    const shown = (await (await get(server, "/api/models")).json()) as {
      providers: { apiKeySet: boolean; models: { id: string }[] }[];
    };
    expect(JSON.stringify(shown)).not.toContain("local-secret");
    expect(shown.providers[0]).toMatchObject({
      id: "ollama",
      apiKeySet: true,
      models: [{ id: "llama3.1:8b" }],
    });

    expect(
      (
        await providers({
          providers: [{ ...provider, apiKey: undefined, models: ["llama3.1:8b", "qwen"] }],
        })
      ).status,
    ).toBe(204);
    const kept = JSON.parse(await readFile(join(agentDirectory, "models.json"), "utf8")) as {
      providers: { ollama: { apiKey: string; models: { id: string }[] } };
    };
    expect(kept.providers.ollama.apiKey).toBe("local-secret");
    expect(kept.providers.ollama.models.map((model) => model.id)).toEqual(["llama3.1:8b", "qwen"]);

    const command = await providers({
      providers: [{ ...provider, apiKey: "!echo secret" }],
    });
    expect(command.status).toBe(422);
    const untouched = JSON.parse(await readFile(join(agentDirectory, "models.json"), "utf8")) as {
      providers: { ollama: { apiKey: string } };
    };
    expect(untouched.providers.ollama.apiKey).toBe("local-secret");
  });

  it("refuses a default that is not a model, and a provider that is not one", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "octo-models-"));
    const server = await serve({}, unusedAgent(), { agentDirectory });

    expect(
      (await post(server, "/api/models/default", { provider: "nope", model: "none" })).status,
    ).toBe(422);
    expect((await post(server, "/api/models/default", { model: "x" })).status).toBe(400);
    expect(
      (
        await post(server, "/api/models/providers", {
          providers: [
            { id: "ollama", baseUrl: "ftp://files", api: "openai-completions", models: ["m"] },
          ],
        })
      ).status,
    ).toBe(422);
    expect((await post(server, "/api/models/providers", {})).status).toBe(400);
    const completions = await post(server, "/api/models/providers", {
      providers: [
        {
          id: "proxy",
          baseUrl: "http://127.0.0.1:8317/v1/chat/completions",
          api: "openai-completions",
          models: ["m"],
        },
      ],
    });
    expect(completions.status).toBe(422);
    expect(await completions.text()).toMatch(/end at \/v1/);
    const google = await post(server, "/api/models/providers", {
      providers: [
        {
          id: "proxy",
          baseUrl: "http://127.0.0.1:8317/v1/chat/completions",
          api: "google-generative-ai",
          models: ["m"],
        },
      ],
    });
    expect(google.status).toBe(422);
    expect(await google.text()).toMatch(/openai-completions/);
  });

  it("stores an API key for the chosen provider and does not return it", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "octo-models-"));
    const server = await serve({}, unusedAgent(), { agentDirectory });
    const page = (await (await get(server, "/api/models")).json()) as {
      models: { provider: string; id: string }[];
      keyed: string[];
    };
    const model = page.models.find((candidate) => candidate.provider === "anthropic");
    expect(model).toBeDefined();
    expect(page.keyed).not.toContain("anthropic");

    const saved = await post(server, "/api/models/key", {
      provider: "anthropic",
      apiKey: "test-key-value",
    });
    expect(saved.status).toBe(204);
    const again = (await (await get(server, "/api/models")).json()) as { keyed: string[] };
    expect(again.keyed).toContain("anthropic");
    expect(JSON.stringify(again)).not.toContain("test-key-value");
    expect((await post(server, "/api/models/key", { provider: "anthropic" })).status).toBe(400);
  });

  it("will not test a model that is not configured", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "octo-models-"));
    const server = await serve({}, unusedAgent(), { agentDirectory });
    const page = (await (await get(server, "/api/models")).json()) as {
      models: { provider: string; id: string }[];
    };
    const model = page.models.find((candidate) => candidate.provider === "anthropic");
    expect(model).toBeDefined();

    const refused = await post(server, "/api/models/test", {
      provider: model?.provider,
      model: model?.id,
    });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toMatch(/configured/);
    expect((await post(server, "/api/models/test", { provider: "anthropic" })).status).toBe(400);
    expect((await get(server, "/api/models/test")).status).toBe(405);
  });

  it("asks a configured model for one token, and reports one that does not answer", async () => {
    const chunks = [
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "." }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const answering = await completionsAt(200, chunks);
    const refusing = await completionsAt(
      401,
      JSON.stringify({ error: { message: "nope", type: "auth" } }),
      "application/json",
    );
    try {
      const agentDirectory = await mkdtemp(join(tmpdir(), "octo-models-"));
      const server = await serve({}, unusedAgent(), { agentDirectory });
      const provider = {
        id: "local",
        api: "openai-completions",
        apiKey: "local-secret",
        models: ["m"],
      };

      expect(
        (
          await post(server, "/api/models/providers", {
            providers: [{ ...provider, baseUrl: answering.url }],
          })
        ).status,
      ).toBe(204);
      const tested = await post(server, "/api/models/test", { provider: "local", model: "m" });
      expect(tested.status).toBe(200);
      const result = (await tested.json()) as {
        available: boolean;
        inputTokens: number;
        outputTokens: number;
      };
      expect(result).toEqual({ available: true, inputTokens: 1, outputTokens: 1 });
      expect(JSON.stringify(result)).not.toContain("local-secret");
      expect(answering.bodies).toHaveLength(1);
      const sent = answering.bodies[0] as {
        max_tokens?: number;
        max_completion_tokens?: number;
        messages?: { role?: string; content?: unknown }[];
        tools?: unknown;
        reasoning_effort?: unknown;
      };
      expect(sent.max_tokens).toBe(1);
      expect(sent.max_completion_tokens).toBe(1);
      expect(sent.tools).toBeUndefined();
      expect(sent.reasoning_effort).toBeUndefined();
      expect(sent.messages).toHaveLength(1);
      expect(sent.messages?.[0]?.role).toBe("user");
      expect(JSON.stringify(sent.messages?.[0]?.content)).toBe(JSON.stringify("."));

      expect(
        (
          await post(server, "/api/models/providers", {
            providers: [{ ...provider, baseUrl: refusing.url }],
          })
        ).status,
      ).toBe(204);
      const failed = await post(server, "/api/models/test", { provider: "local", model: "m" });
      expect(failed.status).toBe(200);
      const problem = (await failed.json()) as { available: boolean; problem?: string };
      expect(problem.available).toBe(false);
      expect(problem.problem).toMatch(/nope/);
      expect(refusing.bodies).toHaveLength(1);
    } finally {
      await answering.close();
      await refusing.close();
    }
  });
});

/** A local chat-completions endpoint, so a probe can be checked without a provider. */
function completionsAt(
  status: number,
  body: string,
  type = "text/event-stream",
): Promise<{ url: string; bodies: unknown[]; close: () => Promise<void> }> {
  const bodies: unknown[] = [];
  const http = createHttpServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      response.writeHead(status, { "content-type": type });
      response.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      const address = http.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        bodies,
        close: () =>
          new Promise((done, fail) => {
            http.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

describe("a notebook's model", () => {
  const provider = {
    id: "ollama",
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    models: ["llama3.1:8b"],
  };

  async function withOllama(): Promise<RunningServer> {
    const agentDirectory = await mkdtemp(join(tmpdir(), "octo-models-"));
    const server = await serve({ "hello.md": hello }, unusedAgent(), { agentDirectory });
    expect((await post(server, "/api/models/providers", { providers: [provider] })).status).toBe(
      204,
    );
    return server;
  }

  it("writes a configured model into the notebook, and clears it", async () => {
    const server = await withOllama();

    const saved = await post(server, "/api/notebooks/model", {
      notebook: "hello.md",
      model: "ollama/llama3.1:8b",
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      path: "hello.md",
      title: "Hello",
      model: "ollama/llama3.1:8b",
    });
    expect(await readFile(join(server.directory, "hello.md"), "utf8")).toBe(
      hello.replace(
        "---\ntitle: Hello\n---\n",
        "---\ntitle: Hello\nmodel: ollama/llama3.1:8b\n---\n",
      ),
    );
    const listed = (await (await get(server, "/api/notebooks")).json()) as {
      notebooks: { path: string; model?: string }[];
    };
    expect(listed.notebooks).toEqual([
      { path: "hello.md", title: "Hello", model: "ollama/llama3.1:8b" },
    ]);

    const cleared = await post(server, "/api/notebooks/model", {
      notebook: "hello.md",
      model: "",
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ path: "hello.md", title: "Hello" });
    expect(await readFile(join(server.directory, "hello.md"), "utf8")).toBe(hello);
  });

  it("tells an open session, and refuses a model that is not configured", async () => {
    const server = await withOllama();
    const session = await open(server, "hello.md");

    const saved = await post(server, "/api/notebooks/model", {
      notebook: "hello.md",
      model: "ollama/llama3.1:8b",
    });
    expect(saved.status).toBe(200);
    const state = await stateOf(server, session.id);
    expect(state.model).toBe("ollama/llama3.1:8b");
    expect(state.frontmatter).toBe("title: Hello\nmodel: ollama/llama3.1:8b\n");
    expect(state.revision).not.toBe(session.revision);
    expect(state.cells[0]?.body).toBe("Say hello.\n");

    const again = await post(server, "/api/notebooks/model", {
      notebook: "hello.md",
      model: "ollama/llama3.1:8b",
    });
    expect(again.status).toBe(200);
    expect((await stateOf(server, session.id)).revision).toBe(state.revision);

    expect(
      (await post(server, "/api/notebooks/model", { notebook: "hello.md", model: "no/such" }))
        .status,
    ).toBe(422);
    expect(
      (await post(server, "/api/notebooks/model", { notebook: "hello.md", model: "nope" })).status,
    ).toBe(400);
    expect(
      (
        await post(server, "/api/notebooks/model", {
          notebook: "missing.md",
          model: "ollama/llama3.1:8b",
        })
      ).status,
    ).toBe(404);
    expect((await post(server, "/api/notebooks/model", { notebook: "hello.md" })).status).toBe(400);
    expect((await get(server, "/api/notebooks/model")).status).toBe(405);
  });

  it("accepts a model whose provider has a stored key", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "octo-models-"));
    const server = await serve({ "hello.md": hello }, unusedAgent(), { agentDirectory });
    const page = (await (await get(server, "/api/models")).json()) as {
      models: { provider: string; id: string }[];
    };
    const model = page.models.find((candidate) => candidate.provider === "anthropic");
    expect(model).toBeDefined();
    expect(
      (
        await post(server, "/api/notebooks/model", {
          notebook: "hello.md",
          model: `${model?.provider}/${model?.id}`,
        })
      ).status,
    ).toBe(422);

    expect(
      (await post(server, "/api/models/key", { provider: "anthropic", apiKey: "test-key-value" }))
        .status,
    ).toBe(204);
    const saved = await post(server, "/api/notebooks/model", {
      notebook: "hello.md",
      model: `${model?.provider}/${model?.id}`,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ model: `${model?.provider}/${model?.id}` });
  });
});

describe("a notebook's mode", () => {
  async function modesDirectory(files: Readonly<Record<string, string>> = {}): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "octo-modes-"));
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(directory, name), contents, "utf8");
    }
    return directory;
  }

  it("lists the modes octo ships, and a mode the user added", async () => {
    const directory = await modesDirectory({
      "design.md": "---\nmodel: openai/gpt-5\n---\nDesign.\n",
    });
    const server = await serve({ "hello.md": hello }, unusedAgent(), { modesDirectory: directory });

    const listed = await get(server, "/api/modes");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      modes: ["code", "design", "work"],
      own: [{ name: "design", model: "openai/gpt-5", prompt: "Design." }],
    });
    expect((await post(server, "/api/modes", {})).status).toBe(400);
    expect((await get(server, "/api/modes", { method: "DELETE" })).status).toBe(405);
  });

  it("leaves out a user mode that reuses a shipped name", async () => {
    const directory = await modesDirectory({ "code.md": "You are something else.\n" });
    const server = await serve({}, unusedAgent(), { modesDirectory: directory });

    expect(await (await get(server, "/api/modes")).json()).toEqual({
      modes: ["work"],
      own: [{ name: "code", prompt: "You are something else." }],
    });
  });

  it("writes an available mode into the notebook, and clears it", async () => {
    const directory = await modesDirectory();
    const server = await serve({ "hello.md": hello }, unusedAgent(), { modesDirectory: directory });

    const saved = await post(server, "/api/notebooks/mode", { notebook: "hello.md", mode: "work" });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ path: "hello.md", title: "Hello", mode: "work" });
    expect(await readFile(join(server.directory, "hello.md"), "utf8")).toBe(
      hello.replace("---\ntitle: Hello\n---\n", "---\ntitle: Hello\nmode: work\n---\n"),
    );
    const listed = (await (await get(server, "/api/notebooks")).json()) as {
      notebooks: { path: string; mode?: string }[];
    };
    expect(listed.notebooks).toEqual([{ path: "hello.md", title: "Hello", mode: "work" }]);
    const tree = (await (await get(server, "/api/tree")).json()) as {
      entries: { kind: string; mode?: string }[];
    };
    expect(tree.entries).toEqual([
      { kind: "notebook", name: "hello.md", path: "hello.md", title: "Hello", mode: "work" },
    ]);

    const cleared = await post(server, "/api/notebooks/mode", { notebook: "hello.md", mode: "" });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ path: "hello.md", title: "Hello" });
    expect(await readFile(join(server.directory, "hello.md"), "utf8")).toBe(hello);
  });

  it("tells an open session, and refuses a mode that is not available", async () => {
    const directory = await modesDirectory({
      "design.md": "---\nmodel: openai/gpt-5\n---\nDesign.\n",
    });
    const server = await serve({ "hello.md": hello }, unusedAgent(), { modesDirectory: directory });
    const session = await open(server, "hello.md");

    const saved = await post(server, "/api/notebooks/mode", {
      notebook: "hello.md",
      mode: "design",
    });
    expect(saved.status).toBe(200);
    const state = await stateOf(server, session.id);
    expect(state.mode).toBe("design");
    expect(state.frontmatter).toBe("title: Hello\nmode: design\n");
    expect(state.revision).not.toBe(session.revision);
    expect(state.cells[0]?.body).toBe("Say hello.\n");

    const again = await post(server, "/api/notebooks/mode", {
      notebook: "hello.md",
      mode: "design",
    });
    expect(again.status).toBe(200);
    expect((await stateOf(server, session.id)).revision).toBe(state.revision);

    const refused = await post(server, "/api/notebooks/mode", {
      notebook: "hello.md",
      mode: "review",
    });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toMatch(/not available here/);
    expect(
      (await post(server, "/api/notebooks/mode", { notebook: "missing.md", mode: "work" })).status,
    ).toBe(404);
    expect((await post(server, "/api/notebooks/mode", { notebook: "hello.md" })).status).toBe(400);
    expect((await get(server, "/api/notebooks/mode")).status).toBe(405);
  });

  it("creates a mode, rewrites it, and removes it", async () => {
    const directory = await modesDirectory();
    const server = await serve({ "hello.md": hello }, unusedAgent(), { modesDirectory: directory });
    const draft = {
      name: "design",
      prompt: "Keep to the brief.",
      model: "openai/gpt-5",
      tools: ["read", "write"],
      skills: [] as string[],
    };

    const created = await post(server, "/api/modes", { ...draft, skills: null });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      name: "design",
      prompt: "Keep to the brief.",
      model: "openai/gpt-5",
      tools: ["read", "write"],
    });
    expect(await readFile(join(directory, "design.md"), "utf8")).toContain("Keep to the brief.");

    const listed = (await (await get(server, "/api/modes")).json()) as { modes: string[] };
    expect(listed.modes).toEqual(["code", "design", "work"]);
    const chosen = await post(server, "/api/notebooks/mode", {
      notebook: "hello.md",
      mode: "design",
    });
    expect(chosen.status).toBe(200);

    const rewritten = await post(server, "/api/modes/design", {
      name: "draft",
      prompt: "Say what you assumed.",
      model: "",
      tools: null,
      skills: [],
    });
    expect(rewritten.status).toBe(200);
    expect(await rewritten.json()).toEqual({
      name: "draft",
      prompt: "Say what you assumed.",
      skills: [],
    });
    expect(await readFile(join(directory, "draft.md"), "utf8")).toContain("skills: []");
    await expect(readFile(join(directory, "design.md"), "utf8")).rejects.toThrow();

    const removed = await get(server, "/api/modes/draft", { method: "DELETE" });
    expect(removed.status).toBe(204);
    const after = (await (await get(server, "/api/modes")).json()) as {
      modes: string[];
      own: unknown[];
    };
    expect(after.modes).toEqual(["code", "work"]);
    expect(after.own).toEqual([]);
    expect(
      (await post(server, "/api/notebooks/mode", { notebook: "hello.md", mode: "draft" })).status,
    ).toBe(422);
  });

  it("refuses a shipped name, a bad name, a duplicate, and removing a mode that is not there", async () => {
    const directory = await modesDirectory({ "design.md": "Design.\n" });
    const server = await serve({}, unusedAgent(), { modesDirectory: directory });
    const body = { prompt: "", model: "", tools: null, skills: null };

    expect((await post(server, "/api/modes", { ...body, name: "work" })).status).toBe(422);
    expect((await post(server, "/api/modes", { ...body, name: "../x" })).status).toBe(400);
    expect((await post(server, "/api/modes", { ...body, name: "design" })).status).toBe(409);
    expect((await post(server, "/api/modes/missing", body)).status).toBe(404);
    expect((await get(server, "/api/modes/work", { method: "DELETE" })).status).toBe(422);
    expect((await get(server, "/api/modes/missing", { method: "DELETE" })).status).toBe(404);
    expect((await get(server, "/api/modes/design")).status).toBe(405);
  });
});

describe("a cell's model rounds", () => {
  it("refuses a cell that has not run, and one whose session was not kept", async () => {
    const server = await serve({ "hello.md": hello });
    const session = await open(server, "hello.md");

    const early = await get(server, `/api/sessions/${session.id}/cells/greet/rounds`);
    expect(early.status).toBe(422);
    expect(await early.text()).toMatch(/has not run/);
    expect((await post(server, `/api/sessions/${session.id}/cells/greet/rounds`, {})).status).toBe(
      405,
    );

    const agent = createScriptedAgent([{ text: "Hello, world" }]);
    const running = await serve({ "hello.md": hello }, agent);
    const opened = await open(running, "hello.md");
    const browser = await watch(running, opened.id);
    expect(await run(running, opened.id)).toBe(202);
    await browser.next("run-ended");
    await browser.close();

    const later = await get(running, `/api/sessions/${opened.id}/cells/greet/rounds`);
    expect(later.status).toBe(200);
    expect(await later.json()).toMatchObject({
      query: "Say hello.",
      prompts: ["Say hello."],
      rounds: [],
      toolCalls: [],
      roundsProblem: expect.stringMatching(/not on disk/),
    });
  });
});

/** A Skill file where pi looks for one: a markdown file, or a directory's SKILL.md. */
async function installedSkill(
  dir: string,
  name: string,
  description: string,
  directory = false,
): Promise<void> {
  const file = directory ? join(dir, name, "SKILL.md") : join(dir, `${name}.md`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\nDo ${name}.\n`,
    "utf8",
  );
}

describe("installed skills", () => {
  it("lists the user's skills and the workspace's, and refuses what is not a notebook here", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "octo-skill-agent-"));
    const home = await mkdtemp(join(tmpdir(), "octo-skill-home-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "octo-skill-ws-"));
    await mkdir(join(elsewhere, ".git"));
    await installedSkill(join(agentDirectory, "skills"), "global-file", "From the agent directory");
    await installedSkill(
      join(home, ".agents", "skills", "global-dir"),
      "global-dir",
      "From home",
      true,
    );
    await installedSkill(join(elsewhere, ".pi", "skills"), "there", "In the notebook's workspace");

    const server = await serve(
      {
        "notes.md": `---\nworkspace: ${JSON.stringify(elsewhere)}\n---\n\n\`\`\`prompt id=ask\nHi\n\`\`\`\n`,
        "here.md": "```prompt id=ask\nHi\n```\n",
        "broken.md": "---\nnever closed\n",
      },
      unusedAgent(),
      { agentDirectory, home },
    );
    await mkdir(join(server.directory, ".git"));
    await installedSkill(
      join(server.directory, ".pi", "skills"),
      "here",
      "In the served directory",
    );

    const globals = [
      { name: "global-dir", description: "From home", scope: "global" },
      { name: "global-file", description: "From the agent directory", scope: "global" },
    ];
    expect(await (await get(server, "/api/skills?notebook=notes.md")).json()).toEqual({
      skills: [
        { name: "there", description: "In the notebook's workspace", scope: "local" },
        ...globals,
      ],
    });
    expect(await (await get(server, "/api/skills")).json()).toEqual({
      skills: [
        { name: "here", description: "In the served directory", scope: "local" },
        ...globals,
      ],
    });
    expect((await fetch(new URL("/api/skills", server.url))).status).toBe(401);
    expect((await post(server, "/api/skills", {})).status).toBe(405);
    expect((await get(server, "/api/skills?notebook=missing.md")).status).toBe(404);
    expect((await get(server, "/api/skills?notebook=../secret.md")).status).toBe(404);
    const broken = await get(server, "/api/skills?notebook=broken.md");
    expect(broken.status).toBe(422);
    expect(await broken.text()).toMatch(/never closed|Frontmatter/);
  });
});
