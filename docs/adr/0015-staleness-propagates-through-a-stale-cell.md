# Staleness propagates through a Stale Cell

A Cell is Stale when a Cell it depends on has run again since it last ran, or when a Cell it
depends on is itself Stale. The second clause settles the question ADR-0014 left open: a Run
naming the first and third Cells of a chain, skipping the second, leaves the third Stale as
well as the second — though the third has only just run.

## Considered Options

**Leaving the skipping Cell valid** is what the narrower rule gives, since the Cell it
depends on did not itself run again. It would have a Notebook call itself fully valid while
one of its Cells was built on a Cell that no longer reflects the Cell before it. ADR-0014
makes that concrete: the third Cell forked at the first Cell's new turn and never saw the
second Cell's, so it ran in a context no Run of this Notebook has ever produced end to end.
What a reader would be left holding is "valid, except downstream of anything stale", which is
the staleness question asked a second time and by hand.

**Refusing a Run whose named set has a gap** was the other way out: legislate the recovery
flow and reject everything else. It refuses Runs an author has good reason to want — running
one Cell to see what it does now, without paying again for the Cell before it — and it turns
staleness into a rule about what may run rather than a report of what stands. ADR-0004
already chose reporting over cascading, and this is the same choice one level down.

Propagating costs one clause of a traversal that already walks the Graph in run order, and
the Cells it adds are exactly the ones a reader would have added for themselves.

## Consequences

The Stale set is closed under dependents: nothing outside it depends on anything inside it.
One Run of it therefore returns the Notebook to fully valid, whatever subset the Run before
named and whatever the edges among them. That is the property the recovery flow rests on, and
it is asserted as a property rather than an example.

A Cell that has never run comes out Stale as well, whenever a Cell it depends on has run. A
Run cannot tell "never ran" from "ran before the Run I am carrying on from", since the record
it continues accounts only for the Cells that Run touched — and it does not need to, because
both are put right by running the Cell, which is what the Stale set is for.

An empty Stale set therefore says less than it looks like saying: it says nothing is out of
date, not that every Cell holds a good result. A Cell that has never run and depends on
nothing is not Stale — there is no result of it to have gone out of date — so a Notebook only
ever half run reports nothing Stale, as does one recovered by running the Stale set while the
Cell that failed underneath it is still Errored. Both of those are read off the Cells of the
Runs themselves rather than off this set, and reading them across a chain of Runs wants the
Run Record reader that nothing has yet needed.

A Cell that failed is Errored rather than Stale. Its dependents go Stale, a Cell they depend
on having run again and left them nothing to build on, but the failure itself is a status on
that Cell's own record and not a fourth thing for staleness to mean. So recovering a failed
Run means retrying the failure as well as running the Stale set, and how much of that happens
without being asked is ticket 11's.
