# The Graph is checked when the Notebook is parsed

A `uses` edge naming no Cell, and a cycle among the edges, stop a Notebook from parsing.
Both arrive as Diagnostics carrying a line number, alongside a duplicate id and an unknown
Input Reference, rather than as a refusal issued by the Run.

## Considered Options

The Run already refuses a Notebook whose declared environment is not the one it finds
(ADR-0010), and checking the Graph there too would have kept every reason a Run can decline
to start in a single place. It is the wrong place for this one. What a Run checks is the
machine — a Skill that is not installed, a Workspace that is not there — and the verdict is
allowed to differ between two machines. A cycle is none of that: it is a property of the
bytes in the file, so every Run of that file everywhere would re-derive the same answer.

Parsing is where the Notebook's other self-contained mistakes are already caught, and
catching this one there buys a line number. `uses=reveiw` is a typo, and a typo wants the
line it sits on, which a Run's refusal has no way to give — it reports against the Notebook
as a whole. Ticket 16's editor will want to underline the offending fence, and it can only
do that if this is reported the way the parser reports everything else.

## Consequences

Ordering cannot fail. A parsed Notebook has a closed, acyclic Graph, so the run order is a
total function over it with no error path to design — the same shape ADR-0009 gave
interpolation. Ticket 09's staleness and ticket 10's scheduler traverse a Graph already
known to be acyclic, so neither has to carry a cycle check of its own or decide what to do
when it trips.

A cycle is reported as the chain of Cells that closes it, naming each one, because "this
notebook has a cycle" leaves the author to find it by hand. Which edge to remove is theirs
to choose, so the Diagnostic names the loop and proposes nothing.

The report is bounded rather than complete: one cycle per edge found to close a loop, which
can leave two cycles sharing an edge to be reported one after the other. Enumerating every
distinct cycle is unbounded — a graph can hold vastly more of them than an author would
read — so a Notebook may have to be parsed more than once to see the last of them, and is
refused until there are none. Complete would be better and is not worth being unbounded.

A Notebook with a cycle cannot be loaded at all — not to run it, and not to look at it.
That cost falls on the editor rather than on the runner: ticket 17 cannot open a cyclic
Notebook and let the author break the loop in place, because parsing is all-or-nothing for
every other malformation too. Changing that means a parse that returns a Notebook *and* its
Diagnostics, which is a change to make for all of them at once or not at all.
