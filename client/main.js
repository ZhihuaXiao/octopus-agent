// @ts-check
/**
 * The client: lists the Notebooks the server can see, opens one into its
 * Notebook Session, and shows the Session as the Author View — the Notebook as
 * written, each Cell as the Notebook declares it, with what running it has
 * produced: its text as it is spoken, shown as plain text or as Markdown,
 * each tool the agent invokes as it
 * invokes it, and the files it left — and a way to run one Cell or all of
 * them, or to stop; and, while editing, the whole Notebook as a form —
 * frontmatter, Prose and Cells, to be changed, added, removed and reordered —
 * saved whole, based on the revision it was drawn from.
 *
 * Beside whichever is shown, the served directory is drawn as a tree of its
 * folders and the Notebooks in them, the one open marked, with a way to make
 * a new Notebook and a way to choose the model that Notebook runs on, from
 * the models its user can already call; and under an open Notebook are the ways to add a Prompt
 * Cell or a Bash Cell to it, which begin the editing when it has not begun.
 *
 * The same Session is shown a second way, as the Run View: the Cells hidden,
 * the Notebook's declared Inputs as a form, one button, and, as it runs, how
 * far it has got and what each Cell says and leaves; a Run that could not
 * start or did not finish is explained in words that say whether running it
 * again will help or somebody has to be asked. For whoever is handed a
 * Notebook and not its prompts.
 *
 * The Session is the server's. This page asks it to run, to stop, to save, or
 * for an Export of a finished Run, over HTTP, and hears what happens over a
 * WebSocket; closing the page changes nothing about the work. The Notebook opened is kept in the URL's fragment —
 * `#run/` before it for the Run View — so a reload opens the same one again
 * and a link opens it the same way for whoever it is sent to. Every event is
 * numbered, and the page keeps the number of the last it heard: when the
 * socket drops — the network went, or the server was restarted — the page
 * reconnects and asks for everything since, so what happened while it was
 * away arrives as it would have, and nothing is drawn twice.
 *
 * Every request goes through `request`, which handles the one answer that is
 * about the page rather than what it asked: a `401`, meaning the browser has
 * no Connection — none yet, or one the server no longer knows, as after a
 * restart. The connect panel is shown and the request waits; the password, or
 * the token pasted from the URL the server printed, is presented to
 * `/api/connect`, which answers with the cookie every request from then on
 * carries, and the request is made again. The socket needs nothing of its own:
 * the browser sends the cookie with the upgrade, and a socket refused for want
 * of one closes and is reconnected through the same path.
 */

/**
 * @typedef {{ path: string, title: string, model?: string }} NotebookEntry
 * @typedef {{ directory: string, notebooks: NotebookEntry[] }} NotebookList
 * @typedef {{
 *   id: string,
 *   name?: string,
 *   firstMessage: string,
 *   messages: number,
 *   created: string,
 *   modified: string,
 * }} ChatEntry
 * @typedef {{ chats: ChatEntry[] }} ChatList
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
 * @typedef {{ kind: "prose", text: string } | { kind: "cell", id: string }} SegmentView
 * @typedef {"string" | "number" | "boolean"} InputType
 * @typedef {{
 *   name: string,
 *   type: InputType,
 *   description?: string,
 *   default?: string | number | boolean,
 * }} InputView
 * @typedef {{
 *   id: string,
 *   notebook: string,
 *   title: string,
 *   model?: string,
 *   revision: string,
 *   frontmatter?: string,
 *   inputs: InputView[],
 *   segments: SegmentView[],
 *   running: boolean,
 *   sequence: number,
 *   cells: CellView[],
 * }} NotebookSessionState
 * @typedef {"notebook" | "inputs" | "cells" | "workspace" | "agent" | "environment"} RefusalKind
 * @typedef {{ kind: RefusalKind, problems: string[] }} Refusal
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
 * @typedef {{ sequence: number } & (
 *   | { type: "run-started", run: string, cells: string[] }
 *   | { type: "cell-started", cell: string }
 *   | { type: "cell-text", cell: string, text: string }
 *   | { type: "cell-tool-call", cell: string, call: ToolCall }
 *   | { type: "cell-ended", record: CellRecord }
 *   | { type: "run-ended", record: { id: string, stale: string[] } }
 *   | { type: "run-refused", error: string, refusal?: Refusal }
 *   | { type: "notebook-changed", session: NotebookSessionState }
 * )} NumberedEvent
 * @typedef {(
 *   | { type: "notebook-session", session: NotebookSessionState }
 *   | NumberedEvent
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

/** @typedef {"token" | "password"} Method */

/** What the panel says for each way of authenticating: what to present, and where it comes from. */
const CONNECT_MESSAGES = {
  token:
    "This server takes the token it printed when it started. Open the URL it printed, or paste the token from that URL here.",
  password: "This server takes the password set with `octo password`.",
};

/**
 * The connect under way, when the panel is shown, so that every request refused
 * meanwhile waits on the one panel rather than each showing a panel of its own.
 * @type {Promise<void> | undefined}
 */
let asking;

/**
 * Shows the connect panel and resolves once a Connection has been opened.
 * @param {Method} method
 * @returns {Promise<void>}
 */
function askToConnect(method) {
  if (asking !== undefined) return asking;
  const panel = element("connect");
  const form = /** @type {HTMLFormElement} */ (element("connect-form"));
  const secret = /** @type {HTMLInputElement} */ (element("secret"));
  const status = element("connect-status");
  element("connect-message").textContent = CONNECT_MESSAGES[method];
  element("connect-label").textContent = method === "token" ? "Token" : "Password";
  secret.value = "";
  status.textContent = "";
  panel.hidden = false;
  secret.focus();

  asking = new Promise((connected) => {
    /** @param {SubmitEvent} event */
    const submit = async (event) => {
      event.preventDefault();
      status.textContent = "";
      /** @type {Response} */
      let response;
      try {
        response = await fetch("/api/connect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ [method]: secret.value }),
        });
      } catch (cause) {
        status.textContent = `Could not reach the server: ${describe(cause)}`;
        return;
      }
      if (response.ok) {
        form.removeEventListener("submit", submit);
        panel.hidden = true;
        asking = undefined;
        connected();
        return;
      }
      status.textContent =
        response.status === 401
          ? `That is not the ${method}.`
          : (await response.text()).trim() || `The server answered ${response.status}`;
      secret.select();
    };
    form.addEventListener("submit", submit);
  });
  return asking;
}

/**
 * A request to the server, made again once a Connection has been opened
 * when the answer was that it must.
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function request(path, init) {
  for (;;) {
    const response = await fetch(path, init);
    if (response.status !== 401) return response;
    /** @type {{ authenticate?: Method }} */
    const told = await response.json().catch(() => ({}));
    await askToConnect(told.authenticate ?? "password");
  }
}

/**
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<Response>}
 */
async function post(path, body) {
  const response = await request(path, {
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
  const response = await request("/api/notebooks");
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
  link.href = hashFor(entry.path, "author");
  link.append(make("span", "title", entry.title), make("span", "path", entry.path));
  // The other way in, for whoever is here to run it rather than read it.
  const run = make("a", "run-link", "Run view");
  run.href = hashFor(entry.path, "run");
  item.append(link, modelButton(entry.path, entry.model), run);
  return item;
}

/**
 * The button that chooses the model this Notebook runs on, from the models
 * the user can already call.
 * @param {string} notebook
 * @param {string} [model]
 * @param {string} [className]
 */
function modelButton(notebook, model, className) {
  const button = make("button", className ?? "notebook-model", model ?? "Model");
  button.type = "button";
  button.title = model ?? "Choose a configured model for this notebook";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (draft !== undefined && watching?.state.notebook === notebook) {
      element("session-status").textContent = "Save or cancel the draft before choosing a model.";
      return;
    }
    void openNotebookModel(notebook, model);
  });
  return button;
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
      found.notebooks.length === 0
        ? "No notebooks found in this directory. Press New notebook to begin one."
        : "";
  } catch (cause) {
    status.textContent = `Could not list the notebooks: ${describe(cause)}`;
    element("tree-status").textContent = status.textContent;
  }
  await refreshTree();
  await showChats();
}

/**
 * One entry of the served directory, as the sidebar lists it.
 * @typedef {{ name: string, path: string, kind: "directory", children: TreeNode[] }
 *   | { name: string, path: string, kind: "notebook", title: string, model?: string }
 *   | { name: string, path: string, kind: "file" }} TreeNode
 * @typedef {{ directory: string, entries: TreeNode[] }} FileTree
 */

/** The Notebooks last listed, so a new one can be offered a name none of them has. */
/** @type {NotebookEntry[]} */
let listed = [];

/** The folders the sidebar has open, by path ending in a slash, kept open each time it is drawn again. */
/** @type {Set<string>} */
const openFolders = new Set();

/** Which Notebook's folders were last unfolded, so a refresh does not reopen one the reader closed. */
let revealed = "";

/**
 * The Notebooks in a tree, for naming a new one that does not collide.
 * @param {TreeNode[]} nodes
 * @param {NotebookEntry[]} [into]
 * @returns {NotebookEntry[]}
 */
function notebooksIn(nodes, into = []) {
  for (const node of nodes) {
    if (node.kind === "notebook") into.push({ path: node.path, title: node.title });
    else if (node.kind === "directory") notebooksIn(node.children, into);
  }
  return into;
}

/**
 * Unfolds the folders that lead to `notebook`, so the one open can be seen.
 * @param {string} notebook
 */
function reveal(notebook) {
  const folders = notebook.split("/").slice(0, -1);
  let prefix = "";
  for (const name of folders) {
    prefix += `${name}/`;
    openFolders.add(prefix);
  }
}

/**
 * What one folder holds: its folders, then its files, a Notebook opening and
 * any other file only listed.
 * @param {TreeNode[]} nodes
 * @returns {HTMLLIElement[]}
 */
function renderNodes(nodes) {
  return nodes.map((node) => {
    if (node.kind === "directory") {
      const path = `${node.path}/`;
      const item = make("li", "tree-folder");
      const details = document.createElement("details");
      details.open = openFolders.has(path);
      details.addEventListener("toggle", () => {
        if (details.open) openFolders.add(path);
        else openFolders.delete(path);
      });
      const contents = make("ul", "tree");
      contents.append(
        ...(node.children.length === 0
          ? [make("li", "tree-empty", "Empty")]
          : renderNodes(node.children)),
      );
      details.append(make("summary", "", `${node.name}/`), contents);
      item.append(details);
      return item;
    }
    if (node.kind === "notebook") {
      const item = make("li", "tree-notebook");
      const link = make("a", "", node.name);
      link.href = hashFor(node.path, "author");
      link.title = node.title;
      if (node.path === asked) link.setAttribute("aria-current", "page");
      item.append(link, modelButton(node.path, node.model, "tree-model"));
      return item;
    }
    const item = make("li", "tree-file", node.name);
    item.title = node.path;
    return item;
  });
}

/** @param {FileTree} found */
function drawTree(found) {
  listed = notebooksIn(found.entries);
  if (asked !== "" && asked !== revealed) {
    reveal(asked);
    revealed = asked;
  }
  element("directory").textContent = found.directory;
  const root = element("tree-root");
  root.textContent = `${found.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? found.directory}/`;
  root.title = found.directory;
  element("tree").replaceChildren(...renderNodes(found.entries));
  element("tree-status").textContent = found.entries.length === 0 ? "This folder is empty." : "";
}

/** @returns {Promise<FileTree>} */
async function fetchTree() {
  const response = await request("/api/tree");
  if (!response.ok) throw new Error(`The server answered ${response.status}`);
  return response.json();
}

/** Lists the directory again for the sidebar, as a folder may have gained a file since. */
async function refreshTree() {
  try {
    drawTree(await fetchTree());
  } catch (cause) {
    element("tree-status").textContent = `Could not list the directory: ${describe(cause)}`;
  }
}

/**
 * Gives the open Notebook a new filename. The session follows the file, and
 * the address follows the session, so a reload opens the renamed one.
 */
async function renameNotebook() {
  if (watching === undefined) return;
  const current = watching.state.notebook;
  const given = window.prompt("Rename this notebook to:", current)?.trim();
  if (given === undefined || given === "" || given === current) return;
  const to = given.endsWith(".md") ? given : `${given}.md`;
  const status = element("session-status");
  try {
    const made = /** @type {NotebookEntry} */ (
      await (await post("/api/notebooks/rename", { from: current, to })).json()
    );
    if (watching?.state.notebook === current) {
      watching.state.notebook = made.path;
      watching.state.title = made.title;
      const next = hashFor(made.path, view);
      if (location.hash !== next) location.hash = next;
      else renderSession();
    }
    status.textContent = "";
    await refreshTree();
  } catch (cause) {
    status.textContent = `Could not rename: ${describe(cause)}`;
  }
}

/**
 * The Notebook to begin editing once it is open: one just made, whose one
 * empty Cell is there to be written.
 * @type {string | undefined}
 */
let editOnOpen;

/** A name for a new Notebook that none of those listed has. */
function untitledName() {
  const taken = new Set(listed.map((entry) => entry.path));
  let name = "untitled.md";
  for (let count = 2; taken.has(name); count += 1) name = `untitled-${count}.md`;
  return name;
}

/**
 * Makes a new Notebook under a name the author gives — `.md` added when it is
 * left off — holding one empty Prompt Cell, and opens it to be written.
 * @param {HTMLElement} status where to say what went wrong
 */
async function newNotebook(status) {
  const given = window.prompt("Name the new notebook:", untitledName())?.trim();
  if (given === undefined || given === "") return;
  const to = given.endsWith(".md") ? given : `${given}.md`;
  try {
    const made = /** @type {NotebookEntry} */ (await (await post("/api/notebooks", { to })).json());
    status.textContent = "";
    editOnOpen = made.path;
    location.hash = hashFor(made.path, "author");
  } catch (cause) {
    status.textContent = `Could not make the notebook: ${describe(cause)}`;
  }
}

/**
 * The chats pi has had in this directory, each with a way to promote it.
 * Shown under the Notebooks and only when there are any: a directory pi has
 * never been run in has nothing to promote, and need not say so.
 */
async function showChats() {
  const section = element("chats-section");
  const status = element("chats-status");
  try {
    const found = await fetchChats();
    section.hidden = found.chats.length === 0;
    element("chats").replaceChildren(...found.chats.map(renderChat));
    status.textContent = "";
  } catch (cause) {
    section.hidden = false;
    status.textContent = `Could not list the chats: ${describe(cause)}`;
  }
}

/** @returns {Promise<ChatList>} */
async function fetchChats() {
  const response = await request("/api/chats");
  if (!response.ok) throw new Error(`The server answered ${response.status}`);
  return response.json();
}

/**
 * @param {ChatEntry} chat
 * @returns {HTMLLIElement}
 */
function renderChat(chat) {
  const item = document.createElement("li");
  const about = document.createElement("div");
  const messages = chat.messages === 1 ? "1 message" : `${chat.messages} messages`;
  about.append(
    make("span", "said", chat.name ?? chat.firstMessage),
    make("span", "when", `${new Date(chat.modified).toLocaleString()} · ${messages}`),
  );
  const button = make("button", "", "Promote");
  button.type = "button";
  button.addEventListener("click", () => void promote(chat, button));
  item.append(about, button);
  return item;
}

/**
 * Makes a Notebook of the chat under a name the reader gives, and opens it.
 * @param {ChatEntry} chat
 * @param {HTMLButtonElement} button
 */
async function promote(chat, button) {
  const suggested = `${(chat.name ?? chat.firstMessage)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)}.md`;
  const to = window.prompt("Save this chat as a notebook named:", suggested);
  if (to === null || to.trim() === "") return;
  button.disabled = true;
  try {
    const made = /** @type {NotebookEntry} */ (
      await (
        await post(`/api/chats/${encodeURIComponent(chat.id)}/promote`, { to: to.trim() })
      ).json()
    );
    location.hash = hashFor(made.path, "author");
  } catch (cause) {
    element("chats-status").textContent = `Could not promote: ${describe(cause)}`;
  } finally {
    button.disabled = false;
  }
}

/**
 * What is being watched right now, so opening another Notebook lets go of it:
 * the state the events keep up to date, the socket they arrive on, the number
 * of the last event heard — what a reconnection asks for everything since —
 * and the Run in progress once it has named itself, which is what a Cell that
 * starts is running in — or, when the last Run asked for never started, why
 * not, for the Run View to explain until the next one starts.
 */
/**
 * @type {{
 *   state: NotebookSessionState,
 *   socket: WebSocket,
 *   sequence: number,
 *   run?: string,
 *   refused?: { error: string, refusal?: Refusal },
 * } | undefined}
 */
let watching;

/**
 * Which way the Notebook is shown: as its Cells, for whoever writes them, or
 * as the Run View. Read off the URL, so a link says which.
 * @typedef {"author" | "run"} View
 */
/** @type {View} */
let view = "author";

/** What the fragment begins with when it names the Run View; a Notebook's own path is encoded, so it never does. */
const RUN_VIEW_PREFIX = "run/";

/**
 * The fragment that opens `notebook` in the view named.
 * @param {string} notebook
 * @param {View} shown
 */
const hashFor = (notebook, shown) =>
  `#${shown === "run" ? RUN_VIEW_PREFIX : ""}${encodeURIComponent(notebook)}`;

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

/** How a Cell's reply is drawn. Kept in this browser. */
const OUTPUT_FORMAT_KEY = "octo-output-format";

/** @typedef {"plain" | "markdown"} OutputFormat */

/** @returns {OutputFormat} */
function storedOutputFormat() {
  try {
    return localStorage.getItem(OUTPUT_FORMAT_KEY) === "markdown" ? "markdown" : "plain";
  } catch {
    return "plain";
  }
}

/** @type {OutputFormat} */
let outputFormat = storedOutputFormat();

function syncFormatButtons() {
  /** @type {HTMLButtonElement} */ (element("format-plain")).setAttribute(
    "aria-pressed",
    outputFormat === "plain" ? "true" : "false",
  );
  /** @type {HTMLButtonElement} */ (element("format-markdown")).setAttribute(
    "aria-pressed",
    outputFormat === "markdown" ? "true" : "false",
  );
}

/** @param {OutputFormat} format */
function setOutputFormat(format) {
  outputFormat = format;
  try {
    localStorage.setItem(OUTPUT_FORMAT_KEY, format);
  } catch {
    // A browser that refuses storage still switches for this page.
  }
  syncFormatButtons();
  repaintOutputs();
}

/** Draws every visible reply again, in the format now chosen. */
function repaintOutputs() {
  if (watching === undefined) return;
  const root = element(view === "author" ? "segments" : "run-steps");
  for (const cell of watching.state.cells) {
    const output = root.querySelector(`[data-cell="${CSS.escape(cell.id)}"] .streamed`);
    if (output !== null) fillOutput(output, cell.text);
  }
}

/**
 * An address a reply may link to. Anything else — a script, or a name that is
 * not an address — stays text, so a reply cannot navigate the page.
 * @param {string} url
 * @returns {string | undefined}
 */
function linkable(url) {
  if (url.startsWith("/") || url.startsWith("#") || url.startsWith("./") || url.startsWith("../")) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "mailto:"
    ) {
      return url;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Inline marks in one line: code, emphasis, and links. The text itself is
 * never parsed as HTML.
 * @param {string} text
 * @returns {Node[]}
 */
function inlineNodes(text) {
  const pattern =
    /(`+)([^`]+)\1|\*\*([^*]+)\*\*|__([^_]+)__|(?<![A-Za-z0-9*])\*([^*\n]+)\*(?!\*)|(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  /** @type {Node[]} */
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(document.createTextNode(text.slice(last, index)));
    const [whole, , code, stars, underscores, italic, underItalic, label, href] = match;
    if (code !== undefined) {
      const marked = document.createElement("code");
      marked.textContent = code;
      nodes.push(marked);
    } else if (stars !== undefined || underscores !== undefined) {
      const strong = document.createElement("strong");
      strong.append(...inlineNodes(stars ?? underscores ?? ""));
      nodes.push(strong);
    } else if (italic !== undefined || underItalic !== undefined) {
      const em = document.createElement("em");
      em.append(...inlineNodes(italic ?? underItalic ?? ""));
      nodes.push(em);
    } else if (label !== undefined && href !== undefined) {
      const safe = linkable(href);
      if (safe === undefined) nodes.push(document.createTextNode(whole));
      else {
        const link = document.createElement("a");
        link.href = safe;
        link.rel = "noopener noreferrer";
        link.target = "_blank";
        link.append(...inlineNodes(label));
        nodes.push(link);
      }
    }
    last = index + whole.length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

/** @param {string} line */
const listItem = (line) => /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);

/**
 * A reply as Markdown: blocks of the lines, and the marks inside them. What
 * is not a mark stays text.
 * @param {string} text
 * @returns {Node[]}
 */
function markdownBlocks(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  /** @type {Node[]} */
  const blocks = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? "";
    if (line.trim() === "") {
      at += 1;
      continue;
    }
    const fence = /^```(.*)$/.exec(line);
    if (fence !== null) {
      /** @type {string[]} */
      const code = [];
      at += 1;
      while (at < lines.length && !/^```/.test(lines[at] ?? "")) {
        code.push(lines[at] ?? "");
        at += 1;
      }
      if (at < lines.length) at += 1;
      const pre = document.createElement("pre");
      const body = document.createElement("code");
      body.textContent = code.join("\n");
      pre.append(body);
      blocks.push(pre);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push(document.createElement("hr"));
      at += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const marks = heading[1] ?? "#";
      const title = document.createElement(
        marks.length <= 1 ? "h2" : marks.length === 2 ? "h3" : marks.length === 3 ? "h4" : "h5",
      );
      title.append(...inlineNodes(heading[2] ?? ""));
      blocks.push(title);
      at += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      /** @type {string[]} */
      const quoted = [];
      while (at < lines.length && /^>\s?/.test(lines[at] ?? "")) {
        quoted.push((lines[at] ?? "").replace(/^>\s?/, ""));
        at += 1;
      }
      const quote = document.createElement("blockquote");
      quote.append(...markdownBlocks(quoted.join("\n")));
      blocks.push(quote);
      continue;
    }
    const listed = listItem(line);
    if (listed !== null) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (at < lines.length) {
        const item = listItem(lines[at] ?? "");
        if (item === null || /^\s*\d+\.\s+/.test(lines[at] ?? "") !== ordered) break;
        const row = document.createElement("li");
        row.append(...inlineNodes(item[3] ?? ""));
        list.append(row);
        at += 1;
      }
      blocks.push(list);
      continue;
    }
    /** @type {string[]} */
    const paragraph = [];
    while (at < lines.length) {
      const next = lines[at] ?? "";
      if (
        next.trim() === "" ||
        /^```/.test(next) ||
        /^#{1,6}\s+/.test(next) ||
        /^>\s?/.test(next) ||
        listItem(next) !== null ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(next.trim())
      ) {
        break;
      }
      paragraph.push(next);
      at += 1;
    }
    const block = document.createElement("p");
    paragraph.forEach((row, index) => {
      if (index > 0) block.append(document.createElement("br"));
      block.append(...inlineNodes(row));
    });
    blocks.push(block);
  }
  return blocks;
}

/**
 * Puts a Cell's reply into `node`: the characters as written, or Markdown.
 * @param {Element} node
 * @param {string} text
 */
function fillOutput(node, text) {
  const markdown = outputFormat === "markdown" && text.trim() !== "";
  node.classList.toggle("markdown", markdown);
  if (!markdown) {
    node.textContent = text;
    return;
  }
  node.replaceChildren(...markdownBlocks(text));
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
  const output = make("div", "cell-output streamed");
  fillOutput(output, cell.text);

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

/**
 * The Notebook in order: its Prose as written, and each Cell where it sits.
 * @param {NotebookSessionState} state
 */
function renderSegments(state) {
  return state.segments.map((segment) => {
    if (segment.kind === "prose") return make("li", "prose", segment.text.replace(/\r?\n$/, ""));
    const cell = state.cells.find((candidate) => candidate.id === segment.id);
    return cell === undefined ? make("li", "prose", "") : renderCell(cell, state.id, state.running);
  });
}

function renderSession() {
  if (watching === undefined) return;
  const { state } = watching;
  element("title").textContent = state.title;
  element("notebook").textContent = state.notebook;
  const authoring = view === "author";
  element("author-controls").hidden = !authoring;
  element("run-controls").hidden = authoring;
  /** @type {HTMLAnchorElement} */ (element("to-run-view")).href = hashFor(state.notebook, "run");
  /** @type {HTMLAnchorElement} */ (element("to-author-view")).href = hashFor(
    state.notebook,
    "author",
  );
  element("run-view").hidden = authoring;
  element("add-cells").hidden = !authoring;
  if (!authoring) {
    element("segments").hidden = true;
    element("editor").hidden = true;
    renderRunView(state);
    return;
  }
  /** @type {HTMLButtonElement} */ (element("run-all")).disabled = state.running;
  /** @type {HTMLButtonElement} */ (element("interrupt")).disabled = !state.running;
  const chosen = /** @type {HTMLButtonElement} */ (element("notebook-model"));
  chosen.textContent = state.model ?? "Model";
  chosen.title =
    draft !== undefined
      ? "Save or cancel the draft before choosing a model."
      : (state.model ?? "Choose a configured model for this notebook");
  chosen.disabled = draft !== undefined;
  element("edit").hidden = draft !== undefined;
  element("segments").hidden = draft !== undefined;
  element("editor").hidden = draft === undefined;
  // While the Notebook is being edited the draft is what is on the page; the
  // Cells are drawn again from the state once the editing is over.
  if (draft === undefined) element("segments").replaceChildren(...renderSegments(state));
}

/**
 * Appends to one Cell's output without redrawing the rest, since text arrives
 * a fragment at a time and a redraw per fragment would flicker. Whichever view
 * is drawn has the Cell's output somewhere on the page.
 * @param {string} id
 * @param {string} text
 */
function appendText(id, text) {
  const list = view === "author" ? "segments" : "run-steps";
  const output = element(list).querySelector(`[data-cell="${CSS.escape(id)}"] .streamed`);
  if (output === null) return;
  const cell = cellNamed(id);
  fillOutput(output, cell === undefined ? `${output.textContent ?? ""}${text}` : cell.text);
}

/**
 * Adds one card to one Cell's tool calls, for the same reason: a turn may make
 * many, and each should appear as it happens without the page jumping.
 * @param {string} id
 * @param {ToolCall} call
 */
function appendToolCall(id, call) {
  const calls = element("segments").querySelector(`[data-cell="${id}"] .tool-calls`);
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
  // Where the page now stands, for the next reconnection to pick up from.
  watching.sequence = "sequence" in event ? event.sequence : event.session.sequence;

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
      delete watching.refused;
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
      // The Author View shows the runner's words as they are; the Run View
      // says what they mean, and keeps them until the next Run starts.
      watching.refused = {
        error: event.error,
        ...(event.refusal !== undefined ? { refusal: event.refusal } : {}),
      };
      status.textContent = view === "author" ? event.error : "";
      renderSession();
      return;
    case "notebook-changed": {
      // Saved from here or elsewhere, or found changed on disk: what the
      // session holds now, which is what the next save is based on. A draft
      // on the page is left alone, since it is the author's work in progress.
      // A rename is the same event with a new path, and the address follows it.
      const moved = event.session.notebook !== asked;
      watching.state = event.session;
      if (draft !== undefined && !draft.saving && draft.base !== event.session.revision) {
        element("editor-status").textContent =
          `${event.session.notebook} has changed since this draft was begun. Save to write over it, or cancel to see what it holds now.`;
      }
      renderSession();
      if (moved) {
        asked = event.session.notebook;
        const next = hashFor(event.session.notebook, view);
        if (location.hash !== next) location.hash = next;
        void refreshTree();
      }
      return;
    }
  }
}

/**
 * Runs the Cells named, or the whole Notebook when none are; either carries on
 * from the Run before. The session says it is running as soon as it has taken
 * the request, and the page says so with it: the Run names itself over the
 * socket only once the agent is set up, which with a real one is a moment.
 * The answer and the socket are two connections, though, and a Run short
 * enough may have begun and ended over the socket before the answer arrives;
 * the answer says which event the session stood at, and is taken at its word
 * only when the page has heard nothing since. The Inputs' values are given as
 * typed; the server reads them, and refuses the Run with what is wrong with
 * them when something is.
 * @param {string[]} [cells]
 * @param {Record<string, string>} [inputs]
 */
async function startRun(cells, inputs) {
  if (watching === undefined) return;
  const { state } = watching;
  try {
    const answered = /** @type {NotebookSessionState} */ (
      await (
        await post(`/api/sessions/${state.id}/run`, {
          ...(cells !== undefined ? { cells } : {}),
          ...(inputs !== undefined ? { inputs } : {}),
        })
      ).json()
    );
    if (watching?.state === state && watching.sequence === answered.sequence) {
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
 * The Notebook as it is being edited: each field as typed, so a half-written
 * `uses` or timeout is kept as text until the save, when the server reads it
 * and says what it makes of it. A body is content, without the line ending
 * that closes it, which is the fence's to supply.
 * @typedef {{
 *   kind: "cell",
 *   id: string,
 *   type: "prompt" | "bash",
 *   body: string,
 *   uses: string,
 *   isolated: boolean,
 *   model: string,
 *   timeout: string,
 * }} DraftCell
 * @typedef {{ kind: "prose", text: string }} DraftProse
 * @typedef {DraftCell | DraftProse} DraftSegment
 * @typedef {{
 *   base: string,
 *   frontmatter: string,
 *   segments: DraftSegment[],
 *   saving: boolean,
 * }} Draft
 */

/** The draft being edited, when the page is in its edit mode. */
/** @type {Draft | undefined} */
let draft;

/**
 * A draft of the Notebook as the session holds it.
 * @param {NotebookSessionState} state
 * @returns {Draft}
 */
function draftOf(state) {
  return {
    base: state.revision,
    frontmatter: state.frontmatter ?? "",
    segments: state.segments.flatMap(
      /** @returns {DraftSegment[]} */ (segment) => {
        if (segment.kind === "prose") return [{ kind: "prose", text: segment.text }];
        const cell = state.cells.find((candidate) => candidate.id === segment.id);
        if (cell === undefined) return [];
        return [
          {
            kind: "cell",
            id: cell.id,
            type: cell.type,
            body: cell.body.replace(/\r?\n$/, ""),
            uses: cell.uses.join(", "),
            isolated: cell.isolated,
            model: cell.model ?? "",
            timeout: cell.timeout === undefined ? "" : formatDuration(cell.timeout),
          },
        ];
      },
    ),
    saving: false,
  };
}

/**
 * The draft as the server takes it: the fields as the format spells them, an
 * empty one left out rather than sent as empty — the frontmatter among them,
 * so clearing its field is how it is removed.
 * @param {Draft} edited
 */
function saveRequestOf(edited) {
  return {
    base: edited.base,
    ...(edited.frontmatter === "" ? {} : { frontmatter: edited.frontmatter }),
    segments: edited.segments.map((segment) => {
      if (segment.kind === "prose") return segment;
      const model = segment.model.trim();
      const timeout = segment.timeout.trim();
      return {
        kind: "cell",
        id: segment.id.trim(),
        type: segment.type,
        body: segment.body,
        uses: segment.uses
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== ""),
        isolated: segment.isolated,
        ...(model === "" ? {} : { model }),
        ...(timeout === "" ? {} : { timeout }),
      };
    }),
  };
}

/**
 * A text field sized to what it holds, bound to one string of the draft.
 * @param {string} value
 * @param {(value: string) => void} set
 * @param {string} [placeholder]
 */
function textarea(value, set, placeholder) {
  const field = document.createElement("textarea");
  field.value = value;
  field.rows = Math.max(3, value.split("\n").length + 1);
  if (placeholder !== undefined) field.placeholder = placeholder;
  field.addEventListener("input", () => {
    set(field.value);
    field.rows = Math.max(3, field.value.split("\n").length + 1);
  });
  return field;
}

/**
 * A one-line field bound to one string of the draft.
 * @param {string} label
 * @param {string} value
 * @param {(value: string) => void} set
 * @param {string} [className]
 */
function field(label, value, set, className) {
  const wrapper = document.createElement("label");
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  if (className !== undefined) input.className = className;
  input.addEventListener("input", () => set(input.value));
  wrapper.append(label, input);
  return wrapper;
}

/** A Cell id no Cell of the draft has yet. */
function freshId() {
  const taken = new Set(
    (draft?.segments ?? []).flatMap((segment) => (segment.kind === "cell" ? [segment.id] : [])),
  );
  let count = taken.size + 1;
  while (taken.has(`cell-${count}`)) count += 1;
  return `cell-${count}`;
}

/**
 * A Cell with nothing in it yet, to go after `before`, with a blank line ahead
 * of it when that is another Cell, so the two fences do not abut.
 * @param {"prompt" | "bash"} type
 * @param {DraftSegment | undefined} before
 * @returns {DraftSegment[]}
 */
function blankCell(type, before) {
  /** @type {DraftCell} */
  const cell = {
    kind: "cell",
    id: freshId(),
    type,
    body: "",
    uses: "",
    isolated: false,
    model: "",
    timeout: "",
  };
  return before?.kind === "cell" ? [{ kind: "prose", text: "\n" }, cell] : [cell];
}

/**
 * Adds an empty Cell at the end of the Notebook, beginning the editing when it
 * has not begun, and puts the cursor in it.
 * @param {"prompt" | "bash"} type
 */
function addCell(type) {
  if (watching === undefined) return;
  if (draft === undefined) beginEditing();
  const segments = draft?.segments;
  if (segments === undefined) return;
  segments.push(...blankCell(type, segments.at(-1)));
  renderEditor();
  focusSegment(segments.length - 1);
}

/**
 * Puts the cursor in the text of the draft's segment at `at`, and brings it into view.
 * @param {number} at
 */
function focusSegment(at) {
  const body = element("draft").querySelector(".segments")?.children[at]?.querySelector("textarea");
  if (body === null || body === undefined) return;
  body.focus();
  body.scrollIntoView({ block: "center" });
}

/**
 * The row that adds a segment after position `at` — before everything when
 * `at` is -1 — and the ways to move and remove the segment it is under.
 * @param {number} at
 */
function actionsFor(at) {
  const actions = make("div", "draft-actions");
  const segments = draft?.segments ?? [];

  /**
   * @param {string} label
   * @param {() => void} act
   * @param {boolean} [disabled]
   */
  const button = (label, act, disabled = false) => {
    const made = make("button", "", label);
    made.type = "button";
    made.disabled = disabled;
    made.addEventListener("click", () => {
      act();
      renderEditor();
    });
    return made;
  };

  if (at >= 0) {
    const segment = segments[at];
    actions.append(
      button("↑", () => swap(at, at - 1), at === 0),
      button("↓", () => swap(at, at + 1), at === segments.length - 1),
      button("Remove", () => segments.splice(at, 1)),
    );
    // The same Run a Cell has when it is not being edited. The draft is saved
    // first, so the command just typed is what runs.
    if (segment?.kind === "cell") {
      const cell = segment;
      actions.append(
        button(
          "Run",
          () => void runDraftCell(cell),
          watching?.state.running === true || draft?.saving === true,
        ),
      );
    }
  }

  /** @param {DraftSegment[]} added */
  const insert = (added) => segments.splice(at + 1, 0, ...added);
  const inserts = make("span", "draft-insert", at >= 0 ? "Insert below:" : "Insert at the top:");
  inserts.append(
    button("prompt cell", () => insert(blankCell("prompt", segments[at]))),
    button("bash cell", () => insert(blankCell("bash", segments[at]))),
    button("prose", () => insert([{ kind: "prose", text: "\n" }])),
  );
  actions.append(inserts);
  return actions;
}

/**
 * Trades the segments at two positions, when both are there.
 * @param {number} from
 * @param {number} to
 */
function swap(from, to) {
  const segments = draft?.segments;
  if (segments === undefined || to < 0 || to >= segments.length) return;
  const a = segments[from];
  const b = segments[to];
  if (a === undefined || b === undefined) return;
  segments[from] = b;
  segments[to] = a;
}

/**
 * @param {DraftCell} cell
 * @param {number} at
 */
function renderDraftCell(cell, at) {
  const card = make("li", `draft-segment cell ${cell.type}`);
  const declaration = make("div", "draft-declaration");

  const type = document.createElement("select");
  for (const option of ["prompt", "bash"]) {
    const choice = document.createElement("option");
    choice.value = option;
    choice.textContent = option;
    choice.selected = cell.type === option;
    type.append(choice);
  }
  type.addEventListener("change", () => {
    cell.type = type.value === "bash" ? "bash" : "prompt";
    card.className = `draft-segment cell ${cell.type}`;
  });

  const isolated = document.createElement("label");
  const flag = document.createElement("input");
  flag.type = "checkbox";
  flag.checked = cell.isolated;
  flag.addEventListener("change", () => (cell.isolated = flag.checked));
  isolated.append(flag, "isolated");

  declaration.append(
    type,
    field("id", cell.id, (value) => (cell.id = value), "draft-id"),
    field("uses", cell.uses, (value) => (cell.uses = value)),
    isolated,
    field("model", cell.model, (value) => (cell.model = value)),
    field("timeout", cell.timeout, (value) => (cell.timeout = value)),
  );
  card.append(
    declaration,
    textarea(
      cell.body,
      (value) => (cell.body = value),
      cell.type === "bash" ? "A shell command" : "What to ask the agent",
    ),
    actionsFor(at),
  );
  return card;
}

/**
 * @param {DraftProse} prose
 * @param {number} at
 */
function renderDraftProse(prose, at) {
  const card = make("li", "draft-segment prose");
  card.append(
    make("span", "draft-label", "Prose"),
    textarea(prose.text, (value) => (prose.text = value), "Markdown between the cells"),
    actionsFor(at),
  );
  return card;
}

/** Draws the draft as a form, whole: after a segment is added, moved or removed. */
function renderEditor() {
  if (draft === undefined) return;
  const edited = draft;
  const frontmatter = make("div", "draft-frontmatter");
  frontmatter.append(
    make("span", "draft-label", "Frontmatter"),
    textarea(
      edited.frontmatter,
      (value) => (edited.frontmatter = value),
      "title, mode, workspace, model, inputs…",
    ),
    actionsFor(-1),
  );
  const list = make("ol", "segments");
  list.append(
    ...edited.segments.map((segment, at) =>
      segment.kind === "cell" ? renderDraftCell(segment, at) : renderDraftProse(segment, at),
    ),
  );
  element("draft").replaceChildren(frontmatter, list);
}

function beginEditing() {
  if (watching === undefined || draft !== undefined) return;
  draft = draftOf(watching.state);
  element("editor-status").textContent = "";
  renderEditor();
  renderSession();
}

function stopEditing() {
  draft = undefined;
  element("draft").replaceChildren();
  const status = element("session-status");
  if (status.textContent === "Save or cancel the draft before choosing a model.")
    status.textContent = "";
  renderSession();
}

/**
 * Saves the draft, based on the revision the session held when it was begun
 * or last found changed. A save the server would not take is explained where
 * the draft is, and the draft stays for the author to act on: change it, save
 * over what changed on disk, or cancel. Resolves true when the file was written.
 * @returns {Promise<boolean>}
 */
async function saveDraft() {
  if (watching === undefined || draft === undefined) return false;
  const { state } = watching;
  const edited = draft;
  const status = element("editor-status");
  edited.saving = true;
  /** @type {HTMLButtonElement} */ (element("save")).disabled = true;
  try {
    const response = await request(`/api/sessions/${state.id}/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(saveRequestOf(edited)),
    });
    if (draft !== edited || watching?.state.id !== state.id) return false;
    if (response.ok) {
      watching.state = /** @type {NotebookSessionState} */ (await response.json());
      stopEditing();
      element("session-status").textContent = "";
      return true;
    }
    const problem = (await response.text()).trim() || `The server answered ${response.status}`;
    if (response.status === 409) {
      // The session holds something newer; the next save is based on that,
      // so saving again is a choice to write over it, made knowingly.
      const now = await request(`/api/sessions/${state.id}`);
      if (now.ok && draft === edited) {
        watching.state = /** @type {NotebookSessionState} */ (await now.json());
        edited.base = watching.state.revision;
      }
      status.textContent = `${problem}\nSave again to write over it, or cancel to see what it holds now.`;
    } else status.textContent = problem;
    return false;
  } catch (cause) {
    status.textContent = `Could not save: ${describe(cause)}`;
    return false;
  } finally {
    edited.saving = false;
    /** @type {HTMLButtonElement} */ (element("save")).disabled = false;
  }
}

/**
 * Saves the draft, then runs the Cell it names. What was typed is what runs,
 * and the Cell is shown with its output once the editing is over.
 * @param {DraftCell} cell
 */
async function runDraftCell(cell) {
  if (draft === undefined || draft.saving || watching?.state.running) return;
  const id = cell.id.trim();
  if (id === "") {
    element("editor-status").textContent = "Give this cell an id before running it.";
    return;
  }
  if (await saveDraft()) await startRun([id]);
}

/**
 * The filename a download was offered under, read off Content-Disposition —
 * `filename*` when it is there, else `filename`. Nothing when the header names
 * none, which is the caller's to fill in.
 * @param {Response} response
 */
function filenameOf(response) {
  const header = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(header);
  if (encoded?.[1] !== undefined) return decodeURIComponent(encoded[1]);
  const quoted = /filename="([^"]+)"/.exec(header);
  return quoted?.[1];
}

/**
 * Downloads the Export of the Notebook and its latest finished Run, the same
 * document `octo export` writes. A Notebook that has never been run has
 * nothing to export, and the server says so.
 */
async function exportRun() {
  if (watching === undefined) return;
  const { id } = watching.state;
  const status = element("session-status");
  try {
    const response = await request(`/api/sessions/${encodeURIComponent(id)}/export`);
    if (!response.ok) {
      throw new Error((await response.text()).trim() || `The server answered ${response.status}`);
    }
    const href = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = href;
    link.download = filenameOf(response) ?? "notebook.html";
    document.body.append(link);
    link.click();
    link.remove();
    // Not at once: some browsers are still reading the blob when `click` returns.
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
    status.textContent = "";
  } catch (cause) {
    status.textContent = `Could not export: ${describe(cause)}`;
  }
}

/** Copies the Notebook under a name the author gives, and opens the copy. */
async function duplicate() {
  if (watching === undefined) return;
  const { notebook } = watching.state;
  const suggested = notebook.replace(/(\.md)?$/, "-copy.md");
  const to = window.prompt("Save a copy of this notebook as:", suggested);
  if (to === null || to.trim() === "") return;
  try {
    const made = /** @type {NotebookEntry} */ (
      await (await post("/api/notebooks", { from: notebook, to: to.trim() })).json()
    );
    location.hash = hashFor(made.path, "author");
  } catch (cause) {
    element("session-status").textContent = `Could not duplicate: ${describe(cause)}`;
  }
}

/*
 * The Run View: the Notebook for whoever is handed it and not its prompts.
 * The Inputs are a form and the Cells are a list of names with how each is
 * getting on; what a Cell says and leaves is shown under its name, and a Run
 * that could not start or did not finish is explained in plain words that say
 * whether to try again or to ask somebody.
 *
 * The values typed here reach a Cell's body as they are typed, a Bash Cell's
 * command included. That is not a boundary being crossed: there is one account
 * (ADR-0006), the Run View is opened with the same credential the Author View
 * is, and whoever is at this form could edit the Cells with a click. The form
 * is for people who do not write prompts, not for people who may not.
 */

/**
 * The declared Inputs the form on the page was drawn for, and for which
 * session. The form is drawn again only when they change: everything else on
 * the page is redrawn as events arrive, and a redraw would empty the fields
 * while somebody is typing into them.
 * @type {string | undefined}
 */
let formDrawnFor;

/**
 * One Input as a field: a text field for a string, a number field for a
 * number, a choice of yes or no for a boolean; the default filled in where
 * there is one, and the field required where there is not, or where an empty
 * field could not be read as the Input's type.
 * @param {InputView} input
 */
function renderInputField(input) {
  const wrapper = make("label", `run-input ${input.type}`);
  wrapper.append(make("span", "run-input-name", input.name));
  if (input.description !== undefined) {
    wrapper.append(make("span", "run-input-description", input.description));
  }

  /** @type {HTMLInputElement | HTMLSelectElement} */
  let field;
  if (input.type === "boolean") {
    const select = document.createElement("select");
    // A blank choice first when there is no default, so that not choosing is
    // not mistaken for choosing whichever came first.
    const choices = [
      ...(input.default === undefined ? [{ value: "", label: "Choose…" }] : []),
      { value: "true", label: "yes" },
      { value: "false", label: "no" },
    ];
    for (const { value, label } of choices) {
      const choice = document.createElement("option");
      choice.value = value;
      choice.textContent = label;
      choice.selected = input.default !== undefined && value === String(input.default);
      select.append(choice);
    }
    field = select;
  } else {
    const typed = document.createElement("input");
    typed.type = input.type === "number" ? "number" : "text";
    if (input.type === "number") typed.step = "any";
    if (input.default !== undefined) typed.value = String(input.default);
    field = typed;
  }
  field.name = input.name;
  // Nothing typed is a string, and is not a number or a yes or no.
  field.required = input.default === undefined || input.type !== "string";
  wrapper.append(field);
  return wrapper;
}

/**
 * Draws the form for the Inputs the Notebook declares, when it is not already
 * drawn for them.
 * @param {NotebookSessionState} state
 */
function renderRunForm(state) {
  const declared = `${state.id}\n${JSON.stringify(state.inputs)}`;
  if (formDrawnFor === declared) return;
  formDrawnFor = declared;
  element("run-inputs").replaceChildren(
    ...(state.inputs.length === 0
      ? [make("p", "run-no-inputs", "This notebook needs nothing filled in.")]
      : state.inputs.map(renderInputField)),
  );
}

/** The values in the form, each as typed, by the Input's name. */
function valuesTyped() {
  /** @type {Record<string, string>} */
  const values = {};
  for (const field of Array.from(/** @type {HTMLFormElement} */ (element("run-form")).elements)) {
    if (
      (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) &&
      field.name !== ""
    ) {
      values[field.name] = field.value;
    }
  }
  return values;
}

/** What each state of a Cell is called where nobody is reading the Cells. */
/** @type {Record<CellState, string>} */
const STATE_WORDS = {
  idle: "not run yet",
  running: "running…",
  ok: "done",
  error: "failed",
  timeout: "took too long",
  interrupted: "stopped",
  stale: "needs running again",
};

/**
 * One Cell as the Run View shows it: its name and how it is getting on, what
 * it has said, and the files it left. Its body, and what the agent invoked
 * to do it, are what this view is for hiding.
 * @param {CellView} cell
 * @param {string} session
 */
function renderStep(cell, session) {
  const item = make("li", `run-step ${cell.status}`);
  item.dataset.cell = cell.id;
  const heading = make("div", "run-step-header");
  heading.append(
    make("span", "run-step-name", cell.id),
    make("span", "run-step-state", STATE_WORDS[cell.status]),
  );
  const output = make("div", "run-step-output streamed");
  fillOutput(output, cell.text);
  item.append(heading, output);
  if (cell.artifacts.length > 0 && cell.run !== undefined) {
    const run = cell.run;
    const artifacts = make("ul", "artifacts");
    artifacts.append(...cell.artifacts.map((path) => renderArtifact(session, run, path)));
    item.append(artifacts);
  }
  return item;
}

/**
 * What the Run View says of a Run that is over or never began: what happened,
 * in a sentence; the details as the server gave them, for passing on; and
 * what to do — try again, or ask somebody, since one of those is always the
 * answer and the difference is the one thing the reader needs to know.
 * A Run somebody stopped has its own tone, as an Interrupted Cell has its own
 * colour: nothing about it wants putting right.
 * @typedef {{
 *   tone: "done" | "failed" | "stopped",
 *   heading: string,
 *   details: string[],
 *   advice: string,
 * }} Outcome
 */

const ASK_WHO_SET_UP = "ask whoever set this notebook up on this computer.";
const ASK_WHO_WROTE = "ask whoever wrote this notebook";
const PASS_ON = "and pass on what it says here.";

/**
 * Why nothing ran, by what the runner said was wrong. The values are the
 * reader's own to put right; everything else is somebody else's, and running
 * again will not change it.
 * @type {Record<RefusalKind, { heading: string, advice: string }>}
 */
const REFUSALS = {
  inputs: {
    heading: "The run could not start because of the values given.",
    advice: "Correct them and press Run again.",
  },
  environment: {
    heading: "This computer is missing something the notebook needs, so nothing was run.",
    advice: `Running again will not help until it is installed: ${ASK_WHO_SET_UP}`,
  },
  workspace: {
    heading: "The folder this notebook works on is not on this computer, so nothing was run.",
    advice: `Running again will not help: ${ASK_WHO_SET_UP}`,
  },
  notebook: {
    heading: "The notebook itself could not be read, so nothing was run.",
    advice: `Running again will not help: ${ASK_WHO_WROTE} to look at it.`,
  },
  agent: {
    heading: "The agent could not be started, so nothing was run.",
    advice: `Try once more. If it fails again, ${ASK_WHO_SET_UP}`,
  },
  cells: {
    heading: "The run asked for a part of the notebook that is not there, so nothing was run.",
    advice: `Running again will not help: ${ASK_WHO_WROTE} to look at it.`,
  },
};

/**
 * @param {{ error: string, refusal?: Refusal }} refused
 * @returns {Outcome}
 */
function refusalOutcome(refused) {
  if (refused.refusal === undefined) {
    return {
      tone: "failed",
      heading: "Something went wrong before the run could start.",
      details: [refused.error],
      advice: `Try once more. If it fails again, ask for help ${PASS_ON}`,
    };
  }
  const { kind, problems } = refused.refusal;
  return { tone: "failed", ...REFUSALS[kind], details: problems };
}

/**
 * Why the Run stopped, from the Cells that did not succeed: the first says
 * what happened, since the Run halts at the first, and every one is listed.
 * @param {CellView[]} failed
 * @returns {Outcome}
 */
function failureOutcome(failed) {
  const [first] = failed;
  const details = failed.map((cell) => `${cell.id}: ${cell.error ?? STATE_WORDS[cell.status]}`);
  if (first === undefined) throw new Error("No cell failed");
  const name = `"${first.id}"`;
  switch (first.status) {
    case "timeout":
      return {
        tone: "failed",
        heading: `${name} took longer than the notebook allows, so the run stopped there.`,
        details,
        advice: `Try running it again. If it happens again, ${ASK_WHO_WROTE}.`,
      };
    case "interrupted":
      return {
        tone: "stopped",
        heading: `The run was stopped at ${name} before it finished.`,
        details,
        advice: "Press Run to start it again when you are ready.",
      };
    default:
      // A command does the same thing each time it is run, so failing twice the
      // same way is the notebook's to fix; a turn with the model fails for
      // reasons that pass, and a second try is worth making first.
      return first.type === "bash"
        ? {
            tone: "failed",
            heading: `${name} failed, so the run stopped there.`,
            details,
            advice: `Try once more. If it fails the same way, running again will not fix it: ${ASK_WHO_WROTE} ${PASS_ON}`,
          }
        : {
            tone: "failed",
            heading: `The agent could not finish ${name}, so the run stopped there.`,
            details,
            advice: `This is often a passing problem reaching the model. Try again in a minute; if it keeps failing, ask for help ${PASS_ON}`,
          };
  }
}

/**
 * What to say of the Notebook as it stands: nothing while it runs, or before
 * anything has; why it did not run, or where it stopped; or that it finished.
 * @param {NotebookSessionState} state
 * @param {{ error: string, refusal?: Refusal } | undefined} refused
 * @returns {Outcome | undefined}
 */
function outcomeOf(state, refused) {
  if (state.running) return undefined;
  if (refused !== undefined) return refusalOutcome(refused);
  const failed = state.cells.filter(
    (cell) => cell.status === "error" || cell.status === "timeout" || cell.status === "interrupted",
  );
  if (failed.length > 0) return failureOutcome(failed);
  if (state.cells.length > 0 && state.cells.every((cell) => cell.status === "ok")) {
    return {
      tone: "done",
      heading: "Finished.",
      details: [],
      advice: "Everything ran; what it produced is below.",
    };
  }
  return undefined;
}

/**
 * How far the Run has got, while it runs: the Cells done of those there are,
 * counted against the Run in progress once it has named itself.
 * @param {NotebookSessionState} state
 * @param {string | undefined} run
 */
function progressOf(state, run) {
  if (!state.running) return "";
  if (run === undefined) return "Starting…";
  const done = state.cells.filter((cell) => cell.run === run && cell.status !== "running").length;
  return `Running… ${done} of ${state.cells.length} done`;
}

/** Empties the Run View, for a Notebook that could not be opened to be shown with nothing of the last one's. */
function clearRunView() {
  formDrawnFor = undefined;
  element("run-inputs").replaceChildren();
  element("run-steps").replaceChildren();
  element("run-outcome").hidden = true;
  element("run-progress").textContent = "";
}

/** @param {NotebookSessionState} state */
function renderRunView(state) {
  if (watching === undefined) return;
  renderRunForm(state);
  /** @type {HTMLButtonElement} */ (element("run-start")).disabled = state.running;
  element("run-stop").hidden = !state.running;
  element("run-progress").textContent = progressOf(state, watching.run);

  const panel = element("run-outcome");
  const outcome = outcomeOf(state, watching.refused);
  panel.hidden = outcome === undefined;
  panel.replaceChildren();
  if (outcome !== undefined) {
    panel.className = `run-outcome ${outcome.tone}`;
    panel.append(make("p", "run-outcome-heading", outcome.heading));
    if (outcome.details.length > 0) {
      panel.append(make("pre", "run-outcome-details", outcome.details.join("\n")));
    }
    panel.append(make("p", "run-outcome-advice", outcome.advice));
  }

  element("run-steps").replaceChildren(...state.cells.map((cell) => renderStep(cell, state.id)));
}

/**
 * The Notebook the URL most recently asked for. Opening one takes a round trip,
 * and the URL may have moved on by the time it is back; the answer to an
 * earlier request is then dropped rather than shown over the later one.
 */
let asked = "";

/** @param {string} notebook */
async function showSession(notebook) {
  const editing = editOnOpen === notebook && view === "author";
  editOnOpen = undefined;
  draft = undefined;
  element("draft").replaceChildren();
  element("editor").hidden = true;
  element("segments").hidden = view !== "author";
  element("add-cells").hidden = view !== "author";
  element("author-controls").hidden = view !== "author";
  element("run-controls").hidden = view === "author";
  // Drawn once the Notebook is open; a Run button with no form yet says nothing.
  element("run-view").hidden = true;
  element("list").hidden = true;
  element("session").hidden = false;
  const status = element("session-status");
  // The same Notebook shown the other way: the session is the one being
  // watched, and only the page changes.
  if (watching?.state.notebook === notebook) {
    status.textContent = "";
    renderSession();
    return;
  }
  watching?.socket.close();
  watching = undefined;
  status.textContent = `Opening ${notebook}…`;

  /** @type {NotebookSessionState} */
  let state;
  try {
    state = await (await post("/api/sessions", { notebook })).json();
  } catch (cause) {
    if (asked !== notebook) return;
    element("title").textContent = notebook;
    element("notebook").textContent = "";
    element("segments").replaceChildren();
    element("add-cells").hidden = true;
    clearRunView();
    status.textContent = `Could not open the notebook: ${describe(cause)}`;
    return;
  }
  if (asked !== notebook) return;

  watching = { state, socket: connect(state.id), sequence: state.sequence };
  status.textContent = "";
  renderSession();
  if (editing) {
    beginEditing();
    focusSegment(0);
  }
}

/**
 * Opens the socket a session's events arrive on: fresh, to be told the state
 * as it stands; or, given `since`, to be told everything after that event,
 * which is how the page catches up after a connection was lost.
 * @param {string} id
 * @param {number} [since]
 */
function connect(id, since) {
  const url = new URL(`/api/sessions/${id}/events`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (since !== undefined) url.searchParams.set("since", String(since));
  const socket = new WebSocket(url);
  let opened = false;

  socket.addEventListener("open", () => (opened = true));
  socket.addEventListener("message", (message) => {
    if (watching?.socket !== socket) return;
    apply(/** @type {NotebookSessionEvent} */ (JSON.parse(String(message.data))));
  });
  socket.addEventListener("close", () => {
    if (watching?.socket !== socket) return;
    element("session-status").textContent = "Lost the connection to the server. Reconnecting…";
    // A socket that never opened is a server that answers requests but not
    // sockets — a proxy in the way, say — and is not to be asked every second.
    void reconnect(socket, opened ? RECONNECT_AFTER : RECONNECT_AT_MOST);
  });
  return socket;
}

/** How long to wait before the first try at reconnecting, and the longest. */
const RECONNECT_AFTER = 1000;
const RECONNECT_AT_MOST = 10_000;

/**
 * Gets the session's events back after `lost` dropped, trying until the
 * server answers: a server being restarted is back in seconds, so the wait
 * begins short, and grows so that one that is down for longer is not
 * hammered. The session is asked for by the Notebook's path, as on opening,
 * which is answered with the same session when the server kept it — as one
 * restarted does — and the page then asks for everything since the last
 * event it heard; a different session is one the page has to draw afresh.
 * @param {WebSocket} lost
 * @param {number} wait how long to wait before the first try
 */
async function reconnect(lost, wait) {
  for (;;) {
    await new Promise((tick) => setTimeout(tick, wait));
    // Moved on meanwhile — another Notebook opened, or the list shown.
    if (watching?.socket !== lost) return;
    const { notebook } = watching.state;

    /** @type {Response} */
    let response;
    try {
      // A server restarted may no longer know this browser's Connection, in
      // which case this waits on the connect panel before it asks again.
      response = await request("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notebook }),
      });
    } catch {
      wait = Math.min(wait * 2, RECONNECT_AT_MOST);
      continue; // The server is not answering yet.
    }
    if (watching?.socket !== lost) return;
    if (!response.ok) {
      // Answering, and saying no: the Notebook is gone, or no longer opens.
      const problem = (await response.text()).trim() || `The server answered ${response.status}`;
      element("session-status").textContent = `Could not reopen the notebook: ${problem}`;
      return;
    }

    const state = /** @type {NotebookSessionState} */ (await response.json());
    if (watching?.socket !== lost) return;
    if (state.id === watching.state.id) {
      watching.socket = connect(state.id, watching.sequence);
    } else {
      watching = { state, socket: connect(state.id), sequence: state.sequence };
      renderSession();
    }
    element("session-status").textContent = "";
    return;
  }
}

function route() {
  const hash = location.hash.slice(1);
  view = hash.startsWith(RUN_VIEW_PREFIX) ? "run" : "author";
  asked = decodeURIComponent(view === "run" ? hash.slice(RUN_VIEW_PREFIX.length) : hash);
  if (asked === "") {
    watching?.socket.close();
    watching = undefined;
    void showList();
  } else {
    void refreshTree();
    void showSession(asked);
  }
}

/**
 * Pi's model settings, in a dialog: the default a Run uses when nothing names
 * a model, and the custom providers in pi's `models.json`.
 * @typedef {{ provider: string, id: string, name: string }} ModelChoice
 * @typedef {{ id: string }} CustomModel
 * @typedef {{
 *   id: string,
 *   baseUrl: string,
 *   api: string,
 *   apiKeySet: boolean,
 *   apiKeyFromCommand: boolean,
 *   apiKey?: string,
 *   models: CustomModel[],
 * }} CustomProvider
 * @typedef {{
 *   defaultProvider?: string,
 *   defaultModel?: string,
 *   defaultThinking?: string,
 *   thinkingLevels: string[],
 *   apis: string[],
 *   models: ModelChoice[],
 *   keyed: string[],
 *   providers: CustomProvider[],
 * }} ModelPage
 */

/** The providers being edited, including ones added and not yet saved. */
/** @type {CustomProvider[]} */
let providerDraft = [];

/** @type {ModelPage | undefined} */
let modelPage;

/** The model the dialog will save, once one has been picked. */
/** @type {{ provider: string, id: string } | undefined} */
let chosenModel;

/**
 * When set, the list is only models the user can already call: a provider
 * with a stored API key, or a custom provider they added.
 */
let configuredOnly = false;

/** @param {ModelChoice} model @param {string} needle */
function rank(model, needle) {
  if (needle === "") return 0;
  const label = `${model.provider}/${model.id}`.toLowerCase();
  if (label.startsWith(needle)) return 0;
  if (model.id.toLowerCase().startsWith(needle)) return 1;
  if (model.provider.toLowerCase().startsWith(needle)) return 2;
  return 3;
}

/** @param {ModelChoice} model */
const modelLabel = (model) =>
  model.name !== model.id
    ? `${model.provider}/${model.id} — ${model.name}`
    : `${model.provider}/${model.id}`;

function chosenText() {
  const chosen = element("models-chosen");
  if (chosenModel === undefined) {
    chosen.textContent = "No model chosen yet. Search, then pick one.";
    return;
  }
  const keyed = modelPage?.keyed?.includes(chosenModel.provider) === true;
  chosen.textContent = `${chosenModel.provider}/${chosenModel.id}${keyed ? " · a key is stored" : " · no key stored"}`;
}

/** Providers the user has a key for, plus custom providers they added. */
function configuredProviderIds() {
  const ids = new Set(modelPage?.keyed ?? []);
  for (const provider of modelPage?.providers ?? []) {
    if (provider.id !== "") ids.add(provider.id);
  }
  return ids;
}

function syncConfiguredButton() {
  const button = /** @type {HTMLButtonElement} */ (element("models-configured"));
  button.setAttribute("aria-pressed", configuredOnly ? "true" : "false");
  button.textContent = configuredOnly ? "Show all" : "Show configured";
}

/** @param {string} query */
function renderMatches(query) {
  const list = element("models-matches");
  const needle = query.trim().toLowerCase();
  const allowed = configuredOnly ? configuredProviderIds() : undefined;
  const models = (modelPage?.models ?? [])
    .filter((model) => allowed === undefined || allowed.has(model.provider))
    .filter((model) => needle === "" || modelLabel(model).toLowerCase().includes(needle))
    .sort((a, b) => rank(a, needle) - rank(b, needle));
  list.replaceChildren(
    ...models.map((model) => {
      const item = document.createElement("li");
      const button = make("button", "", modelLabel(model));
      button.type = "button";
      const current = chosenModel?.provider === model.provider && chosenModel.id === model.id;
      if (current) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => {
        chosenModel = { provider: model.provider, id: model.id };
        const key = /** @type {HTMLInputElement} */ (element("models-key"));
        key.value = "";
        key.placeholder =
          modelPage?.keyed?.includes(model.provider) === true
            ? "Leave blank to keep the stored key"
            : "Paste an API key";
        chosenText();
        renderMatches(/** @type {HTMLInputElement} */ (element("models-search")).value);
      });
      item.append(button);
      return item;
    }),
  );
  if (models.length === 0) {
    list.append(
      make(
        "li",
        "models-none",
        configuredOnly
          ? needle === ""
            ? "No model with a stored key or a custom provider."
            : "No matching configured model."
          : "No matching model.",
      ),
    );
  }
}

/** @param {ModelPage} page */
function renderModelPage(page) {
  modelPage = page;
  providerDraft = page.providers.map((provider) => ({ ...provider, models: [...provider.models] }));
  if (page.defaultProvider !== undefined && page.defaultModel !== undefined) {
    chosenModel = { provider: page.defaultProvider, id: page.defaultModel };
  }
  chosenText();
  const key = /** @type {HTMLInputElement} */ (element("models-key"));
  key.value = "";
  key.placeholder =
    chosenModel !== undefined && page.keyed?.includes(chosenModel.provider) === true
      ? "Leave blank to keep the stored key"
      : "Paste an API key";
  /** @type {HTMLInputElement} */ (element("models-search")).value = "";

  const thinking = /** @type {HTMLSelectElement} */ (element("models-thinking"));
  thinking.replaceChildren(
    ...page.thinkingLevels.map((level) => {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      option.selected = level === page.defaultThinking;
      return option;
    }),
  );
  renderMatches("");
  syncConfiguredButton();
  renderProviders();
}

function renderProviders() {
  const list = element("models-providers");
  const apis = modelPage?.apis ?? [];
  list.replaceChildren(
    ...providerDraft.map((provider, at) => {
      const card = make("div", "provider");
      const name = document.createElement("input");
      name.type = "text";
      name.value = provider.id;
      name.placeholder = "ollama";
      name.addEventListener("input", () => (provider.id = name.value.trim()));

      const baseUrl = document.createElement("input");
      baseUrl.type = "text";
      baseUrl.value = provider.baseUrl;
      baseUrl.placeholder = "http://localhost:11434/v1";
      baseUrl.addEventListener("input", () => (provider.baseUrl = baseUrl.value.trim()));

      const api = document.createElement("select");
      for (const choice of apis) {
        const option = document.createElement("option");
        option.value = choice;
        option.textContent = choice;
        option.selected = provider.api === choice;
        api.append(option);
      }
      if (provider.api === "" && apis[0] !== undefined) provider.api = apis[0];
      api.addEventListener("change", () => (provider.api = api.value));

      const key = document.createElement("input");
      key.type = "password";
      key.autocomplete = "off";
      key.placeholder = provider.apiKeyFromCommand
        ? "A command supplies the current key; type a key to replace it"
        : provider.apiKeySet
          ? "Leave blank to keep the current key"
          : "API key, or $ENV_VAR";
      key.addEventListener("input", () => {
        provider.apiKey = key.value;
      });

      const models = document.createElement("textarea");
      models.value = provider.models.map((model) => model.id).join("\n");
      models.placeholder = "One model id per line";
      models.addEventListener("input", () => {
        provider.models = models.value
          .split("\n")
          .map((id) => id.trim())
          .filter((id) => id !== "")
          .map((id) => ({ id }));
      });

      const remove = make("button", "", "Remove");
      remove.type = "button";
      remove.addEventListener("click", () => {
        providerDraft.splice(at, 1);
        renderProviders();
      });

      const nameLabel = document.createElement("label");
      nameLabel.append("Name", name);
      const urlLabel = document.createElement("label");
      urlLabel.append("Base URL", baseUrl);
      const apiLabel = document.createElement("label");
      apiLabel.append("API", api);
      const keyLabel = document.createElement("label");
      keyLabel.append("API key", key);
      const modelsLabel = document.createElement("label");
      modelsLabel.append("Model ids", models);
      const actions = make("div", "provider-actions");
      actions.append(remove);
      card.append(nameLabel, urlLabel, apiLabel, keyLabel, modelsLabel, actions);
      return card;
    }),
  );
}

/** The notebook the model dialog is choosing for, and the model it names now. */
let modelTarget = "";
/** @type {string | undefined} */
let modelCurrent;
/** The model page the dialog last loaded, so a search filters that and not the Models tab. */
/** @type {ModelPage | undefined} */
let notebookModels;

/**
 * Models the user can already call: a provider with a stored key, or a custom
 * provider they added.
 * @param {ModelPage} page
 * @returns {ModelChoice[]}
 */
function configuredModelsOf(page) {
  const ids = new Set(page.keyed ?? []);
  for (const provider of page.providers ?? []) {
    if (provider.id !== "") ids.add(provider.id);
  }
  return page.models.filter((model) => ids.has(model.provider));
}

/**
 * Opens the list of configured models for `notebook`. `current` is the one it
 * names now, when it names one.
 * @param {string} notebook
 * @param {string} [current]
 */
async function openNotebookModel(notebook, current) {
  modelTarget = notebook;
  modelCurrent = current;
  const dialog = /** @type {HTMLDialogElement} */ (element("notebook-model-dialog"));
  element("notebook-model-title").textContent = notebook;
  const status = element("notebook-model-status");
  status.textContent = "Loading…";
  element("notebook-model-list").replaceChildren();
  /** @type {HTMLInputElement} */ (element("notebook-model-search")).value = "";
  if (!dialog.open) dialog.showModal();
  try {
    notebookModels = await fetchModels();
    renderNotebookModelChoices(
      configuredModelsOf(notebookModels),
      /** @type {HTMLInputElement} */ (element("notebook-model-search")).value,
    );
    status.textContent = "";
    /** @type {HTMLInputElement} */ (element("notebook-model-search")).focus();
  } catch (cause) {
    status.textContent = `Could not load the models: ${describe(cause)}`;
  }
}

/**
 * @param {ModelChoice[]} models
 * @param {string} query
 */
function renderNotebookModelChoices(models, query) {
  const list = element("notebook-model-list");
  const needle = query.trim().toLowerCase();
  const matched = models
    .filter((model) => needle === "" || modelLabel(model).toLowerCase().includes(needle))
    .sort((a, b) => rank(a, needle) - rank(b, needle));

  const clear = make("button", "", "Use the default");
  clear.type = "button";
  if (modelCurrent === undefined) clear.setAttribute("aria-current", "true");
  clear.addEventListener("click", () => void chooseNotebookModel(""));
  const none = document.createElement("li");
  none.append(clear);

  list.replaceChildren(
    none,
    ...matched.map((model) => {
      const item = document.createElement("li");
      const named = `${model.provider}/${model.id}`;
      const button = make("button", "", modelLabel(model));
      button.type = "button";
      if (named === modelCurrent) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => void chooseNotebookModel(named));
      item.append(button);
      return item;
    }),
  );
  if (matched.length === 0) {
    list.append(
      make(
        "li",
        "models-none",
        needle === ""
          ? "No model with a stored key or a custom provider."
          : "No matching configured model.",
      ),
    );
  }
}

/** @param {string} model an empty string clears the notebook's model */
async function chooseNotebookModel(model) {
  const notebook = modelTarget;
  const wanted = model === "" ? undefined : model;
  const dialog = /** @type {HTMLDialogElement} */ (element("notebook-model-dialog"));
  if (wanted === modelCurrent) {
    dialog.close();
    return;
  }
  const status = element("notebook-model-status");
  status.textContent = "";
  try {
    const entry = /** @type {NotebookEntry} */ (
      await (await post("/api/notebooks/model", { notebook, model })).json()
    );
    dialog.close();
    if (watching?.state.notebook === entry.path) {
      if (entry.model !== undefined) watching.state.model = entry.model;
      else delete watching.state.model;
      renderSession();
    }
    if (!element("list").hidden) await showList();
    else await refreshTree();
  } catch (cause) {
    status.textContent = `Could not set the model: ${describe(cause)}`;
  }
}

/** @returns {Promise<ModelPage>} */
async function fetchModels() {
  const response = await request("/api/models");
  if (!response.ok) {
    throw new Error((await response.text()).trim() || `The server answered ${response.status}`);
  }
  return response.json();
}

async function openModels() {
  configuredOnly = false;
  element("workspace").hidden = true;
  element("models").hidden = false;
  element("tab-notebook").removeAttribute("aria-current");
  element("tab-models").setAttribute("aria-current", "page");
  const status = element("models-status");
  status.textContent = "Loading…";
  try {
    renderModelPage(await fetchModels());
    status.textContent = "";
    /** @type {HTMLInputElement} */ (element("models-search")).focus();
  } catch (cause) {
    status.textContent = `Could not load the models: ${describe(cause)}`;
  }
}

function closeModels() {
  element("models").hidden = true;
  element("workspace").hidden = false;
  element("tab-models").removeAttribute("aria-current");
  element("tab-notebook").setAttribute("aria-current", "page");
}

async function saveModelDefault() {
  const status = element("models-status");
  if (chosenModel === undefined) {
    status.textContent = "Search for a model and pick one before saving.";
    return;
  }
  const { provider, id } = chosenModel;
  const thinking = /** @type {HTMLSelectElement} */ (element("models-thinking")).value;
  const apiKey = /** @type {HTMLInputElement} */ (element("models-key")).value.trim();
  status.textContent = "";
  try {
    await post("/api/models/default", {
      provider,
      model: id,
      ...(thinking === "" ? {} : { thinking }),
    });
    if (apiKey !== "") await post("/api/models/key", { provider, apiKey });
    renderModelPage(await fetchModels());
    status.textContent = apiKey === "" ? "Saved the default." : "Saved the default and the key.";
  } catch (cause) {
    status.textContent = `Could not save: ${describe(cause)}`;
  }
}

async function saveModelProviders() {
  const status = element("models-status");
  status.textContent = "";
  try {
    await post("/api/models/providers", {
      providers: providerDraft
        .filter(
          (provider) =>
            provider.id.trim() !== "" ||
            provider.baseUrl.trim() !== "" ||
            provider.models.length > 0,
        )
        .map((provider) => ({
          id: provider.id.trim(),
          baseUrl: provider.baseUrl.trim(),
          api: provider.api,
          models: provider.models.map((model) => model.id),
          ...(provider.apiKey !== undefined && provider.apiKey !== ""
            ? { apiKey: provider.apiKey }
            : {}),
        })),
    });
    status.textContent = "Saved the providers.";
    renderModelPage(await fetchModels());
  } catch (cause) {
    status.textContent = `Could not save the providers: ${describe(cause)}`;
  }
}

function addProvider() {
  const api = modelPage?.apis[0] ?? "openai-completions";
  providerDraft.push({
    id: "",
    baseUrl: "",
    api,
    apiKeySet: false,
    apiKeyFromCommand: false,
    models: [],
  });
  renderProviders();
}

element("tab-notebook").addEventListener("click", closeModels);
element("tab-models").addEventListener("click", () => void openModels());
element("models-close").addEventListener("click", closeModels);
element("notebook-model").addEventListener("click", () => {
  if (watching === undefined) return;
  void openNotebookModel(watching.state.notebook, watching.state.model);
});
element("notebook-model-cancel").addEventListener("click", () => {
  /** @type {HTMLDialogElement} */ (element("notebook-model-dialog")).close();
});
element("notebook-model-search").addEventListener("input", () => {
  if (notebookModels === undefined) return;
  renderNotebookModelChoices(
    configuredModelsOf(notebookModels),
    /** @type {HTMLInputElement} */ (element("notebook-model-search")).value,
  );
});
element("models-search").addEventListener("input", () => {
  renderMatches(/** @type {HTMLInputElement} */ (element("models-search")).value);
});
element("models-configured").addEventListener("click", () => {
  configuredOnly = !configuredOnly;
  syncConfiguredButton();
  renderMatches(/** @type {HTMLInputElement} */ (element("models-search")).value);
});
element("models-save-default").addEventListener("click", () => void saveModelDefault());
element("models-save-providers").addEventListener("click", () => void saveModelProviders());
element("models-add").addEventListener("click", addProvider);
element("models-form").addEventListener("submit", (event) => event.preventDefault());

element("format-plain").addEventListener("click", () => setOutputFormat("plain"));
element("format-markdown").addEventListener("click", () => setOutputFormat("markdown"));
syncFormatButtons();
element("run-all").addEventListener("click", () => void startRun());
element("interrupt").addEventListener("click", () => void interrupt());
element("run-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void startRun(undefined, valuesTyped());
});
element("run-stop").addEventListener("click", () => void interrupt());
element("edit").addEventListener("click", beginEditing);
element("duplicate").addEventListener("click", () => void duplicate());
element("rename").addEventListener("click", () => void renameNotebook());
element("export").addEventListener("click", () => void exportRun());
element("cancel").addEventListener("click", stopEditing);
element("add-prompt").addEventListener("click", () => addCell("prompt"));
element("add-bash").addEventListener("click", () => addCell("bash"));
element("tree-new").addEventListener("click", () => void newNotebook(element("tree-status")));
element("list-new").addEventListener("click", () => void newNotebook(element("status")));
element("editor").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveDraft();
});
window.addEventListener("hashchange", route);
route();
