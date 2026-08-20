# 06 — Declared environment and workspace trust

**What to build:** A notebook declares the workspace it operates on and the tools, skills
and packages it needs. A run refuses to start when any of them is missing, because a
silently degraded environment produces a plausible wrong answer rather than an error. The
pi trust decision for the workspace is made explicitly instead of being skipped, which is
what pi does by default in non-interactive modes.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] Cells execute with the declared workspace as their working directory
- [ ] Only the declared tools are available to the agent
- [ ] A missing declared skill or package stops the run before any cell executes, naming what is missing
- [ ] The workspace trust decision is made explicitly and recorded, so project skills never silently fail to load
- [ ] A declared pi version that does not match the running one is reported
