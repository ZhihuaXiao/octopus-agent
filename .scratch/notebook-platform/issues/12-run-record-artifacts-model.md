# 12 — Run record completeness, artifacts, and per-cell model

**What to build:** The run record fully describes what happened on a run, and files the
agent produced are stored beside it and referenced by path rather than embedded in the
notebook; see ADR-0005. A cell may override the notebook's default model, which is what
makes a cheap deterministic step cheap — and the model that actually ran must be recorded,
because providers rotate versions under stable names.

**Blocked by:** 02, 04

**Status:** ready-for-agent

- [ ] The run record carries per-cell status, start and end times, the model actually used, token counts and cost
- [ ] Generated files and images are written to the run's artifact location and referenced by path
- [ ] No output or artifact content is ever written into the notebook file
- [ ] A cell's model override is honoured and recorded
- [ ] Two runs of the same notebook produce two separate run records
