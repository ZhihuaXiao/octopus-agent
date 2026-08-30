# 05 — Declared inputs and interpolation

**What to build:** A notebook declares named inputs with a type, a default and a
description. Their values interpolate into cell bodies before those cells run, and the
command line supplies them, so one notebook serves many cases.

**Blocked by:** 03

**Status:** done

- [x] Inputs declared in frontmatter are readable as a typed set with descriptions
- [x] A reference to an input inside a cell body is replaced by its value before the cell runs
- [x] Values supplied from the command line override declared defaults
- [x] A required input with no value stops the run with a clear message before anything executes
- [x] A value of the wrong type is rejected before any cell runs

## Comments

**References are `{{name}}`, and an unknown one is reported.** Recorded in ADR-0009 with the
reasoning, and as **Input Reference** in `CONTEXT.md` — always qualified, because an
unqualified "reference" is a Dependency. The short version: `${name}` is unusable because a bash cell's body is a shell
script; only a bare declared name is a reference, so a Go template like `{{.State.Status}}`
in a `docker inspect` command is left alone; a backslash escapes the bare ones Go also uses,
so `\{{end}}` runs as `{{end}}`. A reference naming no declared input stops the notebook
from parsing, rather than reaching the model as itself and getting a plausible answer about
a directory called `taget`.

**An input's type is inferred from its default when it declares none.** `default: 3` is a
number input, because YAML has already typed the scalar and that is what the author
plainly meant; an input with neither type nor default is a required string. The three types
are `string`, `number` and `boolean` — no lists, because a value has to read as itself once
it is inside a prompt or a command. This tightened ticket 03's contract, where `type` was
any string and a default was any YAML shape: an unknown type, a default that disagrees with
its declared type, and a default of a shape no input can hold are now all reported.

**Required is the absence of a default, not a field of its own.** An input with a default
can always run and one without never can, so a second `required:` field could only ever
agree with the first or contradict it. Ticket 20's form will read the same distinction.

**Values are resolved once, before the first cell runs.** Everything wrong with them is
reported together, and the run throws rather than producing a record — the same shape as a
notebook that cannot be parsed. A notebook that stopped at its third cell for want of an
input would have spent the tokens of the first two.

**Left for the tickets that own it.** The command line is still the thin entry point ticket
13 replaces; `--target docs` and `--target=docs` both work, an unknown option or a repeated
one is reported, and the parsing sits in `src/cli/arguments.ts` so the real launcher can
take it over. Ticket 20 supplies the same values from Run View's form, which is the second
caller `resolveInputs` was shaped for: it reads values written as text, because that is what
a form and a command line both hand over.

**One thing with no owner.** Interpolation is textual, so a value carrying shell
metacharacters lands in a bash cell's command as written. Harmless while the author supplies
the values — they could have written the command — but Run View hands the form to precisely
the person not trusted to write cells. Ticket 20 or ticket 06 should decide whether a value
is quoted, refused, or left as it is with the trust boundary stated somewhere.
