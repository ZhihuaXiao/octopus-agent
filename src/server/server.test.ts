import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type RunningServer, startServer } from "./server.js";

const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

/** A server over a fresh directory holding the given files, closed when the test ends. */
async function serve(files: Readonly<Record<string, string>> = {}): Promise<RunningServer> {
  const directory = await mkdtemp(join(tmpdir(), "octo-serve-"));
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), contents, "utf8");
  }
  // Port 0 asks the operating system for a free one, so tests never collide.
  const server = await startServer({ port: 0, directory });
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

    const server = await startServer({ port, directory: tmpdir() });
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
    const server = await startServer({ port: 0, directory: tmpdir() });
    running.push(server);

    expect(server.directory).toBe(tmpdir());
  });

  it("reports a port already in use rather than starting on another", async () => {
    const first = await serve();
    const port = new URL(first.url).port;

    await expect(startServer({ port: Number(port), directory: tmpdir() })).rejects.toThrow(
      `port ${port}`,
    );
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
