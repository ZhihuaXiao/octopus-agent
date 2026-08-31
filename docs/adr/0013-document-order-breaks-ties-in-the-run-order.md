# Document order breaks ties in the run order

Cells run in a topological order of the Graph. Where the Graph leaves two Cells free to run
in either order, the one written first in the Notebook goes first: the next Cell to run is
always the earliest-written one whose Dependencies have all run.

## Considered Options

The edges alone do not settle an order. A Notebook with no `uses` at all admits every
permutation of its Cells, so something other than the Graph has to choose, and the candidates
are the document or the implementation's own convenience. Taking whatever order a `Map`
happens to iterate in would be topologically legitimate and unreadable in practice: the Run
Record's list of Cells would not match the file a reader has open beside it, and it could
change under a refactor that touched no Notebook at all.

Refusing to run an under-determined Notebook was the other option — if the order matters,
declare the edge. It asks for edges that mean nothing. Two Cells that genuinely do not depend
on each other would need a Dependency invented between them to say which runs first, and an
invented edge propagates staleness (ADR-0004) the author never intended, so the Notebook
would end up lying about its Graph in order to be allowed to run.

## Consequences

A Notebook with no declared edges runs top to bottom, which is what its author would guess
from reading it. That is what lets the format be useful before anyone has learned what `uses`
is for, and it is why tickets 02 through 06 could run Cells in document order and be right.

Moving a Cell in the file can change the run order, which is a real edit rather than a
cosmetic one. It can only reorder Cells the edges already left interchangeable, though, so
the move can never violate a Dependency — the worst it can do is reorder two Cells whose
author had said nothing about which came first.

The order is a pure function of the Notebook, so two Runs of one file schedule identically.
Ticket 10's parallelism does not disturb this: it may start independent Cells at the same
time, but the order it reaches them in stays the document's, which keeps a parallel Run's
record readable against the file.
