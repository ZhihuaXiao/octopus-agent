# 15 — Notebook sessions and event streaming

**What to build:** Opening a notebook creates a notebook session owned by the server, with
its own execution state and an agent session attached. Cells run inside it and every
execution event streams to connected clients as it happens. Several notebook sessions run
at once, so one long run never blocks the rest.

**Blocked by:** 09, 10, 11, 14

**Status:** ready-for-agent

- [ ] Opening a notebook creates a notebook session owned by the server rather than by a client
- [ ] Running a cell streams its text to the client as it is produced
- [ ] Several notebook sessions run concurrently without blocking one another
- [ ] A running cell can be interrupted from the client
- [ ] Closing the browser does not stop the work
