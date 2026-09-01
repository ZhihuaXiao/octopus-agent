# 08 — Shared context and anchoring

**What to build:** All cells in a notebook share one agent session by default, so a later
cell can say "now do the same for the other files" and be understood. Each executed cell
records the pi entry id it ended at, so that a later re-run can fork the agent session at
exactly the right point rather than replaying from nothing.

**Blocked by:** 02

**Status:** done

- [x] A cell can refer to what an earlier cell did and the agent understands it
- [x] Each executed cell's anchor is recorded in the run record
- [x] Re-running a cell resumes from its predecessor's anchor rather than from an empty context
- [x] The abandoned branch remains present in pi's session rather than being destroyed

## Comments

**The shared Agent Session was already there; what was missing was the way back into it.**
One pi session has served a whole Notebook since ticket 02, so "now do the same for the
others" has worked all along and this ticket only had to prove it. What it did not have was
any way to re-enter that Agent Session partway through. That is the Anchor: every Prompt
Cell now records the pi entry its turn ended on, a Run Record names the Agent Session those
entries live in, and a Run may be told to carry on from an earlier Run — reopening that
session and moving the leaf back to where the Cell it is re-running began.

**Forking rather than replaying, and the reasoning is ADR-0014.** Replaying the earlier
Cells to arrive back at the same context spends their tokens again, re-applies their changes
to a Workspace that already bears them, and does not arrive at the same context anyway,
since none of those turns is deterministic. Reconstructing a history from the Run Record
would make our record the authority on an exchange pi owns, and pi's Agent Session holds
tool results, compactions and model changes that the record does not. Truncating loses the
abandoned turn, which ADR-0004 already refuses to do to downstream work. Pi's Agent Session
is an append-only tree, so moving the leaf and appending is a fork with no deletion in it —
and `navigateTree` with no summary asked for runs no model, so getting back to a Cell's
starting point costs nothing.

**Only a Prompt Cell has an Anchor.** A Bash Cell never enters the Agent Session, so there
is no entry in it for the Cell to point at. `anchorBefore` therefore passes over one: a Cell
whose predecessor in the document was a shell command still begins where the last turn
ended, two or ten places back. The alternative — inventing an Anchor for a Bash Cell so that
every Cell has one — would have been a uniformity bought by lying about the session's shape.
The discriminated Cell Record already told the two kinds apart, so this cost nothing.

**A Run forks once, before the first Prompt Cell it runs.** Every Cell after that follows
the one before, because that is where the conversation now is: forking each of them back to
where it began last time would discard the turn its predecessor had just taken. Right for a
contiguous set of Cells, which is what ticket 09's stale set is. A set with a gap in it gets
one fork and then a straight conversation, so the later Cell sees the re-run of the earlier
one rather than the untouched turn between them. ADR-0014 records that as ticket 09's
question rather than a thing settled here by accident.

**A failed turn anchors nothing, and neither does the Run that held it.** No Anchor is
recorded for a Cell whose turn threw, so a re-run forks at the last Cell that succeeded —
which is the right place, since the failed turn sits on the abandoned branch and the Cell
replacing it has no business seeing it. Following from that, a Run Record names its session
only when some Cell left an Anchor in it. That also sidesteps a trap: pi does not write a
session file until an assistant message arrives, so a Run that named its session on the
strength of having merely tried would have offered a later Run a path to nothing.

**This ticket needed a way to run one Cell, and stopped there.** `RunOptions.cells` names
what to run and nothing is inferred from what it leaves out — no staleness, no carrying
forward of a previous Run's results, no dependents pulled in. The list is filtered through
the Graph's order rather than run in the order given, so ticket 07's ordering still holds
over a subset and the ids may be written in any order. Deciding what belongs in that list is
ticket 09's whole job. Note that naming a subset is not by itself a re-run: without
`continues` those Cells run in a new Agent Session, which is a Notebook run partially rather
than a Notebook resumed. Both are wanted, and the option that tells them apart is the one
that carries the Anchors.

**Where the four claims are tested.** Everything above the boundary — the Anchors in the
record, the Agent Session named, the fork asked for, one fork per Run, the passing-over of a
Bash Cell — is asserted through `runNotebook` against the scripted agent, which grew anchors
and a record of what it was asked to resume from. What pi does is pinned separately in
`session-format.test.ts`, on a session written by hand and navigated with no summary asked
for, so those need no model and run everywhere: the leaf names the entry the last append
landed on, reopening leaves the leaf at the end, navigating back rebuilds the context at the
entry, navigating to the root empties it, and both paths remain afterwards. That file also
drives `createPiAgent` itself far enough to show it reopens the session it is handed and
that both ways of resuming reach somewhere pi accepts.

**One weakness worth knowing about.** That the agent *understands* a reference to an earlier
Cell can only be shown by a model, so it is a live test — which also forks at an anchor and
checks the abandoned turn is still in the session. The live suite is skipped wherever no
provider credentials are configured, including the environment this was built in, so that
one criterion is covered by an assertion that has never been observed to pass. Its mechanism
is covered without a model; the understanding is not, and cannot be.

**And two things left undone.** `continues` takes a Run Record in hand, and `store.ts` still
only writes them — nothing reads one back off disk, so a Run can be continued only inside
the process that ran it. Adding a reader nothing calls seemed worse than naming the gap:
whoever gives re-running a way in needs it, and that is ticket 13's launcher or ticket 15's
server. Which is the second thing: the command line still runs whole Notebooks only.
Ticket 15's live Notebook Session is the setting anchoring was designed for, where the fork
happens in an Agent Session that never closed rather than in one reopened from a file.
