# Run results live outside the Notebook

A Notebook contains no results. Each Run writes a Run Record and its Artifacts beside the
document instead of into it.

The Notebook is the program; a Run is an event that happened to it. Keeping them separate
is what makes the Markdown format of ADR-0002 actually diffable — embedded outputs are why
`.ipynb` files are miserable in git and why Jupytext exists — and it matches the fact that
Stale is a property of a Run rather than of the document. Artifacts are referenced by path
rather than embedded, which is affordable here because the agent is already producing real
files in a real Workspace.

## Consequences

Sharing a Notebook shares the program and not the results, so an explicit export that
combines a Notebook with a Run Record into one readable document is a required feature
rather than a nicety.
