# 04 — Bash cells

**What to build:** A bash cell runs its body as a shell command in the notebook's
workspace, without involving the agent and without spending tokens, and its result becomes
part of the run. These are what make a notebook reproducible rather than merely repeatable.

**Blocked by:** 02

**Status:** done

- [x] A bash cell executes and its stdout, stderr and exit status land in the run record
- [x] A non-zero exit is treated as a cell failure
- [x] Bash cells consume no tokens and are recorded at zero cost

## Comments

**From ticket 03 (format contract).** A ```` ```bash ```` fence is only a Bash Cell when it
carries an `id`; without one it stays Prose, so that the shell snippets in ordinary
documentation aren't mistaken for Cells. The cost is that an author who forgets the `id` on
a real Bash Cell gets silence — the cell simply never runs — where the same mistake on a
prompt fence is reported. Ticket 03 narrowed the silence as far as it could without
guessing (a mistyped tag carrying an `id`, attributes with no tag, and an indented cell
fence are all reported now), but this last case needs a judgement that belongs with the
ticket that makes bash cells real. Worth deciding here whether a bash fence with no id but
with other cell attributes should be reported.

**Decided: yes, reported.** A bash fence with no `id` but carrying `type`, `uses`,
`isolated` or `model` now reports "Cell is missing an id". Those four attributes are this
project's own invention, so no documentation snippet carries one and the report needs no
guess; a fence carrying some other tool's attributes, like ` ```bash title="Install" `,
still stays Prose. A bare ` ```bash ` fence with a forgotten id stays silent, because
nothing distinguishes it from a snippet. Recorded in ADR-0008.

**Two decisions worth knowing about downstream.** The Run Record's per-cell entry is now a
union discriminated by `type`: a prompt cell carries text, tool calls and a model, a bash
cell carries stdout, stderr and an exit code, and both carry `usage` — zero for bash, which
is where "recorded at zero cost" lives until ticket 12 adds a cost field. And bash cells
run under `bash -c` with stdin closed, so a command that waits on input sees end of file
rather than wedging a headless run; a command killed by a signal records a null exit code,
which is the hook ticket 11 needs for timeouts.

**Left for the tickets that own it.** A bash cell's output does not stream — it lands in
the record when the command finishes, and the CLI prints stderr only for a cell that
failed. Ticket 15 owns streaming. Input interpolation into bash bodies is ticket 05, and
validating a declared workspace before the run starts is ticket 06 — today a missing
workspace surfaces as the first bash cell failing to start.

**One thing with no owner.** Nothing bounds how much output a command may buffer, and a
timeout is not the answer: ticket 11 would bound how long a command runs, not how much a
fast one can produce in that time. Worth its own ticket if a runaway command ever costs
somebody a run.
