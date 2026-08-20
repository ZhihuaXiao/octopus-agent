# 08 — Shared context and anchoring

**What to build:** All cells in a notebook share one agent session by default, so a later
cell can say "now do the same for the other files" and be understood. Each executed cell
records the pi entry id it ended at, so that a later re-run can fork the agent session at
exactly the right point rather than replaying from nothing.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] A cell can refer to what an earlier cell did and the agent understands it
- [ ] Each executed cell's anchor is recorded in the run record
- [ ] Re-running a cell resumes from its predecessor's anchor rather than from an empty context
- [ ] The abandoned branch remains present in pi's session rather than being destroyed
