# The run's own flags are reserved Input names

On the command line an Input is given its value as a long option named after it,
`--target docs`, and the run's own two flags, `--trust` and `--no-trust` (ADR-0011), are
read the same way. So an Input may not be named `trust` or `no-trust`: the parser reports one
that is, when the Notebook is read, as it reports one named `artifacts` (ADR-0019).

## Considered Options

**A generic `--input target=docs`** removes the collision entirely, since no Input is ever a
flag. It was rejected when the command line was first written and stays rejected: a Notebook
is parameterised in its own vocabulary, and the command that runs it should read in that
vocabulary too — `octo run audit.md --target docs` says what the run is about, where
`--input target=docs` says only that something was passed.

**A positional grammar** — the run's flags before the Notebook's path, Inputs after it —
resolves the ambiguity by position rather than by name. It was rejected because the rule is
invisible: `--trust audit.md` and `audit.md --trust` would mean different things and nothing
on the screen says so, and the existing behaviour of reading an Input written before the
Notebook would have to go.

**Resolving it at the command line** — reading `--trust` as the flag and `--trust=value` as
an Input of that name — leaves a boolean Input named `trust` with no way to be given `true`
that is not also the flag. The ambiguity is in the Notebook, not the command line, and is
better reported where it is.

**Leaving the two names unreservable but unreported**, which is where tickets 06 and 12 left
it, means a Notebook declaring an Input called `trust` parses cleanly and can never be run
from the command line with a value for it, which is discovered only by trying.

## Consequences

The format contract grows two reserved Input names beside ADR-0019's one. They are reserved
because of how one client spells its flags, and Run View's form would have no such collision;
the format carries the rule anyway, because a Notebook is written once and run from wherever
it is run, and one that some runner cannot run without ambiguity is wrong when it is written.

The names live once, as `TRUST_FLAGS` in the format module, and the parser and the launcher
both read them there, so the reservation and the flags cannot drift apart. Should the run's
command line grow another flag of its own, the same map is where it is declared and the same
diagnostic is what an Input taking its name gets.

The launcher reads its own flags before it takes anything for an Input, so the decision is
never left to a name collision even for a Notebook written before this rule existed. Such a
Notebook now fails to parse, which is the cost: an Input called `trust` has to be renamed.
