# 12 — Run record completeness, artifacts, and per-cell model

**What to build:** The run record fully describes what happened on a run, and files the
agent produced are stored beside it and referenced by path rather than embedded in the
notebook; see ADR-0005. A cell may override the notebook's default model, which is what
makes a cheap deterministic step cheap — and the model that actually ran must be recorded,
because providers rotate versions under stable names.

**Blocked by:** 02, 04

**Status:** done

- [x] The run record carries per-cell status, start and end times, the model actually used, token counts and cost
- [x] Generated files and images are written to the run's artifact location and referenced by path
- [x] No output or artifact content is ever written into the notebook file
- [x] A cell's model override is honoured and recorded
- [x] Two runs of the same notebook produce two separate run records

## Comments

**An Artifact is what a Cell leaves in the directory it is given — ADR-0019.** The open
question was how a Run knows which files a Cell produced, and every way of finding out —
reading pi's `write` and `edit` calls, keeping the images the agent read, diffing the
Workspace — either missed the files that matter most (anything a script made through the
`bash` tool, and every Bash Cell's) or mistook a code-mode Cell's edits for its output, and
all of them were an inference from one run of the kind ADR-0003 and ADR-0016 decline. So the
Run tells the Cell instead: every Cell has a directory of its own under the Run's, written
`{{artifacts}}` in its body, made before the Cell runs and only when the body names it, and
whatever is there when the Cell ends is listed against the Cell as paths relative to the Run's
directory — `artifacts/count/count.txt`. This reserves one Input name; an Input called
`artifacts` is now reported. The cost is that an author has to say where a file goes, and a
Prompt Cell that forgets gets its file in the Workspace as it always did. The Run's id is
now chosen before the first Cell rather than when the record is written, since the Cells'
directories live under it.

**Cost is pi's figure, not ours.** `Usage` grew a `cost`, in US dollars, summed from the
`usage.cost.total` pi puts on each assistant message of the turn; a price list here would
drift from the provider's exactly as ADR-0018 says a copy of pi's retry classification
would. Bash Cells record `cost: 0` with their zero tokens, which is where ticket 04's
"recorded at zero cost" now literally lives. No Run total: it is a sum a reader can take,
and a figure the record does not need to keep in step.

**A turn that failed still cost what it cost.** ADR-0017 left a stopped turn's tokens for
this ticket's accounting, and a turn that errored after a long think is no different. So
`TurnFailure` now carries the `usage` the turn had run up when it failed, `pi.ts` fills it
from the messages the turn did leave, and the runner records it against the errored or
timed-out Cell in place of the zero it wrote before. The scripted agent's failing and hanging
turns may say what they had spent, which is how the two tests are written.

**A Cell's span is the Run's span on it, not the timeout's.** `startedAt` and `endedAt` are
stamped where the scheduler starts and finishes with the Cell, so they take in making an
Isolated Cell's context and forking a continued Run's Agent Session, which the timeout clock
(ADR-0017) deliberately does not. The record accounts for what the Run spent; the timeout
bounds what the Cell's own work may take; and a Cell that failed at either arrangement still
has a span. The overlap ADR-0016 said would become visible with per-Cell timings now is —
there is a test of two Isolated Cells whose spans cross.

**The model is asked for per turn, and the record names it with its provider.** The agent
boundary's `prompt` takes options — `{ model, signal }` — rather than a positional signal,
and `modelOf(notebook, cell)` mirrors `timeoutOf`: the Cell's `model`, else the Notebook's,
else nothing, which is pi's own default as before. The override is one Cell's alone: the
Agent Session is put back on its own model as soon as the override's turn is over, however
the turn went, rather than when the next Cell asks. That matters beyond the next Cell — pi
reopens a session on the model it last recorded, so a later Run continuing from the
overridden Cell's Anchor would otherwise have started on the override; putting it back
behind the turn, and reading the Anchor after that, keeps the reopened session on its own
model. `pi.ts` resolves the name with `resolveCliModel`, the same reading pi's
own `--model` flag gets, and reports what served the turn as `provider/model` using pi's
`responseModel`, so the record's model reads beside the Notebook's. The scripted agent
records the model each turn asked for and serves exactly what was asked unless its script
says a dated version ran, which is how the "recorded, not merely honoured" test is written.

**A Run reads pi's settings and writes none of them back.** Pi's `setModel` saves the
model — and the thinking level — as the user's new default in `settings.json`, which is the
right thing for someone at pi's prompt and the wrong thing for a Cell that asked for a
cheaper model. Rather than reimplement the switch on pi's internals, `pi.ts` gives each
Agent Session a `SettingsManager` over an in-memory copy of what pi itself read from disk
(`SettingsManager.fromStorage`, a public API), so pi's writes land in the copy and go with
the Run. Every Agent Session the boundary makes now gets this, not only one that switches
models; nothing a headless Run does should be rewriting the machine's settings. Trust
decisions are a separate store and are still persisted, as ADR-0011 wants.

**The artifact path is absolute, and interpolated as text like every reference.** Absolute
because a Cell runs in the Workspace rather than where the Run was launched from, so a path
relative to the launch directory — which is how the Notebook may well have been named —
would point the Cell somewhere else; there is a test at the runner seam. It lies under the
Notebook's directory, so a Notebook kept somewhere with a space in its path hands its Bash
Cells a `{{artifacts}}` with a space in it; a Bash Cell quotes it as any path it did not
choose, and ADR-0019 says why the Run does not quote it for the author. And if the run
directory itself cannot be written to, making a Cell's artifact directory fails and the Run
stops rather than recording the Cell as errored — but the record would have had nowhere to
go either, since it is written into the same directory.

**Unverified against a provider.** No credentials were present where this was built, so
the live suite gained a test — a turn on the Agent Session's own model, one on a model named
from pi's available list, one back, a check that `settings.json` is byte-for-byte what it
was, and a second agent reopening the session at the overridden turn's Anchor to find it on
its own model — that is written conservatively and skipped until someone with a key runs it. The
same goes for `pi.ts` summing `cost.total` and reading `provider`; the session-format test
already pins that both fields are on the message. The parts the scripted agent can reach —
what the runner asks for, what it records, what it puts on disk — are tested at the runner
seam like everything else.

**Left where it was.** The command line still prints the run id and its record path, and
nothing of cost or artifacts; the record has both, and the launcher is ticket 13's to shape.
Nothing bounds how much a Cell may leave in its directory, as nothing bounds a command's
output. And `toolCalls` in the record still carries a `write` call's whole `content` as its
input — that is the record, which ADR-0005 allows to hold results, not the Notebook — but it
is the one place the record embeds bytes a reader might rather have by path, and worth a
look when ticket 16 draws tool-call cards.
