# 21 — Import a pi session and promote a chat

**What to build:** Work done in the terminal is not lost to the notebook world. An existing
pi session becomes a notebook, and the same machinery turns an ad-hoc chat into a
repeatable one — one implementation, two features. Import is one-way by design, because pi
holds a lockfile and runs one active session per process.

**Blocked by:** 03, 12

**Status:** ready-for-agent

- [ ] A pi session file is imported as a notebook whose prompt cells correspond to its user messages
- [ ] A run record is populated from the imported transcript
- [ ] The imported notebook round-trips and runs like any other
- [ ] Nothing attempts to write pi's session files or sync back to a live session
- [ ] Promoting a chat into a notebook uses the same implementation as import
