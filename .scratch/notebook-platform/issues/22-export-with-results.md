# 22 — Export a notebook with its results

**What to build:** A notebook and a chosen run combine into one self-contained readable
document that can be handed to someone who will never run it. This is required rather than
optional, because keeping results out of the notebook means sharing a notebook otherwise
shares the program and not the answer.

**Blocked by:** 12, 16

**Status:** done

- [x] Exporting produces a single document containing the notebook and a chosen run's results
- [x] Artifacts referenced by that run are included or linked so the document stands alone
- [x] The export contains no credentials
- [x] The notebook file itself is unchanged by exporting

## Comments

**One function, `exportNotebook`, and two ways of asking for it — ADR-0023.** `export/html.ts`
takes a Notebook's path and, optionally, a Run's id, and returns one HTML document; it writes
nothing, so where the document goes is the caller's affair. `octo export <notebook.md>
<document.html> [--run <id>]` writes it at the command line, never over a file that is there;
`GET /api/sessions/<id>/export[?run=<id>]` answers with it as a download, and the Author View's
Export button is that request. `CONTEXT.md` gained Export, and Import's avoid-list no longer
points ahead to this ticket.

**One HTML file, because the document has to stand alone.** Markdown with a folder beside it is
two things to send; Markdown with images as data URIs is one file most viewers will not draw,
and has no honest place for a file that is not an image. So the Export is HTML, and every
Artifact is inside it as a `data:` URL: an image drawn, a text file shown and offered under its
own name, anything else offered and never shown — HTML and SVG an agent wrote included, as
ticket 16 has it for the live view. The table saying which file is which moved out of
`server.ts` into `store.ts` as `runFileType`, so the server and an Export cannot disagree
about it. Everything shown is escaped as text, and a Content-Security-Policy in the head permits
no script and no fetch, so nothing in the file runs and opening it tells nobody. The page
borrows the Author View's look — a card per Cell with its status on the left edge — and heads
itself with the Run's id, when it ran, and what the records shown cost; it names no Workspace
and no path of the machine it was made on, which the reader has none of.

**"A chosen run" is read as the finished work as of that Run.** A partial Run's record holds
only the Cells it ran (ADR-0004), so an Export of a one-Cell re-run would otherwise be one Cell
with results and the rest blank. The rest are read back along `continues`, the nearest Run that
ran each, and each is said to be "from run" that one, with its Artifacts read from that Run's
directory; a Cell the chosen Run left Stale says so, one that never ran says "not run", and one
that failed shows its error and, for a Bash Cell, what it wrote to standard error. An Artifact
the record names that has since gone is said to be gone. The cost is summed over the Cells the
Notebook still declares, so a Cell removed since is not paid for in the heading. The latest Run
is the one whose id sorts last and whose record is written, so a Run under way is passed over
for the one before. `readRunRecord` and `latestRunId` joined `store.ts`, and the Notebook
Session's recovery now reads a left-behind record through the first; `titleOf` moved into
`notebook.ts` so the Export need not reach into the server for it.

**No credentials, by construction and then by striking out.** The Notebook names providers and
never keys, and the Export adds nothing of the machine — no server link, no token, no path. That
alone would not do: a Bash Cell inherits the environment, and `env` in one puts every key in its
record. So `export/credentials.ts` gathers what the machine holds — environment variables with
key, token, secret, password or credential in their names; each provider's key, OAuth tokens and
carried environment in pi's `auth.json`; a custom provider's key and headers in `models.json`,
with a `$NAME` there followed to the variable it names as pi follows it — and every piece of
text the document shows passes through one function that strikes them out before escaping:
Prose, bodies, output, errors, tool inputs and their one-line summaries (each string before it
is cut short, so a key cannot survive by straddling the cut), file names, and a text Artifact in
the copy offered as well as the one shown. A file that is not text and holds one cannot be
struck through without breaking it, so it is withheld and says so. A value written `!command`
is not run: an Export has no business running a password manager. `thisMachine()` is where the
command line and the server both say which environment and agent directory those are.

**The Notebook is read and never written.** The Export returns a string; the command line
writes it with `wx`, so the Notebook, like any file there, cannot be written over; the server
serves it as an attachment. The first test checks the Notebook's bytes and its mtime after an
Export.

**Tested at the one seam agreed, reviewed on two axes, and looked at.** `export/html.test.ts`
drives `exportNotebook` with records real Runs of the scripted agent wrote, and credentials from
a temporary agent directory and a given environment rather than the machine's: the document and
the Notebook left as it was; the title and Prose in order among the Cells; a Prompt Cell's tool
calls, reply, model and cost; agent-written markup kept as text, no script, the policy, and
nothing referred to outside the file; an image embedded byte for byte, a text file shown and
offered, a page and a binary offered only, a file gone said to be gone; the Run named against
the latest; a partial Run's untouched Cell from the Run before, said to be, and the Stale one
marked; a failure's reason, a Bash Cell's standard error, and a Cell never reached; the Run's
account, naming no path, and its cost over the Cells still declared; the refusals; and
credentials from the environment, from `auth.json` and `models.json`, through `$NAME`
references and a credential's own environment, a `!command` not run, a key cut through in a tool
call's summary, a binary withheld and a text file struck through in both copies. The standards
and spec reviews found the summary cut before striking out, the unfollowed `$NAME`, the missing
standard error, the silent missing file, the unlabelled carried result, the cost of removed
Cells and the machine paths in the heading, and each was put right test first. The launcher's
word and the server's route were not put under test, by agreement, and were walked by hand
against a scratch project with pi's agent directory pointed elsewhere and a fake key in it and in
the environment: `octo run` then `octo export`, each refusal — never run, a run that never was, a
file already there, a notebook that is not there, a missing argument — the document opened in a
browser, the route's headers, its 404s, a climbing run id, its 405 and its 401 by curl, and the
button clicked on a Notebook never run and on one that had, the download named for the Notebook
and the Run. Found on the way: the blank lines around Prose, and Prose that is only spacing,
opened wide gaps between Cells, so both are trimmed.

**Left where it was.** Prose is shown as the text it is, not rendered as Markdown; there is no
Markdown renderer here, and the Author View shows it the same way. The values a Run was given
for its Inputs are not in the record, so the Export shows `{{target}}` as written; putting them
in the record is a commitment of its own, and one that has to think about a value that is itself
a secret. A Notebook edited since the Run shows its bodies as they are now beside the records of
the ones that ran, as the Author View does; the record keeps no revision to say they differ. A
Notebook run at the command line opens in the browser with its Cells idle, as ticket 21 left an
imported one, yet exports that Run, since the Export reads the disk. The button exports the
latest finished Run; the route takes `?run=`, and nothing on the page yet offers a choice.
Striking out knows what the exporting machine holds now: a key the Run's process had and this
one does not, a credential inside a compressed file, and one drawn in an image's pixels are not
seen. Nothing bounds the size: every Artifact is inside the file, a third larger for the
encoding, as ADR-0019 says nothing bounds what a Cell leaves. `octo.ts` remains the one untested
file.
