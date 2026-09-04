# 10 — Isolated cells and parallel scheduling

**What to build:** A cell marked isolated runs in a fresh context rather than the
notebook's shared one, which makes it reproducible and safe to run alongside others. The
scheduler runs isolated cells concurrently wherever the graph permits, while shared-context
cells stay strictly serial because they would otherwise both be appending to one message
history.

**Blocked by:** 07, 08

**Status:** done

- [x] An isolated cell sees none of the notebook's shared conversation
- [x] An isolated cell produces the same result on a repeat run given the same inputs
- [x] Isolated cells with no edge between them execute concurrently
- [x] Shared-context cells never execute concurrently with one another
- [x] A cell may be both isolated and declare dependencies, since these are separate axes

## Comments

**An Isolated Cell gets a whole Agent Session, not a fork of the Notebook's, and that is
ADR-0016.** Forking at the root would have given the same fresh context and none of the
parallelism: a fork is still one message history in one session file, which pi locks and
writes serially, so two Cells could no more append to it at once than they can to the shared
one. Making a session per Isolated Cell is also the cheaper change, because it is the
`AgentFactory` called a second time with no session named — `pi.ts` did not have to learn
that Isolated Cells exist, since a session made for one Cell is set up no differently from a
session made for a Notebook.

**Isolation is what parallelism is granted on, for every type of Cell.** The tempting extra
was to run Bash Cells concurrently too, on the grounds that a Bash Cell has no conversation
to share. It shares the Workspace, which two commands can corrupt between them, and an author
who writes two Bash Cells in a row means the second to follow the first. So the rule is one
sentence and holds for both types: an Isolated Cell starts as soon as its Dependencies have
finished, and every other Cell waits for that and for the shared context to be free. A
Notebook that marks nothing Isolated runs exactly as it did before, one Cell at a time.

**The scheduler is its own module and its own seam.** `run/schedule.ts` takes the run order
and a way to run one Cell, and owns three things the runner should not have to interleave:
readiness against the Graph, the shared context's mutual exclusion, and halting. It is the
one place in this ticket tested below the spec's primary seam, because what is being asserted
is when one Cell starts relative to another and a Run Record cannot say that — the test has
to be the thing holding a Cell in flight and watching what starts beside it. Everything else
is driven through `runNotebook` as usual.

**Halting waits for what is already in flight.** Nothing new starts after a Cell fails, but a
turn that has begun is going to reach a provider and change the Workspace whatever the
scheduler does about it, so the Run's account of it is worth waiting for. That makes "the
cells behind a failure" mean the ones that had not started, which is no longer the same as
"the ones written after it": a Cell running beside the failure is recorded, and a Cell
downstream of it is not. Readiness is written as *succeeded* rather than *finished* for the
same reason it is worth saying twice — today the halt is what keeps a dependent off a failed
Cell, and ticket 11's retries are exactly the change that would stop halting being immediate.

**Results come back in run order, never completion order.** A parallel Run's record still
reads top to bottom against the file, which is ADR-0013's promise and worth more than
recording the sequence the clock happened to produce. It does mean the record does not yet
show the overlap at all; per-Cell timings are ticket 12's and are where it becomes visible.

**An Isolated Cell records no Anchor.** Its session is gone when the Cell ends and an Anchor
addresses an entry inside one particular session, so recording one would offer a later Run
somewhere to fork that no longer exists. Everything else followed from that without new code:
`anchorBefore` already passes over a Cell with no Anchor, so a shared Cell after an Isolated
one forks where it should; a Run of nothing but Isolated Cells names no Agent Session,
because the record only names one when something anchored it; and re-running an Isolated Cell
makes another fresh context rather than forking anywhere, which is what reproducible means
here and is the second acceptance criterion in full.

**The scripted agent had to grow from one agent to several.** It is now the factory and a log
across every agent a Run makes, rather than a single object pretending to be both. Each
created agent has its own session name and its own history, so `turns` can say what context
each Cell actually saw — which is what turns "sees none of the shared conversation" into a
behavioural assertion rather than a claim about how many times the factory was called. It
also counts the most turns ever in flight at once, and its turns now yield once before
resolving, because a turn that returns without ever yielding could not be seen to run beside
another however the scheduler started them.

**Two tests prove real concurrency rather than modelled concurrency.** Overlap through the
agent boundary is deterministic but only as honest as the double, so a pair of isolated Bash
Cells each wait on a file the other creates: that run can only finish if the two are genuinely
running at once, and serially the first waits out its bound and fails. Its mirror is a pair of
non-isolated Bash Cells where the first dawdles before appending its line — run concurrently
they come out the other way round.

**Three things this leaves for later tickets.** Nothing bounds the number of Isolated Cells
running at once, so a Notebook with fifty of them makes fifty concurrent provider requests; no
limit is imposed because one chosen now would be a guess. Streaming output from parallel Cells
interleaves at the terminal, which wants a stream per Cell and is ticket 15's. And an Isolated
Cell hands its work on through the Workspace and not through the conversation, since a
Dependency orders Cells without passing results between them — `examples/survey.md` is written
to show that rather than to hide it, and whether an edge should ever carry a result is a
question for whoever wants it.
