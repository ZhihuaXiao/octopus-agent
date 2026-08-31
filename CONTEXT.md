# Agent Notebook Platform

A notebook environment for agents, built on pi. Work described once as a readable document
becomes something you can run again, hand to someone else, and review in a pull request.

## Language

### The document

**Notebook**:
A Markdown document describing a piece of work as a graph of Cells. Always the file, never
the thing running it.
_Avoid_: notebook file, document, script, playbook

**Cell**:
An addressable, executable unit of a Notebook, carrying an id, a type, and its declared
Dependencies.
_Avoid_: block, step, node, chunk

**Prompt Cell**:
A Cell whose body is addressed to the agent.
_Avoid_: agent cell, LLM cell, query cell

**Bash Cell**:
A Cell whose body is a shell command, run deterministically without the agent.
_Avoid_: shell cell, script cell, command cell

**Prose**:
Ordinary Markdown between Cells. Not a Cell: it has no id and no place in the Graph.
_Avoid_: prose cell, markdown cell, text cell, comment

**Input**:
A named, typed parameter declared in a Notebook's frontmatter and interpolated into Cell
bodies.
_Avoid_: parameter, argument, variable, field

**Input Reference**:
Where a Cell body names an Input, written `{{name}}` and replaced by that Input's value
before the Cell runs. Always qualified, because an unqualified "reference" is a Dependency.
_Avoid_: placeholder, template, substitution, variable

**Dependency**:
A declared edge from one Cell to another. Always written by the author, never inferred.
_Avoid_: input, reference, link, requirement

**Graph**:
The directed acyclic graph formed by Cells and their Dependencies. Determines the order
Cells run in, what is Stale, and what may run at the same time.
_Avoid_: DAG, tree, pipeline, dependency tree

**Isolated**:
A Cell that runs in a fresh context rather than the Notebook's shared one, making it
reproducible and safe to run in parallel. Orthogonal to whether it has Dependencies.
_Avoid_: independent, standalone, stateless, pure

**Mode**:
A named preset bundling a system prompt, a tool allowlist, a skill set, and a default
model. Code Mode and Work Mode ship first; a Notebook records its Mode at creation.
_Avoid_: profile, persona, preset, agent type, run mode

**Workspace**:
The directory a Notebook operates on.
_Avoid_: project, root, cwd, folder

**Declared Environment**:
What a Notebook says it needs of the machine that runs it: its Workspace, Tools, Skills,
Packages and pi version. Checked before a Run's first Cell and never repaired.
_Avoid_: requirements, dependencies, prerequisites

**Environment**:
What the machine actually provides, as the agent found it. The other half of the pair: a
Declared Environment is checked against an Environment, never against the disk directly.
_Avoid_: context, surroundings, setup, host

### Running

**Notebook Session**:
A Notebook loaded live in the server, with an Agent Session attached and its own execution
state. Owned by the server, so it outlives any browser that connects to it.
_Avoid_: session (unqualified), instance, kernel, workspace

**Agent Session**:
Pi's own session object and its message history. Pi's term, kept as pi uses it.
_Avoid_: session (unqualified), conversation, context, thread

**Run**:
One execution of some or all of a Notebook's Cells.
_Avoid_: execution, job, invocation, build

**Workspace Trust**:
Whether pi loads a Workspace's own settings, Skills and Extensions. Pi's decision, which a
Run makes explicitly rather than letting pi skip it. Never a security boundary (ADR-0006).
_Avoid_: permission, approval, sandbox, allowlist

**Run Record**:
The persisted result of a Run, stored outside the Notebook: per-Cell status, timings, the
model that actually ran, token usage and cost, and Anchors.
_Avoid_: output, log, result, history, report

**Stale**:
The state of a Cell whose Dependencies have run again since it last ran. A property of a
Run, never of the Notebook.
_Avoid_: dirty, invalid, outdated, expired

**Artifact**:
A file or image produced by a Run, written beside the Run Record and referenced by path.
Never the Notebook itself, and never embedded in it.
_Avoid_: output, attachment, blob, asset

**Anchor**:
The pi entry id a Cell records so a re-run can fork the Agent Session at the right point.
_Avoid_: checkpoint, marker, cursor, pointer

### The interfaces

**Author View**:
The Notebook shown as Cells, for writing and running them.
_Avoid_: edit mode, editor, developer mode

**Run View**:
The same Notebook shown as a form of its Inputs and a single button, with the Cells hidden.
For people who do not write prompts.
_Avoid_: run mode, form mode, simple mode, user mode

**Connection**:
An authenticated client attachment to the server.
_Avoid_: session, login, client session

### Inherited from pi

**Skill**, **Package**, **Extension**, and **Tool** are pi's own concepts and keep pi's
meanings. A Notebook declares which of them it needs; it does not redefine them.
