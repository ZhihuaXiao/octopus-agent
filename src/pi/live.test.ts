import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  createAgentSession,
  hasTrustRequiringProjectResources,
} from "@earendil-works/pi-coding-agent";

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
