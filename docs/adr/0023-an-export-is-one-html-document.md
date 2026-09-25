# An Export is one HTML document of a Notebook and a Run

An Export combines a Notebook with a chosen Run into a single HTML file that stands alone:
the Notebook's Prose and Cells in order, what each Cell said, did, ran on and cost, and the
files it left, carried inside the file rather than linked. The Notebook is not written. The
credentials the machine holds are struck out of the document wherever a Cell repeated one.

This is the other half of ADR-0005. Results live outside the Notebook, so sharing a Notebook
shares the program and not the answer; an Export is the required way to hand someone the
finished work.

## Considered Options

**A Markdown file with an artifacts folder beside it** would be two things to send, and a
folder of files is easy to drop on the way. Ticket 22 asked for a document that stands alone.

**A Markdown file with images as data URIs** is one file, but GitHub and many viewers will
not show those images, and a file that is not an image has no honest place in Markdown at
all. HTML can draw an image, show a text file, and offer anything else as a download, all
from URLs that live in the file.

**Writing the results back into the Notebook** is what ADR-0005 exists to refuse. The Export
is a file of its own.

**Building only from the Notebook and the records, and calling that "no credentials"** would
be true of the Notebook — it names providers, never keys — and false of a Bash Cell that
inherited the environment and printed one. So the values the machine holds are gathered and
struck out: environment variables with `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD` or
`CREDENTIAL(S)` as a segment of their name; each provider's key, OAuth tokens and carried
environment in pi's `auth.json`; and the API keys and header values in `models.json`. A value
in pi's files written `$NAME` or `${NAME}` stands for the variable it names, looked up as pi
looks it up, which reads one variable and runs nothing. One written `!command` is not run: an
Export has no business running a password manager.

**Linking Artifacts to the server** would make the document depend on a server the reader
cannot reach, and put the server's token in it. They are embedded instead.

**Inlining every Artifact as a page** would mean serving HTML and SVG the agent wrote as a
page the reader's browser would run. Ticket 16 already refused that for the live view; the
Export does the same. Images are drawn, text is shown and offered, anything else is offered
and never shown. A file that is not text and holds a credential cannot be struck through
without breaking it, so it is withheld and said to be.

## Consequences

The document is HTML with a Content-Security-Policy that permits no script and no fetch, so
nothing an agent wrote can run and the file tells nobody it was opened. Everything it shows is
escaped as text. Styles are inline, images are `data:` URLs; both are what the policy allows.
It names nothing of the machine it was made on beyond what the Cells themselves printed.

A chosen Run is the latest to have finished, or one named by id. A partial Run accounts only
for the Cells it ran, so the rest are read back along the chain it continues, as Stale is,
each said to be from the Run that ran it, with its Artifacts read from that Run's directory. A
Run still under way is not in it: its record is written when it ends.

Striking out finds only what the exporting machine holds now, and only as written. A key the
Run's process had and the exporting one does not, a credential inside a compressed file, and
one drawn in the pixels of an image are not seen. Nothing bounds the document's size: every
Artifact is inside it, a third larger for the encoding, as ADR-0019 says nothing bounds what a
Cell leaves.

`exportNotebook` is the one function. `octo export` names the files at the command line and
writes the document, never over a file that is there; `GET /api/sessions/<id>/export` is the
same function for the browser's Export button, served as a download. Neither writes the
Notebook.
