# A re-run forks the Agent Session at an Anchor rather than replaying it

Every Prompt Cell records the pi entry its turn ended on. Running a Cell again moves the
Agent Session back to the Anchor its predecessor recorded and takes the new turn from
there, so the Cell sees the context it saw the first time. The path being left behind stays
in the Agent Session as a branch.

## Considered Options

**Replaying** — running the earlier Cells again so that their turns arrive back where they
were — is the obvious alternative, and it fails three ways at once. It spends those Cells'
tokens a second time, which is the cost re-running one Cell exists to avoid. It re-applies
their changes to a Workspace that already bears them, and an agent's turn is frequently a
partial success with side effects already on disk (ADR-0004), so re-applying it is how a
Workspace gets corrupted. And it does not arrive back where it was anyway: none of those
turns is deterministic, so a replay produces something that merely resembles what was
recorded.

**Reconstructing** — handing pi a message history assembled from the Run Record instead of
from its own Agent Session — is cheap and lands on exactly the recorded text. It also makes
our record the authority on an exchange pi owns, which it is not. Pi's Agent Session holds
tool calls, tool results, compaction summaries and model changes that a Run Record does
not, so this means keeping a second copy of pi's message format in step with pi's own, on
top of what pinning already costs us.

**Truncating** — discarding the entries past the Anchor, which is what a rewind would be —
loses the abandoned turn. ADR-0004 already refuses to throw downstream work away when a
Cell is re-run, and a transcript is work: it is the only account of what the agent did to
the Workspace, and the Workspace bears those changes whether or not the Agent Session still
admits to them.

Forking asks pi for what pi's Agent Session already is. It is an append-only tree in which
a branch exists wherever two entries share a parent, so moving the leaf and appending is a
fork with no deletion in it — and pi is asked to navigate without summarising the abandoned
path, so getting back to an Anchor runs no model and costs nothing.

## Consequences

An Anchor addresses an entry inside one particular Agent Session, so a Run Record names the
Agent Session it ran in and a Run continuing it reopens that one rather than starting a
fresh one. A Notebook of Bash Cells therefore names none, having said nothing to the agent;
and a session file that is moved or deleted takes its Runs' Anchors with it. Those Run
Records survive and can still be read — they just cannot be resumed.

A Cell that failed records no Anchor, so a re-run forks at the last Cell that succeeded.
That is the right place. The failed turn is in the Agent Session, on the abandoned branch,
and the Cell replacing it has no business seeing it.

The Agent Session accumulates every abandoned branch, which is the price of losing nothing.
Pi already carries that cost for its own users navigating an entry tree, and ticket 21's
import is where a session's size becomes something anybody has to look at.

A Run forks once, before the first Prompt Cell it runs, and every later Cell follows the
one before it. That is right for a contiguous set of Cells, which is what ticket 09's stale
set is, being reachability from a single Cell. A Run naming a set with a gap in it — the
first Cell and the third, leaving the second alone — gets one fork and then runs straight
on, so the third Cell sees the first Cell's new turn rather than the second Cell's old one.
Whether an author wants that is a question about staleness, and it should be settled by
whoever owns staleness rather than here, by accident.
