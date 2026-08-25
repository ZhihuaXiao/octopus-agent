# 03 — Complete document format and round-trip fidelity

**What to build:** The full notebook format parses and serialises — frontmatter carrying
title, mode, workspace, model, pi version, tools, skills, packages and inputs, and cells
carrying id, type, uses, isolated and an optional model override — with prose preserved
verbatim between cells. Fidelity is the point: an editor that reformats the file on save
destroys the reviewability the Markdown format exists for.

**Blocked by:** 02

**Status:** done

- [x] Every frontmatter field and cell attribute in the format contract parses
- [x] A property test asserts that parse-then-serialise is byte-identical across generated notebooks
- [x] Editing one cell's body leaves every other byte of the file unchanged
- [x] Prose between cells survives a round trip exactly, including blank lines
- [x] A malformed notebook reports the line and the problem rather than throwing
