# 07 — Dependency graph and cycle detection

**What to build:** The `uses` edges declared on cells form a graph, and that graph — not
position in the document — determines what runs and in what order. Edges are always
declared by the author and never inferred; see ADR-0003.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] Cells run in an order consistent with their declared edges regardless of their position in the file
- [ ] An edge naming a cell that does not exist is reported before the run starts
- [ ] A cycle is reported with the cells involved, and nothing runs
- [ ] A notebook with no declared edges runs in document order
