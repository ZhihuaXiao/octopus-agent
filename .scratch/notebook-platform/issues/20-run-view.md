# 20 — Run View

**What to build:** The same notebook presented to someone who does not write prompts — the
cells hidden, the declared inputs shown as a form, one button, visible progress, results
and files at the end, and failures explained in language they can act on.

**Blocked by:** 05, 16

**Status:** done

- [x] Cells are hidden and the notebook's inputs appear as a form with their descriptions
- [x] One button starts the run
- [x] Progress is visible while it runs
- [x] Results and any produced files are shown when it finishes
- [x] A failure is explained in plain language, stating whether to retry or ask for help
- [x] A missing declared skill or package surfaces as a clear message rather than a degraded run

## Comments

**The Run View is the same Notebook Session, shown the other way, and the URL says which.**
`#report.md` opens the Author View as before and `#run/report.md` the Run View — a Notebook's
own path is percent-encoded in the fragment, so `run/` can begin no path and the prefix is
unambiguous — which is what lets a link be sent to the person the view is for and open the
way it should. The header carries a link across — "Run view" among the author's buttons,
"Author view" alone on the other side — and the list a "Run view" link beside each Notebook.
Switching views keeps the session and the socket: `showSession` finds the Notebook already
watched and redraws the page rather than opening it again, so a form half filled in survives
a look at the Cells. The Author View is unchanged but for that link and one class on its
output, so text streamed to whichever view is drawn lands in the Cell it belongs to.

**The state carries the Inputs, so the browser reads no YAML.** `NotebookSessionState` grew
`inputs`: the Notebook's declared Inputs as `frontmatter.ts` read them — name, type,
description, and the default where there is one, its type inferred from it when none is
written. The form is one field per Input, its name over it and its description under that: a
text field for a string, a number field for a number, and a choice of yes or no for a
boolean, with a blank "Choose…" first when there is no default so that not choosing is not
mistaken for choosing. A field is required where the Input has no default — ticket 05's
distinction, read as it said it would be — and also where it is a number or a boolean with a
default, since a cleared one would read as neither. A string with a default may be cleared
to the empty string, which is a string. Every value travels as typed, in the `inputs` the
`run` route already took, and the server reads it as the command line's are read. The form
is drawn once per declared set of Inputs and left alone as events redraw the rest of the
page, or typing into it would be undone by a Cell finishing. A Notebook with no Inputs says
so in a sentence and has the button. The button posts a Run of every Cell, carrying on from
the last as any Run does, which for a first Cell is an empty context, so a Run View Run
begins from the top each time.

**Progress and results are the Cells by name, with everything else about them hidden.** Each
Cell is a row with its id and a word for where it stands — "not run yet", "running…",
"done", "failed", "took too long", "stopped", "needs running again" — coloured as the Author
View colours it; under the name, what it has said so far, streamed as the Author View
streams it, or a command's output once it is over; and the files it left, drawn or linked
through the same route ticket 16 built. The body and the tool calls are not shown, which is
the point of the view. Above the list, while a Run is under way, "Running… 2 of 5 done",
counted against the Run in progress once it has named itself, and a Stop button — one button
starts the Run, but leaving somebody with a Run they cannot end would be worse than a second.
Cell ids are the author's vocabulary, but they are the only names the Cells have, and a
result has to be labelled by something.

**A refusal says what kind of thing was wrong, so the page can say whose it is to fix.** The
runner's refusals were one `Error` with a message; the Run View has to say whether pressing
Run again could help, and that turns on which of the things settled before the first Cell
was not settled. `runNotebook` now throws a `RunRefusal`, whose message reads as it always
has — "Cannot run <path>:" and the problems, for the terminal and the Author View — and
which carries `kind`, one of `notebook`, `inputs`, `cells`, `workspace`, `agent` and
`environment`, and `problems`, each said once. `run-refused` carries the pair as `refusal`
when the runner made the refusal, and only the message when something failed that should
not have. The Run View reads the kind: wrong values are the reader's own to put right, and
the panel says to correct them and press Run again; a missing skill, package or tool, or a
pi version, is "This computer is missing something the notebook needs, so nothing was run",
the runner's line naming what, and "Running again will not help until it is installed: ask
whoever set this notebook up on this computer" — the ticket's last box, and what ADR-0010
promised, now said where the person who would otherwise get a plausible wrong answer is
standing. The Workspace and the Notebook itself are somebody else's too; the agent failing
to start is worth one more try first. A Run that started and stopped is explained from the
Cell it stopped at: a timeout says to try again and to ask if it happens twice; a command
that failed says to try once more and that failing the same way twice is the Notebook's to
fix, since a command does the same thing each time; a turn the model could not finish says
it is often a passing problem and to try again in a minute; a Run somebody stopped says to
press Run when ready, in amber rather than red, as an Interrupted Cell is. The server's own
words go under the heading in monospace, for passing on. "Finished" with everything done is
said in green. The outcome is read off the Cells' statuses rather than the last Run's
record, so a browser opening a Notebook whose last Run failed sees it explained too; a
refusal is held on the page until the next Run starts, and not by the server, so a reload
after one shows the form and nothing more.

**A value typed here reaches a Cell as typed, and that is not a boundary.** Ticket 05 left
open whether a Run View value carrying shell metacharacters into a Bash Cell should be
quoted, refused, or left as it is. Left as it is: there is one account (ADR-0006), the Run
View is opened with the same Connection the Author View is, and whoever is at the form is one
click from editing the Cells; quoting would make `{{target}}` mean something different in
the two views, and refusing would refuse a value the author could have typed. `CONTEXT.md`'s
Run View entry now says so — for people who do not write prompts, not people who may not —
and the client's Run View section says it again where the form is.

**The 202 and the socket are two connections, and a short Run can end over one before the
other answers.** Found walking the Run View through a forwarded port: a Bash Cell and a
scripted turn had begun and ended over the socket before the `run` answer arrived, and the
page then took the answer's word that the Run was under way and stayed there with the button
off. The answer carries the session's `sequence`, and the page now adopts it only when it
has heard nothing since; a Run that has already announced itself, or ended, is left as the
socket said. The Author View had the same race and never met it, since a real turn takes
longer than a round trip. A second thing found: the page's `hidden` attribute was being
beaten by `display: flex` on the controls it hid, so `[hidden]` is now `display: none
!important`, the one place the stylesheet says so.

**Tested at the seams the spec names, and looked at.** `runner.test.ts` gained "what a
refusal says of itself": the inputs kind with everything wrong one to a line and the message
unchanged, the environment kind naming a tool and a skill, and the notebook, cells, workspace
and agent kinds each in their turn. `server.test.ts` gained the Inputs on the state as
declared — a default's type inferred, a required Input with none — the refusal's kind and
problems beside the message the Author View shows, a missing skill refused with no Run named
and the agent asked nothing, and a number and a yes or no read as a form types them; the
full-shape assertion on opening now has `inputs: []`. The client is still not under test but
was walked in a browser against a server over a temporary directory with a scripted agent
underneath: the list's links; the form drawn with a default filled in, a number required and a
boolean's blank choice; a Run with typed values, "Starting…" then "Running… 1 of 2 done",
text streamed under the running Cell, the PNG drawn and the note linked, and "Finished"; the
missing skill's message with the button back on; a command exiting 3 and a scripted 529 each
explained in their own words, the dependent Cell shown as needing running again; a hanging
turn stopped with the Stop button and said to have been; and a switch to the Author View and
back with a typed value kept.

**Left where it was.** Prose is not shown in the Run View, so a Notebook's introduction to
the reader is not read there; showing the first Prose above the form would be the next thing
to try. A Cell's `stderr` is on the record but not on `CellView`, so a failed command's
complaint is not on the page in either view. Whether a Prompt Cell's failure came after pi's
retries is on the record and not on the view either, so the model's advice to try again is
general rather than counted. A refusal is remembered by the page and not the session, so a
second browser, or a reload, does not see it. The `cells` kind cannot arise from the Run
View, which runs every Cell; it is named for completeness and for the Author View's benefit.
`main.js` is past fifteen hundred lines and still one file with no build step; the Run View
is a section of its own and would be the first to move behind a shared DOM module when the
moment comes. `octo.ts` remains the one untested file.
