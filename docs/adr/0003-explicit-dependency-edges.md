# Dependency edges are declared, never inferred

Each Cell names the Cells it depends on. We do not infer the Graph by observing file reads
and writes or context usage, and we do not intend to.

Inference is tempting and would be wrong here: the edges would be derived from an agent's
tool calls, which are non-deterministic, so the same Notebook could produce a different
Graph shape on different Runs and staleness would become unpredictable. A declared edge is
reviewable in a diff and behaves the same every time. This will be suggested again;
the answer is no.
