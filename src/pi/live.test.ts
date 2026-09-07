import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  createAgentSession,
  getAgentDir,
  hasTrustRequiringProjectResources,
} from "@earendil-works/pi-coding-agent";

import { TurnFailure } from "../agent/agent.js";
import { createPiAgent } from "../agent/pi.js";
import { createAssistantTextStream } from "./streaming.js";
import { PI_PACKAGE } from "./version-pin.js";

/**
 * The standing early-warning system for pi upgrades.
 *
 * Pi ships breaking changes in minor releases and never publishes a major, so
 * the pin in package.json defers that cost rather than removing it. This suite
 * exercises the SDK surface we actually depend on, against a real provider, so
 * that raising the pin fails here rather than somewhere subtle later.
 *
 * Nothing here is wrapped in a catch: `ModelRuntime.create()` resolves without
 * credentials and simply reports no available models, so an exception from it
 * means the SDK moved and should fail the suite rather than skip it.
 *
 * It is slow and occasionally flaky by nature. That is an acceptable price for
 * what it buys, provided it stays small.
 */
const availableModels = await (await ModelRuntime.create()).getAvailable();

describe.skipIf(availableModels.length === 0)("pi's SDK against a real provider", () => {
  it("creates a session, streams a reply, and reports token usage and cost", async () => {
    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      noTools: "all",
    });

    const stream = createAssistantTextStream();
    let sawMessageEnd = false;

    const unsubscribe = session.subscribe((event) => {
      stream.accept(event);
      if (event.type === "message_end") sawMessageEnd = true;
    });

    try {
      await session.prompt("Reply with exactly the word: pong");

      expect(sawMessageEnd, "message_end should terminate the stream").toBe(true);
      expect(stream.text().toLowerCase()).toContain("pong");

      const reply = session.messages.at(-1);
      expect(reply?.role).toBe("assistant");

      // Named fields rather than presence: ticket 12's run record reports token
      // counts and cost, so a rename upstream must fail here.
      const usage = (reply as { usage?: Record<string, unknown> }).usage;
      expect(usage).toMatchObject({
        input: expect.any(Number),
        output: expect.any(Number),
      });
      expect(usage?.cost).toMatchObject({ total: expect.any(Number) });

      // The agent boundary reports the model that actually served the turn,
      // because providers rotate versions under a stable name.
      expect(typeof (reply as { model?: unknown }).model).toBe("string");
    } finally {
      unsubscribe();
      session.dispose();
    }
  });

  it("spans a turn across several messages, with tool calls in the earlier ones", async () => {
    const agent = await createPiAgent({ workspace: process.cwd() });

    try {
      const result = await agent.prompt(
        "Run the shell command `echo pong` using the bash tool, then reply with its output.",
      );

      // The agent boundary sums usage across the turn and collects tool calls
      // from every assistant message in it. Reading only the final message —
      // which is what an earlier version did — silently loses both.
      expect(result.toolCalls.map((call) => call.name)).toContain("bash");
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
      expect(result.model).not.toBe("");

      const [call] = result.toolCalls;
      expect(call?.input, "pi names the tool's arguments `arguments`").toMatchObject({
        command: expect.stringContaining("echo"),
      });
    } finally {
      await agent.dispose();
    }
  });

  it("carries one agent session across turns, and forks it back at an anchor", async () => {
    // The whole of ticket 08 in one exchange, because each of its claims is
    // about what the *next* turn sees and only a real model can be said to have
    // understood the one before it.
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "octo-anchor-")));
    const agent = await createPiAgent({ workspace, tools: [] });
    const reply = (body: string) => agent.prompt(body);

    try {
      const first = await reply("Remember the number 41. Reply with just that number.");
      const second = await reply(
        "Add one to the number you were asked to remember. Reply with just the result.",
      );

      // A later turn refers to what an earlier one did and is understood, which
      // is what one shared session buys and the reason it is the default.
      expect(second.text).toContain("42");
      expect(first.anchor, "a turn reports where it left the session").toEqual(expect.any(String));
      expect(second.anchor).not.toBe(first.anchor);

      await agent.resumeFrom(first.anchor);
      const instead = await reply(
        "Add two to the number you were asked to remember. Reply with just the result.",
      );

      // Back where the second turn began: the number is still remembered, and
      // the turn that added one to it is not in the way of the one that adds two.
      expect(instead.text).toContain("43");
      expect(instead.text).not.toContain("44");

      // Reopened the way `createPiAgent` reopens one: the workspace is pi's
      // `cwdOverride`, and the session's own directory is left to be derived.
      const forked = SessionManager.open(agent.agentSession!, undefined, workspace);
      // The abandoned turn is still in the session, on the branch beside this
      // one, rather than having been discarded to make room (ADR-0014).
      expect(forked.getChildren(first.anchor!)).toHaveLength(2);
    } finally {
      await agent.dispose();
    }
  });

  it("takes a turn on the model a cell names, then goes back, and saves nothing as the default", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "octo-model-")));
    const settingsFile = join(getAgentDir(), "settings.json");
    const settingsBefore = await readFile(settingsFile, "utf8").catch(() => undefined);
    const agent = await createPiAgent({ workspace, tools: [] });

    try {
      const own = await agent.prompt("Reply with exactly the word: pong");
      // Any available model other than the one pi opened on. With only one to
      // choose from there is no switch to observe, and the test says so.
      const other = availableModels.find(
        // A prefix rather than equality, since what served may be a dated
        // version of the name pi opened on.
        (model) => !own.model.startsWith(`${model.provider}/${model.id}`),
      );
      if (other === undefined) return;
      const named = `${other.provider}/${other.id}`;

      const overridden = await agent.prompt("Reply with exactly the word: pong", { model: named });
      const back = await agent.prompt("Reply with exactly the word: pong");

      // The record names what served the turn with its provider, as the
      // notebook names what it asked for, and an override is one turn's alone.
      expect(overridden.model.startsWith(`${other.provider}/`)).toBe(true);
      expect(overridden.model).not.toBe(own.model);
      expect(back.model).toBe(own.model);
      // Pi saves a model switch as the user's default; a run must not.
      expect(await readFile(settingsFile, "utf8").catch(() => undefined)).toBe(settingsBefore);

      // One turn's alone across runs too. Pi reopens a session on the model it
      // last recorded, so a run continuing from the overridden turn's anchor
      // would start on the override unless the switch had been undone behind it.
      const later = await createPiAgent({
        workspace,
        tools: [],
        agentSession: agent.agentSession!,
      });
      try {
        await later.resumeFrom(overridden.anchor);
        const continued = await later.prompt("Reply with exactly the word: pong");
        expect(continued.model).toBe(own.model);
      } finally {
        await later.dispose();
      }
    } finally {
      await agent.dispose();
    }
  });

  it("reports a turn it was told to stop as a failure, not as a reply", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "octo-abort-")));
    const agent = await createPiAgent({ workspace, tools: [] });

    try {
      // Fired once the request is under way rather than at once, so what is
      // exercised is pi stopping a stream and not the signal beating it to the
      // start. A Cell's timeout rests on `abort` bringing `prompt` to rest.
      const stop = new AbortController();
      const turn = agent.prompt("Count from 1 to 300, one number per line.", {
        signal: stop.signal,
      });
      const timer = setTimeout(() => stop.abort(), 1500);

      try {
        await expect(turn).rejects.toThrow(TurnFailure);
        await expect(turn).rejects.toMatchObject({ aborted: true });
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await agent.dispose();
    }
  });
});

/**
 * The same early-warning system, for the parts of pi that answer what a
 * Notebook's declarations are checked against. No provider is needed to ask
 * pi what it has, so this runs everywhere rather than only where a key does.
 */
describe("pi's account of the environment a notebook is checked against", () => {
  it("reports its version, and offers exactly the tools it was allowed", async () => {
    // An empty directory: nothing for trust to gate, so nothing is read from
    // or written to the trust store of whoever is running the suite.
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "octo-env-")));
    const agent = await createPiAgent({ workspace, tools: ["read", "bash"] });
    const pinned = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ).dependencies[PI_PACKAGE];

    try {
      expect(agent.environment.piVersion, "pi reports the version we pinned").toBe(pinned);
      // Pi's `tools` option is a hard allowlist, which is what lets a notebook
      // declaring a tool pi does not have be told so rather than quietly given
      // pi's own default set instead.
      expect([...agent.environment.tools].sort()).toEqual(["bash", "read"]);
      expect(agent.environment.trusted).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it("reports the skills and packages it loaded, by the names a notebook declares them under", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "octo-env-")));
    const agent = await createPiAgent({ workspace });

    try {
      // Only the shape: what is installed belongs to whoever is running the
      // suite, so what a declared name is matched against cannot be asserted
      // here. A rename upstream turns these into undefined and fails.
      expect(agent.environment.skills.every((name) => typeof name === "string")).toBe(true);
      expect(agent.environment.packages.every((source) => typeof source === "string")).toBe(true);
    } finally {
      await agent.dispose();
    }
  });
});

/**
 * The two pi facts a Workspace's trust decision rests on. Both are exercised
 * against directories made for the purpose, so nothing here reads or writes
 * the trust store of whoever is running the suite.
 */
describe("pi's account of whether a workspace needs a trust decision", () => {
  it("gates a workspace with project resources, and leaves a plain one alone", async () => {
    const plain = await realpath(await mkdtemp(join(tmpdir(), "octo-plain-")));
    const project = await realpath(await mkdtemp(join(tmpdir(), "octo-project-")));
    await mkdir(join(project, ".pi"));
    await writeFile(join(project, ".pi", "settings.json"), "{}", "utf8");

    // Pi decides what counts as a project resource, and a run refuses to guess
    // exactly when pi says there is something to guess about.
    expect(hasTrustRequiringProjectResources(plain)).toBe(false);
    expect(hasTrustRequiringProjectResources(project)).toBe(true);
  });

  it("remembers a decision, tells an unmade one from a no, and forgets again", async () => {
    const agentDir = await realpath(await mkdtemp(join(tmpdir(), "octo-agent-")));
    const store = new ProjectTrustStore(agentDir);
    const workspace = join(tmpdir(), "octo-never-run");

    // Null rather than false for a Workspace nothing has decided on. That
    // distinction is the whole refusal: pi's own non-interactive answer is the
    // false, and telling the two apart is what lets a run stop instead.
    expect(store.get(workspace)).toBeNull();
    store.set(workspace, false);
    expect(store.get(workspace)).toBe(false);
    store.set(workspace, null);
    expect(store.get(workspace)).toBeNull();
  });
});
