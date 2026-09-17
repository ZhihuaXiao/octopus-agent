# 18 — Disconnect survival and restart recovery

**What to build:** Losing the browser costs nothing. Work carries on, reconnecting replays
everything that happened while away, and a server restart recovers in-flight notebook
sessions rather than destroying them. This is the whole reason remote mode is worth having.

**Blocked by:** 15

**Status:** done

- [x] Closing the browser mid-run leaves the run going
- [x] Reconnecting shows everything that happened while disconnected
- [x] A server restart recovers open notebook sessions and their run state — what each Run left, not the Run in flight, which is Interrupted
- [x] Recovery reattaches through pi's API and never writes pi's session files concurrently

## Comments

**Every event is numbered, and a browser coming back asks for everything since.** A Notebook
Session numbers what it emits from one, with no gaps, and the number travels on the wire as
`sequence` on each event; the state carries the number of the last event it reflects, so a
browser holding a snapshot knows where it stands too. `ws://…/api/sessions/<id>/events?since=N`
is told every event after `N`, in order, and then whatever comes next — no snapshot first,
since a browser that redrew from one and then heard the same events over would show a Cell's
text twice — and a browser that names no number, or one the session does not know (from the
future, negative, not a number, an empty `since`), is given the snapshot as before, because
it has to start over. The catching up and the subscribing happen in one breath inside the session, so
nothing emitted between them is missed or doubled. The alternative ticket 15 left in place —
a snapshot on every reconnection — folds a refused Run, a Cell made Stale by a later Run and a
Notebook changed on disk into one state, and gives the browser two code paths that must
agree; the replay gives it one, and it is the path pi's own `get_entries` takes with its
`since` cursor.

**The Journal is what a session is made from again.** `server/journal.ts` keeps one file per
Notebook Session under `.octo/journals/<id>.jsonl` beside the served directory: a header
naming the Notebook and the Revision it opened, then each event as the browser hears it with
the moment it was written, appended one line after another and never rewritten, like pi's
own session files. The line is written before the event is sent, and synchronously, as pi
appends its own entries, so that every number a browser has heard names the same event on
disk — sent first, an event could be lost to a crash and its number given on recovery to
another. A line a dying process cut short — one without its line ending, or one that is not
JSON — ends the reading at the line before and is cut off, so what the recovered session
appends begins a line of its own rather than finishing one the next server could not read
past. `startServer` recovers before it listens — so a browser coming back as the server does
finds its session rather than a second one opened beside it — and `createNotebookSessions`,
now async, reads every Journal, opens each Notebook again under the id the Journal is named
by, and has the new session hear its events over through the same reducer the live events go
through; the Run Records were already the authority on what each Run left, and the Journal is
the authority on what the session saw of them. A Journal whose Notebook cannot be opened now —
gone, or broken in an editor while no server ran — is kept, and opening that path later
recovers it, so a Notebook put back is the session it was and never has a second Journal
nobody would read; a recovery that fails halfway leaves the Journal to be tried again for
the same reason. A Notebook that was edited while no server ran is read as it now is, and the
recovered session says so with a `notebook-changed`, since a browser adopting the state it
last had would otherwise go on showing the Notebook as it was. Openings are serialised per
path now, in place of the two racing checks, so that two requests to open one Notebook cannot
make two sessions — or two Journals. The server's `close()` interrupts every Run and waits
for its record, which journals its end, and only then stops; `octo --web` now closes that way
on SIGINT and SIGTERM, so Ctrl-C and a deploy's stop both leave every Notebook Session at rest
for the next server to find, where before they ended the process where it stood. ADR-0021
records why the Journal and not the Run Records or pi's session file, `CONTEXT.md` names the
Journal, and the spec's Persistence section names it as the fourth thing kept.

**A Run the server died in is ended as far as it got.** A Journal that ends with a Run still
in progress is one a crash fell in the middle of, since an orderly close journals the Run's
end. The recovered session records each Cell still in flight as Interrupted — as a Cell
stopped from the browser is, with nothing of the half-reply kept (ADR-0017) but the files it
left in its artifact directory listed, and "The server stopped while this cell was running"
— and concludes the Run as the runner would have: the record's end moved out of `runCells`
into `concludeRun`, which both call, so the Stale set, the standing Anchors and the rule of
naming the Agent Session only once an Anchor stands in it are worked out in one place. The
next Run then continues the crashed one, from the Anchors of the Cells that did end, rather
than the Run before as though these had never run; what the Cells in flight had spent is not
known and is recorded as nothing. For this the runner's `run-started` now carries the
Environment the Run found and the Agent Session it speaks into, which is what the record
would have said at the end; pi writes no session file until a turn has ended in one, which is
the finding the spec left for this ticket, and the rule above is why the recovered record
never names one on the strength of a turn merely begun. A Run whose record the runner did
write — the process dying between that and journaling its end — is concluded with that
record, not a second written over it. The glossary's Interrupted grew "or by the server going
down under it": nothing about such a Cell wants putting right, which is what the status
means.

**Recovery reaches pi only where a Run always did.** Nothing here reads a pi session file and
nothing writes one. The next Run after a restart continues the last Run's record, whose
`agentSession` the runner reopens through `SessionManager.open` and forks at the Anchor, as
every continued Run has since ticket 08; the test asks the scripted agent and sees it asked
to reopen the session the old server's runs were in, and to resume at `undefined` for a first
Cell or at the Anchor `a` left for a crashed `b`. Pi's own locking turns out to cover its
settings, auth and trust files and not its sessions — the spec's note that it holds a lock on
session files was not borne out by 0.84.2 — so two servers serving one directory would each
recover the same sessions and could each run one; nothing prevents that yet, and it is
noted below.

**The client reconnects, and picks up where it left.** The page keeps the number of the last
event it heard, and when its socket closes it says "Lost the connection to the server.
Reconnecting…" and tries again after a second, then two, four, eight, ten and every ten —
from ten at once when the socket never opened, which is a server answering requests but not
sockets and not one to ask every second: it opens the Notebook by path as on first opening,
which a server that kept the session — as one restarted does — answers with the same id, and
then connects with `since`; a different id is a session the page draws afresh; a server that
answers no — the Notebook is gone — is shown as the reason and not retried. The connection is `connect(id, since)` now, one function for
the first socket and every one after. Still plain files, still checked rather than compiled,
and walked in a browser against a server with a scripted agent underneath: open, run a Cell
that speaks and hangs, stop the server with SIGINT and watch the Cell go Interrupted and the
page say it is reconnecting, start a server again over the same directory and see the page
come back to the same session with nothing redrawn, run again and see the Run carry on. The
browser reached the server through a forwarded port, which was slow to notice the server was
back and made the page's retries take minutes rather than seconds; that is the tunnel's, not
the page's, and the page kept retrying until it was through.

**Tested at the server seam the spec names for exactly this.** `server.test.ts` gained "a
browser that comes back" — the numbering and the snapshot's number, what happened while away
told in order and nothing twice, what follows heard with no gap, a browser back where it left
hearing only what follows, and the snapshot for a number the session does not know — and "a
server that restarts": the sessions found under their ids with their results and their Stale
Cells, opening finding that session and not a second, a Run in progress stopped as the server
goes down and recovered as Interrupted, a browser coming back after the restart told what it
missed, the next Run reopening the old Agent Session through the agent boundary, the crash —
the Journal cut where a dying process would have cut it, a half-written line left at its end,
and the record it never wrote removed — recorded as far as it got with the record on disk and
no Agent Session named, read whole by a second restart after that, a browser told how the Run
ended, and the next Run carrying on from a crashed Run's standing Anchors; a
Notebook edited while no server ran shown as it is and announced; a Notebook gone at startup
found again when put back and opened; and nothing written over a directory no server has
served. `runner.test.ts` pins the richer `run-started`. `octo.ts` remains the one untested
file, its signal handling included.

**Left where it was.** Recovering a session's run state means what each Run left, Stale Cells
and standing Anchors included; the Run in flight when the server went down is not resumed,
its Cell being Interrupted, since the process that was running it is gone and pi runs
in-process (ADR-0001). The Journal is unbounded, as pi's session files are: a `notebook-changed`
line carries the whole state and a `run-ended` line the whole record, and all of it is read
on recovery and held in memory for replay. Bounding it — a snapshot and only the events after
— changes how far back a browser may ask, and waits until a journal is seen to cost. Nothing
stops two servers serving one directory from both recovering the same sessions and each
running one into one Agent Session, which is the one way pi's session file could now be
written twice at once; two Journals of one Notebook are noticed on recovery and said so, the
later begun standing. Making a second server deliberate is ticket 19's territory, and the
lock file that would do it is a few lines when it is wanted. A session is never closed, so the
set of Journals only grows. The Snapshot a fresh browser is given, and the number a returning
one brings, are named in the code and not yet in the glossary. What the Cells in flight had spent when the server died is
recorded as nothing. A crash before a Run has named itself — while pi was still loading the
Workspace — leaves nothing in the journal, so the session comes back idle and the Run is
simply one that never was.
