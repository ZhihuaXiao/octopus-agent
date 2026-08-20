# 10 — Isolated cells and parallel scheduling

**What to build:** A cell marked isolated runs in a fresh context rather than the
notebook's shared one, which makes it reproducible and safe to run alongside others. The
scheduler runs isolated cells concurrently wherever the graph permits, while shared-context
cells stay strictly serial because they would otherwise both be appending to one message
history.

**Blocked by:** 07, 08

**Status:** ready-for-agent

- [ ] An isolated cell sees none of the notebook's shared conversation
- [ ] An isolated cell produces the same result on a repeat run given the same inputs
- [ ] Isolated cells with no edge between them execute concurrently
- [ ] Shared-context cells never execute concurrently with one another
- [ ] A cell may be both isolated and declare dependencies, since these are separate axes
