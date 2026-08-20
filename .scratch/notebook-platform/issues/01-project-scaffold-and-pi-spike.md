# 01 — Project scaffold and pinned pi spike

**What to build:** A repository that builds, lints and tests on a clean checkout, with pi
embedded as a library at an exact pinned version. Sending a prompt through an embedded
agent session streams the assistant's reply to standard output. A small live integration
test exercises the parts of pi's SDK we depend on, so that a pi upgrade fails loudly here
rather than silently somewhere else later.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Tests run and pass on a clean checkout
- [ ] pi is pinned to an exact version rather than a range
- [ ] A command sends a prompt and streams the assistant's reply to stdout
- [ ] A live integration test covers session creation, prompting, event subscription and usage reporting, and skips cleanly without credentials
- [ ] Whether `importFromJsonl()` preserves branch structure is verified and the answer recorded in the spec
