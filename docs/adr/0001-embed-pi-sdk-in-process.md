# Embed pi's SDK in-process

We build on pi rather than reimplementing an agent loop, and we embed it as a library via
`createAgentSession()` from `@earendil-works/pi-coding-agent` rather than driving a `pi`
subprocess or forking the project.

## Considered Options

**RPC mode** was rejected because it supports one active Agent Session per process with no
multiplexing — no session identifier on any command — which turns concurrent Notebook
Sessions into a process-pool problem for no compensating benefit. **Forking** was rejected
because pi ships breaking changes in roughly one release in six under a policy of lockstep
versioning with no major releases ever, so a fork converts every upstream improvement into
a merge conflict. OpenClaw and `pi-web-ui` both embed in-process, which is the pattern pi's
own documentation recommends.

## Consequences

Our runtime is fixed: TypeScript on Node >= 22.19, ESM-only. We pin an exact pi version and
keep a small live integration test whose only job is to fail loudly when an upgrade breaks
the SDK surface we depend on. Continuous integration maintenance against pi is a permanent
cost, not a one-off.
