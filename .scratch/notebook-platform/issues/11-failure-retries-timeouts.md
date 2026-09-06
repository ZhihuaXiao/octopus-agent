# 11 — Failure handling, retries, and timeouts

**What to build:** A failing cell halts the run rather than letting later work build on a
partially-applied change. Transient provider and transport errors retry, because they are
the only failure class worth retrying automatically. A cell that hangs times out, so a
headless run cannot wedge forever unnoticed.

**Blocked by:** 07

**Status:** done

- [x] A failed cell is marked errored and the run halts
- [x] Dependents of a failed cell are left stale rather than executed
- [x] Provider and transport errors are retried, and the retries appear in the run record
- [x] A cell exceeding its timeout is aborted and reported as a timeout rather than a generic failure
- [x] The run exits with a non-zero status when any cell failed

## Comments

**The first two criteria were already true, and are left as they were.** Halting on a failed
Cell and leaving its dependents Stale arrived with the scheduler in ticket 10 and the Stale
set in ticket 09; both have tests at the runner seam, and this ticket added nothing to them
beyond making a timed-out Cell halt the same way. What it did find was that the halt was not
reachable from a real provider: see the fourth comment.

**Retries are pi's, and the Run records them — ADR-0018.** The spec already said pi
retries transient errors on its own, and it does: three attempts with exponential backoff, on
a classification of provider and transport messages maintained upstream. A runner that retried
on top would be a second loop around the first, multiplying the wait for no new class of
error, and one that replaced pi's would be a drifting copy of pi's list. So the agent boundary
grew a `retries` field — each attempt pi gave up on, with what it failed with — filled from
pi's `auto_retry_start` events, and a `TurnFailure` error that carries the same list when the
turn fails all the same. The record shows `retries: []` on every Prompt Cell rather than
omitting it, so a reader can tell "none" from "not recorded". Bash Cells have no such field: a
command that failed did what it was told, and running it again is a reader's decision.

**A timeout is written in the Notebook — ADR-0017.** Both a `timeout` attribute on a Cell and
a `timeout` frontmatter field for every Cell that does not say otherwise, as a duration with a
required unit. Not a Run option, because how long a Cell should take is a fact about the
Cell's work that its author knows and a colleague in Run View does not; and not a default the
Run imposes, because any number chosen now is a guess that is too long for a one-word reply
and too short for an hour-long survey. A Notebook that writes no timeout runs as long as it
takes, exactly as before, and the place to change that is a Mode's preset in ticket 23. This
extends the spec's format contract by one attribute and one field. A `duration.ts` module
reads and writes `30s`, `5m`, `1h`, `250ms`; a bare `30` is malformed.

**Pi does not throw when a provider fails, and until now the Run did not notice.** The turn
resolves and its last assistant message says `stopReason: "error"` — after pi's retries are
spent — and `pi.ts` was reading the text, usage and anchor off that turn and recording the Cell
as `ok` with nothing to say. It now reads the stop reason and rejects with a `TurnFailure`
carrying the retries, which is what makes the halt-on-failure the first criterion promises
actually reachable from a real provider. The scripted agent had this right all along because
its failures were written as throws, which is a reminder of what a double can and cannot
prove.

**A timed-out Cell has a status of its own.** `CellStatus` is now `ok | error | timeout`,
rather than `error` with a particular message, because what to do next differs: a timed-out
Cell may want a longer timeout and an errored one wants whatever went wrong put right. Every
place that read `=== "error"` now reads `!== "ok"` — the scheduler's halt, the command line's
exit status — so nothing is built on a Cell that was stopped halfway.

**Stopping a Prompt Cell is `AbortSignal` in, `session.abort()` out.** The runner makes an
`AbortSignal.timeout` when the Cell's own work starts — after an Isolated Cell's context is
made and after a continued Run's fork, not when the Cell was scheduled, so a Cell is charged
neither for the Run's arrangements nor for waiting on the shared context — and passes it
through the boundary. `pi.ts` calls `session.abort()`, which stops the run pi has in hand and
waits for the agent to come to rest, after which `prompt` resolves. Two traps in pi: `abort`
is a no-op when pi has no run active, and pi checks credentials before starting one, so a
signal that fires in that gap is re-issued on pi's `agent_start` event; and a turn stopped
while pi was sleeping before a retry leaves no message saying so. So whether the turn was
stopped is a fact the agent states — `TurnFailure.aborted`, set only when `abort` found a run
in hand — rather than something the runner reads off the signal afterwards, which would have
thrown away a turn that finished in the last millisecond as a timeout. The scripted agent
gained a `{ hangs: true }` turn that comes back only when told to stop, and a log of which
turns were.

**Stopping a Bash Cell kills the process group, not the shell.** `bash -c` becomes a
single-command body outright but forks a child per command of a multi-line one, so killing bash
alone leaves the children running — and holding the Cell's stdout open, so the Run would wait
for them anyway. A Bash Cell with a timeout is spawned `detached`, which on Linux makes it a
group leader, and stopped with `SIGKILL` to the negative of its pid; the shell reports
`stopped` only when the command was still running to be stopped, so a command that exited as
the timer fired keeps its exit. The test for the group kill is a body of `echo started; sleep
5; echo finished` under a 100ms timeout, which fails in five seconds with `finished` in its
output when the group kill is removed; that was checked. A group of its own is out of reach of
the terminal's Ctrl-C and outlives a runner that dies, which is why only a Bash Cell with a
timeout is given one — every other Bash Cell runs in the Run's own group exactly as before —
and worth knowing about when ticket 14's server owns the process.

**What the review changed.** The two-axis review caught three things worth recording. The
first draft read the signal after the fact, for both kinds of Cell, and so would have recorded
a Cell that finished as its timer fired as timed out; both paths now report whether anything
was actually stopped. The first draft made every Bash Cell a group leader, timeout or not,
which took every one of them out of reach of Ctrl-C for the sake of the few with a timeout.
And a duration had no ceiling, when Node clamps a timer above 2³¹−1 ms to one millisecond and
a Cell allowed a month would have timed out at once; a duration is now a whole number of
milliseconds under 25 days, and the rule says so.

**Three things this leaves for later.** The live suite gained a test for `abort` bringing a
turn to rest, but no credentials were present where this was built, so it is written
conservatively and unverified against a provider until someone with a key runs it; the same
goes for `pi.ts` reading `stopReason` and `auto_retry_start`, which the scripted agent cannot
reach. The command line's exit status has no test at any seam, there being no harness for
`run-notebook.ts`; it was checked by hand against a timed-out Bash Cell and exits 1. And pi's
retry budget is the machine's setting rather than the Notebook's, which ADR-0018 defends and
which means a Notebook cannot ask for more patience than it is run with; if that turns out to
matter, `settingsManager.applyOverrides` is where it would go.
