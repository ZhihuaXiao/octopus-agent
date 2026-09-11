# 14 — Web server and client shell

**What to build:** A server that binds to loopback, serves the browser client, and lists
the notebooks available to open. No execution yet — this is the shell the rest of the web
interface is built inside.

**Blocked by:** 13

**Status:** done

- [x] The server starts on a chosen port and binds to loopback only
- [x] A browser loads the client shell
- [x] The client lists the notebooks discoverable from the served directory
- [x] The startup message states the URL to open

## Comments

**`startServer` resolves once it is listening, with the URL and a way to stop.** It returns
`{ url, directory, close() }` rather than running forever, so a test can start a server on a
port of the operating system's choosing, drive it with `fetch`, and close it; `octo --web`
prints the directory and the URL from that value — decided once, in the server — and lets
the listening socket keep the process alive, as any server does. The server is
Node's own `node:http`, with no framework: the surface today is three routes, and ticket 15's
WebSocket is the point at which a dependency would earn its place. It binds `127.0.0.1` and
nothing else — the test finds a non-loopback address of the machine and checks a connection
to it is refused — since starting it must never expose the machine by accident (ADR-0006).
Reaching it from elsewhere is ticket 19's deliberate act. `ServerOptions` grew a `directory`,
the one the Notebooks are listed under, which is the working directory when the command runs
and a temporary one under test.

**The default port is 8008, and one in use is reported rather than worked around.** Ticket 13
left the choice here. Fixed rather than left to the operating system so the URL is the same
every morning and a bookmark keeps working; when something else has it the server says so,
names the port and suggests `--port`, instead of quietly starting on another and printing a
URL nobody was expecting. The usage now says the number. Zero is accepted in `ServerOptions`
to mean a free port — what a test wants and nobody else does — and the launcher's `readPort`
still refuses it from the command line.

**The client is plain files, served as written.** `client/index.html`, `main.js` and
`style.css` sit at the repository root beside `src` and `dist` rather than inside either, so
the one relative path `../../client/` finds them from the source under vitest and from the
build the command runs; `tsc` copies nothing but TypeScript, and a build step for three files
would be more moving parts than the shell is worth. There is no framework and no bundler. The
script is checked, not compiled: `client/tsconfig.json` is a `checkJs` project with the DOM
library and `noEmit`, and `npm run typecheck` runs both projects, so the client's JavaScript
is held to the same `strict` as the rest. When the Author View (ticket 16) needs more than a
list, that is the moment to decide whether the client is bundled; nothing here commits it.
The shell asks `GET /api/notebooks` and renders the answer, with a plain sentence for an empty
directory and for a server that did not answer. A path under `/client/` that climbs out of the
client directory, however it spells the climb, is a 404; so is a name no file system would
take, and any file type the client is not made of — the server knows the three it serves and
no more. A `HEAD` is answered as its `GET` would be, without the body, which Node does of its
own accord; anything else is a 405 that says what is allowed.

**A Notebook, for the purposes of the list, is a Markdown file with at least one Cell.** That
is what the glossary says a Notebook is — work described as a graph of Cells — and it is what
keeps a project's README, which has fenced snippets but no Cells, out of the list without a
rule about file names. `src/server/notebooks.ts` walks the served directory, not descending
into `node_modules` or any dot-directory (`.git`, `.octo`, `.scratch`, an editor's settings),
never following a symbolic link, and parses every `.md` it finds, one at a time — a tree of
thousands of them is a documentation site, and opening them all at once would run out of file
descriptors where reading them in turn takes a moment. The list carries each
Notebook's path relative to the served directory, forward slashes whatever the platform, and
its declared title or its file's name when it declares none, sorted by path; the answer also
names the directory searched, so an empty list says where it looked. A file that fails to
parse is left out rather than failing the list, since the shell can do nothing with it yet;
once the browser can edit, ticket 17 may want it shown with its problems instead, and the
parser's diagnostics are there for that.

**Tested at the HTTP seam and nowhere below it.** `src/server/server.test.ts` starts a real
server over a temporary directory and drives it with `fetch`: the binding — a connection to
one of the machine's other addresses is refused outright — the port, a port in use, the shell
and every asset it names resolving, the traversal and malformed names, and what the
notebook list contains for a directory holding Notebooks, a README, a text file, and Notebooks
under `node_modules`, `.git` and `.octo`. Discovery is reached only through `/api/notebooks`,
which is the spec's second seam. The client script itself is not under test — there is no
browser in the suite and a DOM library was not worth adding for a list — and was checked by
hand against a stand-in document; if the client grows, that is the first thing to revisit.

**Left where it was.** Nothing opens a Notebook yet: the list is names, not links, until
ticket 15 gives a Notebook Session to open one into. `octo.ts` prints the startup message and
stays the one untested file, as before. IPv6 loopback is not bound; the URL printed is the
address that is, so a browser following it never asks for `::1`.
