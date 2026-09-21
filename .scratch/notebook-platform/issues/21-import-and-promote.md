# 21 — Import a pi session and promote a chat

**What to build:** Work done in the terminal is not lost to the notebook world. An existing
pi session becomes a notebook, and the same machinery turns an ad-hoc chat into a
repeatable one — one implementation, two features. Import is one-way by design, because pi
holds a lockfile and runs one active session per process.

**Blocked by:** 03, 12

**Status:** done

- [x] A pi session file is imported as a notebook whose prompt cells correspond to its user messages
- [x] A run record is populated from the imported transcript
- [x] The imported notebook round-trips and runs like any other
- [x] Nothing attempts to write pi's session files or sync back to a live session
- [x] Promoting a chat into a notebook uses the same implementation as import

## Comments

**One function, `importSession`, and two ways of naming the file — ADR-0022.** `import/pi-session.ts`
takes a pi session file and a path to write, and makes the Notebook and a Run Record of what
the Chat did. `octo import <session.jsonl> <notebook.md>` names the file at the command line;
`POST /api/chats/<id>/promote` names it off pi's own list of the served directory's Chats,
`GET /api/chats`, which the browser shows under the Notebooks with a Promote button beside
each. Both are that function and nothing else. `CONTEXT.md` gained Chat, Import and Promote;
the ADR has the alternatives — attaching to pi's file in place, pi's own `importFromJsonl()`,
reading without copying — and why each lost.

**The copy is the Agent Session, so pi's file is never opened for writing.** The session file
is copied under the new Run's directory as `session.jsonl` before anything reads it, and
`SessionManager.open` is given the copy. That order is the point, and it was found rather
than assumed: pi brings an older session file up to the current format by rewriting it in
place when it opens one, so opening pi's own file through pi's own API is a write when the
file is old enough. There is a test that a version-2 file comes through byte-identical, its
mtime unchanged, while the copy says version 3. The record names the copy as `agentSession`
and pi's file as a new field, `imported`, for the reader; the copy is what a later Run forks
(ADR-0014), and every entry id survives a byte copy, so the Anchors read off the copy address
it exactly. Listing Chats goes through `SessionManager.list`, which makes pi's session
directory for the Workspace when it is not there — an empty directory pi makes the moment it
runs there, and not a session file; the ADR says so.

**A turn is read off pi's messages the way a live one is.** `summariseTurn` and `failureOf`
moved out of `agent/pi.ts` into `pi/turn.ts` unchanged, and the import calls them on the
messages between one user message and the next along the session's active path — `getBranch()`
from the leaf, which on a reopened file is the end of it — so an imported Cell's tool calls,
tokens, cost and `provider/model` are the same reading a Run would have made. Two differences
are deliberate. `text` is everything the turn's assistant messages said, blank lines between,
where a live record keeps the closing message's — nothing streamed the rest to anyone at the
time, and the Chat's file is all there is. And a turn pi's `stopReason` says was `aborted` is
Interrupted, as one stopped from the browser is, with what it had said kept; one that
`error`ed is Errored with pi's `errorMessage`; a last message never answered is Errored with
"The turn produced no reply", the same words `failureOf` uses. A Cell that did not end well
records no Anchor, as a live one does not, so `anchors` — made with `anchorsAfter` — has only
the turns that ended, and a Chat whose every turn failed names no `agentSession`, as the
runner names none when nothing anchored. Only the path pi was left on is read; a Chat that
forked has the branches it abandoned in the copy and not in the Cells, and its opening Prose
says so, since a reader who remembers asking something would otherwise wonder where it went.

**A command run with `!` is a Bash Cell.** Pi records one as a `bashExecution` message with
the command, its one output stream, and how it exited; it becomes a Bash Cell whose record has
the output as `stdout`, an empty `stderr`, the exit code, and the runner's own words for a
non-zero one — "Command exited with status 1" — with a cancelled one Interrupted. Nothing was
asked of the agent for it, so it closes the turn before it: the prompt Cell's Anchor is the
entry before the command, and the next prompt Cell begins a turn of its own. The ticket named
prompt cells only, but a Chat with its commands left out would be work lost to the notebook
world, which is what the ticket is against.

**The Notebook is written by the edit machinery, from an empty file.** `applyEdit` on
`parseNotebook("")` takes the frontmatter and the segments and produces the bytes, so a body
holding a fence of its own is fenced longer and line endings are the file's, as for a body
typed in the browser; nothing here spells a fence. Cells are `cell-1`, `cell-2`, … in order —
the glossary's word, since a Cell is what each is — with no `uses` between them: the Chat is
evidence that each turn came after the last in one
shared context, which the Notebook's shared context already gives, and not that one depended
on another, which ADR-0003 leaves to the author. Braces in a message are escaped —
`{{ target }}` typed at the terminal becomes `\{{ target }}` — through a new
`escapeReferences` beside the reference regex in `notebook/inputs.ts`, so the parser does not
report an Input the Chat never had and the agent is asked exactly what was typed; there is a
test that interpolating the imported body gives the message back. The frontmatter declares
what the file knows: `title` when the session was named at pi's prompt, `workspace` as a path
relative to the Notebook when the Chat's directory is not the Notebook's, and `model` as the
last assistant message's `provider/model`. One line of Prose says which session it came from
and when.

**What the Chat's file does not say, the record does not claim.** `RunEnvironment` still has
its four fields, and `record.ts` now says beside them what an imported Run puts there:
`workspace` from the session header, `tools` as the names the turns are seen to have called,
`trusted` false and `piVersion` empty, since the file records neither. The alternative —
making the fields optional — would have put `?.` through every reader for a record that is
rare, and the record already says in `imported` which kind it is.

**A refusal leaves the disk as it was.** Absent, invalid — not a pi session, or one nothing
was asked in — and exists, each said once and before anything is written where it can be;
the Run's directory, made so the copy has somewhere to go, is taken back on a refusal along
with the directories made on the way to it when nothing else is in them, the Notebook's own
included when the import made it. The record is written before the Notebook, so a process
dying between the two cannot leave a Notebook with no account of where it came from; the
Notebook is written with `wx` so a name taken between the check and the write is refused
rather than overwritten. The command line says each refusal in a sentence and exits 1, as a
Run's refusal does; the server answers 404, 400 and 409 as the duplicate route does, the
"Markdown file under the served directory" check now being one function, `notebookTarget`,
that copying and promoting share.

**Tested at the seams the spec names, and looked at.** `import/pi-session.test.ts` drives
`importSession` at the module seam with session files pi's own `SessionManager` writes into
a temporary directory: the Cells in order, the record whole against the ids and moments pi
gave the entries, the three ways a turn does not end well, commands as Bash Cells, braces and
fences kept as text, the frontmatter, a forked Chat with its Prose saying so and every branch
in the copy, a Chat whose Workspace has gone refused on that by the Run, the round-trip byte
for byte, a Run of the imported Notebook with a scripted agent asked exactly what was typed,
the version-2 file untouched, and the four refusals leaving nothing behind. `launcher.test.ts` has the `import` word and
its mistakes; `server.test.ts` gained "promoting a chat" — the list latest first with names
and first messages, none, a promotion listed and opened as a Notebook with its record beside
it naming pi's file, the refusals, and the methods each route takes — with pi's session
directory pointed at one of the test's own, so no test reads what pi has on the machine.
The command line and the browser were walked against a temporary project with pi's agent
directory pointed elsewhere: two seeded Chats imported and promoted, the file, record and
copy inspected, pi's file compared byte for byte, and the refusals seen in both places. Found
on the way: a long first message pushed its Promote button off the page, which was the flex
child wanting `min-width: 0`.

**Left where it was.** A Notebook Session opened on an imported Notebook shows its Cells idle:
a fresh session knows only its Journal, as ticket 18 arranged, so the imported record is on
disk and not on the page, exactly as a Run made at the command line is not. A session that
opened on the Notebook's latest record would serve both, and is the next thing to try. Pi's
`SessionManager.list` reads every session file whole to list them, so a directory with
hundreds of long Chats will take a moment to show its list. A user message that was only an
image imports as an empty Prompt Cell. A `\{{name}}` typed literally at the terminal is left
as it was, and so reaches the agent as `{{name}}` when the Cell runs: the format has no way to
spell a literal backslash before braces, and the case is rare enough to leave. Pi's retries are
not recorded in a session file, so an imported Cell's `retries` is always empty. A Chat pi is
still writing to is copied as it stands, and a line pi was midway through is dropped by pi's
own reader without complaint, so a turn in flight at the moment of import is not imported;
pi's lock on the file is not checked. `octo.ts` remains the one untested file.
