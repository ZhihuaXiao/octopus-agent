# 17 — Editing, saving, and forking notebooks in the browser

**What to build:** Notebooks are edited in the browser and saved without disturbing the
rest of the file, so a diff shows only what actually changed. An existing notebook can be
duplicated and adapted, which is how someone who cannot author from scratch still gets a
notebook of their own.

**Blocked by:** 03, 16

**Status:** ready-for-agent

- [ ] Editing one cell and saving changes only that cell's bytes in the file
- [ ] Cells can be added, removed and reordered
- [ ] Frontmatter, including inputs and dependency edges, is editable
- [ ] A notebook can be duplicated under a new name and edited independently
- [ ] Saving a notebook that changed on disk since it was opened is detected rather than silently overwriting
