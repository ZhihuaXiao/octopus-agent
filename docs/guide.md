# User guide

Octo runs a piece of work you have written down once, so you can run it again, hand it to someone else, and review the write-up in a pull request. The write-up is a **notebook**: a Markdown file. The parts that run are **cells**. Everything a run produces is kept beside the file, not pasted into it.

Two kinds of cell:

- A **prompt cell** is a request to the agent. The agent is [pi](https://github.com/earendil-works/pi), with whatever models and tools this machine already has set up for pi.
- A **bash cell** is a shell command. It runs as written, with no agent and no model cost.

Text between cells is ordinary Markdown. It is there for a person to read. It does not run.

This guide is how to write a notebook and run it. How the program is put together is in [architecture.md](architecture.md). A short overview is in the [README](../README.md).

## Install

You need Node.js 22.19 or newer, and pi's provider credentials already working on this machine. A prompt cell uses the copy of pi this project pins.

From a checkout of this repository:

```sh
npm install
npm run build
```

The examples below use `npm run octo -- …`, which builds if needed and then runs. The web flags can omit that `--`: `npm run octo --web --host 0.0.0.0 --port 9000` starts the server the same way. After `npm link`, the same commands are `octo …`.

`octo` with no subcommand is pi itself, at the terminal. `octo help` prints octo's own commands.

## Run the smallest notebook

[examples/hello.md](../examples/hello.md) is one prompt cell.

```sh
npm run octo -- run examples/hello.md
```

The reply streams to the terminal. When the run finishes, octo prints where it wrote the record, under `.octo/runs/` next to the notebook. If a cell fails, times out, or is stopped, the command exits with status 1 and says which cell.

## Open it in the browser

Start the server from the directory whose notebooks you want to see. The examples live in this repository:

```sh
npm run octo -- --web
```

It listens on `127.0.0.1`, port `8008`, and prints a URL with a token, for example `http://127.0.0.1:8008/?token=…`. Open that URL. The token is used once, then the browser keeps a cookie and the token leaves the address bar.

The server stays running until you stop it. Ctrl-C finishes the runs that are in progress and writes what they had done. Closing the browser tab does not stop a run.

Anyone who can open that URL can run commands as the user who started the server. There is no sandbox. Leave the server on this machine's loopback. To use it from a laptop, forward the port with SSH rather than exposing it. That, and the password option, are in [remote.md](remote.md).

```sh
npm run octo -- --web --port 9000
```

### The notebook list

The page lists every Markdown file under the current directory that parses and contains at least one cell. A README full of shell snippets is not listed. `node_modules` and directories whose names start with a dot are skipped.

Click a notebook to open it. The address bar keeps the path in the fragment, so a reload opens the same one, and a link opens it for someone else who can already reach the server:

- `#examples/hello.md` is author view
- `#run/examples/hello.md` is run view

The title in the header returns to the list.

The left column is the directory. Click a folder to open it and list what is in it: subfolders, notebooks, and other files. A notebook opens when you click it. Any other file is listed so you can see it is there. `node_modules` and directories whose names start with a dot are skipped. The notebook that is open is highlighted, and the folders that lead to it start open. On a narrow screen the column sits above the page instead. Each notebook has a **Model** button. It lists the models whose provider already has a stored API key, and the models from custom providers you added. The one you pick is written into that notebook. **Use the default** clears it, so the notebook uses its mode's model, or pi's default when it names no mode. A cell that names its own model still uses that. **Test**, beside a model, asks it for one token and says whether it answered; it does not change the notebook. The same button sits beside the controls of a notebook you have open. Save or cancel an edit before choosing.

**New notebook**, in the left column or beside the list, asks for a filename (`.md` is added if you leave it off; a path such as `notes/audit.md` makes the folder too) and writes a notebook holding one empty prompt cell. It opens in the editor, ready for you to write the prompt. It never overwrites a file that is already there.

**Models** is the other tab, next to **Notebook**. Open it to change pi's model settings, and close it — **Close**, or the **Notebook** tab — to come back. Search for a model and pick it, then **Save** makes it the default a prompt cell uses when neither the notebook nor the cell names one. **Show configured** limits that list to models whose provider already has a stored API key, and to models from custom providers you added. **Show all** brings the rest back. **Test**, beside a configured model, asks it for one token and says whether it answered. The API key field stores a key for that provider, the same place pi's `/login` writes it; leave it blank to keep a key that is already stored. Custom providers are the ones pi reads from `models.json`. Each is closed until you click its name: then a name, a base URL, an API, an optional key, and one model id per line. For an OpenAI-compatible proxy the API is `openai-completions` and the base URL ends at `/v1`; pi adds `/chat/completions` itself. The Google API's base URL is the version root, such as `https://generativelanguage.googleapis.com/v1beta`, not a chat completions path. Saving writes pi's own files for this user, not the notebook.

Below the notebooks, the page lists chats pi has had in this directory, when there are any. **Promote** turns one into a notebook and leaves pi's session file as it is. **Delete** removes that file, after you confirm; a notebook already made from the chat is kept. See [Make a notebook from a chat](#make-a-notebook-from-a-chat).

If the server restarted, the old cookie is no longer valid. The page asks for the token from the new URL, or for the password if the server was started with `--password`.

### Author view

Author view is the notebook as written. Each cell shows its id, its type, the text you wrote, and — once it has run — what it said, which tools the agent used, and the files it left. **Plain** shows that reply as it was written. **Markdown** renders it: emphasis, lists, headings, links, and code. The choice stays in this browser, and it applies in run view too. Statuses you will see:

| Status | Meaning |
| --- | --- |
| idle | Not run yet |
| running | Running now |
| ok | Finished |
| error | Failed |
| timeout | Ran longer than the notebook allows |
| interrupted | Stopped by you, or by the server shutting down |
| stale | Something it depends on has run again since this cell last ran |

**Run all** runs every cell, in dependency order. **Run** on one cell runs that cell alone and carries on from the last run, so it still sees what earlier cells said. Cells that depend on it are not run again. They are marked stale, which means their previous answer is out of date.

**Interrupt** stops the cell that is running. Cells that had already finished keep their results. Cells that had not started do not run.

**Edit** turns the notebook into a form:

- Frontmatter is the YAML at the top: title, inputs, mode, and the rest.
- Each cell has its type (`prompt` or `bash`), id, `uses`, an isolated checkbox, an optional model, an optional timeout, and its body.
- Prose is the Markdown between cells.

**+ Prompt cell** and **+ Bash cell**, under the last cell, add an empty cell to the end of the notebook. They start editing if you are not already, and put the cursor in the new cell. Nothing is written until you save.

**Insert at the top** and **Insert below** add a prompt cell, a bash cell, or prose. **↑** and **↓** reorder. **Remove** deletes that piece. **Run**, beside Remove and the same size, saves the notebook and runs that cell alone. **Save** writes the file. Only what you changed is rewritten, so a diff stays readable. **Cancel** throws the draft away.

If the file changed on disk, or another browser saved it, while you were editing, the first save is refused. Save again to overwrite that newer copy, or cancel to see what it holds now.

**Duplicate** asks for a new filename and opens the copy. The suggestion is the current name with `-copy` before `.md`.

**Rename** asks for a new filename and moves the notebook to it, runs included. `.md` is added if you leave it off, and a path such as `notes/audit.md` moves it into that folder. It never overwrites a file that is already there, and it waits if a run is in progress.

**Export** downloads one HTML file of this notebook and its latest finished run. Someone can open that file without octo. A notebook that has never been run has nothing to export.

**Run view** hides the cells. See below.

### Run view

Run view is for someone who fills in the blanks and presses one button. The cells' prompts are hidden. Declared inputs are a form: text, a number, or yes/no. A field with no default must be filled in. A notebook with no inputs says so.

**Run** starts the whole notebook. While it runs, the page counts how many cells are done, and each cell shows its reply as it arrives and the files it left. **Stop** interrupts it.

When a run finishes, the page says so in a sentence and, if it did not finish, whether trying again is worth it. A wrong input is yours to correct. A missing tool or a workspace that is not on this computer will not be fixed by running again.

Author view and run view are the same login. A value typed into the form is passed to the cells as typed, including into a shell command.

### Coming back

You can close the tab. The run continues on the server. Open the same address again and the page catches up.

If the connection drops, the page says it is reconnecting and then shows what happened while it was away. Restarting the server prints a new URL. The work is still there: each open notebook is restored, and a run that was in progress when the process died is recorded as interrupted.

## Write a notebook

A notebook is a Markdown file. YAML between `---` lines at the top is the frontmatter. Fenced blocks are cells. Everything else is prose.

````markdown
---
title: Greet
inputs:
  - name: name
    type: string
    default: world
    description: Who to greet
---

Say hello, then record that it happened.

```bash id=announce
echo "Greeting {{name}}"
```

```prompt id=greet uses=announce
Say hello to {{name}} in one short sentence.
```
````

Run it and pass the input by name:

```sh
npm run octo -- run examples/greet.md --name Ada
```

Cell ids and input names start with a letter or digit, then letters, digits, dashes, and underscores.

The examples in [examples/](../examples/) are worth reading in this order: `hello.md` (one prompt), `greet.md` (an input), `audit.md` (written top-down, run bottom-up), `report.md` (files a cell leaves behind), `survey.md` (cells that run at the same time).

### Frontmatter

| Field | What it does |
| --- | --- |
| `title` | The name shown in the browser. The filename is used when this is absent. |
| `mode` | Which preset the agent runs in. See [Modes](#modes). |
| `workspace` | The directory the notebook works in. Relative paths are from the notebook's own directory. `.` is that directory. |
| `model` | The model for prompt cells that do not name their own, written `provider/model`, such as `anthropic/claude-sonnet-4-5`. |
| `inputs` | Named values filled in at run time. See below. |
| `timeout` | How long any cell may run, unless the cell says otherwise. A duration: `30s`, `5m`, `1h`. |
| `tools` | The only tools the agent may use. Absent means the mode's list, or pi's own defaults when there is no mode. |
| `skills` | Skills the notebook cannot run without. They must already be available to pi. |
| `packages` | Packages the notebook cannot run without, named as pi names them. |
| `pi_version` | The exact pi version this notebook expects. A different version refuses to run. |

Octo checks tools, skills, packages, and `pi_version` before the first cell, and does not install anything that is missing. The message names what is absent.

### Inputs

```yaml
inputs:
  - name: target
    type: string
    default: src
    description: The directory to audit
  - name: limit
    type: number
    description: How many files to read
```

Types are `string`, `number`, and `boolean`. Leave out `default` when the run must be given a value. `description` is the hint under the field in run view.

Inside a cell, write `{{target}}`. Octo replaces it before the cell runs. A name the notebook does not declare is an error, so a typo fails immediately instead of being sent to the model as itself. To keep the braces as text, escape them: `\{{target}}`.

`{{artifacts}}` is not an input you declare. It is the directory this cell may write files into. See [Files a cell leaves behind](#files-a-cell-leaves-behind).

On the command line, each input is a flag named after it: `--target docs`, or `--target=docs`. `--trust` and `--no-trust` are not inputs. A notebook may not declare an input with either of those names.

### Cells

The fence's tag is the type.

````markdown
```prompt id=review uses=scope
Review {{target}} and say whether anything looks alarming.
```
````

````markdown
```bash id=scope
echo "Auditing {{target}}"
```
````

A `bash` fence with no `id` is prose, not a cell. That is how a notebook can show a sample command without running it. Give it an `id` when it should run.

Attributes on the opening fence:

| Attribute | Meaning |
| --- | --- |
| `id` | Required for a cell. Unique in the notebook. |
| `uses` | Cells that must finish successfully before this one. Several ids are separated by commas: `uses=naming,tests,comments`. |
| `isolated` | Present or absent. This cell runs in a fresh conversation, not the notebook's shared one. |
| `model` | This cell's model, overriding the notebook and the mode. |
| `timeout` | This cell's limit, overriding the notebook's: `timeout=2m`. |

You choose the order the cells appear in the file. That is the order a person reads. The order they run is decided by `uses`. A report can be written at the top of the file and still run last, because it says `uses=review` and the review says `uses=scope`. [examples/audit.md](../examples/audit.md) is that shape.

Cells with no `uses` between them still run one after another when they share the conversation, because the next prompt can see what the previous one said. Mark a cell `isolated` when it must not see the others, and when it is safe to run beside them. Isolated cells start as soon as the cells they use have finished, including at the same time. [examples/survey.md](../examples/survey.md) runs three readings together, then a summary that uses all three.

An isolated cell does not pass its conversation on. If a later cell needs the work, have the earlier cell write a file and the later cell read it.

A bash cell is for work that should be the same every time: counting files, writing a deterministic note, preparing a directory. A prompt cell is for work you want the agent to do.

### Files a cell leaves behind

Each cell is given a directory, written `{{artifacts}}` in its body. Quote the path in a shell command. Whatever the cell puts there is kept with the run and linked from the browser.

````markdown
```bash id=count
find {{target}} -type f | wc -l > "{{artifacts}}/count.txt"
```
````

````markdown
```prompt id=summary uses=count
Read {{target}} and write a short summary to {{artifacts}}/summary.md.
```
````

Do not paste the result into the notebook. The notebook stays the instructions. The files stay with the run that produced them.

### When a cell runs too long

Set `timeout` on the notebook or on one cell. A cell that exceeds it is timed out, and the run stops. Later cells do not start. Raising the timeout is the usual remedy. A timeout is not the same as a failure: the cell did not finish, but it did not report an error of its own either.

Stopping a run yourself, with **Interrupt**, **Stop**, or Ctrl-C, is recorded as interrupted. Nothing is wrong with the cell. Run it again when you want to.

### The workspace, and whether pi trusts it

`workspace` is the directory the agent and the shell commands operate on. Prompt cells read and write files there. Bash cells run there.

If that directory has its own pi settings, skills, or extensions, pi will not load them until someone decides to trust it. The first run stops and tells you so. Decide once:

```sh
npm run octo -- run notes/audit.md --trust
npm run octo -- run notes/audit.md --no-trust
```

The decision is remembered for that directory. Trusting a workspace loads its settings. It does not restrict what the agent can do.

## Modes

A mode is a preset: a system prompt, a default model, which tools the agent may use, and which skills it is given. The notebook names it in frontmatter, and every run of that notebook uses that mode.

```yaml
mode: work
```

Octo ships two:

- `code` is pi as pi is. No extra system prompt, pi's own tools, every skill pi loads, and the model this machine's pi defaults to.
- `work` is for a document rather than a codebase: a report, a summary, a plan. It uses a fixed model and pi's read, bash, edit, and write tools, and no skills unless the notebook names them.

Add your own as `~/.octo/modes/<name>.md`. The frontmatter holds `model`, `tools`, and `skills`. The rest of the file is the system prompt. Look at [modes/work.md](../modes/work.md) for the shape. A file of yours may not reuse the name `code` or `work`.

A notebook that names no mode runs on pi's defaults.

A cell's `model`, then the notebook's `model`, then the mode's model. The notebook's `tools` replace the mode's when the notebook lists any.

## Where a run is kept

Next to the notebook:

```
.octo/runs/<notebook-name>/<run-id>/record.json
.octo/runs/<notebook-name>/<run-id>/artifacts/<cell-id>/…
```

`record.json` is the account of the run: each cell's status, when it ran, the model, token usage and cost, and the paths of the files it left. The browser reads the same record.

Running one cell again continues that conversation. The new run forks where that cell began last time, so earlier cells are not replayed and their edits to the workspace are not undone. Isolated cells start from an empty conversation every time. After a partial run, cells downstream of one you ran again are stale until you run them too.

## Make a notebook from a chat

Work you already did with pi at the terminal can become a notebook. Octo reads pi's session file and writes:

- a prompt cell for each message you sent
- a bash cell for each command you ran with `!`
- a run record of what those turns already did

Pi's own file is copied and never modified. Later runs of the new notebook continue in the copy.

From the command line, name the session file and the notebook to create. The notebook must not already exist.

```sh
npm run octo -- import ~/.pi/agent/sessions/<session>.jsonl notes/from-chat.md
```

Pi keeps those files under `~/.pi/agent/sessions`. In the browser, start the server in the directory where you had the chat, and press **Promote** on the chat in the list. You are asked for the notebook's filename. The new notebook opens in author view. **Delete**, beside Promote, removes that chat's session file. You are asked to confirm. A notebook already promoted from it is not removed.

## Send the result to someone who will not run it

Export writes one HTML file: the notebook's prose and cells, what each cell said and which files it left, inlined so the file stands alone. Credentials found on this machine are removed from the document. The notebook itself is not changed. If the destination already exists, octo refuses rather than overwriting it.

```sh
npm run octo -- export notes/audit.md audit.html
npm run octo -- export notes/audit.md audit.html --run <run-id>
```

Without `--run`, the latest run is used. In the browser, **Export** downloads that same document for the latest finished run.

## From another computer

Prefer an SSH tunnel, so the server never listens on the network:

```sh
# on the machine that has the notebooks
npm run octo -- --web

# on your laptop
ssh -N -L 8008:127.0.0.1:8008 you@that-machine
```

Open the printed URL on the laptop. `127.0.0.1:8008` there is the server's port.

For a server that a supervisor starts, set a password instead of a token that changes every start:

```sh
npm run octo -- password
npm run octo -- --web --password
```

The password is asked for twice, not echoed, and stored for your user under `~/.octo/password`. The browser asks for it. A wrong guess waits longer each time.

`--host` binds another address. From a checkout, this listens on every interface, on port 9000:

```sh
npm run octo --web --host 0.0.0.0 --port 9000
```

The `--` after `octo` is optional for `--web`, `--host`, `--port`, and `--password`. npm may warn that those flags are unknown settings of its own; the server starts anyway. `run`, `import`, and `export` keep the `--`, so npm passes their arguments through.

Bound to `0.0.0.0` or `::`, the server prints the loopback URL and one URL for each of this machine's network addresses. Open whichever the other machine can reach. Read the warning the server prints, and read [remote.md](remote.md), before you use it. The connection is plain HTTP, and anyone who can authenticate can run code as you.

## When a run will not start

Octo checks the notebook before the first cell, and reports every problem it found rather than stopping at the first. Typical messages:

| What it says | What to do |
| --- | --- |
| An input is missing or the wrong type | Pass `--name value`, or fill in the form. `true` and `false` are the boolean values. |
| No cell named "…" | The id in `uses`, or the cell you asked to run, is not in the file. |
| The workspace is not a directory | Fix `workspace`, or create the directory. |
| A skill, tool, package, or pi version is missing | Install it for pi, or change the notebook. Running again does not install it. |
| The workspace has not been trusted | Run once with `--trust` or `--no-trust`. |
| A cycle, an unknown attribute, or a bad id | The file does not parse. The message includes the line. |
| A mode is not available | The name matches neither a shipped mode nor a file in `~/.octo/modes/`. |

A cell that fails stops the run. Cells already running are allowed to finish. Cells not yet started are left unrun. Fix the cause, then run the remaining cells. In author view, **Run** on a cell runs that cell and carries on from the last successful context.

## Command summary

```text
octo                              pi, at the terminal
octo help                         these commands
octo run <notebook.md> [--trust|--no-trust] [--<input> <value>]...
octo --web [--port <number>] [--host <address>] [--password]
octo password
octo import <session.jsonl> <notebook.md>
octo export <notebook.md> <document.html> [--run <id>]
```
