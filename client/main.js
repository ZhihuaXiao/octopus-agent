// @ts-check
/**
 * The client: lists the Notebooks the server can see, opens one into its
 * Notebook Session, and shows the Session as it runs — each Cell's text as it
 * is spoken, and a way to stop it.
 *
 * The Session is the server's. This page asks it to run or to stop, over HTTP,
 * and hears what happens over a WebSocket; closing the page changes nothing
 * about the work. The Notebook opened is kept in the URL's fragment, so a
 * reload opens the same one again.
 */

/**
 * @typedef {{ path: string, title: string }} NotebookEntry
 * @typedef {{ directory: string, notebooks: NotebookEntry[] }} NotebookList
 * @typedef {"idle" | "running" | "ok" | "error" | "timeout" | "interrupted" | "stale"} CellState
 * @typedef {{ id: string, type: "prompt" | "bash", status: CellState, text: string, error?: string }} CellView
 * @typedef {{ id: string, notebook: string, title: string, running: boolean, cells: CellView[] }} NotebookSessionState
 * @typedef {{ id: string, type: "prompt" | "bash", status: "ok" | "error" | "timeout" | "interrupted", text?: string, stdout?: string, error?: string }} CellRecord
 * @typedef {(
 *   | { type: "notebook-session", session: NotebookSessionState }
 *   | { type: "run-started", cells: string[] }
 *   | { type: "cell-started", cell: string }
 *   | { type: "cell-text", cell: string, text: string }
 *   | { type: "cell-ended", record: CellRecord }
 *   | { type: "run-ended", record: { stale: string[] } }
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
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = entry.title;
  const path = document.createElement("span");
  path.className = "path";
  path.textContent = entry.path;
  link.append(title, path);
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

/** What is being watched right now, so opening another Notebook lets go of it. */
/** @type {{ state: NotebookSessionState, socket: WebSocket } | undefined} */
let watching;

/**
 * @param {CellView} cell
 * @returns {HTMLLIElement}
 */
function renderCell(cell) {
  const item = document.createElement("li");
  item.className = `cell ${cell.status}`;
  item.dataset.cell = cell.id;

  const heading = document.createElement("div");
  heading.className = "cell-header";
  const name = document.createElement("span");
  name.className = "cell-id";
  name.textContent = cell.id;
  const type = document.createElement("span");
  type.className = "cell-type";
  type.textContent = cell.type;
  const status = document.createElement("span");
  status.className = "cell-status";
  status.textContent = cell.status;
  heading.append(name, type, status);

  const output = document.createElement("pre");
  output.className = "cell-output";
  output.textContent = cell.text;

  item.append(heading, output);
  if (cell.error !== undefined) {
    const error = document.createElement("p");
    error.className = "cell-error";
    error.textContent = cell.error;
    item.append(error);
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
  element("cells").replaceChildren(...state.cells.map(renderCell));
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
    case "notebook-session":
      watching.state = event.session;
      renderSession();
      return;
    case "run-started":
      state.running = true;
      status.textContent = "";
      renderSession();
      return;
    case "cell-started": {
      const cell = cellNamed(event.cell);
      if (cell !== undefined)
        Object.assign(cell, { status: "running", text: "", error: undefined });
      renderSession();
      return;
    }
    case "cell-text": {
      const cell = cellNamed(event.cell);
      if (cell !== undefined) cell.text += event.text;
      appendText(event.cell, event.text);
      return;
    }
    case "cell-ended": {
      const cell = cellNamed(event.record.id);
      if (cell !== undefined) {
        cell.status = event.record.status;
        cell.text = event.record.text ?? event.record.stdout ?? "";
        if (event.record.error !== undefined) cell.error = event.record.error;
        else delete cell.error;
      }
      renderSession();
      return;
    }
    case "run-ended":
      state.running = false;
      for (const id of event.record.stale) {
        const cell = cellNamed(id);
        if (cell !== undefined) cell.status = "stale";
      }
      renderSession();
      return;
    case "run-refused":
      state.running = false;
      status.textContent = event.error;
      renderSession();
      return;
  }
}

/** Runs the whole Notebook; running one Cell from here is ticket 16's, though the server takes `cells`. */
async function startRun() {
  if (watching === undefined) return;
  try {
    await post(`/api/sessions/${watching.state.id}/run`, {});
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
