# Workspace trust is the run's decision, made explicitly or not at all

Pi gates a project's own settings, skills and extensions behind a trust decision for the
directory. A Run makes that decision from a command-line flag, records it with pi so the
next Run inherits it, and refuses to start when nothing has decided it and the Workspace has
project resources that would be silently skipped.

## Considered Options

Leaving it to pi is what the SDK does by default, and it is the option that produces the bug
this project exists to avoid. Pi's default is to ask, and a non-interactive mode has nobody
to ask, so it answers no and says nothing. A Notebook that declares a project skill then runs
without it, and every acceptance criterion about a declared environment is satisfied by
loading nothing at all.

Trusting always was tempting, since ADR-0006 already establishes that nothing here is a
security boundary — anyone who can run a Notebook can run a Bash Cell, so a project
extension grants no capability they did not already have. It was rejected because trust here
decides what pi *loads*, and quietly loading a repository's extensions the first time
someone runs a Notebook inside it is a surprise even when it is a harmless one. The
difference between granting and skipping should be visible somewhere.

Declaring trust in frontmatter was rejected on principle. A document cannot vouch for the
directory it is pointed at: the Workspace is resolved relative to wherever the file happens
to be, and a Notebook that says "trust my workspace" is a Notebook that trusts itself. Only
the person running it knows what they have cloned.

## Consequences

`--trust` and `--no-trust` are the only way to make the decision, and both are recorded in
pi's own trust store rather than in ours — the same store the `pi` command uses, so a
Workspace already decided on in the terminal needs no flag here. A decision therefore has to
be made once per Workspace and never again.

A Run in a Workspace with nothing to gate needs no decision at all. Pi answers that question
itself, so the flag is required exactly when it would change something, and the common case
of a Notebook beside its own code stays flagless.

The refusal names the Workspace and both flags, because it is the one error here that a
reader cannot diagnose from the Notebook in front of them.

The decision is passed to pi's resource loader explicitly, even when it is a no. Reaching
that code path deliberately rather than falling into it is what makes the recorded answer
the one pi acts on, and it is why the agent boundary drives resource loading itself instead
of letting `createAgentSession` arrange it.
