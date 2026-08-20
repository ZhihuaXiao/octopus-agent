# 18 — Disconnect survival and restart recovery

**What to build:** Losing the browser costs nothing. Work carries on, reconnecting replays
everything that happened while away, and a server restart recovers in-flight notebook
sessions rather than destroying them. This is the whole reason remote mode is worth having.

**Blocked by:** 15

**Status:** ready-for-agent

- [ ] Closing the browser mid-run leaves the run going
- [ ] Reconnecting shows everything that happened while disconnected
- [ ] A server restart recovers open notebook sessions and their run state
- [ ] Recovery reattaches through pi's API and never writes pi's session files concurrently
