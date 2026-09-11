// @ts-check
/**
 * The client shell: the page the rest of the web interface is built inside.
 * Today it asks the server which Notebooks it can see and lists them.
 */

/**
 * @typedef {{ path: string, title: string }} NotebookEntry
 * @typedef {{ directory: string, notebooks: NotebookEntry[] }} NotebookList
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
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = entry.title;
  const path = document.createElement("span");
  path.className = "path";
  path.textContent = entry.path;
  item.append(title, path);
  return item;
}

async function main() {
  const status = element("status");
  const directory = element("directory");
  const list = element("notebooks");

  try {
    const found = await fetchNotebooks();
    directory.textContent = found.directory;
    list.replaceChildren(...found.notebooks.map(renderEntry));
    status.textContent =
      found.notebooks.length === 0 ? "No notebooks found in this directory." : "";
  } catch (cause) {
    status.textContent = `Could not list the notebooks: ${
      cause instanceof Error ? cause.message : String(cause)
    }`;
  }
}

void main();
