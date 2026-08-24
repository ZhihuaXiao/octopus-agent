# 02 — Tracer bullet: headless run of a single prompt cell

**What to build:** Running a notebook file from the command line executes its single prompt
cell against the agent and writes a run record describing what happened. This is the first
complete path through the system, so it also establishes the narrow agent interface behind
which all non-determinism lives, with two implementations: one backed by pi, one scripted
for tests.

**Blocked by:** 01

**Status:** done

- [x] A minimal notebook with frontmatter and one prompt cell runs to completion from the command line
- [x] A run record is written recording the cell's status, its text output and its token usage
- [x] The same notebook runs deterministically against the scripted agent
- [x] No test above the agent interface reaches a real model
