# Research: pi (earendil-works/pi)

**Researched 2026-08-17/18 against pi 0.84.2.**

> **This file goes stale fast.** Pi ships ~700 commits a month, uses lockstep versioning
> where a *minor* bump means breaking changes, and has declared it will never cut a major
> release. Re-verify anything load-bearing before relying on it. Every claim below carries
> its source.

## Summary

Pi is a minimal, extensible AI agent harness: a unified multi-provider LLM API, an agent
loop, a TUI, and a coding-agent CLI. It deliberately ships *without* sub-agents, MCP,
permission popups, plan mode, built-in to-dos, or background bash — the stated philosophy
is "primitives, not features", with extensions and packages as the answer to each
omission.

## 1. License

**MIT.** Declared in `package.json`, in the README, and confirmed by the GitHub API
(`spdx_id: "MIT"`). No CLA, no dual license, no commons clause. Forking, embedding, and
commercial redistribution are all permitted.

## 2. Runtime and package layout

- Node **>= 22.19.0**, TypeScript 5.9.3, **ESM-only** (`"type": "module"`). Standalone
  binaries are compiled with Bun.
- Published under the `@earendil-works/` npm scope. All packages are version-locked in
  lockstep, currently **0.84.2**.
- Previously named `pi-mono` under `badlogic/`, then `earendil-works/pi-mono`. Many in-repo
  doc links and changelog entries still point at the old paths — a live source of stale
  links.

| npm package | Repo path | Role |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | `packages/coding-agent` | The `pi` CLI **plus the SDK plus RPC mode**. This is the one you install. |
| `@earendil-works/pi-agent-core` | `packages/agent` | Agent loop, tool calling, state |
| `@earendil-works/pi-ai` | `packages/ai` | Unified multi-provider LLM API |
| `@earendil-works/pi-tui` | `packages/tui` | Terminal UI, differential rendering |
| `@earendil-works/pi-protocol` | `packages/protocol` | Transport-neutral CBOR protocol for remote sessions |
| `@earendil-works/pi-client` | `packages/client` | Client for remote pi sessions over framed CBOR |
| `@earendil-works/pi-server` | `packages/server` | "Experimental server package for pi" — **undocumented** |
| `@earendil-works/pi-telemetry` | `packages/telemetry` | Telemetry contracts |

`packages/evals` and `packages/session-backends` exist in the repo but are not published.

**Important for us:** the SDK is *not* separately published. Embedding pi programmatically
means depending on the CLI package `@earendil-works/pi-coding-agent`.

There is **no top-level `docs/` directory** — all documentation lives under
`packages/coding-agent/docs/`.

## 3. SDK (the route we chose — decision 2)

Entry point `createAgentSession()`, returning an `AgentSession`; events via
`session.subscribe()`.

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("What files are in the current directory?");
```

`AgentSession`: `prompt`, `steer`, `followUp`, `subscribe`, `setModel`, `setThinkingLevel`,
`cycleModel`, `navigateTree`, `compact`, `abort`, `dispose`, plus accessors `agent`,
`model`, `messages`, `isStreaming`, `sessionFile`, `sessionId`.

A second layer, `createAgentSessionRuntime()` → `AgentSessionRuntime`, owns session
*replacement*: `newSession()`, `switchSession()`, `fork()`, `importFromJsonl()`.

**Two documented footguns that matter for a long-lived server:** `runtime.session` is a
*new object* after any replacement, so you must re-subscribe and re-call
`runtime.session.bindExtensions(...)`. And tools are selected by **name allowlist**
(`tools: ["read", "bash"]`), not by passing tool instances — this changed in a breaking
release.

`importFromJsonl()` is what powers decision 23 (one-way import from a pi session).

Source: `packages/coding-agent/docs/sdk.md`

## 4. RPC mode (the route we rejected)

`pi --mode rpc`. Recorded here because the rejection reason should stay verifiable.

- **Newline-delimited JSON over stdin/stdout — not JSON-RPC.** No `jsonrpc` field, no
  `method`/`params` envelope. Flat objects with `type` and an optional `id`.
- Framing is LF-only. The docs warn that Node's `readline` is **not** protocol-compliant,
  because it also splits on U+2028/U+2029, which are legal inside JSON strings.
- Bidirectional.
- **One active session per process. No multiplexing** — no session ID on any command. This
  is the fact that decided decision 2 against RPC.
- Tool approval works, but only indirectly: an extension's `tool_call` handler calls
  `ctx.ui.select()`, which emits `extension_ui_request` on stdout and blocks for a matching
  `extension_ui_response` on stdin.

Two details worth stealing even though we use the SDK: `get_entries` accepts a `since`
cursor and returns `leafId`, giving durable incremental sync across client restarts. And
`message_update` no longer carries a cumulative snapshot — assemble partial text from
deltas by `contentIndex` and treat `message_end.message` as authoritative.

Source: `packages/coding-agent/docs/rpc.md`

## 5. Extension API

TypeScript modules. **35 documented events** via `pi.on(...)`, including `session_start`,
`before_agent_start`, `agent_start/end/settled`, `turn_start/end`,
`message_start/update/end`, `context`, `before_provider_request`,
`after_provider_response`, `tool_call`, `tool_result`,
`tool_execution_start/update/end`, `user_bash`, `session_before_compact`,
`session_before_fork`, `session_before_tree`, `session_shutdown`.

Registration: `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`,
`registerProvider`, `registerMessageRenderer`, `registerEntryRenderer`,
`registerMarkdownTransformer`. Plus `sendMessage`, `appendEntry`, `exec`,
`getActiveTools`/`setActiveTools`, `setModel`.

Three hooks worth knowing:

- **`before_agent_start`** — inject a message before each turn, persisted and sent to the
  LLM; can also modify the system prompt per turn.
- **`context`** — fires before *every* LLM call with a deep copy of `event.messages`;
  return `{ messages: filtered }`. This is the documented RAG / long-term-memory hook.
- **`tool_call`** — mutate `event.input` in place, or block with
  `{ block: true, reason, terminate }`. This is the real approval seam.

`ctx.ui` degrades in RPC mode (`custom()` returns undefined, theme getters are stubs).

Source: `packages/coding-agent/docs/extensions.md` (~122 KB, the largest doc)

## 6. Session storage

**JSONL**, one JSON object per line, at
`~/.pi/agent/sessions/--<cwd-with-slashes-as-dashes>--/<timestamp>_<uuid>.jsonl`.
The format is documented *with a TypeScript parsing example*, so external reading is
explicitly supported.

- Line 1 is a `SessionHeader` (`{"type":"session","version":3,"id":...,"cwd":...}`) —
  metadata only, not part of the tree.
- Every later entry has `{ type, id (8-char hex), parentId (null for root), timestamp }`.
  Types: `message`, `model_change`, `thinking_level_change`, `compaction`,
  `branch_summary`, `custom`, `custom_message`, `label`, `session_info`.
- **A branch is not an object.** The file is an append-only list; the tree is implied by
  `parentId`. A branch exists wherever two entries share a `parentId`. Navigating away
  appends a `branch_summary` whose `parentId` is the fork point and whose `fromId` is the
  abandoned leaf, carrying an LLM-generated summary of the abandoned path.
- **Versioned, not frozen.** Currently v3, with documented auto-applied migrations
  (v1 linear → v2 tree → v3 `hookMessage` renamed `custom`). Compaction entries have two
  shapes, the older kept "only for backward compatibility".
- **pi holds the file with `proper-lockfile` while running.** Reading is safe and
  supported; concurrent external writes are not. This is why decision 11 keeps our
  document separate and decision 19 reattaches through pi's API.

Source: `packages/coding-agent/docs/session-format.md`

## 7. Tools and sandboxing

Built-in tools, seven: **`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`**.
Controlled by `--tools <list>`, `--no-builtin-tools`, `--no-tools`, or the `defaultTools`
setting.

**There is no permission system and no sandbox.** `docs/security.md` is explicit: "Pi does
not include a built-in sandbox... Built-in tools can read files, write files, edit files,
and run shell commands with the permissions of the pi process." Stated as intentional —
the argument is that a partial in-process sandbox would be mistaken for a security
boundary. This is the fact behind decisions 4, 28, and the mode safety note.

The `tool_call` hook is nonetheless a real approval seam (see §5), and
`@gotgenes/pi-permission-system` already implements one.

Pi *does* gate **project trust** — whether it loads `.pi/settings.json`, project
extensions, skills, and `SYSTEM.md`. Stored in `~/.pi/agent/trust.json`, governed by
`defaultProjectTrust` (default `"ask"`). **Non-interactive modes never prompt**, which is
why decision 28 requires our server to make that decision explicitly.

Sandboxing guidance in `docs/containerization.md`: **Gondolin** (QEMU micro-VM, extension
overrides every built-in tool to route into the VM; needs Node >= 23.6.0), plain **Docker**
(full Dockerfile provided), and **NVIDIA OpenShell**.

## 8. Skills and packages

Skills implement the [Agent Skills standard](https://agentskills.io/specification): a
directory with `SKILL.md` carrying YAML frontmatter (`name`, `description` required).
Only descriptions sit in the system prompt; full instructions load on demand. They
register as `/skill:name`.

Load paths: `~/.pi/agent/skills/`, `~/.agents/skills/`, project `.pi/skills/` and
`.agents/skills/` (walking up to the git root, **only after the project is trusted**),
package `skills/` dirs, the `skills` settings array, and repeatable `--skill <path>`. Pi
can be pointed at `~/.claude/skills` and `~/.codex/skills` directly.

Packages bundle extensions, skills, prompts, and themes under a `pi` key in
`package.json`. `pi install npm:@foo/bar@1.0.0` → `~/.pi/agent/npm/` (or `.pi/npm/` with
`-l`); `pi install git:github.com/user/repo@v1` → `~/.pi/agent/git/<host>/<path>`. Git refs
are pinned and not auto-advanced by `pi update`. Core packages must be declared as
`peerDependencies: "*"` and not bundled.

This is what makes decision 28 (declared environment) mechanically feasible: tools are a
name allowlist, skills are explicit paths, packages pin to exact versions or refs.

## 9. Sub-agents

**Pi ships none, by design.** pi.dev's stated answer: "Spawn Pi instances via tmux, or
build your own with extensions, or install a package that does it your way." Note that
`docs/tmux.md` is *not* an orchestration recipe — it only covers tmux keyboard-modifier
config. The tmux pattern is endorsed but unspecified.

The community fills the gap (decision 22):

- **`pi-subagents`** (nicopreme) — delegation and scripted multi-agent workflows, ~245K
  downloads/month
- **`@tintinweb/pi-subagents`** — Claude-Code-style autonomous sub-agents, ~40K/month
- **`@quintinshaw/pi-dynamic-workflows`** — fan-out across hundreds of subagents, model
  routing, token/cost accounting, resume, git-worktree isolation
- **`pi-background-tasks`** — read-only delegated agents via child pi processes
- **`@vigolium/piolium`** — security audits via specialist sub-agents, isolated contexts
- **`pi-landstrip`** — sandboxed bash and process-backed agents

The SDK docs also name "build custom tools that spawn sub-agents" as supported — the
cleanest in-process route.

## 10. Maturity

- **0.84.2**, released 2026-08-14.
- **719 commits in the last 30 days**; multiple contributors daily.
- **API explicitly not stable.** `AGENTS.md` states the release policy: *"Lockstep
  versioning: all packages share one version... `patch` = fixes + additions, `minor` =
  breaking changes. **No major releases.**"* There will never be a 1.0 and there is no
  semver stability promise.
- **Changelog: 5,509 lines, 271 released versions, 45 with a `### Breaking Changes`
  section — roughly one in six.** Recent breaks that would hit an integration: removal of
  cumulative snapshots from `message_update`; `authStorage`/`modelRegistry` replaced by
  `modelRuntime`; session-replacement methods moved from `AgentSession` to
  `AgentSessionRuntime`; `tools` switched from instances to name strings; minimum Node
  raised to 22.19.0.
- **93 open issues, 43 open PRs, 5,031 closed issues.** New contributors' issues and PRs
  are auto-closed by default and reviewed daily.
- **92,188 stars, 11,420 forks**, 306 watchers. Repo created 2025-08-09.

This section is the evidence for risk 3 and for the decision to pin an exact version with
an integration test guarding the SDK surface.

## 11. Prior art — existing web UIs

**No official web UI.** `export_html` produces a static transcript and `/share` uploads to
a gist; both are read-only artifacts. `@earendil-works/pi-server` exists and is labelled
experimental, built on the CBOR `pi-protocol`/`pi-client` pair, but **is undocumented** —
worth re-checking later, since it may become official remote-session infrastructure.

Community (decision 6 — study, don't inherit):

- **[`jmfederico/pi-web`](https://github.com/jmfederico/pi-web/)** — the most ambitious.
  Sessions survive browser disconnect, multiple parallel sessions, git worktrees, file
  browser, terminals, plugin system, federation across remote machines. **This is the
  closest thing to a competitor.**
- **[`xing-shuyin/pi-web-ui`](https://github.com/xing-shuyin/pi-web-ui)** — web chat on the
  SDK in-process (`createAgentSessionRuntime`), streaming over WebSocket; explicitly
  rejects the subprocess/RPC approach, citing the SDK docs. Good reference for our
  architecture.
- **[`hyperdreamer/pi-webui`](https://github.com/hyperdreamer/pi-webui)** — near-identical
  description to `pi-web`; likely a fork or rename, relationship unverified.
- **[`bilalbentoumi/pi-vsc`](https://github.com/bilalbentoumi/pi-vsc)** — VS Code extension
  spawning `pi --mode rpc`. Reference implementation of an RPC-driven client.

**OpenClaw** ([`openclaw/openclaw`](https://github.com/openclaw/openclaw)) is the flagship
SDK integration pi.dev points at — a personal assistant / messaging gateway. It **embeds pi
in-process via `createAgentSession()`**, passing its own auth storage, tool suite,
per-channel dynamic system prompts, and its own `SessionManager` (sessions under
`~/.openclaw/agents/*/sessions/`). Entry point `runEmbeddedPiAgent()`. Its "Control UI" is a
Vite + Lit SPA served by its gateway on `127.0.0.1:18789`, talking WebSocket on the same
port, with streaming tool-call cards and exec approvals. **Existence proof that a browser
UI over an embedded pi SDK session works.**

Caveat: much OpenClaw documentation online lives on mirror/translation sites rather than
the canonical docs, and some still show the older `@mariozechner/pi-coding-agent` package
name.

## Unverified / open questions

- What `@earendil-works/pi-server` actually exposes — no documentation found.
- The relationship between `pi-web` and `pi-webui`.
- Whether `importFromJsonl()` preserves branch structure or flattens to the active path.
  **Verify during the Phase 0 spike** — decision 23 depends on it.
