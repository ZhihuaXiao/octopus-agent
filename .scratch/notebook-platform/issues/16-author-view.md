# 16 — Author View: cells, tool-call cards, artifacts

**What to build:** The browser renders the notebook as cells with live output, showing what
the agent actually did rather than only what it says it did, and rendering the files it
produced so nobody has to go looking for them.

**Blocked by:** 12, 15

**Status:** ready-for-agent

- [ ] Cells render with their type, output and current state, including stale and errored
- [ ] Tool calls appear as they happen, showing what was invoked
- [ ] Images produced by a run render inline
- [ ] Other generated files appear as links to the artifact location
- [ ] A single cell can be run from the UI
