# octo

A notebook environment for agents, built on [pi](https://github.com/earendil-works/pi). Work described once as a readable Markdown document becomes something you can run again, hand to someone else, and review in a pull request.

A **notebook** is the file. A **cell** is an addressable unit inside it: a **prompt cell** is addressed to the agent, and a **bash cell** is a shell command that runs without the agent. Ordinary Markdown between cells is prose. Results live beside the notebook, not inside it.

## Requirements

- Node.js 22.19 or newer
- Provider credentials already set up for pi on this machine. Prompt cells run through the pi version this package pins (`@earendil-works/pi-coding-agent`).

## Install

```sh
npm install
npm run build
```

`octo` is the `bin` entry, pointing at `dist/cli/octo.js`. From this checkout, `npm run octo -- …` builds and then runs it. The web flags can omit that `--`: `npm run octo --web --host 0.0.0.0 --port 9000` starts the server the same way `npm run octo -- --web --host 0.0.0.0 --port 9000` does. After `npm link`, or once the package is on `PATH`, the same commands are `octo …`.

## Commands

Invoked with no subcommand, octo is pi. Flags and arguments are handed to the pinned pi, so the terminal experience stays pi's. `octo help`, `octo --help`, and `octo -h` print octo's own usage instead.

### Run a notebook

```sh
npm run octo -- run examples/hello.md
npm run octo -- run examples/greet.md --name Ada
```

Each declared input is a long option named after it: `--name Ada`, not a generic `--input`. `--trust` and `--no-trust` decide whether pi loads the workspace's own settings, skills, and extensions. They are not inputs. Left unset, the decision is whatever pi has already recorded for that workspace.

A run streams prompt-cell text to the terminal and prints where the run record was written. A cell that errors, times out, or is interrupted exits with status 1.

### Web interface

```sh
cd ~/work/reports
npm run octo -- --web
```

The server binds `127.0.0.1` and port `8008` unless told otherwise, and serves the notebooks under the current directory. It prints a URL with a token generated for this start. Opening that URL starts a connection; the token then leaves the address bar and the browser keeps a cookie.

The page has two views of the same notebook. **Author view** shows the cells, for writing and running them. **Run view** shows the inputs as a form and a single button, with the cells hidden. There is one account and no sandbox: anyone who can authenticate can run code as the user who started the server. To reach it from another machine, use an SSH tunnel and leave the server on loopback. See [docs/remote.md](docs/remote.md) before using `--host` or a password.

```sh
npm run octo -- password          # asked for twice; stored under ~/.octo/password
npm run octo -- --web --password  # the browser asks for that password
npm run octo -- --web --port 9000
npm run octo --web --host 0.0.0.0 --port 9000
```

`--web`, `--host`, `--port`, and `--password` reach octo with or without a `--` after `octo`. npm may warn that those flags are unknown settings of its own; the server starts anyway. `run`, `import`, and `export` keep the `--`, so npm passes their arguments through.

Bound to `0.0.0.0` or `::`, the server prints the loopback URL and one URL for each of this machine's network addresses. Open whichever the other machine can reach. The connection is plain HTTP, and anyone who authenticates can run code as you. Read the warning it prints, and [docs/remote.md](docs/remote.md), before leaving it that way.

Closing the browser does not stop a run. Restarting the server recovers each notebook session from its journal.

### Import a chat

A chat is a session pi already had at the terminal. Import copies it into a notebook: a prompt cell for each message you sent, a bash cell for each command you ran with `!`, and a run record of what already happened. Pi's session file is read and never written.

```sh
npm run octo -- import ~/.pi/agent/sessions/<session>.jsonl notes/from-chat.md
```

The web interface lists the workspace's chats and can promote one the same way.

### Export

Export writes one notebook and one of its runs as a single HTML document, with the files that run left embedded in it. The latest run is used unless `--run` names another. Credentials this machine holds are struck out of the document. The notebook file is left as it is, and an existing destination is not overwritten.

```sh
npm run octo -- export examples/hello.md hello.html
npm run octo -- export examples/hello.md hello.html --run <id>
```

## Writing a notebook

YAML frontmatter, then prose and fenced cells. The fence tag is the cell type.

````markdown
---
title: Greet
mode: work
inputs:
  - name: name
    type: string
    default: world
    description: Who to greet
timeout: 5m
---

Say hello, then record that it happened.

```bash id=announce
echo "Greeting {{name}}"
```

```prompt id=greet uses=announce
Say hello to {{name}} in one short sentence.
```
````

Cell ids and input names start with a letter or digit and then use letters, digits, dashes, and underscores.

| Piece | Where it goes |
| --- | --- |
| Input | Frontmatter `inputs`. Types are `string`, `number`, and `boolean`. A missing `default` means the run must be given a value. |
| Input reference | `{{name}}` in a cell body, replaced before the cell runs. `\{{name}}` is literal text. A reference to an undeclared name is an error. |
| Dependency | `uses=other` on the fence, or `uses=scope,review` for several. The author writes every edge. The graph is a DAG, checked when the notebook is parsed. Isolated cells with no edge between them run at the same time. |
| Isolated cell | `isolated` on the fence. The cell runs in a fresh context. Isolation is what allows parallelism; it is separate from `uses`. |
| Model | `model` on the notebook, or on one cell. A cell's model wins. |
| Timeout | `timeout` on the notebook or on one cell, written as a duration: `30s`, `5m`, `1h`. A cell that outruns it is timed out and the run stops. |
| Artifact | `{{artifacts}}` is the directory the run gives that cell. Files left there are kept beside the run record and named by path. |
| Workspace | `workspace` in frontmatter, a directory the notebook operates on. |
| Declared environment | `tools`, `skills`, `packages`, and `pi_version`. Checked before the first cell and never repaired. |

Examples in [examples/](examples/) cover a single prompt (`hello.md`), inputs (`greet.md`), a graph read top-down and run bottom-up (`audit.md`), artifacts (`report.md`), and isolated cells that run at the same time (`survey.md`).

### Modes

A mode is its own Markdown file: frontmatter for a default model, a tool allowlist, and a skill set, and a body that is the system prompt. A notebook names it with `mode` in frontmatter. No run can choose a different one.

Octo ships [modes/code.md](modes/code.md) and [modes/work.md](modes/work.md). Add your own as `~/.octo/modes/<name>.md`. A user file may not override a shipped mode of the same name. A notebook that names no mode runs on pi's defaults.

### Where runs go

Each run is a directory next to the notebook:

```
.octo/runs/<notebook-stem>/<run-id>/record.json
.octo/runs/<notebook-stem>/<run-id>/artifacts/
```

The record holds per-cell status, timings, the model that actually ran, token usage and cost, anchors, and artifact paths. Re-running a cell forks pi's agent session at that cell's anchor. Dependents of a cell that has run again are stale, and so are dependents of a stale cell.

## Develop

```sh
npm test          # vitest
npm run typecheck # server and client
npm run lint      # prettier --check, then typecheck
npm run format
```

The domain language is in [CONTEXT.md](CONTEXT.md). Decisions are in [docs/adr/](docs/adr/). Reaching the server from another machine is in [docs/remote.md](docs/remote.md).
