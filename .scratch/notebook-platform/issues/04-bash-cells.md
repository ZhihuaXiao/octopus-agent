# 04 — Bash cells

**What to build:** A bash cell runs its body as a shell command in the notebook's
workspace, without involving the agent and without spending tokens, and its result becomes
part of the run. These are what make a notebook reproducible rather than merely repeatable.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] A bash cell executes and its stdout, stderr and exit status land in the run record
- [ ] A non-zero exit is treated as a cell failure
- [ ] Bash cells consume no tokens and are recorded at zero cost
