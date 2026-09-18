// @ts-check
/**
 * The client: lists the Notebooks the server can see, opens one into its
 * Notebook Session, and shows the Session as the Author View — the Notebook as
 * written, each Cell as the Notebook declares it, with what running it has
 * produced: its text as it is spoken, each tool the agent invokes as it
 * invokes it, and the files it left — and a way to run one Cell or all of
 * them, or to stop; and, while editing, the whole Notebook as a form —
 * frontmatter, Prose and Cells, to be changed, added, removed and reordered —
 * saved whole, based on the revision it was drawn from.
 *
 * The Session is the server's. This page asks it to run, to stop, or to save,
 * over HTTP, and hears what happens over a WebSocket; closing the page changes
 * nothing about the work. The Notebook opened is kept in the URL's fragment,
 * so a reload opens the same one again. Every event is numbered, and the page
 * keeps the number of the last it heard: when the socket drops — the network
 * went, or the server was restarted — the page reconnects and asks for
 * everything since, so what happened while it was away arrives as it would
 * have, and nothing is drawn twice.
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
 * @typedef {{ kind: "prose", text: string } | { kind: "cell", id: string }} SegmentView
 * @typedef {{
 *   id: string,
 *   notebook: string,
 *   title: string,
 *   revision: string,
 *   frontmatter?: string,
 *   segments: SegmentView[],
 *   running: boolean,
 *   sequence: number,
 *   cells: CellView[],
 * }} NotebookSessionState
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
 *   | { type: "run-refused", error: string }
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
 * the state the events keep up to date, the socket they arrive on, the number
 * of the last event heard — what a reconnection asks for everything since —
 * and the Run in progress once it has named itself, which is what a Cell that
 * starts is running in.
 */
/** @type {{ state: NotebookSessionState, socket: WebSocket, sequence: number, run?: string } | undefined} */
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
  /** @type {HTMLButtonElement} */ (element("run-all")).disabled = state.running;
  /** @type {HTMLButtonElement} */ (element("interrupt")).disabled = !state.running;
  element("edit").hidden = draft !== undefined;
  element("segments").hidden = draft !== undefined;
  element("editor").hidden = draft === undefined;
  // While the Notebook is being edited the draft is what is on the page; the
  // Cells are drawn again from the state once the editing is over.
  if (draft === undefined) element("segments").replaceChildren(...renderSegments(state));
}

/**
 * Appends to one Cell's output without redrawing the rest, since text arrives
 * a fragment at a time and a redraw per fragment would flicker.
 * @param {string} id
 * @param {string} text
 */
function appendText(id, text) {
  const output = element("segments").querySelector(`[data-cell="${id}"] .cell-output`);
  if (output !== null) output.textContent += text;
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
    case "notebook-changed":
      // Saved from here or elsewhere, or found changed on disk: what the
      // session holds now, which is what the next save is based on. A draft
      // on the page is left alone, since it is the author's work in progress.
      watching.state = event.session;
      if (draft !== undefined && !draft.saving && draft.base !== event.session.revision) {
        element("editor-status").textContent =
          `${event.session.notebook} has changed since this draft was begun. Save to write over it, or cancel to see what it holds now.`;
      }
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
    actions.append(
      button("↑", () => swap(at, at - 1), at === 0),
      button("↓", () => swap(at, at + 1), at === segments.length - 1),
      button("Remove", () => segments.splice(at, 1)),
    );
  }

  /** @param {DraftSegment[]} added */
  const insert = (added) => segments.splice(at + 1, 0, ...added);
  /**
   * A Cell with nothing in it yet, with a blank line before it when it would
   * follow another Cell, so the two fences do not abut.
   * @param {"prompt" | "bash"} type
   * @returns {DraftSegment[]}
   */
  const newCell = (type) => {
    const cell = /** @type {DraftCell} */ ({
      kind: "cell",
      id: freshId(),
      type,
      body: "",
      uses: "",
      isolated: false,
      model: "",
      timeout: "",
    });
    return segments[at]?.kind === "cell" ? [{ kind: "prose", text: "\n" }, cell] : [cell];
  };
  const inserts = make("span", "draft-insert", at >= 0 ? "Insert below:" : "Insert at the top:");
  inserts.append(
    button("prompt cell", () => insert(newCell("prompt"))),
    button("bash cell", () => insert(newCell("bash"))),
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
  renderSession();
}

/**
 * Saves the draft, based on the revision the session held when it was begun
 * or last found changed. A save the server would not take is explained where
 * the draft is, and the draft stays for the author to act on: change it, save
 * over what changed on disk, or cancel.
 */
async function saveDraft() {
  if (watching === undefined || draft === undefined) return;
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
    if (draft !== edited || watching?.state.id !== state.id) return;
    if (response.ok) {
      watching.state = /** @type {NotebookSessionState} */ (await response.json());
      stopEditing();
      element("session-status").textContent = "";
      return;
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
  } catch (cause) {
    status.textContent = `Could not save: ${describe(cause)}`;
  } finally {
    edited.saving = false;
    /** @type {HTMLButtonElement} */ (element("save")).disabled = false;
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
    location.hash = `#${encodeURIComponent(made.path)}`;
  } catch (cause) {
    element("session-status").textContent = `Could not duplicate: ${describe(cause)}`;
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
  draft = undefined;
  element("draft").replaceChildren();
  element("editor").hidden = true;
  element("segments").hidden = false;
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
    element("segments").replaceChildren();
    status.textContent = `Could not open the notebook: ${describe(cause)}`;
    return;
  }
  if (asked !== notebook) return;

  watching = { state, socket: connect(state.id), sequence: state.sequence };
  status.textContent = "";
  renderSession();
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
  asked = decodeURIComponent(location.hash.slice(1));
  if (asked === "") {
    watching?.socket.close();
    watching = undefined;
    void showList();
  } else void showSession(asked);
}

element("run-all").addEventListener("click", () => void startRun());
element("interrupt").addEventListener("click", () => void interrupt());
element("edit").addEventListener("click", beginEditing);
element("duplicate").addEventListener("click", () => void duplicate());
element("cancel").addEventListener("click", stopEditing);
element("editor").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveDraft();
});
window.addEventListener("hashchange", route);
route();
