import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type ScriptedAgent, createScriptedAgent } from "../agent/scripted.js";
import { type RunningServer, startServer } from "./server.js";

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
): Promise<RunningServer> {
  const directory = await mkdtemp(join(tmpdir(), "octo-serve-"));
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), contents, "utf8");
  }
  // Port 0 asks the operating system for a free one, so tests never collide.
  const server = await startServer({ port: 0, directory, agent: agent.create });
  running.push(server);
  return server;
}

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

    expect(server.url).toBe(`http://127.0.0.1:${port}/`);
  });

  it("answers on loopback", async () => {
    const server = await serve();

    const response = await fetch(server.url);

    expect(response.status).toBe(200);
  });

  it.skipIf(externalAddress() === undefined)("cannot be reached from beyond loopback", async () => {
    const server = await serve();
    const port = new URL(server.url).port;

    await expect(fetch(`http://${externalAddress()}:${port}/`)).rejects.toMatchObject({
      cause: { code: "ECONNREFUSED" },
    });
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
function rawRequest(url: string, path: string): Promise<number> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    request({ hostname, port, path, method: "GET" }, (response) => {
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

    const response = await fetch(server.url);

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("<title>");
  });

  it("finds every script and style it refers to", async () => {
    const server = await serve();
    const assets = assetsOf(await (await fetch(server.url)).text());

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

    const response = await fetch(server.url, { method: "POST", body: "x" });

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
    const response = await fetch(new URL("/api/notebooks", server.url));
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
  fetch(new URL(path, server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

/** What a Notebook Session says of itself, as the server reports it. */
interface NotebookSessionState {
  id: string;
  notebook: string;
  title: string;
  running: boolean;
  cells: { id: string; type: string; status: string; text: string; error?: string }[];
}

/** Opens a Notebook into a Notebook Session and returns what the server said of it. */
async function open(server: RunningServer, notebook: string): Promise<NotebookSessionState> {
  const response = await post(server, "/api/sessions", { notebook });
  if (!response.ok) throw new Error(`opening ${notebook} answered ${response.status}`);
  return (await response.json()) as NotebookSessionState;
}

const stateOf = async (server: RunningServer, id: string): Promise<NotebookSessionState> => {
  const response = await fetch(new URL(`/api/sessions/${id}`, server.url));
  if (!response.ok) throw new Error(`session ${id} answered ${response.status}`);
  return (await response.json()) as NotebookSessionState;
};

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
      running: false,
      cells: [{ id: "greet", type: "prompt", status: "idle", text: "" }],
    });
    // Kept by the server, not by whoever asked: found again by its id alone.
    expect(await stateOf(server, session.id)).toEqual(session);
  });

  it("opens the same notebook into the session already open for it", async () => {
    const server = await serve({ "hello.md": hello });
    const first = await open(server, "hello.md");

    const response = await post(server, "/api/sessions", { notebook: "hello.md" });

    expect(response.status).toBe(200);
    expect(((await response.json()) as NotebookSessionState).id).toBe(first.id);
  });

  it("gives each notebook a session of its own", async () => {
    const server = await serve({ "hello.md": hello, "audit.md": audit });

    const one = await open(server, "hello.md");
    const other = await open(server, "audit.md");

    expect(other.id).not.toBe(one.id);
    expect(other.cells).toEqual([{ id: "scope", type: "bash", status: "idle", text: "" }]);
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
        await fetch(new URL("/api/sessions", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not json",
        })
      ).status,
    ).toBe(400);
  });

  it("has no session under an id it never gave out", async () => {
    const server = await serve({ "hello.md": hello });

    expect((await fetch(new URL("/api/sessions/nothing", server.url))).status).toBe(404);
  });

  it("is asked for, never read: opening is a change to what the server holds", async () => {
    const server = await serve({ "hello.md": hello });

    const response = await fetch(new URL("/api/sessions", server.url));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

/** An event as the server sends it, with as much of its shape as the tests read. */
interface Event {
  type: string;
  cell?: string;
  text?: string;
  session?: NotebookSessionState;
  record?: { id?: string; status?: string; cells?: { id: string; status: string }[] };
  error?: string;
}

/** A browser's view of a Notebook Session: the events, as they arrive. */
interface Watching {
  readonly socket: WebSocket;
  readonly events: Event[];
  /** Resolves with the next event of the kind not yet waited for, now or when it arrives. */
  next(type: string): Promise<Event>;
  close(): Promise<void>;
}

/** Connects to a Notebook Session's events the way the browser does. */
function watch(server: RunningServer, id: string): Promise<Watching> {
  const url = new URL(`/api/sessions/${id}/events`, server.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url);
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
    expect(browser.events[3]).toEqual({ type: "cell-text", cell: "greet", text: "Hello, world" });
    expect(ended.record?.cells).toEqual([expect.objectContaining({ id: "greet", status: "ok" })]);
    await browser.close();
  });

  it("streams a cell's text while the cell is still running", async () => {
    const agent = createScriptedAgent([{ hangs: true, text: "Working on it…" }]);
    const server = await serve({ "hello.md": hello }, agent);
    const session = await open(server, "hello.md");
    const browser = await watch(server, session.id);

    await run(server, session.id);
    const spoken = await browser.next("cell-text");

    expect(spoken).toEqual({ type: "cell-text", cell: "greet", text: "Working on it…" });
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
    expect((await stateOf(server, session.id)).cells).toEqual([
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

    expect((await stateOf(server, session.id)).cells).toEqual([
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

  it("takes only a well-formed request to run", async () => {
    const server = await serve({ "hello.md": hello });
    const session = await open(server, "hello.md");

    expect(await run(server, session.id, { cells: "greet" })).toBe(400);
    expect(await run(server, session.id, { notebook: "other.md" })).toBe(400);
  });

  it("tells a plain read of the events what to connect with instead", async () => {
    const server = await serve({ "hello.md": hello });
    const session = await open(server, "hello.md");

    const response = await fetch(new URL(`/api/sessions/${session.id}/events`, server.url));

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
      { type: "cell-text", cell: "go", text: "Audited" },
    ]);
    await Promise.all([watchingSlow.close(), watchingQuick.close()]);
  });
});

describe("a browser that goes away", () => {
  it("leaves the work running: the session is the server's, not the browser's", async () => {
    // Long enough that the browser is gone well before the command is done.
    const server = await serve({ "slow.md": "```bash id=wait\nsleep 0.3\necho survived\n```\n" });
    const session = await open(server, "slow.md");
    const browser = await watch(server, session.id);
    await run(server, session.id);
    await browser.next("cell-started");

    await browser.close();

    const settled = async (): Promise<NotebookSessionState> => {
      for (;;) {
        const state = await stateOf(server, session.id);
        if (!state.running) return state;
        await new Promise((tick) => setTimeout(tick, 20));
      }
    };
    expect((await settled()).cells).toMatchObject([
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

    expect(told.session?.cells).toEqual([
      { id: "greet", type: "prompt", status: "ok", text: "Hello, world" },
    ]);
    await later.close();
  });
});
