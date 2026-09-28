# 23 — Modes as preset files

**What to build:** A mode is a file bundling a system prompt, a tool allowlist, a skill set
and a default model — data, not code. Code and Work ship as files, and a user can add their
own without waiting for a release. Work mode is a preset only; connectors are out of scope,
and it exists to learn what office automation should be rather than to be it.

**Blocked by:** 06

**Status:** done

- [x] Code and Work modes exist as preset files rather than as code
- [x] A notebook's declared mode resolves to its preset at run time
- [x] A user-defined mode file is discovered and usable without changing the application
- [x] Work mode ships with no connectors
- [x] A notebook's mode cannot be overridden per run, since that would break Run View's reproducibility

## Comments

**A Mode is a Markdown file, the shape a Notebook and a pi Skill already have.** ADR-0024 has
the reasoning. YAML frontmatter holds its default `model`, its `tools` and its `skills`, each
optional; the body is its system prompt, and an empty one keeps pi's. The file's name is the
Mode's. `modes/code.md` and `modes/work.md` ship beside the program, found from `src/` and
`dist/` alike; a user's own are `~/.octo/modes/<name>.md`, beside the password, found by
listing that directory — so a name that climbs out of it is simply a Mode that is not there.
`src/mode/mode.ts` is the reading and the finding; the Run is the only caller.

**The Notebook's own word stands in place of its Mode's.** A Cell's `model`, then the
Notebook's, then the Mode's; the Notebook's `tools`, when it lists any, instead of the Mode's.
The Skills are the exception, being needs rather than a choice: a Mode's `skills` are the only
Skills pi gives the agent, together with the ones the Notebook declares, and a Mode that lists
none leaves every Skill pi loads. `AgentSetup` grew `systemPrompt` and `skills`; `pi.ts` hands
them to pi's resource loader as `systemPromptOverride` — in place of `SYSTEM.md` too, with pi
still adding the Workspace's context files and the Skills after it — and a `skillsOverride`
that filters what pi loaded, so a Skill in the set that pi never found is reported missing.

**Everything about a Mode that is not right refuses the Run, of kind `environment`.** A Mode
that is not here, naming the ones that are and where the user's own go; a malformed Mode file,
every problem at once against its line; a user file with a shipped Mode's name, which would
make `mode: code` mean something else on one machine without either file saying so; and a
tool or Skill the Mode names that is not here, named after the Mode, as ADR-0010 has it for
the Notebook's own. Run View already words that kind as this computer missing something. The
check of a Mode's tools was not asked for; it is there because a misspelt tool in a Mode is
otherwise an agent quietly short of one.

**Code mode names no tools, which a review caught.** Naming any is an allowlist to pi: it shuts
out every tool the machine's extensions add and ignores its configured defaults. Code mode is
pi as pi is, so it names none. Work mode names pi's own four and nothing else, and that is what
keeps it without connectors even on a machine whose extensions add some — a usability choice,
never a boundary, with `bash` among them. Its prompt is for office and knowledge work and says
to admit there is no tool for mail or calendars rather than pretend; its model is
`anthropic/claude-sonnet-4-5`; it gives the agent no Skills but the Notebook's.

**Nothing but the Notebook chooses the Mode.** `RunOptions` has no field for it and the command
line no flag: `octo run nb.md --mode work` is an Input named `mode`, refused when the Notebook
declares none. `userModesDirectory` says where to look, not what to pick, and only a test sets
it. The Run Record's `environment` names the Mode that ran; a Notebook that names none runs on
pi's defaults as it did before, and its record names none.

**Tested at the one seam agreed.** Fifteen `runNotebook` tests with the scripted agent and a
temporary directory of the user's Modes: Code mode as pi is, Work mode's prompt, model, Skills
and tools, a user's Mode found and its model, prompt, tools and Skills given, the Notebook's own
model and tools over the Mode's, a missing tool and Skill named after the Mode, the Mode
recorded, and each refusal. Pi's wiring was not put under test, by agreement, and was walked by
hand with pi's agent directory pointed at a scratch one holding two Skills: the filtered set
reached the Environment, and the session's prompt was the Mode's with only the allowed Skill
after it. The built command line was walked too: an unknown Mode refused and the shipped two
listed, Code mode run, `--mode` refused, and a Mode in a scratch `HOME`'s `~/.octo/modes`
found, applied and recorded.

**Left where it was.** Nothing yet lets a Notebook be created with a Mode chosen (story 57): the
browser has no "new Notebook", and an Import writes no `mode`, though a Chat is Code mode in
all but name. A user file shadowing a shipped Mode is refused only when a Notebook asks for that
Mode. The record names the Mode and not its contents, so a Mode file edited since a Run is not
detected, as a Skill updated since is not; and a Notebook whose `mode` is edited between a Run
and one continuing it continues the Agent Session under the new Mode, as it would under a new
`model`. Modes in the Workspace, so a team could commit theirs, were left for later. The
frontmatter reading in `mode.ts` repeats the shape of the Notebook's rather than sharing it,
since the fields and the messages differ.
