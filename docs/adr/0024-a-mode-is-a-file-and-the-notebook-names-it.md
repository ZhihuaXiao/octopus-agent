# A Mode is a file, and only the Notebook names it

A Mode is a Markdown file: YAML frontmatter for its default `model`, its `tools` and its
`skills`, and a body that is its system prompt. Its name is the file's. Octo ships `code.md`
and `work.md` in `modes/` beside the program; a user's own are `~/.octo/modes/<name>.md`,
found by listing that directory, so adding one changes nothing in the application. A Notebook
names its Mode in frontmatter, the Run resolves it before the first Cell, and nothing else
can choose it.

## Considered Options

**Modes as code**, a table of Modes in the program, is what the spec ruled out: a user
could not add Design mode without a release.

**YAML or JSON alone** would do for the fields, but a system prompt is paragraphs of prose,
and a prompt inside a YAML string is a prompt nobody enjoys editing. Markdown with frontmatter
is the shape a Notebook already has and a pi Skill already has.

**A per-run override** — `--mode`, a field on the run request — was refused by the spec: Run
View's colleague would get whatever the person who set the server up chose, not what the
Notebook says, and the Notebook could no longer be read to know how it will run. The command
line has no such flag, so `--mode` is an Input like any other and is refused when the Notebook
declares none by that name.

**A user file overriding a shipped Mode of the same name** would let someone tune Code mode,
at the price of `mode: code` meaning something different on their machine than on everyone
else's without either file saying so. It is refused, naming the file, when a Notebook asks
for that Mode.

**Modes in the Workspace**, so a team could commit theirs, was left for later: `~/.octo/` is
where octo already keeps what belongs to its user, and one place to look is one place to be
told about.

**A Notebook with no Mode resolving to Code** would change how every Notebook written before
Modes existed runs. One that names none runs on pi's defaults as it always did, and its
record names no Mode.

## Consequences

A Notebook's own declarations stand in place of its Mode's: a Cell's `model`, then the
Notebook's, then the Mode's; the Notebook's `tools`, when it lists any, instead of the Mode's.
The Skills are the exception, being needs rather than a choice: a Mode's `skills` are the only
Skills pi gives the agent, together with the ones the Notebook declares; a Mode that lists
none leaves every Skill pi loads. A Mode's prompt replaces pi's, `SYSTEM.md` included; pi
still adds the Workspace's context files and the Skills after it. An empty body keeps pi's.

What a Mode asks for is checked as a Declared Environment is (ADR-0010): a tool or Skill it
names that is not here stops the Run, named after the Mode. So does a Mode that is not here, a
malformed Mode file — every problem at once, against its line — and a user file shadowing a
shipped one. All of them are refusals of kind `environment`, which Run View already words as
this computer missing something the Notebook needs.

Naming any tools is an allowlist to pi, which then shuts out every tool the machine's
extensions add and ignores its configured default tools. So Code mode, which is pi as pi is,
names none: no prompt of its own, pi's tools and its extensions', every Skill, and the
machine's default model. Work mode has a prompt for office and knowledge work,
`anthropic/claude-sonnet-4-5`, and no Skills but the Notebook's. It names pi's own `read`,
`bash`, `edit` and `write` and nothing else, which is what keeps it without connectors even on
a machine whose extensions add some; its prompt tells the agent to say so rather than pretend
when a task needs one. That allowlist is a usability choice, never a security boundary
(ADR-0006): `bash` is among it.

The Run Record's `environment` names the Mode that ran. It names the Mode, not its contents: a
Mode file edited since is not detected, as a Skill updated since is not.
