# 05 — Declared inputs and interpolation

**What to build:** A notebook declares named inputs with a type, a default and a
description. Their values interpolate into cell bodies before those cells run, and the
command line supplies them, so one notebook serves many cases.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] Inputs declared in frontmatter are readable as a typed set with descriptions
- [ ] A reference to an input inside a cell body is replaced by its value before the cell runs
- [ ] Values supplied from the command line override declared defaults
- [ ] A required input with no value stops the run with a clear message before anything executes
- [ ] A value of the wrong type is rejected before any cell runs
