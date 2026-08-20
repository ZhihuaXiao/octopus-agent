# 11 — Failure handling, retries, and timeouts

**What to build:** A failing cell halts the run rather than letting later work build on a
partially-applied change. Transient provider and transport errors retry, because they are
the only failure class worth retrying automatically. A cell that hangs times out, so a
headless run cannot wedge forever unnoticed.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] A failed cell is marked errored and the run halts
- [ ] Dependents of a failed cell are left stale rather than executed
- [ ] Provider and transport errors are retried, and the retries appear in the run record
- [ ] A cell exceeding its timeout is aborted and reported as a timeout rather than a generic failure
- [ ] The run exits with a non-zero status when any cell failed
