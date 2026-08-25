# 04 — Bash cells

**What to build:** A bash cell runs its body as a shell command in the notebook's
workspace, without involving the agent and without spending tokens, and its result becomes
part of the run. These are what make a notebook reproducible rather than merely repeatable.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] A bash cell executes and its stdout, stderr and exit status land in the run record
- [ ] A non-zero exit is treated as a cell failure
- [ ] Bash cells consume no tokens and are recorded at zero cost

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
