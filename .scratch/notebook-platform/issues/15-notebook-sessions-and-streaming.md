# 15 — Notebook sessions and event streaming

**What to build:** Opening a notebook creates a notebook session owned by the server, with
its own execution state and an agent session attached. Cells run inside it and every
execution event streams to connected clients as it happens. Several notebook sessions run
at once, so one long run never blocks the rest.

**Blocked by:** 09, 10, 11, 14

**Status:** done

- [x] Opening a notebook creates a notebook session owned by the server rather than by a client
- [x] Running a cell streams its text to the client as it is produced
- [x] Several notebook sessions run concurrently without blocking one another
- [x] A running cell can be interrupted from the client
- [x] Closing the browser does not stop the work

## Comments

**A Notebook Session is the server's, and there is one per Notebook.** `POST /api/sessions`
with `{ "notebook": "reports/audit.md" }` opens the Notebook at that path under the served
directory into a Notebook Session and answers with its state — an id, the path, the title,
whether it is running, and each Cell with its type, where it stands, and what it has said —
`201` when the session was made and `200` when the Notebook was already open, in which case
it is the same session: a Notebook is one file with one set of Run Records beside it, and two
live copies of it would be two Runs writing into one history. The state is there again at
`GET /api/sessions/<id>` for anyone who asks, which is what makes the session the server's
rather than the browser's — nothing about it is held by whoever opened it. A path that climbs
out of the directory or names no file is a `404`, as it is under `/client/`; a file that is
there but does not parse, or has no Cell, is a `422` that says why, since the browser can do
nothing with it yet (ticket 17 may want to show it). `src/server/notebook-session.ts` holds all of
this: `createNotebookSessions({ directory, agent })` is the registry, keyed by resolved path
and by id, and `NotebookSession` is one session with `state()`, `run()`, `interrupt()` and
`subscribe()`.

**Commands are HTTP; what a Run produces is a WebSocket.** `POST /api/sessions/<id>/run`
starts a Run — of the whole Notebook, or of the `cells` named in the body, with `inputs` for
the Notebook's declared Inputs — and answers `202` with the state, or `409` when the session
is already running one, since two Runs would both be appending to one Agent Session.
`POST /api/sessions/<id>/interrupt` stops the Run in progress and answers `204` once it has
stopped — at once when there was none: an interrupt asks that nothing be running, and the
answer is given when nothing is, so a `run` sent on the strength of it is taken rather than
told `409`. A command has an answer, and `fetch` gives it; a Run has a flow, and a browser opens
`ws://…/api/sessions/<id>/events` to hear it. The first message is `{ type: "notebook-session" }`
with the state as it stands, so a browser arriving mid-Run or after one can draw the
Notebook; then `run-started` naming the Cells; then the runner's own `cell-started`,
`cell-text` and `cell-ended` as they happen; then `run-ended` with the Run Record, or
`run-refused` with the runner's sentence when it would not start — a missing Input, an
undecided Workspace — which is how a refusal reaches the browser without the `run` request
having to wait for pi to load the Workspace before answering. The WebSocket is `ws`, the
dependency ticket 14 said this would earn: Node's `http` speaks no framing protocol, and a
hand-rolled RFC 6455 is more surface than the whole server. A WebSocket rather than
server-sent events, which need nothing, because the spec names the WebSocket surface as
the second seam, tickets 18 and 19 build on it, and a browser limits HTTP/1.1 connections
per origin to about six — this very ticket has several Notebook Sessions open at once, and
a tab per session on SSE would run out. The server's `close()` interrupts every Run in
progress and waits for each to write its record before cutting the sockets off and closing,
so nothing outlives the server it runs in and nothing is left half-written behind it; ticket
18 is where a Run outliving a restart begins. The events are emitted from inside the Run, so
a listener that throws — a socket that could not be written to — is reported and passed
over rather than allowed to stop a Cell.

**The runner reports as it goes, and can be stopped.** `RunOptions` grew two options.
`observe` is called with each `RunEvent` — `cell-started`, `cell-text` with a fragment of
the reply, `cell-ended` with the very `CellRecord` the Run Record will carry — so a watcher
that kept every event holds the same account as the record. To make the text a Cell's,
`onText` moved from `createPiAgent`'s options to `TurnOptions`: the runner is the one that
knows which Cell is speaking, and one mechanism is enough, so `octo run` now prints through
`observe` and the pi agent knows nothing of the terminal. The scripted agent speaks a text
turn through `onText` in one piece before resolving, which is the least a real turn
streams; and a `hangs` turn may carry a `text` it says before going quiet, which is what
proves at the runner seam that text arrives while the Cell is still running. A Bash Cell's
output is not spoken and arrives whole with its record, as before.

**Interrupted is a status of its own, beside Timed Out.** `RunOptions.signal` interrupts the
Run where it is: the Cell in flight is stopped through the same signal a timeout uses — the
two are joined with `AbortSignal.any` where the Cell's work begins — and recorded with
`status: "interrupted"` and `error: "Interrupted"`, the timer's word deciding when both
fired. ADR-0017's reasoning carries over unchanged, and its consequences now say so: what
to do about the three differs, and a Cell somebody stopped wants nothing put right. It
halts the Run as the other two do and
leaves its dependents Stale, since a Cell stopped halfway may have half-applied a change.
The scheduler reads the signal before each round of starts and starts nothing after it, so
an interruption that lands between Cells leaves the rest unrun and absent from the record
rather than recorded as anything, exactly as after a failure. `runShellCommand` learned to
honour a signal that has already fired — it spawns nothing and says it was stopped — because
Node's `addEventListener("abort")` never fires for one, and the two agents already did. The
Run Record's `CellStatus` grows the value, a commitment to readers of records on disk, and
`CONTEXT.md` grows the term; `octo run` says "was interrupted" for it, though nothing on the
command line sends the signal yet.

**Each Run in a session is the runner's own, carrying on from the one before.** A Notebook
Session holds no live agent between Runs. It calls `runNotebook` with `continues` set to the
last Run's record, and it is the record's `agentSession` that attaches the Agent Session:
the runner reopens it and forks at the Anchor the re-run Cell began at (ADR-0014), the
same path a headless re-run takes, and `stale` is read off the record the same way. Running
a single Cell is therefore `cells: [id]` on a continued Run, and the state shows what it
left Stale; the server takes it now, and the button for it is ticket 16's. The alternative — an agent kept open across Runs and handed to
each — would have had the runner take a ready-made agent and stop deciding its setup from
the Notebook it has just read, which is what lets a Notebook edited between Runs (ticket
17) run as it now stands. The cost is that pi loads the Workspace's resources per Run rather
than per session, which is a moment, and paid where a Run already spends seconds.

**The client opens a Notebook, runs it, watches it, and stops it.** The list's entries became
links; following one puts the path in the URL's fragment, so a reload opens the same
Notebook again, and `POST`s the session open. The session view is the title, the path,
"Run all" and "Interrupt", and the Cells — id, type, status and output, the status also
marked in colour, since watching a Cell run and stop is what the ticket is for; rendering
the Cells properly, Stale and Errored included, is ticket 16's. Text is appended to the one Cell's output as fragments
arrive rather than redrawing the list, since a redraw per fragment would flicker;
everything else redraws from the state the events keep up to date. A refusal is shown as
the runner's sentence. Still plain files, still checked rather than compiled, and still not
under test: as in ticket 14 it was checked by hand, this time in a browser against the
server with a scripted agent — open, run all, watch the hanging Cell say its piece,
interrupt it, run again, come back after a reload.

**Tested at the two seams the spec names.** `runner.test.ts` gained "watching a run" and
"interrupting a run" at the runner seam: the events and their order, text before the end,
a Bash Cell's output arriving with its record, the Cell in flight recorded as interrupted,
nothing starting after an interruption between Cells, dependents left Stale, an
interruption told from a timeout on a Cell that has one, a command killed with what it had
written kept and one the interruption beat to the start never spawned. `server.test.ts`
drives a real server with `fetch` and Node's own `WebSocket` client, the scripted agent
underneath: opening and its refusals, the events in order, text streamed while the state
says running, results held for a browser that asks later, a continued Run leaving a Cell
Stale, one Run at a time, a refused Run reported, Inputs taken, malformed requests, an
interrupt stopping a turn and a command alike and answering only once the session is at
rest, two sessions running at once with each hearing only its own Run, a browser closing
its socket mid-command and mid-turn with the work going on regardless, and the server's
`close()` stopping a Run and having its record on disk before it resolves.

**Left where it was.** Reconnecting shows the state as it now stands, not what happened in
between — the replay is ticket 18's, as is surviving a restart. Tool calls are in the
record and not yet in the stream; ticket 16 owns the cards. The client has no form for
Inputs, so a Notebook whose Inputs have no defaults is refused with the runner's sentence
until ticket 20's form; the `run` request already takes them. Workspace Trust is left to
what pi has recorded (ADR-0011), and an undecided Workspace is a refusal shown in the
browser; deciding it from the web interface is not yet anyone's ticket. Found on the way,
and not fixed: `anchorBefore` reads only the Run being continued, so after a Run of `[b]`
alone, re-running `a` begins at `b`'s Anchor rather than at the empty context — it does not
follow the `continues` chain. Nothing before this ticket could re-run in two steps, so
nothing met it; the first Author View re-run that does will. `octo.ts` stays the one
untested file.
