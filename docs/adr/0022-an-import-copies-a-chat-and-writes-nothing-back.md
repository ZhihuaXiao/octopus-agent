# An Import copies a Chat and writes nothing back

Importing a Chat makes a Notebook and a Run Record from pi's session file by copying the file
under the new Run's directory and reading the copy. Pi's file is never opened for writing,
never moved, and never told about the Notebook; the copy is the imported Run's Agent Session,
and a later Run that carries on from the record forks the copy. Nothing syncs a Notebook back
to a live session, and the spec puts two-way sync out of scope for good.

## Considered Options

**Attaching to the session in place** — naming pi's own file as the imported Run's Agent
Session, so a later Run forks pi's file where the Chat left off — would mean the next Run
appends to a file pi may still hold. Pi runs one active session per process and holds the
file with a lockfile while it does; a Notebook run from the browser while the terminal
session is open would either fail on the lock or, where the lock is not honoured, interleave
two writers in one append-only tree. The research notes and the spec are plain: read pi's
session files if useful, never write them concurrently.

**Pi's own `importFromJsonl()`** does copy the file, but into pi's session directory under
the file's own name — so a second import of the same Chat silently overwrites the first — and
it does so by tearing down the runtime's current Agent Session, which a server holding
Notebook Sessions cannot afford. It also throws when the recorded working directory has gone,
where an import should still produce the Notebook and let the Run refuse on the Workspace.

**Reading pi's file without copying it** — parsing the entries and recording no Agent Session
at all — would leave the record unresumable, when ADR-0014 makes the Agent Session the thing
an Anchor is meaningful in. And it would not even be a read: `SessionManager.open` brings an
older session up to the current format by rewriting the file in place, so opening pi's own
file through pi's own API is a write when the file is old enough.

**Copying first, then opening the copy** is what pi does inside `importFromJsonl()`, done
where the copy belongs — beside the record, under the Run's directory, where the Run's
Artifacts already live — and with pi's API kept for what it is good at: migrating the
format, resolving the tree, and naming the leaf. A byte copy keeps every branch and every
entry id, so the Anchors read off the copy address the copy exactly.

## Consequences

An imported Run Record names two files: `imported`, pi's session file, for the reader's
account of where the results came from; and `agentSession`, the copy, for the machinery —
named, as the runner names one, only when an Anchor stands in it, since a Chat whose every
turn failed has nothing in it for a later Run to fork at. The two hold the same bytes at the
moment of import and drift apart from then on — pi's as the terminal session goes on, ours as
Runs fork it — which is the one-way arrangement the ticket asked for. Only the path the Chat
was left on becomes Cells; the branches it abandoned are in the copy, every entry of them,
and the Notebook's opening Prose says so when there are any, so a reader who remembers asking
something is told where it went rather than left to wonder.

A Chat's size is the copy's size, and it is paid once per import. ADR-0014 said an import is
where a session's size becomes something anybody has to look at; it is, and the answer for
now is that a session pi found affordable to keep is affordable to copy once.

What the Chat's file does not say, the record does not claim. It names the Workspace the Chat
ran in and the tools its turns are seen to have called; it records `trusted` as false and
`piVersion` as empty, since the file holds neither, and `record.ts` says so beside the
fields. A Prompt Cell's `text` is everything the turn said, since nothing streamed the rest
to anyone at the time. And the Notebook declares no Dependencies between its Cells: the Chat
is evidence that each turn came after the last in one shared context, which the Notebook's
shared context already gives, and not that one depended on another, which ADR-0003 leaves to
the author to say.

Listing a Workspace's Chats goes through `SessionManager.list`, which makes pi's session
directory for the Workspace when it does not yet exist — an empty directory pi makes itself
the moment it is run there, and not a session file. It is the one thing about a Workspace an
import can be said to touch, and it is what pi would have done. Agent Sessions belonging to
Notebooks (from Run Records or active Journals) are excluded from the listing, keeping the
list focused on interactive CLI chats and protecting Notebook sessions from deletion.
