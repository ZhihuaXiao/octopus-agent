import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";

import { createPiAgent } from "../agent/pi.js";

// Derived from pi's own signature rather than imported: the message types live
// in @earendil-works/pi-ai, which is pi's dependency and not ours to pin.
type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];

const userMessage = (content: string): AppendableMessage => ({
  role: "user",
  content,
  timestamp: Date.now(),
});

const assistantReply = (text: string): AppendableMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
  api: "anthropic-messages",
  provider: "anthropic",
  model: "test-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
});

/** A session forked at the assistant reply, with a branch either side of it. */
function branchedSession(dir: string) {
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage(userMessage("root"));
  const fork = manager.appendMessage(assistantReply("reply"));
  manager.appendMessage(userMessage("first path"));
  manager.branch(fork);
  manager.appendMessage(userMessage("second path"));
  return { manager, fork };
}

/**
 * Guards the pi behaviour we build on, so that an upgrade breaking it fails
 * here rather than somewhere subtle later. See docs/adr/0001.
 */
describe("pi's session store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "octo-session-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("targets the session format version we understand", () => {
    expect(CURRENT_SESSION_VERSION).toBe(3);
  });

  it("writes a newly created session to disk only once an assistant message arrives", () => {
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage(userMessage("only a question"));

    expect(existsSync(manager.getSessionFile()!)).toBe(false);

    manager.appendMessage(assistantReply("an answer"));

    expect(existsSync(manager.getSessionFile()!)).toBe(true);
  });

  it("keeps both branches when a session forks", () => {
    const { manager, fork } = branchedSession(dir);

    expect(manager.getChildren(fork)).toHaveLength(2);
    expect(manager.getEntries()).toHaveLength(4);
  });

  it("reopens a copied session file with every branch intact", () => {
    // This is the mechanism importFromJsonl() uses: it copies the session file
    // wholesale and reopens the copy. Calling importFromJsonl() itself needs a
    // live model, so ticket 21 is where that gets covered end to end.
    const { manager, fork } = branchedSession(dir);

    const destination = join(dir, "imported.jsonl");
    copyFileSync(manager.getSessionFile()!, destination);
    const imported = SessionManager.open(destination, dir);

    expect(imported.getChildren(fork)).toHaveLength(2);
    expect(imported.getEntries()).toHaveLength(4);
  });

  it("names the entry the last append landed on, which is what an anchor is", () => {
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage(userMessage("a question"));
    const latest = manager.appendMessage(assistantReply("an answer"));

    expect(manager.getLeafId()).toBe(latest);
  });

  it("reopens a session with its leaf at the end of what it already holds", () => {
    // Which is why resuming at an anchor is an explicit move rather than a
    // consequence of reopening: a cell that ran first in the session being
    // continued would otherwise inherit the whole of it.
    const { manager, fork } = branchedSession(dir);
    const reopened = SessionManager.open(manager.getSessionFile()!, dir);

    expect(reopened.getLeafId()).not.toBe(fork);
  });
});

/**
 * How a Run puts a Cell back where it began: pi's own navigation, driven with
 * no summary asked for, so nothing is spent on getting there.
 *
 * Guarded here rather than in the live suite because it needs no model — the
 * session is written by hand and navigated, which is precisely the part a
 * scripted agent cannot stand in for.
 */
describe("pi's navigation back to an earlier entry", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "octo-navigate-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Two turns written by hand, with the entry the first of them ended on. */
  async function twoTurns() {
    const manager = SessionManager.create(dir, dir);
    const { session } = await createAgentSession({
      cwd: dir,
      sessionManager: manager,
      noTools: "all",
    });

    manager.appendMessage(userMessage("first"));
    const anchor = manager.appendMessage(assistantReply("first done"));
    manager.appendMessage(userMessage("second"));
    manager.appendMessage(assistantReply("second done"));

    return { manager, session, anchor };
  }

  it("rebuilds the context at the entry, and leaves the abandoned path in place", async () => {
    const { manager, session, anchor } = await twoTurns();

    try {
      await session.navigateTree(anchor);

      // The context as it stood when the turn after the anchor began: two
      // messages, not the four the session holds.
      expect(manager.getLeafId()).toBe(anchor);
      expect(session.messages).toHaveLength(2);

      const held = manager.getEntries().length;
      manager.appendMessage(userMessage("second, again"));

      // A fork rather than a rewind: the new path leaves the anchor beside the
      // old one, and nothing the session already held has gone (ADR-0014).
      expect(manager.getChildren(anchor)).toHaveLength(2);
      expect(manager.getEntries()).toHaveLength(held + 1);
    } finally {
      session.dispose();
    }
  });

  /**
   * As much of the agent boundary's own use of all this as can be driven with no
   * provider: reopening a session and moving back inside it need no model, and
   * only the turn that follows does. Here rather than beside `createPiAgent`
   * because writing the session by hand is what makes a model unnecessary, and
   * these are the fixtures for that.
   */
  it("is what the agent boundary reopens when a run carries on from another", async () => {
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage(userMessage("first"));
    const anchor = manager.appendMessage(assistantReply("first done"));
    manager.appendMessage(userMessage("second"));
    manager.appendMessage(assistantReply("second done"));
    const file = manager.getSessionFile()!;

    const agent = await createPiAgent({ workspace: dir, agentSession: file });

    try {
      // The session the anchors above belong to, rather than a new one beside it.
      expect(agent.agentSession).toBe(file);

      // Both of the ways a run resumes: at an anchor, and at the empty context a
      // cell that spoke first begins from. Neither is observable from outside the
      // boundary, so what this pins is that they arrive somewhere pi accepts —
      // where they arrive is what the two tests above pin.
      await expect(agent.resumeFrom(anchor)).resolves.toBeUndefined();
      await expect(agent.resumeFrom(undefined)).resolves.toBeUndefined();
    } finally {
      await agent.dispose();
    }
  });

  it("empties the context when the entry navigated to is the root", async () => {
    // Which is how a cell that spoke first is put back where it began. The root
    // is not always the first message — pi may have recorded the model it chose
    // ahead of it — and neither of those is a message, so either way the
    // context arrives empty.
    const { manager, session } = await twoTurns();

    try {
      const root = manager.getEntries().find((entry) => entry.parentId === null);
      await session.navigateTree(root!.id);

      expect(session.messages).toEqual([]);
      expect(manager.getEntries().length).toBeGreaterThan(1);
    } finally {
      session.dispose();
    }
  });
});
