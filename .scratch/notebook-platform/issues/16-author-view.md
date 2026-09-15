# 16 — Author View: cells, tool-call cards, artifacts

**What to build:** The browser renders the notebook as cells with live output, showing what
the agent actually did rather than only what it says it did, and rendering the files it
produced so nobody has to go looking for them.

**Blocked by:** 12, 15

**Status:** done

- [x] Cells render with their type, output and current state, including stale and errored
- [x] Tool calls appear as they happen, showing what was invoked
- [x] Images produced by a run render inline
- [x] Other generated files appear as links to the artifact location
- [x] A single cell can be run from the UI

## Comments

**A Cell is shown as the Notebook declares it, and then as running it went.** `CellView`
grew the declaration: the `body` as written, `uses`, `isolated`, and the Cell's own `model`
and `timeout` when it names them — an Author View that hid the prompt would be a Run View
with the Cells' names on it. The header carries the id, the type, those attributes as small
monospace badges, the status in colour, and a Run button; below it the body, then the
tool-call cards, then what the Cell said, then why it did not succeed, then the files it
left. Stale is purple, Interrupted amber — nothing about it wants putting right, so its
"Interrupted" is not painted the red an error is — and Errored and Timed Out red, as they
were. The view is a projection of the record and nothing more: no field is invented for
the browser that the record or the Notebook does not already hold.

**Tool calls stream through the same seams the text does.** `TurnOptions` grew `onToolCall`
beside `onText`; `pi.ts` fires it from pi's `tool_execution_start`, with the validated
arguments, which is the same call `summariseTurn` reads off the message afterwards; the
scripted agent announces a turn's `toolCalls` one at a time before speaking its text, as
pi's tools run before its reply, and a `hangs` turn may carry calls too, which is how "a
tool call arrives while the Cell is still running" is proved at both seams. The runner
reports each as `cell-tool-call` with the Cell's id and the call, the Notebook Session keeps
them against the Cell in flight and reads them off the record once it is over, and the
browser draws a card per call — appended as it arrives, as text is, rather than redrawn —
with the tool's name and a one-line gist (the command, the path, or the first string it was
given), and the whole input as JSON under a disclosure. Ticket 12's worry about a `write`
call carrying a whole file is answered in the card rather than the record: strings past 400
characters are cut with a count of what was cut, so the record keeps what ADR-0005 lets it
keep and the page shows what was invoked. Nothing yet says whether a call errored: pi's
`tool_execution_end` has it, but `ToolCall` in the record does not, and adding a field to
the record for the sake of a badge is a commitment worth making on its own.

**The Run names itself first, so the browser knows where a Cell's files are before the record
arrives.** A Cell's Artifacts are paths relative to its Run's directory, and the Run's id was
chosen inside the runner where nothing above it could hear; so `RunEvent` grew
`run-started`, emitted once the Notebook is cleared to run, with the id the record will
carry and the Cells in the order they will run. The Notebook Session passes it through in
place of the `run-started` it used to make up itself — same event, better information, and
the runner rather than the session is now the one that says a Run has begun — and reads the
id off it so each `CellView` can say which Run it is from: `run` beside `artifacts`. Since
the runner names itself only once the agent is set up, which with pi is a moment, the page
turns its buttons on hearing the `202` rather than waiting for the socket. A refused Run
never names itself and arrives as `run-refused` alone, as before.

**The server serves what a Run left from under the Run's directory.**
`GET /api/sessions/<id>/runs/<run>/<path>` answers with the file at `path` under that Run's
directory — `artifacts/<cell>/chart.png` as the record names it, or `record.json` — and the
browser builds the URL from the Cell's `run` and each artifact path; a browser arriving
between Cells learns the Run in progress from the state's `run`. `store.ts` owns which file
the pair names, in `runFile`: nothing when the run's name or the path climbs out, spelt
however, checked with `util/paths.ts`'s `within`, which the notebook path and the client
files are now checked with too; and nothing for a link a Cell left pointing out of the Run's
directory, since the path is followed to where it really is before it is said to be inside.
Images — PNG, JPEG, GIF, WebP — are served as what they are and the page draws them inline;
`.txt`, `.md`, `.csv`, `.log` as plain text and `.json` as JSON, so a link opens in the
browser; anything else, HTML and SVG included, is `application/octet-stream` with a
`content-disposition: attachment` — the name spelt as `filename*` beside an ASCII fallback,
a header carrying nothing else as written — and every answer says `nosniff`. The files a Run leaves
share an origin with the client, and a page an agent wrote, served as a page, could read
whatever the client holds — ticket 19's token to begin with. Nothing an agent wrote is ever
run by the browser that shows it.

**A Cell runs alone from its own button, and running it twice keeps its context.** The button
posts `cells: [id]` to the `run` the server already took, which continues from the last Run
as ticket 15 arranged. Doing it twice over met the defect ticket 15 found and left: a Run of
`[b]` alone has nothing before `b` in its own record, so `anchorBefore` gave the second
re-run nothing and dropped `b` into an empty context. The Run Record now carries `anchors`,
the Anchors standing after it — the continued Run's with its own laid over, accumulated
through the chain as `stale` is — and `anchorBefore` searches those in Run order rather than
one record's Cells; ADR-0014's consequences say so. The same change puts a re-run of a failed
Cell back where the failed turn began, which ADR-0014 promised and the single-record search
could not deliver once the Run before was out of hand, and it keeps a Run of Bash Cells alone
naming the Agent Session it carried on from, so the Run after it still has one to reopen.
`forkedAt`, the first cut at this, went: one Anchor said where a Run began and nothing about
Cells it did not run, so `[b]` then `[a]` put `a` after the new `b` instead of first.

**Tested at the two seams the spec names, and looked at.** `runner.test.ts` gained the
`run-started` event first with the record's id and the Graph's order, tool calls reported in
order before the Cell ends and matching the record's, a call heard while the Cell still
runs, and under "anchoring" the standing Anchors recorded and laid over the continued Run's,
a same-Cell re-run twice over landing where it did the first time, a Cell that runs first
beginning empty however many Runs since, a failed Cell's re-run put back, and a Bash-only Run
carrying the Agent Session forward. `server.test.ts` pins the full `CellView` shape on
opening, the declared attributes and their absence, `run-started` naming the record's id and
each Cell saying its Run, the state naming the Run in progress to a browser arriving between
Cells, tool calls streamed mid-Cell and held in the state for a browser that asks during and
after, and under "the files a run leaves" a Bash Cell that writes a one-pixel PNG, an HTML
page, a page named in Chinese, a note and a link to `/`: named against the Cell with its Run,
the PNG served byte-for-byte as `image/png`, the note as text and the record as JSON, the
page as a download, the Chinese name as `filename*`, the link answered with nothing,
encoded-slash climbs in the run's name and the file's refused along with a NUL, a directory,
an absent file and a Run that never was, and the route taking nothing but a read. The client is still not under test, but this
time it was walked in a headless Chromium against a server with a scripted agent underneath
— open, run all, open a card, run one Cell that invokes a tool and hangs, interrupt it,
reload — and the image was seen to load. Still plain files and no bundler: the script is
some five hundred lines and reads top to bottom, and the moment to bundle has not come.

**Left where it was.** Prose between Cells is not shown; the Author View is the Cells, and
showing the document around them is ticket 17's, which is where the body becomes editable
too. The command line hears `run-started` and `cell-tool-call` and prints neither. A tool
call's result and whether it errored are not on the record and so not on the card. An
Isolated Cell's Anchor is dropped as before, so its re-run makes a fresh context, which is
the point of it. Reconnecting mid-Run still shows the state as it stands rather than
replaying what was missed, which is ticket 18's. `octo.ts` remains the one untested file.
