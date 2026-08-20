# 23 — Modes as preset files

**What to build:** A mode is a file bundling a system prompt, a tool allowlist, a skill set
and a default model — data, not code. Code and Work ship as files, and a user can add their
own without waiting for a release. Work mode is a preset only; connectors are out of scope,
and it exists to learn what office automation should be rather than to be it.

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] Code and Work modes exist as preset files rather than as code
- [ ] A notebook's declared mode resolves to its preset at run time
- [ ] A user-defined mode file is discovered and usable without changing the application
- [ ] Work mode ships with no connectors
- [ ] A notebook's mode cannot be overridden per run, since that would break Run View's reproducibility
