# 09 — Staleness and selective re-run

**What to build:** Re-running a cell marks exactly the cells reachable from it in the graph
as stale, leaving everything else valid, and a run can target only the stale set. Nothing
downstream re-runs on its own and nothing is discarded; see ADR-0004.

**Blocked by:** 07, 08

**Status:** done

- [x] Re-running a cell marks its graph dependents stale and nothing else
- [x] A cell unrelated to the re-run keeps its previous result
- [x] The stale set is visible in the run record
- [x] Re-running only the stale cells returns the notebook to fully valid
- [x] No dependent runs automatically, and no previous result is deleted

## Comments

**Staleness is read off the Graph when a Run ends, rather than accumulated as it goes.** The
Cells a Run leaves Stale are mostly Cells it never touched, so the question is not what this
Run disturbed but what the Notebook now stands at, and only the whole Graph answers that.
`staleAfter` is a second traversal of the order the Run itself ran in: one pass over
`runOrder`, in which a Cell that ran is as current as the Cells that order put before it, and
a Cell that did not is Stale if anything it depends on has moved underneath it. The Run Record
grows a `stale` list in that order, so `cells: previous.stale` is the whole of the recovery
flow and no new option was needed to express it.

**Staleness propagates, and that is ADR-0015.** ADR-0014 left one question to whoever owned
staleness: a Run naming the first and third Cells of a chain forks at the first Cell's new
turn and never sees the second Cell's, so what does the third count as afterwards. It counts
as Stale, along with the second, because a Cell built on a Stale Cell is itself Stale. That
keeps "fully valid" worth saying, and it makes the Stale set closed under dependents — which
is what lets one Run of that set return the Notebook to valid whatever the Run before it
named. The alternative, refusing the gapped Run, would have made staleness a rule about what
may run rather than a report of what stands.

**A Run that carries on from another names it.** A partial Run's record accounts only for the
Cells it ran, so alone it cannot say where the rest of the Notebook's results are, nor what
its own Stale set was worked out from; `continues` carries the earlier Run's id and answers
both. Nothing is copied forward: an untouched Cell's result stays in the record that produced
it, which is also the whole of the "nothing is deleted" claim, since a re-run writes a new
record and never opens an old one.

**An errored Cell is not a Stale one.** A Cell that ran and failed is Errored, which its own
record already says. What the failure does to staleness is make its dependents Stale, a Cell
they depend on having run again and left them nothing to build on. So the Stale set of a
failed Run is the work below the failure and not the failure itself, and recovering means
retrying that Cell as well as running the set; how much of that happens without being asked is
ticket 11's.

**An empty Stale set says less than it looks like saying.** It says nothing is out of date, not
that every Cell holds a good result. A Cell that has never run and depends on nothing is not
Stale — there is no result of it for anything to have got ahead of — so a Notebook only ever
half run reports nothing Stale, and so does one recovered by running the Stale set while the
Cell that failed underneath it is still Errored. Never-run and Errored are read off the Cells
of the Runs themselves rather than off this set, and reading them along a chain of Runs wants
the record reader nothing has needed yet. Worth saying out loud, because "fully valid" invites
the stronger reading; a worked example pins the never-run Cell so that it stays a decision
rather than a side effect.

**Where the five claims are tested.** All five through `runNotebook` against the scripted
agent, as the spec's primary seam requires: the examples in `runner.test.ts` cover the
dependents of a re-run Cell and nothing besides, the unrelated Cell's result still sitting in
the record that produced it, the Stale set in the record, the return to fully valid, and the
absence of any cascade — the agent is asked one body and one only. Beside them
`staleness.test.ts` asserts the closure generatively: a whole-Notebook Run leaves nothing
Stale, re-running one Cell leaves exactly its dependents Stale (checked against a naive
reachability walk over the generated edges rather than against our own traversal), and one Run
of whatever a partial Run left Stale leaves nothing Stale. It generates three shapes, because
a generator whose Cells each depend on the first Cell directly never shows staleness
travelling further than one edge: over sparse graphs alone, an implementation with propagation
deleted passed all three properties.

**Three things left for the tickets that need them.** Nothing reads a Run Record off disk yet,
as ticket 08 already noted, so a chain of Runs can be followed only inside the process that
made it — `continues` is the thread for whoever adds the reader. Nobody assembles the per-Cell
view an Author View wants, each Cell's latest result and whether it still stands, which is that
reader plus a walk back along the chain and ticket 16's to want. And the command line still
runs whole Notebooks only, so a Run that halts on a failure leaves Cells Stale in its record
that nothing at the terminal mentions; ticket 13's launcher is where a re-run gets a way in
and where saying so belongs.
