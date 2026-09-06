# A timeout is declared in the Notebook

How long a Cell may run is written in the Notebook: a `timeout` attribute on the Cell, or a
`timeout` field in the frontmatter for every Cell that does not say otherwise. Either is a
duration with a unit — `30s`, `5m`, `1h` — and a Notebook that writes neither runs each Cell
as long as it takes, exactly as every Notebook did before a timeout could be written. A Cell
that outruns its timeout is stopped and recorded with a status of `timeout`, which halts the
Run as an error would.

## Considered Options

**A default the Run imposes** — ten minutes, say, on every Cell that says nothing — is what
"a headless run cannot wedge forever unnoticed" most directly asks for, and any number chosen
now would be a guess. A survey of a large repository can honestly take an hour; a Cell that
replies with one word should not take a minute. A default long enough for the first is no
protection for the second, and one short enough for the second breaks the first, so the Run
would be enforcing a bound nobody had chosen. The same reasoning kept ADR-0016 from bounding
how many Isolated Cells run at once: a limit nothing asked for is a limit chosen blind.

**A Run option** — `--timeout` on the command line, `timeout` in `RunOptions` — puts the
decision with whoever is running the Notebook rather than whoever wrote it. That is where
Workspace Trust sits (ADR-0011), because a document cannot vouch for the directory it is
pointed at. A timeout is the other way round: how long a Cell should take is a fact about the
Cell's work, which its author knows and a colleague pressing one button in Run View does not.
A Run option would also have every Run of the same Notebook differ in a way its record could
not explain.

**Timing the Run rather than the Cell** is one number instead of one per Cell, and says
nothing about which Cell hung. A Cell's timeout is measured from the moment that Cell starts,
not from the moment the Run did, so a Cell that waited on the shared context or on the Cells
it uses is not charged for the wait.

**A bare number** — `timeout=30` — reads as seconds to one author and milliseconds to another,
and a timeout is the wrong place to be off by a thousand. The unit is required, and a
Notebook written without one is malformed rather than guessed at (ADR-0012).

## Consequences

The format contract grows one attribute and one frontmatter field, both named `timeout`. The
Cell's overrides the Notebook's, in the same way its `model` does.

A timed-out Cell has a status of its own rather than being an error with a particular
message, because what to do about the two differs: a timed-out Cell may want a longer
timeout, an errored one wants whatever went wrong put right. Both halt the Run, both fail it,
and both leave their dependents Stale, since a Cell stopped halfway may have half-applied a
change just as a failed one may have.

A Cell's clock starts when its own work does — after an Isolated Cell's context has been
made, after a continued Run has forked the Agent Session — and not when the Cell was
scheduled, so the Run's own arrangements are not charged to the Cell. And a signal that fires
as the Cell is finishing stops nothing: whether a Cell was stopped is what the agent or the
shell says happened, never what the clock says should have, so a turn that completed in the
last millisecond keeps its result.

Stopping a Prompt Cell asks pi to abort the turn and waits for the agent to come to rest,
which is how a turn that was already changing the Workspace is brought to a known stop rather
than abandoned mid-write. What the agent had said so far is not recorded, since half a reply
is not what the Cell asked for; nor, yet, are the tokens it spent, which is ticket 12's
accounting to add along with the rest of a Cell's cost.

Stopping a Bash Cell kills the whole process group the command was started in, not only the
shell, because `bash -c` forks a child per command of a multi-line body and a child left
running would hold the Cell's output open — the Run would then wait for the child anyway,
which is the hang the timeout exists to end. What the command had written when it was stopped
is kept, as the only account there is of how far it got. The group is killed outright rather
than asked to stop first: a command that has already outrun its time is not owed a chance to
ignore the request. A group of its own is also out of reach of the terminal's Ctrl-C and
outlives a runner that dies, so only a Bash Cell with a timeout is given one; a Bash Cell
nothing will stop early runs in the Run's own group, exactly as it did.

A Notebook that declares no timeout anywhere is not protected from hanging. That is a
deliberate absence rather than an oversight, and the place to change it is a default written
into a Mode's preset (ticket 23), where a number can be chosen for the kind of work rather
than for every Notebook at once.
