# Isolation is what grants a Cell parallelism

A Cell marked Isolated runs in an Agent Session made for it alone, used for its one turn and
disposed with it. Being Isolated is also the only thing a Run grants concurrency on: Isolated
Cells run at the same time wherever the Graph permits, and every other Cell — Prompt Cell and
Bash Cell alike — runs one at a time, in the run order.

## Considered Options

**Forking the shared Agent Session** rather than making a new one is the closest alternative,
and it delivers half of what is wanted. A fork at the root is a fresh context, so the Cell is
as reproducible either way. What it does not deliver is the parallelism: a fork is still one
message history in one session file, which pi holds a lock on and writes serially, and two
Cells appending to it at once is precisely the thing the serial rule exists to prevent. It
would also leave an Isolated Cell's turn inside the Notebook's own session, on a branch a
later Cell could navigate into — so the Cell's context would be private while the Cell's
turn was not.

**Granting concurrency per type instead of per isolation** — running every Bash Cell at once,
since a Bash Cell has no shared context to speak into — costs the author nothing and is wrong. A
Bash Cell shares the Workspace, which is a mutable thing two commands can corrupt between
them, and an author who writes two Bash Cells one after the other means the second to follow
the first. Where they do not, `isolated` is one word to say so, and saying it is cheaper than
debugging a Notebook that has silently started racing.

**Inferring what may overlap** from what each Cell reads and writes is the same offer
ADR-0003 refuses for the edges, and it fails the same way: the observation is of one
non-deterministic run, and a Cell that touched no shared file this time may touch one next
time. Concurrency inferred from a sample is a race waiting for a slow day.

**Scheduling in waves** — every Cell whose Dependencies are satisfied, then a barrier, then
the next batch — is a much shorter scheduler and throws away most of what parallelism buys,
because a wave takes as long as its slowest Cell. A Cell whose Dependencies are met has no
reason to wait for a Cell it does not depend on, so the scheduler starts each one as its own
edges clear.

## Consequences

An Isolated Cell records no Anchor. An Anchor addresses an entry inside one particular Agent
Session (ADR-0014) and this one is discarded when the Cell ends, so recording it would offer
a later Run somewhere to fork that no longer exists. A re-run makes another fresh context
instead, which is the whole of what reproducible means here. A Run of nothing but Isolated
Cells therefore names no Agent Session at all, and an Isolated Cell is passed over when a
shared Cell looks for the Anchor it begins at, exactly as a Bash Cell is.

Isolation says nothing about order. A Cell may be Isolated and declare Dependencies, and it
then waits for them like any other Cell: the Graph decides when it may run and isolation
decides only what it may run beside. The two are separate axes and the scheduler reads both.

The Run Record lists Cells in run order rather than in the order they finished, so a parallel
Run's record still reads against the file the way ADR-0013 promises. What the record does not
yet show is the overlap itself, which becomes visible when ticket 12 adds per-Cell timings.

Each Isolated Cell costs a session setup, which is pi loading the Workspace's resources over
again. Real, and small beside a turn.

Nothing bounds how many Isolated Cells run at once. A Notebook with fifty of them opens fifty
sessions and makes fifty concurrent provider requests, which is a way to meet a rate limit.
No limit is imposed until something asks for one, because a limit chosen now would be a guess
and the Notebooks that exist have single-figure Cell counts.

Output from Cells running at the same time interleaves, and the command line writes it
straight to the terminal. Legible streaming from a parallel Run wants a stream per Cell,
which is ticket 15's, and until then a Notebook watched at a terminal reads best when its
Isolated Cells are few.

A Notebook that marks nothing Isolated runs exactly as it did before any of this: one Cell at
a time, in document order wherever the edges leave the choice open.
