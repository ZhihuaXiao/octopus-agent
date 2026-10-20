# A Notebook Session is recovered from its own Journal, never from pi's session file

Every event a Notebook Session emits is numbered, from one with no gaps, and appended to a
Journal of its own on disk before it reaches anyone watching. The Journal is the one thing a
Notebook Session is made from again: a server that starts reads the Journals the one before it
left, opens each Notebook into a session under the id it had, and hears the events over, so
the session stands where it stood. A browser that comes back — after its connection dropped,
or after the server's restart — says the number of the last event it heard and is told every
event since, in order, exactly as it would have heard them.

## Considered Options

**A snapshot on reconnecting**, which is what ticket 15 left in place, tells a browser where
the session stands but not what happened: a Run that was refused while the browser was away,
a Cell that ended and was made Stale again by a later Run, a Notebook that changed — all
arrive folded into one state, with the browser left to draw it whole and lose whatever it
was showing. It also gives the browser two code paths, one for events and one for states,
that must agree; a replay gives it one.

**Recovering from the Run Records** works for what a Run wrote — which Cells hold which
results, what is Stale, where the Anchors stand — since a record is written when a Run ends
and the chain of `continues` leads back through them. It says nothing about a Run that did
not end, which is the Run a crash falls in the middle of: its finished Cells' records are in
memory and nowhere else, so the work they did is lost from view though the Workspace bears
it and the Agent Session holds their turns. And it cannot serve a reconnecting browser,
which wants events and not records.

**Recovering from pi's session file** is the temptation once the Run Records fall short,
because the file has every turn that was taken. It is pi's — its format is versioned and
migrated by pi, and the spec is plain that it is to be read if useful and reattached to
through pi's API, never written concurrently — and it is the Agent Session, not the Run: it
holds no Cell ids, no timings, no Bash Cell's output, and a Cell whose turn was mid-flight
when the process died has no entry to be recovered from. Reading it would also make our
account of a Run depend on pi's account of the Agent Session, which ADR-0014 already
declined for reconstruction.

**A Journal of the session's own events** costs a file per session and a line per event, and
buys both things at once with one mechanism: replayed to a browser it is what the browser
missed, and replayed to a new session it is what the old one knew. The Run Records stay the
authority on what each Run left, the Journal on what the session saw of it, and pi's file on
the Agent Session; none is derived from another.

## Consequences

The line is written before the event is sent, and synchronously, as pi appends its own
entries: a browser asks for everything since a number, so every number it has heard must
name the same event in the Journal, and an event sent before it was on disk could be lost
to a crash and its number given to another. The cost is a small write on the event loop per
event, which pi already pays per entry. A line that cannot be written is not sent and its
number is not kept. That Notebook Session stops taking new work. A Run already going is
stopped in memory and left unfinished on disk, and the next command that would append tries
the write: when it succeeds, the Run is journaled as Interrupted, the same conclusion a
restart would write, and then the command proceeds. Other notebooks are not affected. A
browser that reconnects before the write succeeds is told the last line that landed.

A Journal that ends in a Run still in progress is a Run the process died in, since a server
closing in an orderly way interrupts its Runs and journals their end before it stops. The
recovered session ends the Run as far as it got: each Cell still in flight is recorded as
Interrupted — as a Cell stopped from the browser is, with nothing of the half-reply kept
(ADR-0017) but the files it left in its artifact directory listed — and the Run is concluded
as the runner would have concluded it, by the same function, so that the next Run continues
it from the Anchors of the Cells that did end rather than the Run before, as though these had
never run. For this the runner says at `run-started` what it would otherwise say only in the
record: the Environment it found and the Agent Session it speaks into. Concluding keeps the
runner's rule of naming the Agent Session only when an Anchor stands in it, since pi writes no
session file until a turn has ended in one. What the Cells in flight had spent is not known
and is recorded as nothing, which is the one figure in such a record that is not what
happened. A Run whose record the runner did write, the process dying between that and the
journaling of its end, is concluded with that record rather than a second one written over
it.

The Journal is a persisted format beside the Run Record, and a commitment in the same way:
under `.octo/journals/<id>.jsonl` beside the served directory, its lines are the events as the
browser hears them, with the moment each was written, under a header naming the Notebook and
the Revision the session opened. It is append-only like pi's own, and a line cut short by a
dying process — one without its line ending, or one that is not JSON — ends the reading at
the line before and is cut off, so that what the recovered session appends begins a line of
its own.

Recovery reaches pi only where a Run always did: the next Run reopens the Agent Session the
record names through `SessionManager.open`, and forks it at an Anchor. Nothing here reads a
pi session file, and nothing writes one; two servers serving one directory would both
recover the same sessions and could each run one, and neither this decision nor pi's own
locking — which covers its settings, auth and trust, not its sessions — prevents it. That is
a matter for whoever makes a second server deliberate, which ticket 19 begins.

The Journal is unbounded, as pi's session file is. A `notebook-changed` line carries the
whole state and a `run-ended` line the whole record, so a session saved and run many times
has a Journal in the megabytes, all of it read on recovery and held for replay. Bounding it
— replaying from a snapshot and only the events after — is a change to how far back a
browser may ask, and is left until a Journal is seen to be a cost.
