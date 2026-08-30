# 06 — Declared environment and workspace trust

**What to build:** A notebook declares the workspace it operates on and the tools, skills
and packages it needs. A run refuses to start when any of them is missing, because a
silently degraded environment produces a plausible wrong answer rather than an error. The
pi trust decision for the workspace is made explicitly instead of being skipped, which is
what pi does by default in non-interactive modes.

**Blocked by:** 03

**Status:** done

- [x] Cells execute with the declared workspace as their working directory
- [x] Only the declared tools are available to the agent
- [x] A missing declared skill or package stops the run before any cell executes, naming what is missing
- [x] The workspace trust decision is made explicitly and recorded, so project skills never silently fail to load
- [x] A declared pi version that does not match the running one is reported

## Comments

**The Run makes its own agent now.** `runNotebook` takes an agent factory rather than a
ready-made agent, because how the agent is set up — its Workspace, its tools, its trust
decision — is the Notebook's to say and the Notebook has not been read when a Run is asked
for. The CLI no longer parses the Notebook a second time to find the Workspace. Ticket 10
wants this anyway: an isolated Cell is a second agent from the same factory.

**Trust is the Run's decision, not the Notebook's.** ADR-0011 has the reasoning. It arrives
as `--trust` / `--no-trust`, is recorded in pi's own trust store so the `pi` command and a
Run share one answer, and a Workspace pi gates with nothing decided about it refuses the
Run rather than silently loading none of its skills. The cost is that `trust` and `no-trust`
are two Input names this command line cannot pass a value for — worth settling in ticket 13.

**A declared environment is refused, never repaired.** ADR-0010. That includes `pi_version`,
which stops a Run like anything else missing: pi ships breaking changes in minor releases,
so "close enough" has no meaning that could be encoded. A Notebook that does not care does
not declare one.

**Two things for the tickets that own them.** The Run Record grew a run-level `environment`
— the Workspace, the trust decision, the pi version and the tools the agent had — because
"recorded" has to mean something a reader of a record can see; ticket 12 still owns the
per-cell fields. And a missing Workspace now refuses the Run rather than surfacing as the
first Bash Cell failing to start, which is where ticket 04 left it.

**One weakness worth knowing about.** A declared skill or package is matched by exact string
against pi's own name or source, and no test proves that matching against a genuinely
installed one: loading a project skill needs a trust decision recorded on the developer's
machine, which is not a side effect a test suite should have. The live suite guards the
shape and the trust primitives; the matching itself is guarded only by the refusal being
loud when it is wrong.
