# 17 — Editing, saving, and forking notebooks in the browser

**What to build:** Notebooks are edited in the browser and saved without disturbing the
rest of the file, so a diff shows only what actually changed. An existing notebook can be
duplicated and adapted, which is how someone who cannot author from scratch still gets a
notebook of their own.

**Blocked by:** 03, 16

**Status:** done

- [x] Editing one cell and saving changes only that cell's bytes in the file
- [x] Cells can be added, removed and reordered
- [x] Frontmatter, including inputs and dependency edges, is editable
- [x] A notebook can be duplicated under a new name and edited independently
- [x] Saving a notebook that changed on disk since it was opened is detected rather than silently overwriting

## Comments

**An edit is the whole document, applied to the Notebook as it stands.** `notebook/edit.ts`
takes a `NotebookEdit` — the frontmatter's text, and the Prose and Cells in the order they
should appear, each Cell as its author declares it — and `applyEdit` makes the bytes. The
alternative, a list of operations — replace this body, move that Cell — would have had the
browser keep a history of what it did to arrive at its draft, and would have made adding,
removing and reordering three operations where one description of the result does for all
of them, and for a body change too. Fidelity is kept the way `notebook.ts` keeps it: nothing
is rendered that can be replayed. Prose is the bytes the edit carries; a Cell whose
declaration is unchanged keeps the fence lines its author wrote — `isolated=true` and
`timeout=0.5m` stay spelt that way when the edit says `isolated` and `30s` — and the
frontmatter keeps its delimiters. Only a Cell that is new or declared differently has its
fence written out, and only that fence changes; `replaceCellBody` is now the one-Cell case of
this and stays where ticket 03 put it. A body travels as content — without the line ending
that closes its last line, which is the fence's to supply — because that is what a text
field holds, and it is what lets a body the author did not touch be known for one and kept
to the byte, a blank line at its end included; a body the author wrote is closed with the
Notebook's own line ending, and a Timeout spelt in a way the format does not read is never
"the same" as the one it had, so the fence is written and the parser says so rather than the
value being dropped. What the edit makes is parsed before anything is written, so a `uses`
naming no Cell, a cycle, two Cells with one id or frontmatter that is not YAML is refused
against the lines of the Notebook it would have made, and a Cell body that comes to hold a
fence of its own is fenced longer, as an author would. The round-trip property gained two
more clauses: an edit that describes a generated Notebook as it stands reproduces it byte
for byte, and one that replaces a body changes nothing else — across CRLF files, tilde
fences, longer fences and files without a final newline; a file of mixed line endings is
reproduced too, since Prose the Notebook already has is recognised by its bytes and kept.
Only what a browser wrote is framed: its line endings become the Notebook's, a body or Prose
that should end on a line ending is given one, and empty Prose is left out.

**The state carries the Notebook whole, and a Revision of it.** `NotebookSessionState` grew
`frontmatter`, the YAML as written; `segments`, the layout — Prose verbatim, and each Cell
by id where it sits, the Cells themselves staying in `cells` as ticket 16 pinned them; and
`revision`, sixteen hex characters of the file's digest, which `CONTEXT.md` now names. `POST /api/sessions/<id>/save`
takes the edit with the `base` revision the draft was made from, and answers `200` with the
state as saved, `422` with the diagnostics when the result would not be a Notebook that can
be opened — no Cells left included — or `409` when the draft is out of date. Out of date two
ways: the file on disk no longer holds what the session read, which is the case the ticket
names and is what "edit it in any editor" (ADR-0002) makes ordinary; or another browser saved
since. Either way nothing is written, and the session adopts what is on disk and tells every
browser watching with a new event, `notebook-changed`, which is also how a save from one
browser reaches the others. A file that changed into something that does not parse still
moves the revision, so a save made knowingly can put a readable Notebook back; the Cells
shown stay the last that could be read. Saves through one session are queued one after
another, since two reading the file and then writing it would each write over the other's
work with neither told. A Cell that ran keeps what it produced across an edit — its body
changing does not make its result Stale, since Stale is a property of a Run — and a Cell
that is removed takes its result out of view; the next Run reads the file as saved, which
ticket 15 arranged for. `POST /api/notebooks` with `{ from, to }` copies a Notebook byte for
byte under the new name — its title included, which is the author's to change — and never
over a file that is there; a directory the name needs is made, and the copy's Runs begin
when it is first run, since the original's are the original's history.

**The client shows the Notebook, and edits it whole.** Prose is drawn between the Cells as
the text it is — a Markdown renderer is a dependency, and the moment for one has not come —
which is what ticket 16 left for here. Edit turns the Author View into a form — the Author
View still, since writing the Cells is what it is for: the
frontmatter's YAML in a text field; each segment a card — Prose a text field, a Cell its
type, id, `uses`, `isolated`, `model` and `timeout` as fields with the body below — with
arrows to trade places with the neighbour above or below, Remove, and a row to insert a
prompt Cell, a bash Cell or Prose beneath it, a blank line put between two Cells that would
otherwise abut. Save posts the draft against the revision it was drawn from and leaves the
form on success; a `422` is shown where the draft is; a `409` is explained there too, the
draft kept and re-based on what the session now holds, so saving again is a choice to write
over it made knowingly and Cancel shows what is there now. A `notebook-changed` heard while
a draft is open says so above it rather than redrawing over the author's work, and Runs
that stream meanwhile update the state without touching the form. Duplicate asks for a name
with `window.prompt`, the plainest thing that asks a question, and follows the copy's link.
Still plain files, still checked rather than compiled.

**Tested at the seams the spec names, and looked at.** `edit.test.ts` pins `applyEdit` at the
module seam: the identity, one body's bytes alone, a body given its line ending and one left
empty, a blank line kept at the end of a body untouched and of one typed, a body fenced
longer, a declaration changing only its fence and one spelt differently kept as written, a
rename, a type change, a quoted value, adding, removing and reordering with each Cell
keeping its fence, a last Cell given a line ending when it moves, Prose as carried and
framed, frontmatter replaced, added and removed, CRLF and mixed line endings kept, and the
refusals with their lines, a Timeout that is not one on a Cell that had none among them; `round-trip.test.ts` has the two properties. `server.test.ts` gained "editing a
notebook in its session" and "duplicating a notebook": the layout and revision on opening,
one body saved with the file checked byte for byte and the event heard, the saved Notebook
run, results kept and a removed Cell's forgotten, add-remove-reorder with the whole file
asserted, a title and an Input edited into the frontmatter and the Input taken by the Run,
edges edited, the two `409`s with the disk version adopted and a knowing save over it, the
`422`s writing nothing, malformed requests, the route taking only a write, and the copy:
byte-identical, listed, opened into its own session, edited independently, never over a
file, and refused outside the directory, under another extension or without a name. The
client was walked in a headless Chromium against a server with a scripted agent underneath
— open, run all, edit a body, a timeout and a new Cell, save and read the file, two tabs
saving one after the other and the second told, cancel, duplicate and see the copy open
idle, move and remove and save — and the file was what the edits said.

**Left where it was.** A Notebook that does not parse is still refused on opening rather than
shown with its problems, so a file broken in another editor is fixed there. The session
learns that its file changed on disk when a save is tried, not before; a Run started
meanwhile runs the file as it is, as ticket 15 arranged, while the state shows what was last
read; and a file deleted since it was opened is written back by a save rather than reported,
there being nothing in it to write over. Prose is text on the page, not rendered Markdown,
and Prose is Markdown: a fence with an id typed into it is a Cell once saved, since what the
edit makes is parsed rather than checked against what it described. A Run in progress does
not stop a save, which lands in the file for the next Run to read. `octo.ts` remains the one
untested file.
