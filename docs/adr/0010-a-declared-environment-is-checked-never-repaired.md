# A declared environment is checked before the first cell, and never repaired

A Notebook declares its Workspace, its tools, its skills, its packages and the pi version it
was written against. A Run checks all of them before executing anything, reports every
difference at once, and stops. It never installs what is missing, and it never carries on
with a warning.

## Considered Options

Repairing the environment is the tempting one, and pi makes it easy: its package manager
takes an `onMissing` handler that installs a missing source on the spot. It is the wrong
default here. Installing a package is a change to the machine, made on the authority of a
document that may have arrived in a pull request from someone else, at the moment its author
is least present to judge it. And it makes a Notebook's first run on a new machine
unreproducible in the specific way that matters: what ran was not what was declared, it was
what could be fetched today.

Warning and carrying on is worse, and is the failure mode the whole declaration exists to
prevent. A Notebook that declares a skill and runs without it does not fail — the model
still answers, plausibly and at length, having never been given the instructions the author
was relying on. Nobody re-reads a warning above a confident answer.

Checking lazily, as each Cell needs what it needs, was rejected for the reason inputs are
resolved eagerly (ADR-0009): a Notebook that stops at its third Cell has already spent the
tokens of the first two and half-applied their changes to the Workspace.

## Consequences

The check is by name and nothing deeper. Pi already decides what counts as an installed
skill or a resolved package, and a second opinion here would be one more thing to keep in
step with pi across its breaking releases. So the environment is read from the agent as it
was actually set up — the tools the session will really offer, the skills pi really loaded —
rather than from a separate reading of the same directories.

A declared `pi_version` that differs stops the Run like anything else missing. Pi ships
breaking changes in minor releases and never publishes a major, so "close enough" has no
meaning that could be encoded here. A Notebook that does not care simply does not declare
one, which is the common case.

Setting the agent up therefore happens before the check rather than after it, because
setting it up is what discovers the environment. That makes creating a session part of the
cost of refusing a Run, which is cheap: no model is called and no tokens are spent.
