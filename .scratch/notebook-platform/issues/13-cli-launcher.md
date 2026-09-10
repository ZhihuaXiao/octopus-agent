# 13 — CLI launcher

**What to build:** One command with three behaviours. Invoked bare it hands the terminal to
the real pi, so the terminal experience stays pi's own rather than a reimplementation of
it. A run subcommand executes a notebook headlessly. Web flags dispatch to the server
entry point.

**Blocked by:** 01

**Status:** done

- [x] A bare invocation execs pi and the terminal experience is pi's own
- [x] A run subcommand executes a notebook headlessly as established in ticket 02
- [x] Web flags, including a port, are parsed and dispatch to the server
- [x] Unknown flags produce a helpful usage message

## Comments

**The first word decides, and only our own words are read.** `octo` is the command, declared
as the package's `bin` and reachable locally as `npm run octo --`. `octo run <notebook.md>` is
ticket 02's runner behind the argument parsing `arguments.ts` had grown, now folded into
`src/cli/launcher.ts`; `octo --web [--port N]` is the server; `octo --help`, `-h` or `help`
is the usage. Everything else — a bare `octo`, `octo --version`, `octo -p "…"`,
`octo install npm:…` — is handed to pi as written. The alternative, knowing pi's flags so as
to report a mistyped one ourselves, is a copy of pi's command line that would drift with
every one of its releases, which is the reason ADR-0018 gives for not copying pi's retry
classification. So "unknown flags produce a helpful usage message" holds inside `run` and the
web flags, where every flag is ours to know, and a flag pi does not know is reported by pi in
pi's own words — verified against 0.84.2, which rejects an unknown long option once its
extensions are loaded and have said which flags they add, so `octo --wbe` prints pi's
`Unknown option: --wbe` and exits 1 rather than opening pi's prompt. The words pi does not
get are `--help`, `-h` and a first word of `help`: someone typing any of them at `octo` most
wants to know what `octo` does, and the usage says how the rest reaches pi. Inside `run`, a
bare `help` is a Notebook of that name, and only the two flags ask for help.

**"Exec" is a spawn on the same terminal.** Node cannot replace its process the way `exec`
would, so `src/pi/command.ts` starts pi's own `cli.js` — the file the pinned package names
as its `pi` binary — under the running Node with stdin, stdout and stderr inherited, so pi's
interactive mode draws and reads the terminal directly. The terminal's own signals, Ctrl-C
and a hangup, reach pi already, since it shares the process group; the launcher's job is only
not to die of them first, so it waits them out rather than forwarding them, which would have
delivered each twice. `SIGTERM`, which a supervisor aims at the launcher by its id, is passed
on to pi so that nothing is left running behind an empty prompt. The exit status is pi's,
`128 + signal` when a signal ended it, as a shell reports one.
Pi's `main` is exported from its index and could have been called in-process, but pi's own
entry point does more than call `main` — it sets the process title, marks the environment,
silences warnings and configures its HTTP dispatcher — and a hand-off that reproduced that
list would be another copy to keep in step. The entry point is found beside the package's
resolved entry rather than through `node_modules/.bin`, which points at whichever pi is
nearest, not the one pinned here; pi's `dist` layout is not part of its exported surface, so
`src/pi/command.test.ts` runs what was found with `--version` and expects the pinned
`VERSION` back, which is the guard against the layout moving under an upgrade.

**The web flags dispatch to a server that says it is not built.** `src/server/server.ts`
exports `startServer({ port? })`, which is where ticket 14 begins; today it rejects with a
sentence saying so, naming the port it was asked for, rather than leaving a reader to wonder
whether the flag was read. `--port` takes a whole number from 1 to 65535 and is reported
without `--web`, since a port on its own is most likely a `--web` that was forgotten and a
server started on a guess is worse than a sentence. No default port is chosen here; the
usage says the server picks one, and ticket 14 owns the choice.

**`trust` and `no-trust` are reserved Input names, settling what tickets 06 and 12 left —
ADR-0020.** An Input is still written `--name value`, in the Notebook's own vocabulary, and
the run's own two flags still read as flags before anything is taken for an Input. What
changed is that the collision is no longer silent: the parser now reports an Input named
`trust` or `no-trust` when the Notebook is read, as it reports one named `artifacts`, because
a Notebook that cannot be run without ambiguity is wrong when it is written rather than when
it is run. The ADR has the alternatives — a generic `--input`, a positional grammar, resolving
it at the command line — and why each lost. The names live once, as `TRUST_FLAGS` in
`notebook/inputs.ts`, and both the parser and the launcher read them from there. Found on the
way: the old parser looked a flag up by indexing a plain object, so an Input named
`constructor` would have been mistaken for a trust decision; the map cannot be misread that
way and there is a test that such an Input is an Input.

**Exit codes.** A mistake on the command line exits 2 and prints the complaint above the
usage; a Run with a failed or timed-out Cell, or a refusal to run at all, exits 1 as before;
a bare invocation exits as pi did.

**Left where it was.** What `run` prints — the streamed text, the run id and record path,
the failed Cells — is exactly what the tracer's entry point printed, and nothing of cost or
artifacts, which ticket 12 noted are in the record. The entry point `src/cli/octo.ts` is the
one untested file, as `run-notebook.ts` was: it dispatches on a `Command` the tests cover to
functions the tests cover, and stays thin for that reason.
