# An Input is referenced as `{{name}}`, and an unknown reference is an error

A Cell body refers to an Input by its name in double braces. Only a bare declared name is a
reference, a backslash escapes the braces, and a reference to an Input the Notebook does not
declare stops the Notebook from parsing.

## Considered Options

The obvious alternative is the shell's own `${name}`, which every developer already reads as
    10|interpolation. It is unusable here: a Bash Cell's body is a shell script, so `${name}` and
`$name` already mean something inside it, and the Cell that most needs a parameter is often
the one that can least afford to have its variables rewritten. Braces are the one sigil that
collides with neither the shell nor ordinary Markdown.

They do collide with Go's templates, which matters because `docker inspect -f` and
`kubectl -o go-template` are exactly the sort of command a Bash Cell runs. Two things keep
that workable. Only a bare name matching an Input's grammar is a reference, so
`{{.State.Status}}` and `{{range .Items}}` are left alone without anyone having to think
about it. For the bare ones Go also uses — `{{end}}`, `{{else}}` — a backslash escapes the
    20|braces: `\{{end}}` runs as `{{end}}`.

Leaving an unresolvable reference as text was the other option, and is what a template
engine would do. We report it instead. A mistyped `{{taget}}` left as text reaches the model
as itself, and the model will answer plausibly about a directory called `taget` — the same
silently-degraded run that the declared environment exists to prevent. The cost is that a
Notebook wanting a literal `{{word}}` must escape it.

## Consequences

Interpolation cannot fail. By the time a Run starts, the parser has established that every
    30|reference names a declared Input, and resolution has established that every declared Input
has a value, so replacing them is a total function with no error path to design.

Values are resolved once, before the first Cell runs, rather than as each Cell needs them. A
Notebook that stopped at its third Cell for want of an Input would have spent the tokens of
the first two and half-applied their changes to the Workspace.

The escape has no escape of its own: a backslash immediately before a reference always
escapes it, so a body cannot write a literal backslash directly in front of an interpolated
value. Nothing needs one yet, and the rule stays one sentence long by not trying.

Interpolation is textual, which in a Bash Cell means a value can carry shell metacharacters
into the command. That is nobody's problem while the author supplies the values, since the
author could equally have written the command. It becomes one in Run View, where the person
    40|filling in the form is precisely the person not trusted to write the Cell.
