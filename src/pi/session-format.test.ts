import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";

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
});
