# 09 — Staleness and selective re-run

**What to build:** Re-running a cell marks exactly the cells reachable from it in the graph
as stale, leaving everything else valid, and a run can target only the stale set. Nothing
downstream re-runs on its own and nothing is discarded; see ADR-0004.

**Blocked by:** 07, 08

**Status:** ready-for-agent

- [ ] Re-running a cell marks its graph dependents stale and nothing else
- [ ] A cell unrelated to the re-run keeps its previous result
- [ ] The stale set is visible in the run record
- [ ] Re-running only the stale cells returns the notebook to fully valid
- [ ] No dependent runs automatically, and no previous result is deleted
