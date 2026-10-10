// @ts-check
/**
 * The client: lists the Notebooks the server can see, opens one into its
 * Notebook Session, and shows the Session as the Author View — the Notebook as
 * written, each Cell as the Notebook declares it, with what running it has
 * produced: its text as it is spoken, shown as plain text or as Markdown,
 * each tool the agent invokes as it
 * invokes it, and the files it left — and a way to run one Cell or all of
 * them, or to stop. A Bash Cell that is still running, or that left a service
 * running, has Stop on it, which ends that service. A prompt cell, a bash
 * cell, or a block of prose starts collapsed, and can be expanded on its own
 * or all at once; the choice stays
 * while this notebook is open, and a saved edit keeps it. While editing, the
 * whole Notebook is a form —
 * frontmatter, Prose and Cells, to be changed, added, removed and reordered —
 * saved whole, based on the revision it was drawn from. Typing / in a Prompt
 * Cell lists the Skills installed for the user and for that Notebook's
 * Workspace; choosing one writes `/skill:name` and runs the Cell.
 *
 * Beside whichever is shown, the served directory is drawn as a tree of its
 * folders and the Notebooks in them, the one open marked, with a way to make
 * a new Notebook. A small arrow between the columns folds that column away
 * and brings it back; the choice stays in this browser. A text or source file in that
 * tree — plain text, Markdown
 * that is not a Notebook, data such as CSV or JSON, or code such as Python,
 * JavaScript, TypeScript, or Java — opens in a subtab of
 * the Notebook. A Run that creates or changes one of those files leaves it
 * under review: Accept keeps the new text, and Reject puts back what was
 * there, or removes a file that was new. A text file that is not a Notebook
 * is renamed from its own page, in the folder it is already in. The list of Notebooks, and an open one, choose the mode it
 * runs in and the model it runs on; and under an open Notebook are the ways to add a Prompt
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
 * @typedef {{ path: string, title: string, model?: string, mode?: string }} NotebookEntry
 * @typedef {{
 *   name: string,
 *   prompt?: string,
 *   model?: string,
 *   tools?: string[],
 *   skills?: string[],
 *   problems?: string[],
 * }} EditableMode
 * @typedef {{ modes: string[], own?: EditableMode[] }} ModeList
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
 *   service?: boolean,
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
 *   mode?: string,
 *   revision: string,
 *   frontmatter?: string,
 *   inputs: InputView[],
 *   segments: SegmentView[],
 *   running: boolean,
 *   sequence: number,
 *   cells: CellView[],
 *   reviews?: TextReview[],
 * }} NotebookSessionState
 * @typedef {{ path: string, kind: "created" | "modified", before?: string }} TextReview
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
 *   servicePids?: number[],
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
 *   | { type: "text-changed", reviews: TextReview[] }
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
  item.append(link, modeControl(entry.path, entry.mode), modelButton(entry.path, entry.model), run);
  return item;
}

/** The modes a notebook can be set to, once they have been loaded. */
/** @type {string[]} */
let knownModes = [];

/** The user's own modes, once they have been loaded for the Modes page. */
/** @type {EditableMode[]} */
let ownModes = [];

/**
 * @returns {Promise<ModeList>}
 */
async function fetchModes() {
  const response = await request("/api/modes");
  if (!response.ok) {
    throw new Error((await response.text()).trim() || `The server answered ${response.status}`);
  }
  const page = /** @type {ModeList} */ (await response.json());
  knownModes = page.modes;
  ownModes = page.own ?? [];
  return page;
}

/**
 * The menu of modes for one notebook. An empty choice clears the mode, so the
 * notebook runs on pi's defaults.
 * @param {string} notebook
 * @param {string} [mode]
 * @returns {HTMLElement}
 */
function modeControl(notebook, mode) {
  const select = document.createElement("select");
  select.className = "notebook-mode";
  select.setAttribute("aria-label", "Mode");
  fillModeSelect(select, mode);
  select.disabled = draft !== undefined && watching?.state.notebook === notebook;
  select.title = select.disabled
    ? "Save or cancel the draft before choosing a mode."
    : "The mode this notebook runs in. Default uses pi's own settings.";
  select.addEventListener("click", (event) => event.stopPropagation());
  select.addEventListener("change", () => void chooseNotebookMode(notebook, select));
  const label = document.createElement("label");
  label.className = "mode-choice";
  label.append(select);
  return label;
}

/**
 * @param {HTMLSelectElement} select
 * @param {string} [mode]
 */
function fillModeSelect(select, mode) {
  const names = [...knownModes];
  if (mode !== undefined && mode !== "" && !names.includes(mode)) names.push(mode);
  const wanted = ["", ...names];
  const have = [...select.options].map((option) => option.value);
  const same =
    have.length === wanted.length && have.every((value, index) => value === wanted[index]);
  if (!same) {
    select.replaceChildren(
      ...wanted.map((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value === "" ? "Default" : value;
        return option;
      }),
    );
  }
  const chosen = mode ?? "";
  if (select.value !== chosen && document.activeElement !== select) select.value = chosen;
  select.dataset.mode = chosen;
}

/**
 * @param {string} notebook
 * @param {HTMLSelectElement} select
 */
async function chooseNotebookMode(notebook, select) {
  const mode = select.value;
  const previous = select.dataset.mode ?? "";
  if (mode === previous) return;
  const status = notebookStatus(notebook);
  if (draft !== undefined && watching?.state.notebook === notebook) {
    select.value = previous;
    status.textContent = "Save or cancel the draft before choosing a mode.";
    return;
  }
  status.textContent = "";
  try {
    const entry = /** @type {NotebookEntry} */ (
      await (await post("/api/notebooks/mode", { notebook, mode })).json()
    );
    if (watching?.state.notebook === entry.path) {
      if (entry.mode !== undefined) watching.state.mode = entry.mode;
      else delete watching.state.mode;
      renderSession();
    }
    if (!element("list").hidden) await showList();
    else await refreshTree();
  } catch (cause) {
    select.value = previous;
    status.textContent = `Could not set the mode: ${describe(cause)}`;
  }
}

/**
 * Where a problem choosing a mode is said, for the notebook it was chosen on.
 * @param {string} notebook
 */
function notebookStatus(notebook) {
  if (watching?.state.notebook === notebook && !element("session").hidden) {
    return element("session-status");
  }
  if (!element("list").hidden) return element("status");
  return element("tree-status");
}

/**
 * The button that chooses the model this Notebook runs on, from the models
 * the user can already call.
 * @param {string} notebook
 * @param {string} [model]
 */
function modelButton(notebook, model) {
  const button = make("button", "notebook-model", "Model");
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
    let modeProblem = "";
    const [found] = await Promise.all([
      fetchNotebooks(),
      fetchModes().catch((cause) => {
        modeProblem = `Could not list the modes: ${describe(cause)}`;
      }),
    ]);
    element("directory").textContent = found.directory;
    element("notebooks").replaceChildren(...found.notebooks.map(renderEntry));
    status.textContent =
      modeProblem !== ""
        ? modeProblem
        : found.notebooks.length === 0
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
 *   | { name: string, path: string, kind: "notebook", title: string, model?: string, mode?: string }
 *   | { name: string, path: string, kind: "text" }
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
 * What one folder holds: its folders, then its files. A Notebook opens as a
 * Notebook. A text file opens in a subtab. Any other file is only listed.
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
      item.append(link);
      return item;
    }
    if (node.kind === "text") {
      const item = make("li", "tree-text");
      const button = make("button", "tree-open", node.name);
      button.type = "button";
      button.title = node.path;
      if (node.path === openPane) button.setAttribute("aria-current", "page");
      if (reviewsOf().some((review) => review.path === node.path)) button.classList.add("pending");
      button.addEventListener("click", () => openText(node.path));
      item.append(button);
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

/** Whether the directory column is folded away. Kept in this browser. */
const FOLDERS_HIDDEN_KEY = "octo-folders-hidden";

/** @returns {boolean} */
function storedFoldersHidden() {
  try {
    return localStorage.getItem(FOLDERS_HIDDEN_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Shows or hides the directory column. The arrow between the columns stays,
 * pointing at the column it will open or close.
 * @param {boolean} hidden
 */
function applyFoldersHidden(hidden) {
  element("workspace").classList.toggle("folders-hidden", hidden);
  const button = /** @type {HTMLButtonElement} */ (element("sidebar-toggle"));
  button.setAttribute("aria-expanded", hidden ? "false" : "true");
  button.textContent = hidden ? ">" : "<";
  button.title = hidden ? "Show the directory" : "Hide the directory";
  button.setAttribute("aria-label", button.title);
}

/** @param {boolean} hidden */
function setFoldersHidden(hidden) {
  try {
    localStorage.setItem(FOLDERS_HIDDEN_KEY, hidden ? "true" : "false");
  } catch {
    // A browser that refuses storage still switches for this page.
  }
  applyFoldersHidden(hidden);
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
 * The file's new path: the name typed, in the same folder. A name with no
 * extension keeps the old one. A slash is a different folder, which this
 * rename does not do.
 * @param {string} current
 * @param {string} given
 * @returns {string | undefined}
 */
function renameTarget(current, given) {
  if (given.includes("/") || given.includes("\\") || given === "." || given === "..") {
    return undefined;
  }
  const parent = current.includes("/") ? current.slice(0, current.lastIndexOf("/") + 1) : "";
  const old = current.split("/").pop() ?? current;
  let name = given;
  if (!name.includes(".")) {
    const dot = old.lastIndexOf(".");
    if (dot > 0) name = `${name}${old.slice(dot)}`;
  }
  return `${parent}${name}`;
}

/**
 * The open file, and any subtab or review of it, follows a rename.
 * @param {string} from
 * @param {string} to
 */
function followRenamedFile(from, to) {
  const index = textTabs.indexOf(from);
  if (index >= 0) textTabs[index] = to;
  if (fileDrafts.has(from)) {
    const draft = fileDrafts.get(from);
    if (draft !== undefined) fileDrafts.set(to, draft);
    fileDrafts.delete(from);
  }
  if (watching?.state.reviews !== undefined) {
    watching.state.reviews = watching.state.reviews.map((review) =>
      review.path === from ? { ...review, path: to } : review,
    );
  }
  if (openPane !== from) {
    if (watching !== undefined) renderSession();
    else renderSubtabs();
    return;
  }
  openPane = to;
  if (watching === undefined) {
    showHeading(to.split("/").pop() ?? to, to);
    element("file-view").hidden = false;
    renderSubtabs();
    void showFile(to);
    return;
  }
  renderSession();
}

/**
 * Where a rename of `path` reports itself: the file on show, or the tree.
 * @param {string} path
 * @returns {HTMLElement}
 */
function renameStatus(path) {
  if (!element("file-view").hidden && openPane === path) return element("file-status");
  if (!element("session").hidden) return element("session-status");
  return element("tree-status");
}

/**
 * Gives the open file a new name in its own folder. The page follows it.
 * @param {string} from
 */
async function renameOtherFile(from) {
  const fileName = from.split("/").pop() ?? from;
  const given = window.prompt("Rename this file to:", fileName)?.trim();
  if (given === undefined || given === "") return;
  const status = renameStatus(from);
  const to = renameTarget(from, given);
  if (to === undefined) {
    status.textContent = "Type a new file name, without a folder.";
    return;
  }
  if (to === from) return;
  try {
    const made = /** @type {{ path: string }} */ (
      await (await post("/api/files/rename", { from, to })).json()
    );
    followRenamedFile(from, made.path);
    status.textContent = "";
    await refreshTree();
  } catch (cause) {
    status.textContent = `Could not rename: ${describe(cause)}`;
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
  const promoteButton = make("button", "", "Promote");
  promoteButton.type = "button";
  promoteButton.addEventListener("click", () => void promote(chat, promoteButton));
  const deleteButton = make("button", "", "Delete");
  deleteButton.type = "button";
  deleteButton.addEventListener("click", () => void removeChat(chat, deleteButton));
  const actions = make("div", "chat-actions");
  actions.append(promoteButton, deleteButton);
  item.append(about, actions);
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
 * Removes the chat, after the reader confirms: pi's session file, not a
 * notebook already made from it.
 * @param {ChatEntry} chat
 * @param {HTMLButtonElement} button
 */
async function removeChat(chat, button) {
  const name = chat.name ?? chat.firstMessage;
  if (
    !window.confirm(
      `Delete “${name}”? Pi's session file is removed. A notebook already made from it is kept.`,
    )
  ) {
    return;
  }
  button.disabled = true;
  try {
    const response = await request(`/api/chats/${encodeURIComponent(chat.id)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error((await response.text()).trim() || `The server answered ${response.status}`);
    }
    await showChats();
  } catch (cause) {
    element("chats-status").textContent = `Could not delete: ${describe(cause)}`;
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

/** Text files open as subtabs, in the order they were opened. */
/** @type {string[]} */
let textTabs = [];

/** The subtab on show: "notebook", or the path of a text file. */
/** @type {string} */
let openPane = "notebook";

/** Which load of the open text file is current, so a slower answer cannot replace a newer one. */
let fileLoad = 0;

/** The text last drawn for the file on show, before any diff marks. */
let fileSource = "";

/** Unsaved text of files being edited, by path, so changing subtab does not drop it. */
/** @type {Map<string, string>} */
const fileDrafts = new Map();

/** Whether the file editor breaks long lines. Kept while the page is open. */
let fileWrap = false;

/** @type {Record<string, string>} */
const TEXT_LABELS = {
  txt: "Text",
  text: "Text",
  log: "Text",
  md: "Markdown",
  markdown: "Markdown",
  csv: "CSV",
  tsv: "TSV",
  json: "JSON",
  jsonc: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  xml: "XML",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "CSS",
  sql: "SQL",
  py: "Python",
  pyi: "Python",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  java: "Java",
  c: "C",
  h: "C",
  cpp: "C++",
  cc: "C++",
  hpp: "C++",
  cs: "C#",
  go: "Go",
  rs: "Rust",
  rb: "Ruby",
  php: "PHP",
  swift: "Swift",
  kt: "Kotlin",
  scala: "Scala",
  sh: "Shell",
  bash: "Shell",
  lua: "Lua",
  dart: "Dart",
  vue: "Vue",
  svelte: "Svelte",
};

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
 * Commands a reply is likely to write inside `$...$`, drawn as the character
 * instead of the command. A command that is not here is left as written.
 * @type {Readonly<Record<string, string>>}
 */
const LATEX_SYMBOLS = {
  rightarrow: "→",
  leftarrow: "←",
  leftrightarrow: "↔",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  Leftrightarrow: "⇔",
  to: "→",
  times: "×",
  cdot: "·",
  ldots: "…",
  cdots: "⋯",
  dots: "…",
  pm: "±",
  leq: "≤",
  geq: "≥",
  neq: "≠",
  approx: "≈",
  infty: "∞",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  theta: "θ",
  lambda: "λ",
  pi: "π",
  sigma: "σ",
  omega: "ω",
  Delta: "Δ",
  Sigma: "Σ",
  Omega: "Ω",
};

/** @param {string} source the inside of a `$...$`, which contains a command */
function latexText(source) {
  return source.replace(/\\+([a-zA-Z]+)/g, (whole, name) => {
    const symbol = typeof name === "string" ? LATEX_SYMBOLS[name] : undefined;
    return symbol ?? whole;
  });
}

/**
 * Inline marks in one line: code, emphasis, links, and `$...$` that names a
 * symbol. The text itself is never parsed as HTML.
 * @param {string} text
 * @returns {Node[]}
 */
function inlineNodes(text) {
  const pattern =
    /(`+)([^`]+)\1|\*\*([^*]+)\*\*|__([^_]+)__|(?<![A-Za-z0-9*])\*([^*\n]+)\*(?!\*)|(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])|\[([^\]\n]+)\]\(([^)\s]+)\)|\$([^$\n]*\\[^$\n]*)\$/g;
  /** @type {Node[]} */
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(document.createTextNode(text.slice(last, index)));
    const [whole, , code, stars, underscores, italic, underItalic, label, href, math] = match;
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
    } else if (math !== undefined) {
      nodes.push(document.createTextNode(latexText(math)));
    }
    last = index + whole.length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

/** @param {string} line */
const listItem = (line) => /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);

/** @param {string} line */
function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
}

/** @param {string} line */
function rowLike(line) {
  return line.includes("|") && splitRow(line).length >= 2;
}

/** @param {string} line */
function separatorRow(line) {
  if (!line.includes("|")) return false;
  const cells = splitRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/**
 * @param {string[]} lines
 * @param {number} at
 */
function tableStart(lines, at) {
  const header = lines[at] ?? "";
  const rule = lines[at + 1] ?? "";
  return rowLike(header) && separatorRow(rule) && splitRow(header).length === splitRow(rule).length;
}

/** @param {string} cell `:---`, `---:`, or `:---:` */
function columnAlign(cell) {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

/**
 * @param {HTMLElement} cell
 * @param {string} align
 */
function alignCell(cell, align) {
  if (align === "center" || align === "right") cell.style.textAlign = align;
}

/**
 * A pipe table, from its header through the last row. `at` is the header line.
 * @param {string[]} lines
 * @param {number} at
 * @returns {{ node: HTMLTableElement, at: number }}
 */
function readTable(lines, at) {
  const align = splitRow(lines[at + 1] ?? "").map(columnAlign);
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  splitRow(lines[at] ?? "").forEach((cell, index) => {
    const th = document.createElement("th");
    alignCell(th, align[index] ?? "left");
    th.append(...inlineNodes(cell));
    headRow.append(th);
  });
  head.append(headRow);
  table.append(head);
  const body = document.createElement("tbody");
  at += 2;
  while (at < lines.length && rowLike(lines[at] ?? "") && !separatorRow(lines[at] ?? "")) {
    const tr = document.createElement("tr");
    const cells = splitRow(lines[at] ?? "");
    for (let index = 0; index < align.length; index += 1) {
      const td = document.createElement("td");
      alignCell(td, align[index] ?? "left");
      td.append(...inlineNodes(cells[index] ?? ""));
      tr.append(td);
    }
    body.append(tr);
    at += 1;
  }
  table.append(body);
  return { node: table, at };
}

/**
 * One list, including items nested under its entries and blank lines between
 * items. A following item of the same kind stays in this list, so `1.` written
 * on every item still counts 1, 2, 3.
 * @param {string[]} lines
 * @param {number} at
 * @param {number} indent
 * @returns {{ node: HTMLOListElement | HTMLUListElement, at: number }}
 */
function readList(lines, at, indent) {
  const first = listItem(lines[at] ?? "");
  const ordered = /^\d+\.$/.test(first?.[2] ?? "");
  const list = ordered ? document.createElement("ol") : document.createElement("ul");
  if (list instanceof HTMLOListElement) {
    const start = Number.parseInt(first?.[2] ?? "1", 10);
    if (start > 1) list.start = start;
  }
  while (at < lines.length) {
    let look = at;
    while (look < lines.length && (lines[look] ?? "").trim() === "") look += 1;
    const item = listItem(lines[look] ?? "");
    if (item === null) break;
    const itemIndent = (item[1] ?? "").length;
    if (itemIndent !== indent) break;
    if (/^\d+\.$/.test(item[2] ?? "") !== ordered) break;
    at = look + 1;
    const row = document.createElement("li");
    row.append(...inlineNodes(item[3] ?? ""));
    while (at < lines.length) {
      const next = lines[at] ?? "";
      if (next.trim() === "") {
        let peek = at + 1;
        while (peek < lines.length && (lines[peek] ?? "").trim() === "") peek += 1;
        const peeked = listItem(lines[peek] ?? "");
        const peekedIndent = (peeked?.[1] ?? "").length;
        if (peeked === null || peekedIndent <= indent) break;
        at = peek;
        const nested = readList(lines, at, peekedIndent);
        row.append(nested.node);
        at = nested.at;
        continue;
      }
      const nestedItem = listItem(next);
      if (nestedItem !== null) {
        const nestedIndent = (nestedItem[1] ?? "").length;
        if (nestedIndent <= indent) break;
        const nested = readList(lines, at, nestedIndent);
        row.append(nested.node);
        at = nested.at;
        continue;
      }
      const continued = next.match(/^\s*/)?.[0].length ?? 0;
      if (continued > indent && next.trim() !== "") {
        row.append(document.createElement("br"), ...inlineNodes(next.trim()));
        at += 1;
        continue;
      }
      break;
    }
    list.append(row);
  }
  return { node: list, at };
}

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
    if (tableStart(lines, at)) {
      const table = readTable(lines, at);
      blocks.push(table.node);
      at = table.at;
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
      const list = readList(lines, at, (listed[1] ?? "").length);
      blocks.push(list.node);
      at = list.at;
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
        tableStart(lines, at) ||
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

/** Which part of a prompt cell's turn a button opens. */
/** @typedef {"rounds" | "system" | "prompts" | "tools"} TurnView */

/**
 * Shown once a prompt cell has run. Each opens one part of that turn.
 * @param {CellView} cell
 * @returns {HTMLButtonElement[]}
 */
function turnButtons(cell) {
  if (cell.type !== "prompt" || cell.run === undefined) return [];
  if (cell.status === "idle" || cell.status === "running") return [];
  return [
    turnButton(cell, "rounds", "Rounds", "The model rounds of this cell's turn"),
    turnButton(cell, "system", "System", "The system prompt this cell's turn was given"),
    turnButton(cell, "prompts", "Prompts", "The prompts other than the system prompt"),
    turnButton(cell, "tools", "Tools", "The tool calls of this cell's turn"),
  ];
}

/**
 * @param {CellView} cell
 * @param {TurnView} view
 * @param {string} label
 * @param {string} title
 * @returns {HTMLButtonElement}
 */
function turnButton(cell, view, label, title) {
  const button = /** @type {HTMLButtonElement} */ (make("button", "cell-turn", label));
  button.type = "button";
  button.title = title;
  button.addEventListener("click", () => {
    if (view === "system") void showSystemPrompt(cell.id);
    else if (view === "prompts") void showPrompts(cell.id);
    else if (view === "tools") void showToolCalls(cell.id);
    else void showRounds(cell.id);
  });
  return button;
}

/** @param {unknown} value */
function roundText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * @param {{
 *   query: string,
 *   prompts?: string[],
 *   systemPrompt?: string,
 *   toolCalls?: { name: string, input: unknown, result?: string, isError?: boolean }[],
 *   roundsProblem?: string,
 *   rounds: {
 *     kind: "model" | "you",
 *     text: string,
 *     thinking?: string,
 *     model?: string,
 *     inputTokens?: number,
 *     outputTokens?: number,
 *     toolCalls: { name: string, input: unknown, result?: string, isError?: boolean }[],
 *   }[],
 * }} value
 */
function renderRounds(value) {
  const body = element("cell-rounds-body");
  const query = make("section", "round");
  query.append(make("h3", "", "You"), make("p", "", value.query === "" ? "(empty)" : value.query));
  /** @type {Node[]} */
  const nodes = [query];
  if (value.rounds.length === 0) {
    nodes.push(make("p", "", value.roundsProblem ?? "The model did not answer."));
  }
  let count = 0;
  for (const round of value.rounds) {
    const block = make("section", "round");
    if (round.kind === "you") {
      block.append(make("h3", "", "You"), make("p", "", round.text));
      nodes.push(block);
      continue;
    }
    count += 1;
    const heading = make("h3", "", `Round ${count}`);
    if (round.model !== undefined) heading.append(make("span", "round-model", round.model));
    block.append(heading);
    const spent = [round.inputTokens, round.outputTokens].filter((n) => n !== undefined);
    if (spent.length === 2) {
      block.append(make("p", "round-usage", `${round.inputTokens} in, ${round.outputTokens} out`));
    }
    if (round.thinking !== undefined && round.thinking !== "") {
      const thought = document.createElement("details");
      thought.append(
        make("summary", "", "Thinking"),
        make("pre", "round-thinking", round.thinking),
      );
      block.append(thought);
    }
    const said = make("div", "cell-output markdown");
    said.append(...markdownBlocks(round.text === "" ? "" : round.text));
    if (round.text === "") said.append(make("p", "", "(no text)"));
    block.append(said);
    for (const call of round.toolCalls) {
      const tool = make("div", "round-tool");
      tool.append(
        make("p", "round-tool-name", call.isError === true ? `${call.name} failed` : call.name),
      );
      tool.append(make("pre", "", roundText(call.input)));
      if (call.result !== undefined) tool.append(make("pre", "round-result", call.result));
      block.append(tool);
    }
    nodes.push(block);
  }
  body.replaceChildren(...nodes);
}

/**
 * The prompts other than the system prompt, in the order they were sent.
 * @param {{ query: string, prompts?: string[] }} value
 */
function promptsOf(value) {
  if (value.prompts !== undefined) return value.prompts;
  return value.query === "" ? [] : [value.query];
}

/**
 * @param {{
 *   toolCalls?: { name: string, input: unknown, result?: string, isError?: boolean }[],
 *   rounds: { toolCalls: { name: string, input: unknown, result?: string, isError?: boolean }[] }[],
 * }} value
 */
function toolCallsOf(value) {
  if (value.toolCalls !== undefined) return value.toolCalls;
  return value.rounds.flatMap((round) => round.toolCalls);
}

/** @param {string} text */
function promptBlock(text) {
  const block = make("section", "round");
  block.append(make("pre", "prompt-text", text === "" ? "(empty)" : text));
  return block;
}

/**
 * @param {{ systemPrompt?: string }} value
 */
function renderSystemPrompt(value) {
  const text = value.systemPrompt;
  element("cell-rounds-body").replaceChildren(
    text === undefined || text === ""
      ? make("p", "", "This cell recorded no system prompt.")
      : promptBlock(text),
  );
}

/**
 * @param {{ query: string, prompts?: string[] }} value
 */
function renderPrompts(value) {
  const prompts = promptsOf(value);
  element("cell-rounds-body").replaceChildren(
    ...(prompts.length === 0
      ? [make("p", "", "This turn sent no other prompt.")]
      : prompts.map(promptBlock)),
  );
}

/**
 * @param {{
 *   rounds: { toolCalls: { name: string, input: unknown, result?: string, isError?: boolean }[] }[],
 * }} value
 */
function renderToolCalls(value) {
  const calls = toolCallsOf(value);
  if (calls.length === 0) {
    element("cell-rounds-body").replaceChildren(make("p", "", "This turn called no tools."));
    return;
  }
  const block = make("section", "round");
  for (const call of calls) {
    const tool = make("div", "round-tool");
    tool.append(
      make("p", "round-tool-name", call.isError === true ? `${call.name} failed` : call.name),
    );
    tool.append(make("pre", "", roundText(call.input)));
    if (call.result !== undefined) tool.append(make("pre", "round-result", call.result));
    block.append(tool);
  }
  element("cell-rounds-body").replaceChildren(block);
}

/**
 * Opens one part of a prompt cell's turn.
 * @param {string} cell
 * @param {TurnView} view
 */
async function showTurn(cell, view) {
  if (watching === undefined) return;
  const dialog = /** @type {HTMLDialogElement} */ (element("cell-rounds-dialog"));
  const titles = { rounds: "Rounds", system: "System", prompts: "Prompts", tools: "Tools" };
  element("cell-rounds-title").textContent = `${titles[view]} · ${cell}`;
  element("cell-rounds-body").replaceChildren(make("p", "", "Loading…"));
  if (!dialog.open) dialog.showModal();
  try {
    const response = await request(
      `/api/sessions/${encodeURIComponent(watching.state.id)}/cells/${encodeURIComponent(cell)}/rounds`,
    );
    if (!response.ok) {
      throw new Error((await response.text()).trim() || `The server answered ${response.status}`);
    }
    const value = await response.json();
    if (view === "system") renderSystemPrompt(value);
    else if (view === "prompts") renderPrompts(value);
    else if (view === "tools") renderToolCalls(value);
    else renderRounds(value);
  } catch (cause) {
    element("cell-rounds-body").replaceChildren(make("p", "", describe(cause)));
  }
}

/** @param {string} cell */
const showRounds = (cell) => showTurn(cell, "rounds");

/** @param {string} cell */
const showSystemPrompt = (cell) => showTurn(cell, "system");

/** @param {string} cell */
const showPrompts = (cell) => showTurn(cell, "prompts");

/** @param {string} cell */
const showToolCalls = (cell) => showTurn(cell, "tools");

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
 * Pieces of a notebook the reader has expanded. A cell is remembered by its
 * id (`cell:<id>`). Prose has no id, so it is remembered by its place
 * (`prose:<index>`). Anything absent is collapsed, which is how a notebook
 * opens. The choice lasts while this page has the notebook open, and a redraw
 * puts it back. While editing, the draft piece remembers it, and a save
 * writes that back here.
 * @type {Map<string, Set<string>>}
 */
const openedPieces = new Map();

/** @returns {Set<string>} */
function openedForNotebook() {
  const notebook = watching?.state.notebook ?? "";
  let found = openedPieces.get(notebook);
  if (found === undefined) {
    found = new Set();
    openedPieces.set(notebook, found);
  }
  return found;
}

/** @param {string} id */
const cellFoldKey = (id) => `cell:${id}`;

/** @param {number} index */
const proseFoldKey = (index) => `prose:${index}`;

/** @param {string} key */
const isFolded = (key) => !openedForNotebook().has(key);

/**
 * Keys of the pieces that fold: each cell, and each block of prose that is
 * not a blank line.
 * @param {NotebookSessionState} state
 * @returns {string[]}
 */
function foldKeys(state) {
  /** @type {string[]} */
  const keys = [];
  state.segments.forEach((segment, index) => {
    if (segment.kind === "prose") {
      if (segment.text.replace(/\r?\n$/, "").trim() !== "") keys.push(proseFoldKey(index));
      return;
    }
    keys.push(cellFoldKey(segment.id));
  });
  return keys;
}

/** Whether every prompt cell, bash cell, and block of prose is expanded. */
function allExpanded() {
  if (draft !== undefined) return draft.segments.every((segment) => !segment.folded);
  if (watching === undefined) return false;
  const opened = openedForNotebook();
  return foldKeys(watching.state).every((key) => opened.has(key));
}

/** Brings Expand all / Collapse all into line with the pieces on the page. */
function syncFoldAllButton() {
  const button = /** @type {HTMLButtonElement} */ (element("fold-all"));
  const collapse = allExpanded();
  button.textContent = collapse ? "Collapse all" : "Expand all";
  button.title = collapse
    ? "Collapse every prompt cell, bash cell, and block of prose"
    : "Expand every prompt cell, bash cell, and block of prose";
  button.setAttribute("aria-label", button.title);
}

/**
 * Collapses or expands every prompt cell, bash cell, and block of prose.
 * @param {boolean} folded
 */
function setAllFolded(folded) {
  if (draft !== undefined) {
    for (const segment of draft.segments) segment.folded = folded;
    renderEditor();
    return;
  }
  const opened = openedForNotebook();
  opened.clear();
  if (!folded && watching !== undefined) {
    for (const key of foldKeys(watching.state)) opened.add(key);
  }
  if (watching !== undefined) renderSession();
}

/**
 * The first line of a folded piece, so it can be told from the next.
 * @param {string} text
 */
function foldPreview(text) {
  const line = text
    .replace(/\r?\n$/, "")
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  if (line === undefined) return "";
  return line.length > 96 ? `${line.slice(0, 95)}…` : line;
}

/**
 * Collapses or expands one prompt cell, bash cell, or prose block.
 * @param {HTMLElement} item the piece on the page
 * @param {string} key how that piece is remembered for this notebook
 * @param {boolean} folded
 * @param {HTMLButtonElement} button
 * @param {string} name what the button calls it, such as "this bash cell"
 */
function setFolded(item, key, folded, button, name) {
  item.classList.toggle("folded", folded);
  const opened = openedForNotebook();
  if (folded) opened.delete(key);
  else opened.add(key);
  button.textContent = folded ? "Expand" : "Collapse";
  button.setAttribute("aria-expanded", folded ? "false" : "true");
  button.title = `${folded ? "Expand" : "Collapse"} ${name}`;
  button.setAttribute("aria-label", button.title);
  syncFoldAllButton();
}

/**
 * The button that collapses and expands `item`.
 * @param {HTMLElement} item
 * @param {string} key
 * @param {string} name
 * @param {boolean} folded
 */
function foldButton(item, key, name, folded) {
  const button = make("button", "fold", folded ? "Expand" : "Collapse");
  button.type = "button";
  button.setAttribute("aria-expanded", folded ? "false" : "true");
  button.title = `${folded ? "Expand" : "Collapse"} ${name}`;
  button.setAttribute("aria-label", button.title);
  button.addEventListener("click", () => {
    setFolded(item, key, !item.classList.contains("folded"), button, name);
  });
  return button;
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
  const key = cellFoldKey(cell.id);
  const folded = isFolded(key);
  if (folded) item.classList.add("folded");

  const heading = make("div", "cell-header");
  heading.append(foldButton(item, key, `this ${cell.type} cell`, folded));
  heading.append(make("span", "cell-id", cell.id), make("span", "cell-type", cell.type));
  if (cell.isolated) heading.append(make("span", "cell-attribute", "isolated"));
  if (cell.uses.length > 0)
    heading.append(make("span", "cell-attribute", `uses ${cell.uses.join(", ")}`));
  if (cell.model !== undefined) heading.append(make("span", "cell-attribute", cell.model));
  if (cell.timeout !== undefined)
    heading.append(make("span", "cell-attribute", `timeout ${formatDuration(cell.timeout)}`));
  heading.append(make("span", "cell-status", cell.status));
  heading.append(...turnButtons(cell));
  heading.append(branchButton(cell));
  if (cell.service === true && cell.status !== "running")
    heading.append(make("span", "cell-attribute", "service"));
  if (cell.service === true) heading.append(serviceStopButton(cell.id));
  const runOne = make("button", "cell-run", "Run");
  runOne.type = "button";
  runOne.title = `Run ${cell.id} alone, carrying on from the last run`;
  runOne.disabled = running;
  runOne.addEventListener("click", () => void startRun([cell.id]));
  heading.append(runOne, make("span", "cell-preview", foldPreview(cell.body)));

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
 * Prose as written. A blank line between cells stays blank, with nothing to fold.
 * @param {string} text
 * @param {number} index its place in the notebook, which is the only name it has
 */
function renderProse(text, index) {
  const body = text.replace(/\r?\n$/, "");
  if (body.trim() === "") return make("li", "prose");
  const item = make("li", "prose");
  const key = proseFoldKey(index);
  const folded = isFolded(key);
  if (folded) item.classList.add("folded");
  item.append(foldButton(item, key, "this prose", folded), make("div", "prose-text", body));
  return item;
}

/**
 * The Notebook in order: its Prose as written, and each Cell where it sits.
 * @param {NotebookSessionState} state
 */
function renderSegments(state) {
  return state.segments.map((segment, index) => {
    if (segment.kind === "prose") return renderProse(segment.text, index);
    const cell = state.cells.find((candidate) => candidate.id === segment.id);
    return cell === undefined ? make("li", "prose", "") : renderCell(cell, state.id, state.running);
  });
}

/** Reviews still open on the Notebook in view. */
function reviewsOf() {
  return watching?.state.reviews ?? [];
}

/** Opens a subtab for each file still under review, without closing one the reader opened. */
function rememberReviews() {
  for (const review of reviewsOf()) {
    if (!textTabs.includes(review.path)) textTabs.push(review.path);
  }
}

/**
 * @param {string} path
 * @returns {string}
 */
function textLabel(path) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_LABELS[extension] ?? "Text";
}

/** The subtab bar: the Notebook, then each open text file. */
function renderSubtabs() {
  const bar = element("subtabs");
  /** @type {HTMLElement[]} */
  const tabs = [];
  if (watching !== undefined) {
    const count = reviewsOf().length;
    const notebookTab = make("button", "subtab", count > 0 ? `Notebook (${count})` : "Notebook");
    notebookTab.type = "button";
    notebookTab.setAttribute("role", "tab");
    notebookTab.title = count > 0 ? `${count} files to accept or reject` : "The notebook";
    if (openPane === "notebook") notebookTab.setAttribute("aria-current", "page");
    notebookTab.addEventListener("click", () => {
      openPane = "notebook";
      renderSession();
    });
    tabs.push(notebookTab);
  }
  for (const path of textTabs) {
    const wrap = make("span", "subtab-wrap");
    wrap.setAttribute("role", "tab");
    const pending = reviewsOf().some((review) => review.path === path);
    if (pending) wrap.classList.add("pending");
    if (openPane === path) wrap.setAttribute("aria-current", "page");
    const button = make("button", "subtab", path.split("/").pop() ?? path);
    button.type = "button";
    button.title = path;
    button.addEventListener("click", () => openText(path));
    const close = make("button", "subtab-close", "×");
    close.type = "button";
    close.title = `Close ${path}`;
    close.setAttribute("aria-label", `Close ${path}`);
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeText(path);
    });
    wrap.append(button, close);
    tabs.push(wrap);
  }
  bar.replaceChildren(...tabs);
}

/**
 * Opens `path` in a subtab. With a Notebook open, the subtab sits beside it;
 * otherwise the file is the page until it is closed.
 * @param {string} path
 */
function openText(path) {
  if (!textTabs.includes(path)) textTabs.push(path);
  openPane = path;
  if (watching === undefined) {
    element("list").hidden = true;
    element("session").hidden = false;
    element("author-controls").hidden = true;
    element("run-controls").hidden = true;
    element("segments").hidden = true;
    element("editor").hidden = true;
    element("add-cells").hidden = true;
    element("run-view").hidden = true;
    showHeading(path.split("/").pop() ?? path, path);
    element("session-status").textContent = "";
    element("file-view").hidden = false;
    renderSubtabs();
    void showFile(path);
    return;
  }
  if (element("session").hidden) {
    element("list").hidden = true;
    element("session").hidden = false;
  }
  renderSession();
}

/**
 * Closes the subtab for `path` and leaves the others open. The review, if
 * there is one, stays until it is decided. The file that was beside the one
 * closed is what is shown next; the view itself closes only when no file
 * subtab remains and no Notebook is open.
 * @param {string} path
 */
function closeText(path) {
  const index = textTabs.indexOf(path);
  textTabs = textTabs.filter((tab) => tab !== path);
  fileDrafts.delete(path);
  if (openPane === path) {
    const neighbor = textTabs[Math.min(Math.max(index, 0), textTabs.length - 1)];
    openPane = neighbor ?? "notebook";
  }
  if (watching === undefined) {
    if (openPane === "notebook") {
      element("session").hidden = true;
      element("list").hidden = false;
      element("file-view").hidden = true;
      return;
    }
    showHeading(openPane.split("/").pop() ?? openPane, openPane);
    element("file-view").hidden = false;
    renderSubtabs();
    void showFile(openPane);
    return;
  }
  renderSession();
}

/**
 * Lines a change is best read as: the shared start and end, and the middle
 * that differs. A long unchanged stretch is one skipped line.
 * @param {string} before
 * @param {string} after
 * @returns {{ kind: "same" | "add" | "del" | "skip", text: string }[]}
 */
function lineDiff(before, after) {
  const older = before.split("\n");
  const newer = after.split("\n");
  let start = 0;
  while (start < older.length && start < newer.length && older[start] === newer[start]) start += 1;
  let endOlder = older.length - 1;
  let endNewer = newer.length - 1;
  while (endOlder >= start && endNewer >= start && older[endOlder] === newer[endNewer]) {
    endOlder -= 1;
    endNewer -= 1;
  }
  /** @type {{ kind: "same" | "add" | "del", text: string }[]} */
  const rows = [];
  for (let index = 0; index < start; index += 1) {
    const text = older[index];
    if (text !== undefined) rows.push({ kind: "same", text });
  }
  for (let index = start; index <= endOlder; index += 1) {
    const text = older[index];
    if (text !== undefined) rows.push({ kind: "del", text });
  }
  for (let index = start; index <= endNewer; index += 1) {
    const text = newer[index];
    if (text !== undefined) rows.push({ kind: "add", text });
  }
  for (let index = endOlder + 1; index < older.length; index += 1) {
    const text = older[index];
    if (text !== undefined) rows.push({ kind: "same", text });
  }
  if (rows.length <= 400) return rows;
  const keep = new Set();
  rows.forEach((row, index) => {
    if (row.kind === "same") return;
    for (let at = Math.max(0, index - 3); at <= Math.min(rows.length - 1, index + 3); at += 1) {
      keep.add(at);
    }
  });
  /** @type {{ kind: "same" | "add" | "del" | "skip", text: string }[]} */
  const shown = [];
  let skipped = false;
  rows.forEach((row, index) => {
    if (keep.has(index)) {
      skipped = false;
      shown.push(row);
    } else if (!skipped) {
      skipped = true;
      shown.push({ kind: "skip", text: "…" });
    }
  });
  return shown;
}

/**
 * @param {string} text
 * @param {TextReview | undefined} review
 */
function renderFileBody(text, review) {
  const body = element("file-body");
  if (review === undefined || review.kind !== "modified" || review.before === undefined) {
    body.classList.remove("diff");
    body.textContent = text;
    return;
  }
  body.classList.add("diff");
  const mark = { same: "  ", add: "+ ", del: "- ", skip: "" };
  body.replaceChildren(
    ...lineDiff(review.before, text).map((row) =>
      make("div", `diff-line ${row.kind}`, `${mark[row.kind]}${row.text === "" ? " " : row.text}`),
    ),
  );
}

/** @returns {HTMLTextAreaElement} */
function fileEditor() {
  const found = element("file-editor");
  if (!(found instanceof HTMLTextAreaElement))
    throw new Error("The file editor is not a text field.");
  return found;
}

/**
 * The subtab already names a file in this directory. The path line is kept
 * only when it says which folder the file is in.
 * @param {string} path
 */
function showFileName(path) {
  const named = element("file-path");
  const file = path.split("/").pop() ?? path;
  named.hidden = path === file;
  named.textContent = path;
}

/**
 * Shows Edit, or Save and Cancel, and Accept and Reject only while reading a review.
 * @param {string} path
 * @param {boolean} editing
 * @param {TextReview | undefined} review
 */
function showFileChrome(path, editing, review) {
  showFileName(path);
  element("file-kind").textContent = editing
    ? textLabel(path)
    : review === undefined
      ? textLabel(path)
      : review.kind === "created"
        ? "New file"
        : "Modified";
  element("file-edit").hidden = editing;
  element("file-wrap").hidden = !editing;
  element("file-save").hidden = !editing;
  element("file-cancel-edit").hidden = !editing;
  const reviewing = !editing && review !== undefined && watching !== undefined;
  element("file-accept").hidden = !reviewing;
  element("file-reject").hidden = !reviewing;
  element("file-body").hidden = editing;
  element("file-editor").hidden = !editing;
}

/**
 * Puts the unsaved text of `path` in the editor.
 * @param {string} path
 */
function presentFileEditor(path) {
  const editor = fileEditor();
  const draft = fileDrafts.get(path) ?? "";
  if (editor.value !== draft) editor.value = draft;
  applyFileWrap();
  showFileChrome(
    path,
    true,
    reviewsOf().find((item) => item.path === path),
  );
  element("file-status").textContent = "";
}

/** Breaks long lines in the editor, or leaves each one on its own row. */
function applyFileWrap() {
  const editor = fileEditor();
  editor.classList.toggle("wrap", fileWrap);
  editor.wrap = fileWrap ? "soft" : "off";
  element("file-wrap").setAttribute("aria-pressed", fileWrap ? "true" : "false");
}

function toggleFileWrap() {
  fileWrap = !fileWrap;
  applyFileWrap();
}

/** Starts editing the file on show, from the text that was loaded. */
function beginFileEdit() {
  if (openPane === "notebook" || element("file-view").hidden) return;
  fileDrafts.set(openPane, fileSource);
  presentFileEditor(openPane);
  fileEditor().focus();
}

/** Drops the unsaved text and shows the file as it is on disk. */
function cancelFileEdit() {
  if (openPane === "notebook") return;
  fileDrafts.delete(openPane);
  void showFile(openPane);
}

/** Writes the editor's text over the file on show. */
async function saveFileEdit() {
  if (openPane === "notebook") return;
  const path = openPane;
  const text = fileEditor().value;
  fileDrafts.set(path, text);
  const status = element("file-status");
  status.textContent = "Saving…";
  try {
    await post("/api/text", { path, text });
    if (openPane !== path) {
      fileDrafts.delete(path);
      return;
    }
    fileSource = text;
    fileDrafts.delete(path);
    status.textContent = "";
    void showFile(path);
  } catch (cause) {
    if (openPane === path) status.textContent = `Could not save: ${describe(cause)}`;
  }
}

/**
 * Draws the text file `path`, and Accept and Reject when a Run left it under review.
 * An edit in progress is left as the reader has it.
 * @param {string} path
 */
async function showFile(path) {
  if (fileDrafts.has(path)) {
    presentFileEditor(path);
    return;
  }
  const load = ++fileLoad;
  const status = element("file-status");
  showFileName(path);
  element("file-body").hidden = false;
  element("file-editor").hidden = true;
  element("file-edit").hidden = true;
  element("file-wrap").hidden = true;
  element("file-save").hidden = true;
  element("file-cancel-edit").hidden = true;
  const review = reviewsOf().find((item) => item.path === path);
  element("file-kind").textContent =
    review === undefined ? textLabel(path) : review.kind === "created" ? "New file" : "Modified";
  element("file-accept").hidden = review === undefined || watching === undefined;
  element("file-reject").hidden = review === undefined || watching === undefined;
  status.textContent = "Loading…";
  try {
    const response = await request(`/api/text?${new URLSearchParams({ path })}`);
    if (load !== fileLoad || openPane !== path || fileDrafts.has(path)) return;
    if (!response.ok) {
      element("file-body").replaceChildren();
      element("file-edit").hidden = true;
      status.textContent =
        response.status === 404 ? "This file is not there." : (await response.text()).trim();
      return;
    }
    const body = /** @type {{ path: string, text: string }} */ (await response.json());
    if (load !== fileLoad || openPane !== path || fileDrafts.has(path)) return;
    fileSource = body.text;
    status.textContent = "";
    showFileChrome(path, false, review);
    renderFileBody(body.text, review);
  } catch (cause) {
    if (load !== fileLoad) return;
    element("file-edit").hidden = true;
    status.textContent = describe(cause);
  }
}

/**
 * Keeps or puts back the text file on show.
 * @param {"accept" | "reject"} decision
 */
async function decideOpenFile(decision) {
  if (watching === undefined || openPane === "notebook") return;
  const path = openPane;
  const review = reviewsOf().find((item) => item.path === path);
  const status = element("file-status");
  status.textContent = "";
  try {
    const response = await post(`/api/sessions/${watching.state.id}/text`, { path, decision });
    const state = /** @type {NotebookSessionState} */ (await response.json());
    if (watching !== undefined && state.sequence >= watching.sequence) {
      watching.state = state;
      watching.sequence = state.sequence;
    }
    if (decision === "reject" && review?.kind === "created") closeText(path);
    else renderSession();
    void refreshTree();
  } catch (cause) {
    status.textContent = `Could not ${decision} this file: ${describe(cause)}`;
  }
}

/**
 * The path already names the file. A title that is only that name, with or
 * without its extension, is the same name twice, so only the path is shown.
 * @param {string} title
 * @param {string} path
 */
function showHeading(title, path) {
  const file = path.split("/").pop() ?? path;
  const stem = file.replace(/\.[^.]+$/, "");
  const folded = title.toLowerCase();
  const same =
    folded === file.toLowerCase() || folded === stem.toLowerCase() || folded === path.toLowerCase();
  const heading = element("title");
  heading.hidden = same;
  heading.textContent = same ? "" : title;
  const named = element("notebook");
  named.textContent = path;
  named.classList.toggle("sole", same && path !== "");
}

function renderSession() {
  if (watching === undefined) return;
  rememberReviews();
  const { state } = watching;
  showHeading(state.title, state.notebook);
  const authoring = view === "author";
  element("author-controls").hidden = !authoring;
  element("run-controls").hidden = authoring;
  /** @type {HTMLAnchorElement} */ (element("to-run-view")).href = hashFor(state.notebook, "run");
  /** @type {HTMLAnchorElement} */ (element("to-author-view")).href = hashFor(
    state.notebook,
    "author",
  );
  element("run-view").hidden = authoring || openPane !== "notebook";
  element("add-cells").hidden = !authoring || openPane !== "notebook";
  element("file-view").hidden = openPane === "notebook";
  renderSubtabs();
  syncFoldAllButton();
  if (!authoring) {
    element("segments").hidden = true;
    element("editor").hidden = true;
    if (openPane !== "notebook") void showFile(openPane);
    else renderRunView(state);
    return;
  }
  /** @type {HTMLButtonElement} */ (element("run-all")).disabled = state.running;
  /** @type {HTMLButtonElement} */ (element("interrupt")).disabled = !state.running;
  const mode = /** @type {HTMLSelectElement} */ (element("notebook-mode"));
  fillModeSelect(mode, state.mode);
  mode.disabled = draft !== undefined;
  mode.title =
    draft !== undefined
      ? "Save or cancel the draft before choosing a mode."
      : "The mode this notebook runs in. Default uses pi's own settings.";
  const chosen = /** @type {HTMLButtonElement} */ (element("notebook-model"));
  chosen.textContent = "Model";
  chosen.title =
    draft !== undefined
      ? "Save or cancel the draft before choosing a model."
      : (state.model ?? "Choose a configured model for this notebook");
  chosen.disabled = draft !== undefined;
  element("edit").hidden = draft !== undefined;
  if (openPane !== "notebook") {
    element("segments").hidden = true;
    element("editor").hidden = true;
    void showFile(openPane);
    return;
  }
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
        if (cell.type === "bash") cell.service = true;
        else delete cell.service;
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
        if (cell.type === "bash" && (event.record.servicePids?.length ?? 0) > 0)
          cell.service = true;
        else delete cell.service;
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
      // The files this Run created or changed are there to be accepted or
      // rejected, once the Run is over and the Notebook is what was on show.
      const firstReview = state.reviews?.[0];
      if (openPane === "notebook" && firstReview !== undefined) openPane = firstReview.path;
      renderSession();
      void refreshTree();
      return;
    case "text-changed":
      if (event.reviews.length === 0) delete state.reviews;
      else state.reviews = event.reviews;
      renderSession();
      void refreshTree();
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
 * Stops the service a Bash Cell is running, or left running.
 * @param {string} cell
 * @returns {Promise<boolean>} whether the server accepted the stop
 */
async function stopCell(cell) {
  if (watching === undefined) return false;
  try {
    await post(
      `/api/sessions/${encodeURIComponent(watching.state.id)}/cells/${encodeURIComponent(cell)}/stop`,
    );
    return true;
  } catch (cause) {
    element("session-status").textContent = `Could not stop: ${describe(cause)}`;
    return false;
  }
}

/**
 * The button that stops a Bash Cell's service. `id` is the Cell's id.
 * @param {string} id
 * @returns {HTMLButtonElement}
 */
function serviceStopButton(id) {
  const button = /** @type {HTMLButtonElement} */ (make("button", "cell-stop", "Stop"));
  button.type = "button";
  button.title = `Stop the service ${id} is running`;
  button.addEventListener("click", () => {
    void stopCell(id).then((stopped) => {
      // The notebook view is drawn again from the session. The editor is not,
      // so the button leaves once the stop has been accepted.
      if (stopped) button.remove();
    });
  });
  return button;
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
 *   folded: boolean,
 * }} DraftCell
 * @typedef {{ kind: "prose", text: string, folded: boolean }} DraftProse
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
 * Configured models (`provider/id`) for the cell model list, once loaded for
 * the draft that is open. Undefined until that load finishes.
 * @type {string[] | undefined}
 */
let cellModels;

/** Which load of that list is current, so a slower answer cannot replace a newer one. */
let cellModelLoad = 0;

/**
 * A draft of the Notebook as the session holds it.
 * @param {NotebookSessionState} state
 * @returns {Draft}
 */
function draftOf(state) {
  return {
    base: state.revision,
    frontmatter: state.frontmatter ?? "",
    segments: draftSegments(state),
    saving: false,
  };
}

/**
 * The notebook's pieces as the form edits them. Each starts collapsed, and
 * is open when the reader had expanded it.
 * @param {NotebookSessionState} state
 * @returns {DraftSegment[]}
 */
function draftSegments(state) {
  /** @type {DraftSegment[]} */
  const segments = [];
  for (const segment of state.segments) {
    if (segment.kind === "prose") {
      segments.push({
        kind: "prose",
        text: segment.text,
        folded: isFolded(proseFoldKey(segments.length)),
      });
      continue;
    }
    const cell = state.cells.find((candidate) => candidate.id === segment.id);
    if (cell === undefined) continue;
    segments.push({
      kind: "cell",
      id: cell.id,
      type: cell.type,
      body: cell.body.replace(/\r?\n$/, ""),
      uses: cell.uses.join(", "),
      isolated: cell.isolated,
      model: cell.model ?? "",
      timeout: cell.timeout === undefined ? "" : formatDuration(cell.timeout),
      folded: isFolded(cellFoldKey(cell.id)),
    });
  }
  return segments;
}

/**
 * Writes the draft's expanded pieces back onto the open notebook, in the
 * order the draft will save them. A collapsed piece is remembered by being
 * left out. A cell with no id yet has nothing to remember it by until it is
 * given one, so it stays collapsed.
 */
function syncDraftFolds() {
  if (draft === undefined) return;
  const opened = openedForNotebook();
  opened.clear();
  draft.segments.forEach((segment, index) => {
    if (segment.folded) return;
    if (segment.kind === "prose") opened.add(proseFoldKey(index));
    else if (segment.id.trim() !== "") opened.add(cellFoldKey(segment.id.trim()));
  });
}

/**
 * Collapses or expands a prompt cell, bash cell, or prose block in the draft.
 * The piece remembers it, so a later redraw of the form keeps it.
 * @param {DraftSegment} segment
 */
function draftFoldButton(segment) {
  const name = () => (segment.kind === "cell" ? `this ${segment.type} cell` : "this prose");
  const button = make("button", "fold", segment.folded ? "Expand" : "Collapse");
  button.type = "button";
  const retitle = () => {
    button.textContent = segment.folded ? "Expand" : "Collapse";
    button.setAttribute("aria-expanded", segment.folded ? "false" : "true");
    button.title = `${segment.folded ? "Expand" : "Collapse"} ${name()}`;
    button.setAttribute("aria-label", button.title);
  };
  retitle();
  button.addEventListener("click", () => {
    segment.folded = !segment.folded;
    const card = button.closest(".draft-segment");
    if (card instanceof HTMLElement) {
      card.classList.toggle("folded", segment.folded);
      const preview = card.querySelector(".fold-preview");
      if (preview !== null) {
        preview.textContent = foldPreview(segment.kind === "cell" ? segment.body : segment.text);
      }
    }
    retitle();
    syncFoldAllButton();
  });
  return button;
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
      if (segment.kind === "prose") return { kind: "prose", text: segment.text };
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

/** @typedef {{ name: string, description: string, scope: "global" | "local" }} InstalledSkill */

/** How many skill menus this page has drawn, so each has its own id. */
let skillMenus = 0;

/**
 * The `/command` the caret is inside, when one is being typed. The token
 * begins at the start of the text or after whitespace, and runs to the next
 * whitespace, caret or not.
 * @param {HTMLTextAreaElement} field
 * @returns {{ start: number, end: number, query: string } | undefined}
 */
function slashToken(field) {
  if (field.selectionStart !== field.selectionEnd) return undefined;
  const caret = field.selectionStart;
  const value = field.value;
  const upTo = value.slice(0, caret);
  const matched = /(?:^|\s)(\/[^\s]*)$/.exec(upTo);
  const token = matched?.[1];
  if (token === undefined) return undefined;
  const start = upTo.length - token.length;
  const tail = /^[^\s]*/.exec(value.slice(caret))?.[0] ?? "";
  return { start, end: caret + tail.length, query: value.slice(start + 1, caret + tail.length) };
}

/**
 * Whether `body` is the skill command, with nothing before it. Pi expands
 * `/skill:name` only then, so a slash typed into a longer prompt is filled in
 * and left for the author to run.
 * @param {string} body
 * @param {string} command
 */
function invokesSkill(body, command) {
  const trimmed = body.trim();
  return (
    trimmed === command || trimmed.startsWith(`${command} `) || trimmed.startsWith(`${command}\n`)
  );
}

/**
 * Skills installed for the user and for the Notebook open now.
 * @returns {Promise<InstalledSkill[]>}
 */
async function fetchInstalledSkills() {
  const notebook = watching?.state.notebook;
  const path =
    notebook === undefined ? "/api/skills" : `/api/skills?notebook=${encodeURIComponent(notebook)}`;
  const response = await request(path);
  if (!response.ok) {
    throw new Error((await response.text()).trim() || `The server answered ${response.status}`);
  }
  const listed = /** @type {{ skills: InstalledSkill[] }} */ (await response.json());
  return listed.skills;
}

/**
 * The prompt's body, with a menu of installed Skills that opens when `/` is
 * typed. Choosing one writes `/skill:name` over the token, and runs the Cell
 * when that command is the whole prompt.
 * @param {HTMLTextAreaElement} field
 * @param {DraftCell} cell
 */
function attachSkillMenu(field, cell) {
  const wrap = field.parentElement;
  if (wrap === null) return;
  const menu = make("ul", "skill-menu");
  menu.id = `skill-menu-${(skillMenus += 1)}`;
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Installed skills");
  field.setAttribute("aria-autocomplete", "list");
  field.setAttribute("aria-controls", menu.id);
  field.setAttribute("aria-expanded", "false");
  wrap.append(menu);
  // A press in the menu must not move focus out of the prompt, or the menu
  // would close before the choice was taken.
  menu.addEventListener("mousedown", (event) => event.preventDefault());

  let writing = false;
  let fetching = false;
  let generation = 0;
  /** @type {InstalledSkill[] | undefined} */
  let loaded;
  let query = "";
  let highlighted = 0;

  const choices = () =>
    [...menu.querySelectorAll("button.skill-choice")].filter(
      (button) => button instanceof HTMLButtonElement,
    );

  /** @param {number} index */
  const mark = (index) => {
    const buttons = choices();
    if (buttons.length === 0) return;
    highlighted = (index + buttons.length) % buttons.length;
    buttons.forEach((button, at) => {
      const on = at === highlighted;
      button.setAttribute("aria-selected", on ? "true" : "false");
      if (on) button.scrollIntoView({ block: "nearest" });
    });
  };

  const close = () => {
    generation += 1;
    fetching = false;
    loaded = undefined;
    menu.hidden = true;
    menu.replaceChildren();
    wrap.classList.remove("open");
    field.setAttribute("aria-expanded", "false");
  };

  /**
   * @param {InstalledSkill} skill
   */
  const choose = (skill) => {
    const token = slashToken(field);
    if (token === undefined) return;
    const command = `/skill:${skill.name}`;
    const next = `${field.value.slice(0, token.start)}${command}${field.value.slice(token.end)}`;
    writing = true;
    field.value = next;
    const caret = token.start + command.length;
    field.selectionStart = caret;
    field.selectionEnd = caret;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    writing = false;
    close();
    if (cell.type === "prompt" && invokesSkill(next, command)) void runDraftCell(cell);
  };

  /**
   * @param {string} [status]
   */
  const draw = (status) => {
    menu.replaceChildren();
    field.setAttribute("aria-expanded", "true");
    wrap.classList.add("open");
    menu.hidden = false;
    if (status !== undefined) {
      menu.append(make("li", "skill-status", status));
      return;
    }
    const needle = query.replace(/^skill:/i, "").toLowerCase();
    const matched = (loaded ?? []).filter(
      (skill) =>
        needle === "" ||
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle),
    );
    if (matched.length === 0) {
      menu.append(
        make(
          "li",
          "skill-status",
          loaded === undefined ? "Looking for skills…" : "No skill matches.",
        ),
      );
      return;
    }
    /**
     * @param {string} label
     * @param {InstalledSkill[]} skills
     */
    const group = (label, skills) => {
      if (skills.length === 0) return;
      menu.append(make("li", "skill-scope", label));
      for (const skill of skills) {
        const item = make("li", "skill-item");
        const button = make("button", "skill-choice");
        button.type = "button";
        button.setAttribute("role", "option");
        button.dataset.skill = skill.name;
        button.title = skill.description;
        button.append(
          make("span", "skill-name", skill.name),
          make("span", "skill-description", skill.description),
        );
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
          choose(skill);
        });
        item.append(button);
        menu.append(item);
      }
    };
    group(
      "Local",
      matched.filter((skill) => skill.scope === "local"),
    );
    group(
      "Global",
      matched.filter((skill) => skill.scope === "global"),
    );
    mark(0);
  };

  const refresh = () => {
    if (writing) return;
    const token = slashToken(field);
    if (token === undefined || cell.type !== "prompt") {
      if (!menu.hidden) close();
      return;
    }
    query = token.query;
    if (loaded !== undefined) {
      draw();
      return;
    }
    if (fetching) return;
    fetching = true;
    const ticket = generation;
    draw("Looking for skills…");
    void fetchInstalledSkills()
      .then((skills) => {
        if (ticket !== generation) return;
        loaded = skills;
        draw();
      })
      .catch((cause) => {
        if (ticket !== generation) return;
        draw(describe(cause));
      })
      .finally(() => {
        if (ticket === generation) fetching = false;
      });
  };

  field.addEventListener("input", refresh);
  field.addEventListener("keydown", (event) => {
    if (menu.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    const buttons = choices();
    if (buttons.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      mark(highlighted + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
      event.preventDefault();
      const button = buttons[highlighted];
      const skill = (loaded ?? []).find((candidate) => candidate.name === button?.dataset.skill);
      if (skill !== undefined) choose(skill);
    }
  });
  field.addEventListener("blur", () => {
    if (!menu.hidden) close();
  });
}

/**
 * A Cell's body. A Prompt Cell's offers the installed Skills when `/` is typed.
 * @param {DraftCell} cell
 */
function cellBody(cell) {
  const field = textarea(
    cell.body,
    (value) => {
      cell.body = value;
    },
    cell.type === "bash"
      ? "A shell command"
      : "What to ask the agent. Type / to run an installed skill.",
  );
  const wrap = make("div", "skill-field");
  wrap.append(field);
  attachSkillMenu(field, cell);
  return wrap;
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
    folded: false,
  };
  return before?.kind === "cell" ? [{ kind: "prose", text: "\n", folded: true }, cell] : [cell];
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
    if (segment !== undefined) actions.append(draftFoldButton(segment));
    actions.append(
      button("↑", () => swap(at, at - 1), at === 0),
      button("↓", () => swap(at, at + 1), at === segments.length - 1),
      button("Remove", () => segments.splice(at, 1)),
    );
    // The same Run a Cell has when it is not being edited. The draft is saved
    // first, so the command just typed is what runs.
    if (segment?.kind === "cell") {
      const cell = segment;
      const live = watching?.state.cells.find((item) => item.id === cell.id.trim());
      if (live?.service === true) actions.append(serviceStopButton(live.id));
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
    button("prose", () => insert([{ kind: "prose", text: "\n", folded: false }])),
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
  const card = make("li", `draft-segment cell ${cell.type}${cell.folded ? " folded" : ""}`);
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
    card.className = `draft-segment cell ${cell.type}${cell.folded ? " folded" : ""}`;
    const fold = card.querySelector("button.fold");
    if (fold instanceof HTMLButtonElement) {
      fold.title = `${cell.folded ? "Expand" : "Collapse"} this ${cell.type} cell`;
      fold.setAttribute("aria-label", fold.title);
    }
    const body = card.querySelector("textarea");
    if (body instanceof HTMLTextAreaElement) {
      body.placeholder =
        cell.type === "bash"
          ? "A shell command"
          : "What to ask the agent. Type / to run an installed skill.";
      body.dispatchEvent(new Event("input"));
    }
  });

  const isolated = document.createElement("label");
  const flag = document.createElement("input");
  flag.type = "checkbox";
  flag.checked = cell.isolated;
  flag.addEventListener("change", () => (cell.isolated = flag.checked));
  isolated.append(flag, "isolated");

  declaration.append(
    type,
    field(
      "id",
      cell.id,
      (value) => {
        cell.id = value;
        fillUsesSelects();
      },
      "draft-id",
    ),
    usesSelect(cell),
    isolated,
    modelSelect(cell.model, (value) => (cell.model = value)),
    field("timeout", cell.timeout, (value) => (cell.timeout = value)),
  );
  card.append(
    declaration,
    make("p", "fold-preview", foldPreview(cell.body)),
    cellBody(cell),
    actionsFor(at),
  );
  return card;
}

/**
 * @param {DraftProse} prose
 * @param {number} at
 */
function renderDraftProse(prose, at) {
  const card = make("li", `draft-segment prose${prose.folded ? " folded" : ""}`);
  card.append(
    make("span", "draft-label", "Prose"),
    make("p", "fold-preview", foldPreview(prose.text)),
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
  syncFoldAllButton();
}

function beginEditing() {
  if (watching === undefined || draft !== undefined) return;
  openPane = "notebook";
  draft = draftOf(watching.state);
  element("editor-status").textContent = "";
  cellModels = undefined;
  renderEditor();
  renderSession();
  const load = ++cellModelLoad;
  void loadCellModels(load);
}

/** @param {string} value */
function usesNames(value) {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/** Ids of the cells in the draft, in the order they are written. */
function draftCellIds() {
  return (draft?.segments ?? []).flatMap((segment) =>
    segment.kind === "cell" && segment.id.trim() !== "" ? [segment.id.trim()] : [],
  );
}

/**
 * The cells this one waits for, chosen from the other cells in the notebook.
 * Click an id to select or clear it. A name already stored that is not a cell
 * stays in the list, so editing does not drop it.
 * @param {DraftCell} cell
 */
function usesSelect(cell) {
  const wrapper = document.createElement("label");
  wrapper.className = "draft-uses-label";
  const select = document.createElement("select");
  select.multiple = true;
  select.className = "draft-uses";
  select.title = "Cells that must finish before this one. Click an id to choose or clear it.";
  fillUsesSelect(select, cell.id, cell.uses);
  // A click toggles one id. The list otherwise replaces the whole choice unless a modifier is held.
  select.addEventListener("mousedown", (event) => {
    if (!(event.target instanceof HTMLOptionElement) || event.target.disabled) return;
    event.preventDefault();
    event.target.selected = !event.target.selected;
    select.dispatchEvent(new Event("change"));
  });
  select.addEventListener("change", () => {
    cell.uses = [...select.selectedOptions]
      .map((option) => option.value)
      .filter((name) => name !== "")
      .join(", ");
  });
  wrapper.append("uses", select);
  return wrapper;
}

/**
 * @param {HTMLSelectElement} select
 * @param {string} self
 * @param {string} value
 */
function fillUsesSelect(select, self, value) {
  const chosen = new Set(usesNames(value));
  const others = draftCellIds().filter((id) => id !== self.trim());
  const missing = [...chosen].filter((id) => !others.includes(id));
  const names = [...others, ...missing];
  select.replaceChildren(
    ...names.map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = missing.includes(name) ? `${name} (not a cell)` : name;
      option.selected = chosen.has(name);
      return option;
    }),
  );
  select.size = Math.min(Math.max(names.length, 1), 4);
  if (names.length === 0) {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "no other cell";
    none.disabled = true;
    select.append(none);
  }
}

/** Refills every uses list from the cells as they stand, keeping each choice. */
function fillUsesSelects() {
  const cells = (draft?.segments ?? []).flatMap((segment) =>
    segment.kind === "cell" ? [segment] : [],
  );
  const selects = [...element("draft").querySelectorAll("select.draft-uses")];
  selects.forEach((select, at) => {
    if (!(select instanceof HTMLSelectElement)) return;
    const cell = cells[at];
    if (cell === undefined) return;
    fillUsesSelect(select, cell.id, cell.uses);
  });
}

/**
 * The model list on a cell: the configured models, plus whatever this cell
 * already names when that is not among them, so editing does not drop it.
 * An empty choice leaves the cell on the notebook's model, or pi's default.
 * @param {string} value
 * @param {(value: string) => void} set
 */
function modelSelect(value, set) {
  const wrapper = document.createElement("label");
  const select = document.createElement("select");
  select.className = "draft-model";
  select.title =
    "A configured model for this cell. The default uses the notebook's model, or pi's when the notebook names none.";
  fillModelSelect(select, value);
  select.addEventListener("change", () => set(select.value));
  wrapper.append("model", select);
  return wrapper;
}

/**
 * @param {HTMLSelectElement} select
 * @param {string} value
 */
function fillModelSelect(select, value) {
  const names = cellModels ?? [];
  /** @type {string[]} */
  const options = [""];
  if (value !== "" && !names.includes(value)) options.push(value);
  options.push(...names);
  select.replaceChildren(
    ...options.map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name === "" ? "default" : name;
      option.selected = name === value;
      return option;
    }),
  );
}

/** Fills every cell's model list from `cellModels`, keeping the choice already made. */
function fillModelSelects() {
  for (const select of element("draft").querySelectorAll("select.draft-model")) {
    if (!(select instanceof HTMLSelectElement)) continue;
    fillModelSelect(select, select.value);
  }
}

/**
 * Loads the configured models for the cell lists. `load` is the edit that asked,
 * so an answer for an edit that was cancelled is ignored.
 * @param {number} load
 */
async function loadCellModels(load) {
  try {
    const page = await fetchModels();
    if (draft === undefined || load !== cellModelLoad) return;
    cellModels = configuredModelsOf(page).map((model) => `${model.provider}/${model.id}`);
    fillModelSelects();
  } catch (cause) {
    if (draft === undefined || load !== cellModelLoad) return;
    const status = element("editor-status");
    if (status.textContent === "")
      status.textContent = `Could not load the models: ${describe(cause)}`;
  }
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
      syncDraftFolds();
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

/**
 * A button that forks a new notebook from this cell and opens it in a new
 * browser tab. The notebook on this page stays where it is.
 * @param {CellView} cell
 * @returns {HTMLButtonElement}
 */
function branchButton(cell) {
  const button = /** @type {HTMLButtonElement} */ (make("button", "cell-branch", "Branch"));
  button.type = "button";
  button.title = `Fork a new notebook from ${cell.id} and open it in a new tab`;
  button.addEventListener("click", () => void branchFrom(cell.id));
  return button;
}

/**
 * The name offered for a branch taken at `cell`: this notebook's name with
 * the cell's id before `.md`.
 * @param {string} notebook
 * @param {string} cell
 */
function branchName(notebook, cell) {
  return notebook.replace(/(\.md)?$/, `-${cell}.md`);
}

/**
 * Opens `href` in a new browser tab. Called with a window `window.open`
 * already returned, when the browser handed one back; otherwise by clicking
 * a link, which is what a browser does when it opens the tab and does not
 * hand it back.
 * @param {string} href
 * @param {Window | null} opened
 */
function showInNewTab(href, opened) {
  if (opened !== null) {
    opened.location.href = href;
    return;
  }
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * Writes a new notebook that keeps this one through `cell`, and opens that
 * notebook in a new browser tab.
 * @param {string} cell
 */
async function branchFrom(cell) {
  if (watching === undefined) return;
  const { notebook } = watching.state;
  const to = window.prompt("Save a branch of this notebook as:", branchName(notebook, cell));
  if (to === null || to.trim() === "") return;
  // Still inside the click, before anything is awaited, so the browser will
  // allow the new tab. The address is set once the branch exists.
  const opened = window.open("about:blank", "_blank");
  const status = element("session-status");
  try {
    const made = /** @type {NotebookEntry} */ (
      await (await post("/api/notebooks/branch", { from: notebook, cell, to: to.trim() })).json()
    );
    const url = new URL(location.href);
    url.hash = hashFor(made.path, "author");
    showInNewTab(url.href, opened);
    status.textContent = "";
    void refreshTree();
  } catch (cause) {
    opened?.close();
    status.textContent = `Could not branch: ${describe(cause)}`;
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
  heading.append(...turnButtons(cell));
  if (cell.service === true) heading.append(serviceStopButton(cell.id));
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
  if (watching?.state.notebook !== notebook) openPane = "notebook";
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
    const opened = post("/api/sessions", { notebook }).then((response) => response.json());
    const modes = fetchModes().catch(() => undefined);
    state = await opened;
    await modes;
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
 *   open?: boolean,
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

/**
 * Whether `model` is one the user can already call: its provider has a stored
 * key, or it is a custom provider they added.
 * @param {ModelChoice} model
 * @param {ModelPage} page
 */
function isConfiguredChoice(model, page) {
  if (page.keyed?.includes(model.provider) === true) return true;
  return page.providers.some((provider) => provider.id !== "" && provider.id === model.provider);
}

/**
 * One row: choosing the model calls `onChoose`. A configured model also has
 * Test, which asks it for one token and says whether it answered.
 * @param {ModelChoice} model
 * @param {ModelPage | undefined} page
 * @param {{ current: boolean, onChoose: () => void }} choice
 */
function modelChoiceItem(model, page, choice) {
  const item = document.createElement("li");
  const button = make("button", "", modelLabel(model));
  button.type = "button";
  if (choice.current) button.setAttribute("aria-current", "true");
  button.addEventListener("click", choice.onChoose);
  item.append(button);
  if (page !== undefined && isConfiguredChoice(model, page)) {
    item.className = "model-row";
    const test = make("button", "model-test", "Test");
    test.type = "button";
    test.title = "Ask this model for one token, to see whether it answers";
    const status = make("span", "model-test-status", "");
    status.setAttribute("aria-live", "polite");
    test.addEventListener("click", () => void testConfiguredModel(model, test, status));
    item.append(test, status);
  }
  return item;
}

/**
 * @param {ModelChoice} model
 * @param {HTMLButtonElement} button
 * @param {HTMLElement} status
 */
async function testConfiguredModel(model, button, status) {
  button.disabled = true;
  status.textContent = "Testing…";
  status.title = "";
  try {
    /** @type {{ available: boolean, problem?: string, inputTokens: number, outputTokens: number }} */
    const result = await (
      await post("/api/models/test", { provider: model.provider, model: model.id })
    ).json();
    const text = result.available
      ? `Available, ${result.inputTokens} in, ${result.outputTokens} out`
      : (result.problem ?? "Unavailable");
    status.textContent = text;
    status.title = text;
  } catch (cause) {
    const text = describe(cause);
    status.textContent = text;
    status.title = text;
  } finally {
    button.disabled = false;
  }
}

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
    ...models.map((model) =>
      modelChoiceItem(model, modelPage, {
        current: chosenModel?.provider === model.provider && chosenModel.id === model.id,
        onChoose: () => {
          chosenModel = { provider: model.provider, id: model.id };
          const key = /** @type {HTMLInputElement} */ (element("models-key"));
          key.value = "";
          key.placeholder =
            modelPage?.keyed?.includes(model.provider) === true
              ? "Leave blank to keep the stored key"
              : "Paste an API key";
          chosenText();
          renderMatches(/** @type {HTMLInputElement} */ (element("models-search")).value);
        },
      }),
    ),
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
      const card = document.createElement("details");
      card.className = "provider";
      card.open = provider.open === true;
      card.addEventListener("toggle", () => {
        provider.open = card.open;
      });
      const summary = document.createElement("summary");
      const title = () => (provider.id === "" ? "New provider" : provider.id);
      summary.textContent = title();

      const name = document.createElement("input");
      name.type = "text";
      name.value = provider.id;
      name.placeholder = "ollama";
      name.addEventListener("input", () => {
        provider.id = name.value.trim();
        summary.textContent = title();
      });

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
      card.append(summary, nameLabel, urlLabel, apiLabel, keyLabel, modelsLabel, actions);
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
  element("notebook-model-chosen").textContent =
    current === undefined ? "No model chosen yet." : current;
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
    .sort((a, b) => {
      const aCurrent = `${a.provider}/${a.id}` === modelCurrent;
      const bCurrent = `${b.provider}/${b.id}` === modelCurrent;
      if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
      return rank(a, needle) - rank(b, needle);
    });

  const clear = make("button", "", "Use the default");
  clear.type = "button";
  if (modelCurrent === undefined) clear.setAttribute("aria-current", "true");
  clear.addEventListener("click", () => void chooseNotebookModel(""));
  const none = document.createElement("li");
  none.append(clear);

  list.replaceChildren(
    none,
    ...matched.map((model) =>
      modelChoiceItem(model, notebookModels, {
        current: `${model.provider}/${model.id}` === modelCurrent,
        onChoose: () => void chooseNotebookModel(`${model.provider}/${model.id}`),
      }),
    ),
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
  element("modes").hidden = true;
  element("models").hidden = false;
  element("tab-notebook").removeAttribute("aria-current");
  element("tab-modes").removeAttribute("aria-current");
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

/** The notebook page: the directory and whichever notebook or list is open. */
function showNotebook() {
  element("models").hidden = true;
  element("modes").hidden = true;
  element("workspace").hidden = false;
  element("tab-models").removeAttribute("aria-current");
  element("tab-modes").removeAttribute("aria-current");
  element("tab-notebook").setAttribute("aria-current", "page");
  if (!element("list").hidden) void showList();
  else if (watching !== undefined) renderSession();
}

async function openModes() {
  element("workspace").hidden = true;
  element("models").hidden = true;
  element("modes").hidden = false;
  element("tab-notebook").removeAttribute("aria-current");
  element("tab-models").removeAttribute("aria-current");
  element("tab-modes").setAttribute("aria-current", "page");
  element("mode-editor").hidden = true;
  const status = element("modes-status");
  status.textContent = "Loading…";
  try {
    await fetchModes();
    renderOwnModes();
    status.textContent = ownModes.length === 0 ? "No modes of your own yet." : "";
  } catch (cause) {
    status.textContent = `Could not load the modes: ${describe(cause)}`;
  }
}

/** Draws the user's modes, each with a way to change it or remove it. */
function renderOwnModes() {
  element("modes-list").replaceChildren(
    ...ownModes.map((mode) => {
      const item = document.createElement("li");
      const text = document.createElement("div");
      text.append(make("span", "title", mode.name));
      if (mode.problems !== undefined) text.append(make("p", "status", mode.problems.join("\n")));
      const actions = make("div", "modes-actions");
      if (mode.problems === undefined) {
        const edit = make("button", "", "Edit");
        edit.type = "button";
        edit.addEventListener("click", () => openModeEditor(mode));
        actions.append(edit);
      }
      const remove = make("button", "", "Delete");
      remove.type = "button";
      remove.addEventListener("click", () => void deleteMode(mode.name));
      actions.append(remove);
      item.append(text, actions);
      return item;
    }),
  );
}

/**
 * The form for a new mode, or for `mode` when one is being changed.
 * @param {EditableMode} [mode]
 */
function openModeEditor(mode) {
  element("mode-editor").hidden = false;
  element("mode-editor-title").textContent = mode === undefined ? "New mode" : mode.name;
  /** @type {HTMLInputElement} */ (element("mode-name")).value = mode?.name ?? "";
  /** @type {HTMLInputElement} */ (element("mode-model")).value = mode?.model ?? "";
  const limitTools = /** @type {HTMLInputElement} */ (element("mode-limit-tools"));
  limitTools.checked = mode?.tools !== undefined;
  /** @type {HTMLTextAreaElement} */ (element("mode-tools")).value = (mode?.tools ?? []).join("\n");
  const limitSkills = /** @type {HTMLInputElement} */ (element("mode-limit-skills"));
  limitSkills.checked = mode?.skills !== undefined;
  /** @type {HTMLTextAreaElement} */ (element("mode-skills")).value = (mode?.skills ?? []).join(
    "\n",
  );
  /** @type {HTMLTextAreaElement} */ (element("mode-prompt")).value = mode?.prompt ?? "";
  /** @type {HTMLInputElement} */ (element("mode-name")).dataset.original = mode?.name ?? "";
  showModeLists();
  /** @type {HTMLInputElement} */ (element("mode-name")).focus();
}

/** Shows the tool and skill lists only when the mode restricts them. */
function showModeLists() {
  element("mode-tools").hidden = !(
    /** @type {HTMLInputElement} */ (element("mode-limit-tools")).checked
  );
  element("mode-skills").hidden = !(
    /** @type {HTMLInputElement} */ (element("mode-limit-skills")).checked
  );
}

/** @param {string} text */
function linesOf(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** The mode the form describes. */
function modeFromForm() {
  const limitTools = /** @type {HTMLInputElement} */ (element("mode-limit-tools")).checked;
  const limitSkills = /** @type {HTMLInputElement} */ (element("mode-limit-skills")).checked;
  return {
    name: /** @type {HTMLInputElement} */ (element("mode-name")).value.trim(),
    prompt: /** @type {HTMLTextAreaElement} */ (element("mode-prompt")).value,
    model: /** @type {HTMLInputElement} */ (element("mode-model")).value.trim(),
    tools: limitTools
      ? linesOf(/** @type {HTMLTextAreaElement} */ (element("mode-tools")).value)
      : null,
    skills: limitSkills
      ? linesOf(/** @type {HTMLTextAreaElement} */ (element("mode-skills")).value)
      : null,
  };
}

/** @param {Event} event */
async function saveMode(event) {
  event.preventDefault();
  if (element("mode-editor").hidden) return;
  const status = element("modes-status");
  const body = modeFromForm();
  if (body.name === "") {
    status.textContent = "Name the mode.";
    return;
  }
  const original = /** @type {HTMLInputElement} */ (element("mode-name")).dataset.original ?? "";
  status.textContent = "";
  try {
    await post(original === "" ? "/api/modes" : `/api/modes/${encodeURIComponent(original)}`, body);
    element("mode-editor").hidden = true;
    await fetchModes();
    renderOwnModes();
    status.textContent = `Saved ${body.name}.`;
  } catch (cause) {
    status.textContent = `Could not save the mode: ${describe(cause)}`;
  }
}

/** @param {string} name */
async function deleteMode(name) {
  if (!window.confirm(`Delete the mode ${name}? A notebook that names it will no longer run.`)) {
    return;
  }
  const status = element("modes-status");
  status.textContent = "";
  try {
    const response = await request(`/api/modes/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!response.ok) {
      throw new Error((await response.text()).trim() || `The server answered ${response.status}`);
    }
    if (/** @type {HTMLInputElement} */ (element("mode-name")).dataset.original === name) {
      element("mode-editor").hidden = true;
    }
    await fetchModes();
    renderOwnModes();
    status.textContent = ownModes.length === 0 ? "No modes of your own yet." : `Deleted ${name}.`;
  } catch (cause) {
    status.textContent = `Could not delete the mode: ${describe(cause)}`;
  }
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
    open: true,
  });
  renderProviders();
}

element("tab-notebook").addEventListener("click", showNotebook);
element("tab-modes").addEventListener("click", () => void openModes());
element("tab-models").addEventListener("click", () => void openModels());
element("modes-close").addEventListener("click", showNotebook);
element("models-close").addEventListener("click", showNotebook);
element("modes-new").addEventListener("click", () => openModeEditor());
element("modes-form").addEventListener("submit", (event) => void saveMode(event));
element("mode-cancel").addEventListener("click", () => {
  element("mode-editor").hidden = true;
});
element("mode-limit-tools").addEventListener("change", showModeLists);
element("mode-limit-skills").addEventListener("change", showModeLists);
element("notebook-mode").addEventListener("change", () => {
  if (watching === undefined) return;
  void chooseNotebookMode(
    watching.state.notebook,
    /** @type {HTMLSelectElement} */ (element("notebook-mode")),
  );
});
element("notebook-model").addEventListener("click", () => {
  if (watching === undefined) return;
  void openNotebookModel(watching.state.notebook, watching.state.model);
});
element("cell-rounds-close").addEventListener("click", () => {
  /** @type {HTMLDialogElement} */ (element("cell-rounds-dialog")).close();
});
element("notebook-model-cancel").addEventListener("click", () => {
  /** @type {HTMLDialogElement} */ (element("notebook-model-dialog")).close();
});
element("notebook-model-close").addEventListener("click", () => {
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
element("fold-all").addEventListener("click", () => setAllFolded(allExpanded()));
element("run-all").addEventListener("click", () => void startRun());
element("interrupt").addEventListener("click", () => void interrupt());
element("run-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void startRun(undefined, valuesTyped());
});
element("run-stop").addEventListener("click", () => void interrupt());
element("edit").addEventListener("click", beginEditing);
element("file-accept").addEventListener("click", () => void decideOpenFile("accept"));
element("file-reject").addEventListener("click", () => void decideOpenFile("reject"));
element("file-edit").addEventListener("click", beginFileEdit);
element("file-rename").addEventListener("click", () => {
  if (openPane !== "notebook" && !element("file-view").hidden) void renameOtherFile(openPane);
});
element("file-wrap").addEventListener("click", toggleFileWrap);
element("file-save").addEventListener("click", () => void saveFileEdit());
element("file-cancel-edit").addEventListener("click", cancelFileEdit);
element("file-editor").addEventListener("input", () => {
  if (openPane !== "notebook") fileDrafts.set(openPane, fileEditor().value);
});
element("file-close").addEventListener("click", () => {
  if (openPane !== "notebook") closeText(openPane);
});
element("duplicate").addEventListener("click", () => void duplicate());
element("rename").addEventListener("click", () => void renameNotebook());
element("export").addEventListener("click", () => void exportRun());
element("cancel").addEventListener("click", stopEditing);
element("add-prompt").addEventListener("click", () => addCell("prompt"));
element("add-bash").addEventListener("click", () => addCell("bash"));
applyFoldersHidden(storedFoldersHidden());
element("sidebar-toggle").addEventListener("click", () => {
  setFoldersHidden(!element("workspace").classList.contains("folders-hidden"));
});
element("tree-new").addEventListener("click", () => {
  const status = !element("list").hidden
    ? element("status")
    : !element("session").hidden
      ? element("session-status")
      : element("tree-status");
  void newNotebook(status);
});
element("list-new").addEventListener("click", () => void newNotebook(element("status")));
element("editor").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveDraft();
});
window.addEventListener("hashchange", route);
route();
