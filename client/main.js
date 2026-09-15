// @ts-check
/**
 * The client: lists the Notebooks the server can see, opens one into its
 * Notebook Session, and shows the Session as the Author View — each Cell as
 * the Notebook declares it, with what running it has produced: its text as it
 * is spoken, each tool the agent invokes as it invokes it, and the files it
 * left — and a way to run one Cell or all of them, or to stop.
 *
 * The Session is the server's. This page asks it to run or to stop, over HTTP,
 * and hears what happens over a WebSocket; closing the page changes nothing
 * about the work. The Notebook opened is kept in the URL's fragment, so a
 * reload opens the same one again.
 */

/**
 * @typedef {{ path: string, title: string }} NotebookEntry
 * @typedef {{ directory: string, notebooks: NotebookEntry[] }} NotebookList
 * @typedef {{ name: string, input: unknown }} ToolCall
 * @typedef {"idle" | "running" | "ok" | "error" | "timeout" | "interrupted" | "stale"} CellState
 * @typedef {{
 *   id: string,
 *   type: "prompt" | "bash",
 *   body: string,
 *   uses: string[],
 *   isolated: boolean,
 *   model?: string,
 *   timeout?: number,
 *   status: CellState,
 *   text: string,
 *   toolCalls: ToolCall[],
 *   artifacts: string[],
 *   run?: string,
 *   error?: string,
 * }} CellView
 * @typedef {{ id: string, notebook: string, title: string, running: boolean, cells: CellView[] }} NotebookSessionState
 * @typedef {{
 *   id: string,
 *   type: "prompt" | "bash",
 *   status: "ok" | "error" | "timeout" | "interrupted",
 *   text?: string,
 *   stdout?: string,
 *   toolCalls?: ToolCall[],
 *   artifacts: string[],
 *   error?: string,
 * }} CellRecord
 * @typedef {(
 *   | { type: "notebook-session", session: NotebookSessionState }
 *   | { type: "run-started", run: string, cells: string[] }
 *   | { type: "cell-started", cell: string }
 *   | { type: "cell-text", cell: string, text: string }
 *   | { type: "cell-tool-call", cell: string, call: ToolCall }
 *   | { type: "cell-ended", record: CellRecord }
 *   | { type: "run-ended", record: { id: string, stale: string[] } }
 *   | { type: "run-refused", error: string }
 * )} NotebookSessionEvent
 */

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function element(id) {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`The shell has no element with id "${id}"`);
  return found;
}

/**
 * @template {keyof HTMLElementTagNameMap} Tag
 * @param {Tag} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElementTagNameMap[Tag]}
 */
function make(tag, className, text) {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

/** @param {unknown} cause */
const describe = (cause) => (cause instanceof Error ? cause.message : String(cause));

/**
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<Response>}
 */
async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error((await response.text()).trim() || `The server answered ${response.status}`);
  return response;
}

/** @returns {Promise<NotebookList>} */
async function fetchNotebooks() {
  const response = await fetch("/api/notebooks");
  if (!response.ok) throw new Error(`The server answered ${response.status}`);
  return response.json();
}

/**
 * @param {NotebookEntry} entry
 * @returns {HTMLLIElement}
 */
function renderEntry(entry) {
  const item = document.createElement("li");
  const link = document.createElement("a");
  link.href = `#${encodeURIComponent(entry.path)}`;
  link.append(make("span", "title", entry.title), make("span", "path", entry.path));
  item.append(link);
  return item;
}

async function showList() {
  element("session").hidden = true;
  const list = element("list");
  list.hidden = false;
  const status = element("status");

  try {
    const found = await fetchNotebooks();
    element("directory").textContent = found.directory;
    element("notebooks").replaceChildren(...found.notebooks.map(renderEntry));
    status.textContent =
      found.notebooks.length === 0 ? "No notebooks found in this directory." : "";
  } catch (cause) {
    status.textContent = `Could not list the notebooks: ${describe(cause)}`;
  }
}

/**
 * What is being watched right now, so opening another Notebook lets go of it:
 * the state the events keep up to date, the socket they arrive on, and the Run
 * in progress once it has named itself, which is what a Cell that starts is
 * running in.
 */
/** @type {{ state: NotebookSessionState, socket: WebSocket, run?: string } | undefined} */
let watching;

/** A Timeout as an author would write it, when the milliseconds allow. */
/** @param {number} ms */
const formatDuration = (ms) =>
  ms % 60_000 === 0 ? `${ms / 60_000}m` : ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;

/** The keys a tool's input is best summed up by, in order of preference. */
const GIST_KEYS = ["command", "path", "file_path", "filePath", "pattern", "query", "url"];
const GIST_LENGTH = 100;
/** As much of one string as a card's full input shows; a `write` call's whole file need not be here. */
const INPUT_STRING_LENGTH = 400;

/**
 * The one line a tool call is best summed up by: the command run, the path
 * read or written, or failing those the first string it was given.
 * @param {unknown} input
 */
function gistOf(input) {
  /** @type {string | undefined} */
  let gist;
  if (typeof input === "string") gist = input;
  else if (typeof input === "object" && input !== null) {
    const record = /** @type {Record<string, unknown>} */ (input);
    const preferred = GIST_KEYS.find((key) => typeof record[key] === "string");
    const first = Object.values(record).find((value) => typeof value === "string");
    const found = preferred !== undefined ? record[preferred] : first;
    if (typeof found === "string") gist = found;
  }
  if (gist === undefined) return "";
  const line = gist.split("\n")[0] ?? "";
  return line.length > GIST_LENGTH || line !== gist ? `${line.slice(0, GIST_LENGTH)}…` : line;
}

/**
 * A tool's input as JSON, its long strings cut short: what was invoked, not
 * the whole file a `write` call carried.
 * @param {unknown} input
 */
const abridged = (input) =>
  JSON.stringify(
    input,
    (_key, value) =>
      typeof value === "string" && value.length > INPUT_STRING_LENGTH
        ? `${value.slice(0, INPUT_STRING_LENGTH)}… (${value.length - INPUT_STRING_LENGTH} more characters)`
        : value,
    2,
  ) ?? "";

/**
 * @param {ToolCall} call
 * @returns {HTMLLIElement}
 */
function renderToolCall(call) {
  const item = make("li", "tool-call");
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.append(
    make("span", "tool-name", call.name),
    make("span", "tool-gist", gistOf(call.input)),
  );
  details.append(summary, make("pre", "tool-input", abridged(call.input)));
  item.append(details);
  return item;
}

/** The files the server serves as pictures, which the page draws rather than links. */
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Where the browser fetches a file a Run left: under the Run's directory, by
 * the path the record names it with.
 * @param {string} session
 * @param {string} run
 * @param {string} path
 */
const artifactUrl = (session, run, path) =>
  `/api/sessions/${encodeURIComponent(session)}/runs/${encodeURIComponent(run)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

/**
 * @param {string} session
 * @param {string} run
 * @param {string} path
 * @returns {HTMLLIElement}
 */
function renderArtifact(session, run, path) {
  const url = artifactUrl(session, run, path);
  const name = path.split("/").at(-1) ?? path;
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  if (IMAGE.test(name)) {
    const item = make("li", "artifact image");
    const image = document.createElement("img");
    image.src = url;
    image.alt = name;
    image.loading = "lazy";
    link.append(image);
    item.append(link, make("span", "artifact-name", name));
    return item;
  }
  const item = make("li", "artifact");
  link.textContent = name;
  item.append(link);
  return item;
}

/**
 * @param {CellView} cell
 * @param {string} session
 * @param {boolean} running
 * @returns {HTMLLIElement}
 */
function renderCell(cell, session, running) {
  const item = make("li", `cell ${cell.type} ${cell.status}`);
  item.dataset.cell = cell.id;

  const heading = make("div", "cell-header");
  heading.append(make("span", "cell-id", cell.id), make("span", "cell-type", cell.type));
  if (cell.isolated) heading.append(make("span", "cell-attribute", "isolated"));
  if (cell.uses.length > 0)
    heading.append(make("span", "cell-attribute", `uses ${cell.uses.join(", ")}`));
  if (cell.model !== undefined) heading.append(make("span", "cell-attribute", cell.model));
  if (cell.timeout !== undefined)
    heading.append(make("span", "cell-attribute", `timeout ${formatDuration(cell.timeout)}`));
  heading.append(make("span", "cell-status", cell.status));
  const runOne = make("button", "cell-run", "Run");
  runOne.type = "button";
  runOne.title = `Run ${cell.id} alone, carrying on from the last run`;
  runOne.disabled = running;
  runOne.addEventListener("click", () => void startRun([cell.id]));
  heading.append(runOne);

  const body = make("pre", "cell-body", cell.body.replace(/\r?\n$/, ""));
  const calls = make("ol", "tool-calls");
  calls.append(...cell.toolCalls.map(renderToolCall));
  const output = make("pre", "cell-output", cell.text);

  item.append(heading, body, calls, output);
  if (cell.error !== undefined) item.append(make("p", "cell-error", cell.error));
  if (cell.artifacts.length > 0 && cell.run !== undefined) {
    const run = cell.run;
    const artifacts = make("ul", "artifacts");
    artifacts.append(...cell.artifacts.map((path) => renderArtifact(session, run, path)));
    item.append(artifacts);
  }
  return item;
}

function renderSession() {
  if (watching === undefined) return;
  const { state } = watching;
  element("title").textContent = state.title;
  element("notebook").textContent = state.notebook;
  /** @type {HTMLButtonElement} */ (element("run-all")).disabled = state.running;
  /** @type {HTMLButtonElement} */ (element("interrupt")).disabled = !state.running;
  element("cells").replaceChildren(
    ...state.cells.map((cell) => renderCell(cell, state.id, state.running)),
  );
}

/**
 * Appends to one Cell's output without redrawing the rest, since text arrives
 * a fragment at a time and a redraw per fragment would flicker.
 * @param {string} id
 * @param {string} text
 */
function appendText(id, text) {
  const output = element("cells").querySelector(`[data-cell="${id}"] .cell-output`);
  if (output !== null) output.textContent += text;
}

/**
 * Adds one card to one Cell's tool calls, for the same reason: a turn may make
 * many, and each should appear as it happens without the page jumping.
 * @param {string} id
 * @param {ToolCall} call
 */
function appendToolCall(id, call) {
  const calls = element("cells").querySelector(`[data-cell="${id}"] .tool-calls`);
  if (calls !== null) calls.append(renderToolCall(call));
}

/**
 * @param {string} id
 * @returns {CellView | undefined}
 */
const cellNamed = (id) => watching?.state.cells.find((cell) => cell.id === id);

/** @param {NotebookSessionEvent} event */
function apply(event) {
  if (watching === undefined) return;
  const { state } = watching;
  const status = element("session-status");

  switch (event.type) {
    case "notebook-session": {
      watching.state = event.session;
      const running = event.session.cells.find((cell) => cell.status === "running");
      if (running?.run !== undefined) watching.run = running.run;
      else delete watching.run;
      renderSession();
      return;
    }
    case "run-started":
      state.running = true;
      watching.run = event.run;
      status.textContent = "";
      renderSession();
      return;
    case "cell-started": {
      const cell = cellNamed(event.cell);
      if (cell !== undefined) {
        Object.assign(cell, { status: "running", text: "", toolCalls: [], artifacts: [] });
        delete cell.error;
        if (watching.run !== undefined) cell.run = watching.run;
      }
      renderSession();
      return;
    }
    case "cell-text": {
      const cell = cellNamed(event.cell);
      if (cell !== undefined) cell.text += event.text;
      appendText(event.cell, event.text);
      return;
    }
    case "cell-tool-call": {
      const cell = cellNamed(event.cell);
      if (cell !== undefined) cell.toolCalls.push(event.call);
      appendToolCall(event.cell, event.call);
      return;
    }
    case "cell-ended": {
      const cell = cellNamed(event.record.id);
      if (cell !== undefined) {
        cell.status = event.record.status;
        cell.text = event.record.text ?? event.record.stdout ?? "";
        cell.toolCalls = event.record.toolCalls ?? [];
        cell.artifacts = event.record.artifacts;
        if (event.record.error !== undefined) cell.error = event.record.error;
        else delete cell.error;
      }
      renderSession();
      return;
    }
    case "run-ended":
      state.running = false;
      delete watching.run;
      for (const id of event.record.stale) {
        const cell = cellNamed(id);
        if (cell !== undefined) cell.status = "stale";
      }
      renderSession();
      return;
    case "run-refused":
      state.running = false;
      delete watching.run;
      status.textContent = event.error;
      renderSession();
      return;
  }
}

/**
 * Runs the Cells named, or the whole Notebook when none are; either carries on
 * from the Run before. The session says it is running as soon as it has taken
 * the request, and the page says so with it: the Run names itself over the
 * socket only once the agent is set up, which with a real one is a moment.
 * @param {string[]} [cells]
 */
async function startRun(cells) {
  if (watching === undefined) return;
  const { state } = watching;
  try {
    await post(`/api/sessions/${state.id}/run`, cells !== undefined ? { cells } : {});
    if (watching?.state === state) {
      state.running = true;
      renderSession();
    }
  } catch (cause) {
    element("session-status").textContent = `Could not run: ${describe(cause)}`;
  }
}

async function interrupt() {
  if (watching === undefined) return;
  try {
    await post(`/api/sessions/${watching.state.id}/interrupt`);
  } catch (cause) {
    element("session-status").textContent = `Could not interrupt: ${describe(cause)}`;
  }
}

/**
 * The Notebook the URL most recently asked for. Opening one takes a round trip,
 * and the URL may have moved on by the time it is back; the answer to an
 * earlier request is then dropped rather than shown over the later one.
 */
let asked = "";

/** @param {string} notebook */
async function showSession(notebook) {
  watching?.socket.close();
  watching = undefined;
  element("list").hidden = true;
  const view = element("session");
  view.hidden = false;
  const status = element("session-status");
  status.textContent = `Opening ${notebook}…`;

  /** @type {NotebookSessionState} */
  let state;
  try {
    state = await (await post("/api/sessions", { notebook })).json();
  } catch (cause) {
    if (asked !== notebook) return;
    element("title").textContent = notebook;
    element("notebook").textContent = "";
    element("cells").replaceChildren();
    status.textContent = `Could not open the notebook: ${describe(cause)}`;
    return;
  }
  if (asked !== notebook) return;

  const url = new URL(`/api/sessions/${state.id}/events`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  watching = { state, socket };
  status.textContent = "";
  renderSession();

  socket.addEventListener("message", (message) => {
    if (watching?.socket !== socket) return;
    apply(/** @type {NotebookSessionEvent} */ (JSON.parse(String(message.data))));
  });
  socket.addEventListener("close", () => {
    if (watching?.socket === socket) status.textContent = "Lost the connection to the server.";
  });
}

function route() {
  asked = decodeURIComponent(location.hash.slice(1));
  if (asked === "") {
    watching?.socket.close();
    watching = undefined;
    void showList();
  } else void showSession(asked);
}

element("run-all").addEventListener("click", () => void startRun());
element("interrupt").addEventListener("click", () => void interrupt());
window.addEventListener("hashchange", route);
route();
