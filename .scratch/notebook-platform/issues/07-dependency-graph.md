# 07 — Dependency graph and cycle detection

**What to build:** The `uses` edges declared on cells form a graph, and that graph — not
position in the document — determines what runs and in what order. Edges are always
declared by the author and never inferred; see ADR-0003.

**Blocked by:** 03

**Status:** done

- [x] Cells run in an order consistent with their declared edges regardless of their position in the file
- [x] An edge naming a cell that does not exist is reported before the run starts
- [x] A cycle is reported with the cells involved, and nothing runs
- [x] A notebook with no declared edges runs in document order

## Comments

**The Graph is the parser's business rather than the Run's.** ADR-0012 has the reasoning. A
dangling edge and a cycle are properties of the bytes in the file, not of the machine, so
they join the duplicate id and the unknown Input Reference as Diagnostics carrying a line
number — which is what the declared-environment check in ticket 06 could not have given
them, since it reports against the Notebook as a whole. `uses=reveiw` is a typo and a typo
wants its line, and ticket 16's editor will want to underline the fence.

The payoff is an invariant rather than a message: a parsed Notebook has a closed, acyclic
Graph, so ordering is a total function with no error path. That is the shape ADR-0009 gave
interpolation, and tickets 09 and 10 inherit it — neither the staleness walk nor the
scheduler has to carry a cycle check of its own or decide what to do when it trips.

**Document order breaks the ties.** ADR-0013. The edges alone do not settle an order, so the
next Cell to run is always the earliest-written one whose Dependencies have all run. A
Notebook declaring no edges runs top to bottom, which is what tickets 02 through 06 were
already relying on, and one declaring them is disturbed no further than they require: a Cell
is hoisted above where it sits only when something above it waits for it. The alternative was
to refuse an under-determined Notebook, which asks for edges that mean nothing — and an
invented edge propagates staleness (ADR-0004) the author never intended.

**A cycle is reported as the chain it reads as** — `audit uses review, which uses audit` —
rotated to start at whichever of its Cells the Notebook writes first, so which line it lands
on is a property of the document rather than of where the traversal began. Which edge to
delete is the author's to choose, so the Diagnostic names the loop and proposes nothing.

**Diagnostics are now sorted by line.** The Graph can only be checked once the whole file has
been scanned, since an edge may name a Cell written further down, so its problems would
otherwise be appended below problems from lines above them. An author reads the list against
the file, top to bottom. Stable, so two problems on one line keep the order they were found
in.

**Two older tests had to start meaning something.** The attribute tests in ticket 03 declared
`uses=collect,summarise` against a Notebook holding neither Cell, which was a well-formed
fence and is now a malformed Notebook. They name real Cells now. That is the cost of checking
the Graph at parse time and it is the right cost: the alternative is a format where an
attribute can parse successfully while naming nothing.

**A repeated `uses` entry collapses rather than being reported.** One Cell either depends on
another or does not; there is no second edge it could have declared. Rejecting it was the
first instinct, since it resembles the duplicate id ticket 03 already reports, but nothing
here asked for it and it would narrow ticket 03's settled format contract. The cooked view
already discards the whitespace around these names, so discarding a redundant one is the same
kind of normalisation, and the fence keeps every byte the author wrote either way.

**The property test drives the runner rather than the Graph.** The spec grants exactly one
below-seam exception, for the round-trip, on the grounds that format fidelity is invisible
from above. Run order is not invisible — the Run Record shows it — so it earns no second
exception. The generated Notebooks are Bash Cells running `true`, which keeps them off the
agent and quick enough to run through `runNotebook` itself.

**Three things this does not do.** Cells still run strictly serially even where the Graph
permits two of them to run at once — that is ticket 10, which is why the Graph's order is
exposed as an order rather than as a frontier of ready Cells. Nothing is Stale yet, and no
Run targets a subset; ticket 09 owns that and will walk the same edges in the other
direction. And the Run Record still records Cells in the order they ran without saying that
the order came from the Graph, which is ticket 12's to shape.

**Three weaknesses worth knowing about.** The cycle report is bounded rather than complete:
one per edge found to close a loop, so two cycles sharing an edge surface one after the other
and a badly tangled Notebook may need parsing more than once to see the last of them.
Enumerating every distinct cycle is unbounded, which is worse, and a test pins the behaviour
so that it stays a decision rather than becoming an accident.

A Notebook with a cycle cannot be loaded at all — not to run, and not to look at — because
parsing is all-or-nothing. That falls on ticket 17, which cannot offer to open a cyclic
Notebook and let the author break the loop in place; fixing it means a parse that returns a
Notebook *and* its Diagnostics, which is a change to make for every malformation at once or
not at all.

And a Cell that failed to parse for want of an id is not in the Graph, so an edge naming it
is reported as naming no Cell: a second complaint about a mistake the author is already being
told about, a line or two further up.
