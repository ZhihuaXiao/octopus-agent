# The fence tag carries a Cell's type

A Cell's type is the fence's tag — ` ```prompt ` or ` ```bash ` — rather than a `type`
attribute among the others. A `type` attribute is accepted when it restates the tag, and
reported when it disagrees.

## Considered Options

The spec's format contract lists `type` alongside `id`, `uses`, `isolated` and `model`,
which reads as though all five are attributes. Writing it as one would have been uniform:
` ```id=audit type=prompt `.

We put the type in the tag because that is the slot Markdown already has for it. Every
editor, every diff viewer and every Markdown renderer highlights a fenced block by its tag,
so ` ```prompt ` gets the highlighting and the reader's eye for free, while a bare fence
carrying attributes gets neither. It also keeps a Cell recognisable at a glance from the
first three characters of its opening line.

## Consequences

The type cannot be spelled two ways, so nothing has to decide which spelling wins when they
disagree. A fence whose tag is neither `prompt` nor `bash` is Prose — but a fence carrying
an `id` attribute is a near miss rather than Prose, and is reported, so a mistyped tag like
` ```promt id=greet ` cannot silently turn a Cell into decoration.

A `bash` fence remains Prose unless it carries an `id`, so the shell snippets that appear in
ordinary documentation are not mistaken for Cells. Ticket 04 settled the case that leaves:
such a fence is reported as missing its id when it carries any *other* cell attribute —
`type`, `uses`, `isolated` or `model`. Those four are our own invention and appear on no
documentation snippet, so their presence is proof of intent rather than a guess; an info
string carrying some other tool's attributes, like ` ```bash title="Install" `, stays Prose.
This is as far as the silence can be narrowed: a bare ` ```bash ` fence with a forgotten id
is indistinguishable from a snippet, and always will be.
