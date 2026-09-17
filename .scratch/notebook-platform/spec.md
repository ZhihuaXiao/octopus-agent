# Spec: Agent Notebook Platform (v1)

**Status:** ready-for-agent
**Date:** 2026-08-19
**Research:** [research-pi.md](./research-pi.md) — pi facts, verified against 0.84.2
**Vocabulary:** [CONTEXT.md](../../CONTEXT.md) — terms used here are defined there
**Decisions:** [docs/adr/](../../docs/adr/)

## Problem Statement

Agent work is ephemeral. You describe a task to a coding agent, it does the work, and what
survives is a transcript nobody re-reads and nothing anybody can re-run. The next time the
same job comes round — the weekly report, the dependency audit, the migration applied to a
fourth service — you start over and re-explain everything from scratch.

Two consequences follow. Work that *should* be repeatable isn't, so its value is consumed
once and thrown away. And the agent stays locked to whoever can drive a terminal, so a
colleague who needs the job done has no way to run it themselves; they have to ask.

Pi already solves the hard part underneath — the agent loop, the providers, the tools, a
session store. What it has no concept of is a **durable Notebook**: work you made once and
can run again, hand to someone else, review in a pull request, and trust.

## Solution

A notebook environment for agents.

A notebook is a Markdown file describing a piece of work as a graph of cells: prompt cells
that ask the agent, and bash cells that do deterministic steps, with ordinary prose between
them.
It declares its own workspace, its mode, its model, its tools and skills, and its inputs.
It lives in git, diffs cleanly, and reviews like code.

Running a notebook produces a **run record** kept outside the document, so the document
stays a program rather than a log. Re-running a cell marks its dependents stale rather than
silently cascading or discarding them, so the notebook behaves predictably when you come
back to it a month later.

Two interfaces. The command line, where a bare invocation is just pi and web flags start a
server. And a browser, where the notebook is edited and watched — locally by default, or
remotely by connecting to a server on another machine.

And a second way to read the same document: **Run View**, which hides the cells, shows a
form of the notebook's declared inputs, and offers one button. That is how someone who
cannot write a prompt still gets the job done.

## User Stories

### Authoring a notebook

1. As a developer, I want to create a notebook that declares its mode, so that its system prompt, skills, and default model are set appropriately for the kind of work.
2. As a developer, I want to write prose between cells, so that the notebook explains itself to whoever reads it next.
3. As a developer, I want to write a prompt cell, so that I can ask the agent to do a piece of work.
4. As a developer, I want to write a bash cell, so that deterministic steps run cheaply and identically every time instead of burning tokens.
5. As a developer, I want to mark a cell isolated, so that it runs in a fresh context and is reproducible.
6. As a developer, I want cells to share one context by default, so that a later cell can say "now do the same for the other files" and be understood.
7. As a developer, I want to declare which cells a cell depends on, so that staleness follows real dependencies rather than position on the page.
8. As a developer, I want to declare the notebook's inputs with names, types, and defaults, so that it can be parameterised and re-run against different targets.
9. As a developer, I want to reference declared inputs inside cell bodies, so that one notebook serves many cases.
10. As a developer, I want to override the model for a single cell, so that a cheap deterministic step doesn't use a frontier model.
11. As a developer, I want the notebook to declare its workspace directory, so that the notebook and the code it operates on travel together.
12. As a developer, I want the notebook to declare required tools, skills, and packages, so that it runs the same way for everyone.
13. As a developer, I want a run to fail loudly when a declared skill or package is missing, so that I never get a plausible wrong answer from a silently degraded environment.
14. As a developer, I want my notebook stored as readable Markdown, so that I can review it in a pull request and edit it in any editor.
15. As a developer, I want the file to round-trip unchanged when I edit one cell in the browser, so that diffs show only what I actually changed.
16. As a developer, I want to ask the agent to edit my notebook, so that the document itself is agent-editable like any other file.

### Running a notebook

17. As a developer, I want to run a whole notebook from the command line without a browser, so that it works in a script or CI.
18. As a developer, I want to run a single cell, so that I can iterate without re-running everything.
19. As a developer, I want to watch a cell's output stream as it happens, so that I can tell whether it's going the right way.
20. As a developer, I want to see the agent's tool calls as it works, so that I can tell what it actually did rather than what it says it did.
21. As a developer, I want to interrupt a running cell, so that I can stop the agent when it's clearly off track.
22. As a developer, I want isolated cells to run in parallel, so that a notebook with several unrelated steps finishes sooner.
23. As a developer, I want shared-context cells to run strictly in order, so that the conversation stays coherent.
24. As a developer, I want a cell that hangs to time out, so that a headless run can't wedge forever unnoticed.
25. As a developer, I want a failed cell to halt the run, so that a partially-applied change doesn't get built on.
26. As a developer, I want provider and transport errors retried automatically, so that transient failures don't cost me a run.
27. As a developer, I want to see which cells are stale, so that I know what no longer reflects the current state.
28. As a developer, I want re-running a cell to mark only its actual dependents stale, so that unrelated cells stay valid.
29. As a developer, I want to re-run only the stale cells, so that recovering a notebook is cheap.

### Results and artifacts

30. As a developer, I want each run recorded separately from the document, so that the notebook stays a program and the runs stay history.
31. As a developer, I want the run record to include the model that actually ran each cell, so that I can explain why a result changed.
32. As a developer, I want token usage and cost in the run record, so that I know what a notebook costs to run.
33. As a developer, I want generated files and images written to an artifacts directory and referenced by path, so that my notebook file doesn't fill with encoded blobs.
34. As a developer, I want to see images and generated files rendered in the browser, so that I don't have to go find them.
35. As a developer, I want to export a notebook together with its results, so that I can send someone the finished work as one readable document.
36. As a developer, I want a notebook I share to contain no credentials, so that sharing it is safe by construction.

### Run View — the non-programmer

37. As a colleague who doesn't code, I want to open a notebook and see a form instead of cells, so that I'm not confronted with prompts I don't understand.
38. As a colleague who doesn't code, I want to fill in the declared inputs and press one button, so that I can do the job without asking anyone.
39. As a colleague who doesn't code, I want to see progress while it runs, so that I know it's working.
40. As a colleague who doesn't code, I want to see the results and any files produced, so that I can use the output.
41. As a colleague who doesn't code, I want a failure explained in plain language, so that I know whether to retry or ask for help.
42. As a developer, I want to be confident a colleague running my notebook gets the environment I tested, so that Run View is trustworthy.

### Getting work into notebooks

43. As a developer, I want to duplicate an existing notebook and edit it, so that I can adapt someone else's work without authoring from scratch.
44. As a developer, I want to promote a chat session into a notebook, so that ad-hoc work becomes repeatable after the fact.
45. As a developer, I want to import a pi session started in the terminal, so that work done in the CLI isn't lost to the notebook world.

### Interfaces and deployment

46. As a developer, I want a bare command-line invocation to just be pi, so that I keep the terminal experience I already know.
47. As a developer, I want to start a local web interface from the command line, so that I get the notebook UI without any setup.
48. As a developer, I want to start a headless server on a port, so that I can work on a remote machine from my laptop.
49. As a developer, I want agents to keep working when I close the browser, so that long work survives me shutting the lid.
50. As a developer, I want notebook sessions to survive a server restart, so that a deploy or a crash doesn't destroy in-flight work.
51. As a developer, I want to reconnect and see everything that happened while I was away, so that disconnection costs me nothing.
52. As a developer, I want to work in several notebooks at once, so that one long run doesn't block everything else.
53. As an operator, I want the server bound to loopback by default, so that starting it never accidentally exposes my machine.
54. As an operator, I want to be told plainly that exposing the port grants arbitrary code execution, so that I can't make that choice by accident.
55. As an operator, I want to authenticate with either a startup token or a password, so that I can pick what suits the situation.
56. As an operator, I want provider API keys held on the server, so that they never travel to a browser or into a document.

### Modes

57. As a developer, I want to pick Code or Work mode when creating a notebook, so that the agent is set up for the kind of task.
58. As a developer, I want the mode recorded in the notebook, so that everyone who runs it gets the same behaviour.
59. As a developer, I want to define my own mode as a file, so that I can add Design mode or a team-specific mode without waiting for a release.

## Implementation Decisions

### Architecture

- **Embed pi's SDK in-process.** `createAgentSession()` from
  `@earendil-works/pi-coding-agent`. Never fork pi. Rejected RPC mode because it supports
  one active session per process with no multiplexing, which makes parallel notebooks a
  process-pool problem. Prior art: OpenClaw and `pi-web-ui` both embed in-process.
- **Runtime is TypeScript on Node >= 22.19, ESM-only**, forced by the SDK.
- **Pin an exact pi version.** Pi uses lockstep versioning where a minor bump means
  breaking changes, ships no major releases ever, and has breaking changes in roughly one
  release in six. An integration test guards the SDK surface we depend on.
- **Start fresh rather than building on an existing community web UI.** Study
  `jmfederico/pi-web` for disconnect survival and `xing-shuyin/pi-web-ui` for SDK wiring;
  don't inherit their session-manager architecture, which is a superset in the wrong
  direction.

### Modules

- **Notebook document** — parses and serialises the Markdown format; owns round-trip
  fidelity. Interface is parse/serialise over a notebook value.
- **Dependency graph** — builds the DAG from declared edges, detects cycles, computes
  staleness, and answers "what can run now".
- **Agent boundary** — a narrow interface taking a prompt and context, returning text, tool
  calls, and usage. One implementation over pi's SDK; one scripted implementation for
  tests. **All non-determinism in the system lives behind this interface.**
- **Notebook runner** — the primary public interface. Takes a notebook path and options,
  executes according to the graph, returns a run record. Owns scheduling, parallelism,
  failure handling, and timeouts.
- **Run store** — persists run records and artifacts outside the document.
- **Server** — owns notebook sessions, serves the web client, streams events, handles auth.
- **CLI** — a launcher. Bare invocation execs the real `pi`; web flags start the server.

### Document format contract

Notebook metadata in YAML frontmatter: `title`, `mode`, `workspace`, `model`,
`pi_version`, `tools`, `skills`, `packages`, `inputs` (each with `name`, `type`, `default`,
`description`).

Cells are fenced blocks carrying attributes: `id`, `type` (`prompt` | `bash`), `uses` (the
explicit dependency edges), `isolated` (fresh context), and an optional `model`
override. Prose between cells is ordinary Markdown. Input references are interpolated into
cell bodies.

No outputs and no credentials ever appear in the document.

### Execution semantics

- **Context** — one shared agent session per notebook by default; `isolated` cells get a
  fresh context, making them reproducible, cacheable, and parallelisable.
- **Staleness** — propagates along declared edges, not document position. Re-running a cell
  marks dependents stale; never cascade (side effects), never truncate (data loss).
- **Concurrency** — shared-context cells strictly serial (they'd otherwise both append to
  one message history); isolated cells parallel where the graph allows.
- **Failure** — halt by default; mark the cell errored and leave dependents stale. Three
  classes handled differently: provider and transport errors are retryable and pi already
  auto-retries; tool errors are usually recovered by the agent inside its own turn; "ran
  successfully but did the wrong thing" is undetectable and needs a human.
- **Anchoring** — cells store pi entry IDs so a re-run can fork the agent session at the
  right point.

### Persistence

- Our Markdown file is the source of truth for the **program**; pi's agent session file holds
  **execution history**; run records hold **what happened on a given run**.
- pi holds a `proper-lockfile` on session files while running. Read them if useful; never
  write them concurrently; reattach through pi's API.
- Run records carry per-cell status, timings, the model actually used, token usage and
  cost, and pi entry IDs. Artifacts are stored per notebook per run.
- Each notebook session keeps a journal of the events it emitted, under `.octo/journals/`
  beside the served directory; it is what a reconnecting browser catches up from and what a
  restarted server recovers the session from (ADR-0021). Never a substitute for pi's session
  file or the run records, which stay authoritative for what they hold.

### Security

- Single-user, single-tenant, one account. Not a user table.
- Loopback binding by default; non-loopback requires an explicit flag whose help text
  states that the port grants arbitrary code execution as the server's user.
- Auth is either an ephemeral bearer token printed as a full URL at startup, or a single
  password stored with argon2id or scrypt and rate-limited. No QR code.
- Provider keys live on the server in pi's own auth storage. Notebooks name providers and
  models, never credentials.
- **Pi ships no sandbox and no permission system.** A mode's tool allowlist is a usability
  choice, never a security boundary, and the UI must not imply otherwise.
- Pi gates loading of project extensions, skills, and `SYSTEM.md` behind a trust decision,
  and never prompts in non-interactive modes. The server makes that decision explicitly per
  workspace and surfaces it.

### Modes

Modes are **data, not code** — a named preset file bundling a system prompt, a tool
allowlist, a skill set, and a default model. Adding Design mode later is authoring a file.
Users can define their own. A notebook records its mode in frontmatter at creation; there
is no per-run override, because one would break Run View's reproducibility.

Work mode at v1 is a preset only — different prompt, skills, and default model, aimed at
non-code work. **No connectors.** It is how we learn what office automation should be, not
office automation itself.

## Testing Decisions

**What makes a good test here:** it drives the system through a public interface and
asserts on observable results — a run record, a file on disk, a response over the wire. It
never reaches into the graph engine, the scheduler, or the parser's internals, because
those shapes should stay free to change. And it is deterministic, which in a system built
on an LLM means every test above the agent boundary uses a scripted agent.

**Primary seam — the notebook runner.** Given a notebook file and a scripted agent, assert
on the returned run record and on the resulting workspace. This one seam covers document
parsing, the dependency graph, staleness, scheduling, parallelism, failure handling,
timeouts, artifacts, input interpolation, declared-environment enforcement, and per-cell
model selection. Most of the product's behaviour is testable here and nowhere else is
needed.

**Substitution boundary — the agent interface.** Two implementations behind one interface.
Scripted doubles ("this cell yields this text and these tool calls") for all engine tests.
Plus a **small recorded/live suite pinned to pi's SDK surface**, whose job is not to test
our logic but to fail loudly when a pi upgrade breaks the integration — the standing
defence against pi's one-in-six breaking releases. Keep it small; it will be slow and
occasionally flaky, and that's acceptable for what it buys.

**Second seam — the server's HTTP and WebSocket surface.** Drive a real client against a
real server with the scripted agent underneath. Covers session ownership, disconnect
survival, restart recovery, reconnect-and-catch-up, concurrent notebooks, binding policy,
and auth.

**Narrow exception — Markdown round-trip.** A property test asserting parse-then-serialise
is byte-identical. This sits below the runner seam, but format fidelity is invisible from
above and the risk is real: an editor that reformats the file on every save destroys the
reviewability the format exists for.

**Prior art:** none in this repo — it's greenfield. `xing-shuyin/pi-web-ui` and OpenClaw
are architectural prior art for embedding the SDK, not for testing.

## Out of Scope

Office automation connectors of any kind — email, spreadsheets, calendar. Multi-agent
orchestration (when wanted, install `pi-subagents` or a competitor rather than building
it). Multi-user accounts, per-user sandboxing, quotas, and audit trails. Non-programmer
authoring from scratch. Live two-way sync between a CLI session and a notebook. Inferred
dependency edges. Design mode. A CLI thin client that attaches to a running daemon. Any
claim, implicit or explicit, that the web UI is a security sandbox. And "workflows" as a
product category — workflows are what re-runnable notebooks produce.

## Further Notes

### Feasibility

Technically feasible, with the caveat that pi supplies less of the hard part than it first
appears. Pi gives you the agent loop, 15+ providers, seven tools, streaming, a documented
tree-structured session store, skills and packages, and a tool-call hook — MIT licensed,
no CLA. Entirely yours: the document format and parser, the dependency graph and staleness
engine, the run store, the scheduler, the server, the web UI, the auth layer, and run
mode. Rough sizing for one competent developer: **6–10 weeks full-time, or 3–5 months at a
serious part-time pace**, to the end of remote mode.

### Phasing

Phases are milestones, not tickets. The one non-obvious property worth defending: **the
headless runner is built before the web UI**, because the document is the wedge, a headless
runner is testable in CI, and it forces the format and graph to be right before rendering
concerns muddy them.

0. **Spike** — embed the SDK, run a prompt, stream events, read the session JSONL. Deliver
   a pinned version and the integration test guarding the SDK surface. Done; findings
   below.
1. **The document** — Markdown parse/serialise with round-trip tests; prompt, prose, and
   bash cells; a headless runner producing a run record. No graph, no UI.
2. **The graph** — declared inputs and edges, staleness, partial runs, cycle detection,
   halt-on-failure, timeouts, isolated cells and their parallelism. **Dogfood from
   here.**
3. **The web UI** — server owning sessions, WebSocket streaming, cell rendering with
   tool-call cards, artifacts, editing, fork-and-edit.
4. **Remote** — binding policy, token and password auth, the explicit flag, SSH tunnelling
   docs.
5. **Leverage** — Run View's form; import and promote-chat (one implementation, two
   features); export with results; modes as preset files.

### Phase 0 findings, verified against pi 0.84.2

**`importFromJsonl()` preserves branch structure completely.** It resolves the input path,
copies the file wholesale with `copyFileSync` into the session directory, and reopens the
copy with `SessionManager.open()`. Because the transfer is a byte-for-byte file copy rather
than a replay of entries, every branch survives, including `branch_summary` entries for
abandoned paths. Note it is a *runtime* method on `AgentSessionRuntime`, not a top-level
export.

Three sharp edges for ticket 21, none of them about branches: importing tears down the
current agent session rather than opening a second one; it throws `MissingSessionCwdError`
when the recorded cwd no longer exists and no override is passed; and the destination is
`sessionDir/<basename>`, so importing a file whose name matches an existing session
silently overwrites it.

**A newly created session is not written to disk until an assistant message exists.**
`SessionManager.create()` buffers entries and only flushes once the session contains a
message with `role: "assistant"`, which avoids littering the disk with sessions that were
opened and abandoned. A crash before the first assistant reply therefore loses the session
entirely, so ticket 18's restart recovery must not assume a file exists for every open
notebook session. This gate applies to newly created sessions; a session opened from an
explicit path writes its header immediately. `isPersisted()` is no guide here — it reports
whether the manager is in persisting mode, not whether anything has reached disk.

### Risks

1. **The dependency graph is the sleeper cost.** Explicit edges plus staleness turned this
   into build-system territory — propagation, cycles, partial-run resumption, and a UI that
   makes stale state legible. Perhaps a third of v1, and the component most likely to be
   perpetually almost-working. Keep it strictly explicit; refuse inference forever.
2. **Non-determinism attacks the premise.** A durable re-runnable artifact assumes
   re-running produces something useful, but LLM cells are non-deterministic, providers
   rotate model versions under stable names, and workspaces drift. Isolated cells, bash
   cells, pinned models, recorded run metadata, and declared environments all reduce this
   and none eliminate it. **Test it deliberately and early: re-run a month-old notebook and
   see what happens.**
3. **Pi's breaking changes are a standing tax.** Pinning defers the cost; it doesn't remove
   it. Budget continuous integration maintenance permanently.
4. **Markdown round-trip fidelity is fiddlier than it looks** — exactly the problem Jupytext
   spent years on. Property tests from Phase 1.
5. **Competition ships in an adjacent direction.** `pi-web` and friends move fast on session
   management; if one adds a document model the wedge narrows sharply. Argues for reaching
   Phase 2 fast and dogfooding over polishing Phase 3.
6. **Work mode may feel thin** and generate pressure toward connectors. That pressure is
   how office automation gets undeferred. Hold the line; let demand pick the connectors.

### Kill criteria

- By the end of Phase 2 you aren't reaching for it daily on real work.
- Re-running a month-old notebook usually needs manual repair — the artifact isn't durable
  and the wedge is gone.
- The staleness engine still has confusing edge cases after a month of use: Jupyter's
  original sin reproduced with worse determinism.
- A community web UI ships a credible notebook mode first.
