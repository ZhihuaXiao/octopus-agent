# An Artifact is what a Cell leaves in the directory it is given

Every Cell of a Run has a directory of its own for the files it produces, under the Run's
directory beside the Run Record, and refers to it in its body as `{{artifacts}}`. Whatever
the Cell leaves there when it ends is its Artifacts, recorded against the Cell as paths
relative to the Run's directory. Nothing a Cell writes anywhere else is an Artifact, and
nothing about an Artifact is ever written into the Notebook.

## Considered Options

**Watching what the agent wrote** — reading the paths off pi's `write` and `edit` tool
calls, and copying those files beside the record — needs no new word in the format and
catches a file the author never thought to name. It also misses the ones that matter most: a
chart drawn by a script the agent ran through the `bash` tool is a file nothing but the
shell saw, and a Bash Cell's files are invisible the same way. What it would catch instead
is every source file a code-mode Cell edited, snapshotted into the Run's directory as though
it were output rather than the work. And it is an inference from one non-deterministic run
about what the Cell produces, which is the offer ADR-0003 declines for the edges and
ADR-0016 for concurrency.

**Keeping the images the agent saw** — the image blocks pi returns when the agent reads a
picture — is the closest thing pi has to Jupyter's display data, and is what "no encoded
blobs" most literally asks for. It is also what the agent *read*, not what it *made*: an
agent checking a screenshot already in the Workspace would leave a copy of it in every Run.
When the agent makes an image and puts it in `{{artifacts}}`, the image is there as a file.

**Handing the directory over as an environment variable** works for a Bash Cell and not
for a Prompt Cell, whose body goes to a model and whose shell is pi's `bash` tool, running
in the process's own environment. One mechanism for both kinds of Cell, and the one
mechanism the format already has for putting a value into a body is an Input Reference.

**One directory per Run** rather than per Cell is one name fewer, and leaves two Cells that
both write `out.txt` overwriting each other, and two Isolated Cells running at once with no
way to say afterwards which left what. A directory per Cell settles both without the Run
having to watch anything.

**Diffing the Workspace** before and after each Cell would catch every file however it was
made, and would be wrong for the same two reasons: a code-mode Cell's edits are its work
rather than its output, and two Cells running at once cannot be told apart by a diff.

## Consequences

The format contract grows one reserved reference. `{{artifacts}}` resolves in every Cell
without being declared, and an Input may not take the name, since a body could then not say
which it meant. ADR-0009's grammar is unchanged: it is a bare name in braces like any Input
Reference, escaped the same way, and reported the same way if misspelled. Two of ADR-0009's
sentences bend for it, and are meant to. "Only a bare declared name is a reference" now
admits one name the Run declares rather than the Notebook; and "values are resolved once,
before the first Cell runs" holds for the Inputs and not for this, whose value is different
in every Cell and is worked out as each Cell starts. What ADR-0009 resolved everything early
*for* — that interpolation cannot fail once a Run has begun — still holds, since a directory
path is a value nothing can fail to have.

Interpolation is textual, as ADR-0009 says of every reference, and this path is the Run's
rather than the author's: it lies under the Notebook's own directory, so a Notebook kept
somewhere with a space in its path gets a `{{artifacts}}` with a space in it. A Bash Cell
quotes it as it would any path it did not choose — `"{{artifacts}}/chart.png"` — and the
example does. It is not quoted for the author, because a reference already inside quotes
would then break instead, and the Run cannot tell the two from the outside.

The directory is made before the Cell runs, so an agent or a command can write straight into
it, and only for a Cell whose body refers to it: a Cell that never names the directory has
nowhere to have left an Artifact and gets no empty directory saying so. Its `artifacts` is
then an empty list rather than absent, as `retries` is, so a reader can tell none from not
recorded.

Whatever the Cell left is listed when it ends, whether or not it succeeded. A Cell that
failed halfway may have left half of what it was making, and that is the only account there
is of how far it got — the same position ADR-0017 takes on a timed-out command's output.

An Artifact is named by a path relative to the Run's directory, `artifacts/<cell>/chart.png`,
rather than an absolute one, so the record and the files it names stay right relative to each
other wherever the Run's directory goes — which is what ticket 22's export needs to make a
document that stands alone. The Run's id is therefore chosen before the first Cell runs
rather than when the record is written, since the Cells' directories are under it.

The author has to say where a file goes. A Prompt Cell that asks for a chart and does not say
`{{artifacts}}` gets its chart in the Workspace, where every file the agent makes has always
gone, and the record does not mention it. That is the cost of not guessing, and it is one
word in the body.

A Run holds no more than the paths. Nothing bounds how much a Cell may put in its directory,
as nothing bounds how much a command may write to its output (ticket 04), and a Cell that
leaves a gigabyte there has a gigabyte beside its record.
