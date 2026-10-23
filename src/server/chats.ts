/**
 * The Chats pi has had in the served directory, and promoting one of them
 * into a Notebook.
 *
 * A Chat is an Agent Session pi wrote at the terminal, kept in pi's own place
 * for the directory it happened in. Promoting one is importing it: the same
 * `importSession` the command line's `import` is, given the file pi's list
 * names rather than one typed by hand, so that the person at the browser need
 * not go looking under `~/.pi` for it. Pi's list is read and its files are
 * copied, never written (ADR-0022). Deleting a Chat is the exception the
 * reader asks for: the one file the list named is removed, and a Notebook
 * already made from it is left where it is.
 */

import { unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { type ToolCall } from "../agent/agent.js";
import { cellSourcesOf, importSession, messagesOf } from "../import/pi-session.js";
import { titleOf } from "../notebook/notebook.js";
import { saidIn, summariseTurn, textBlocksOf, thoughtIn } from "../pi/turn.js";
import { notebookAgentSessions } from "../run/store.js";
import { within } from "../util/paths.js";
import { readJournals } from "./journal.js";
import { type NotebookEntry, notebookTarget, pathWithin } from "./notebooks.js";

/** One Chat as the browser lists it: enough to tell it from the others. */
export interface ChatEntry {
  /** Pi's id for the Agent Session, which is what a promotion names. */
  readonly id: string;
  /** The name given it at pi's prompt, when one was. */
  readonly name?: string;
  /** The first thing said in it, which is how pi itself lists an unnamed one. */
  readonly firstMessage: string;
  /** How many messages it holds. */
  readonly messages: number;
  readonly created: string;
  readonly modified: string;
}

/**
 * Where pi keeps the served directory's Chats. Pi's own place for them unless
 * told otherwise, which a test is, so that no test reads what pi has on the
 * machine it runs on.
 */
export interface ChatsOptions {
  readonly chatDirectory?: string;
}

/**
 * Every Agent Session that belongs to a Notebook under `directory`, both from
 * completed Run Records and from Notebook Sessions' Journals.
 */
async function servedNotebookSessions(directory: string): Promise<Set<string>> {
  const sessions = await notebookAgentSessions(directory);
  for (const journal of await readJournals(directory).catch(() => [])) {
    for (const line of journal.lines) {
      if (typeof line.agentSession === "string") {
        sessions.add(resolve(line.agentSession));
      }
    }
  }
  return sessions;
}

/**
 * The Chats pi has had in `directory`, the latest first, as pi lists them,
 * showing only chats from octo cli runs and omitting any session a prompt
 * cell ran in.
 * Pi makes its directory for them when it is not yet there — an empty
 * directory pi makes itself the moment it runs there, and not a session file.
 */
export async function listChats(
  directory: string,
  options: ChatsOptions = {},
): Promise<ChatEntry[]> {
  const [found, notebookSessions] = await Promise.all([
    SessionManager.list(directory, options.chatDirectory),
    servedNotebookSessions(directory),
  ]);
  return found
    .filter((session) => !notebookSessions.has(resolve(session.path)))
    .map((session) => ({
      id: session.id,
      ...(session.name !== undefined ? { name: session.name } : {}),
      firstMessage: session.firstMessage,
      messages: session.messageCount,
      created: session.created.toISOString(),
      modified: session.modified.toISOString(),
    }));
}

/** One executed bash command in a Chat. */
export interface ChatCommandDetail {
  readonly type: "bash";
  readonly command: string;
  readonly output: string;
  readonly exitCode: number | null;
  readonly cancelled: boolean;
}

/** One prompt turn in a Chat, including executed tool calls and results. */
export interface ChatPromptDetail {
  readonly type: "prompt";
  readonly prompt: string;
  readonly text: string;
  readonly thinking?: string;
  readonly toolCalls: readonly ToolCall[];
}

export type ChatEntryDetail = ChatCommandDetail | ChatPromptDetail;

/** Full details of a Chat, including executed commands and their results. */
export interface ChatDetails {
  readonly id: string;
  readonly name?: string;
  readonly firstMessage: string;
  readonly messages: number;
  readonly created: string;
  readonly modified: string;
  readonly details: readonly ChatEntryDetail[];
}

/**
 * The details of the Chat pi lists under `id`: its executed commands, results,
 * prompt turns, thoughts and tool calls, as recorded in pi's session file.
 */
export async function getChat(
  directory: string,
  id: string,
  options: ChatsOptions = {},
): Promise<ChatDetails | undefined> {
  const [found, notebookSessions] = await Promise.all([
    SessionManager.list(directory, options.chatDirectory),
    servedNotebookSessions(directory),
  ]);
  const session = found
    .filter((candidate) => !notebookSessions.has(resolve(candidate.path)))
    .find((candidate) => candidate.id === id);
  if (session === undefined) return undefined;

  let manager: SessionManager;
  try {
    manager = SessionManager.open(session.path);
  } catch {
    return undefined;
  }

  const path = manager.getBranch();
  const sources = cellSourcesOf(path);
  const details: ChatEntryDetail[] = [];

  for (const source of sources) {
    if (source.kind === "bash") {
      details.push({
        type: "bash",
        command: source.command,
        output: source.output,
        exitCode: source.exitCode,
        cancelled: source.cancelled,
      });
    } else {
      const messages = messagesOf(source);
      const summary = summariseTurn(messages);
      const thinking = thoughtIn(messages);
      const text = saidIn(messages);
      const asked = source.asked;
      const prompt =
        asked.type === "message" && asked.message.role === "user"
          ? textBlocksOf(asked.message.content)
          : "";
      details.push({
        type: "prompt",
        prompt,
        text,
        ...(thinking !== "" ? { thinking } : {}),
        toolCalls: summary.toolCalls,
      });
    }
  }

  return {
    id: session.id,
    ...(session.name !== undefined ? { name: session.name } : {}),
    firstMessage: session.firstMessage,
    messages: session.messageCount,
    created: session.created.toISOString(),
    modified: session.modified.toISOString(),
    details,
  };
}

/** How promoting a Chat went. */
export type Promoted =
  | { readonly kind: "promoted"; readonly entry: NotebookEntry }
  /** No Chat pi lists here has the id. */
  | { readonly kind: "absent" }
  /** The new name is not one a Notebook under the served directory can have, or the Chat cannot be a Notebook. */
  | { readonly kind: "invalid"; readonly problem: string }
  /** A file is already there under the new name. */
  | { readonly kind: "exists" };

/**
 * Promotes the Chat pi lists under `id` into the Notebook at `to`, relative to
 * the served directory. What the import refuses is refused here in the same
 * terms; the Notebook is then listed and opened like any other.
 */
export async function promoteChat(
  directory: string,
  id: string,
  to: string,
  options: ChatsOptions = {},
): Promise<Promoted> {
  const [found, notebookSessions] = await Promise.all([
    SessionManager.list(directory, options.chatDirectory),
    servedNotebookSessions(directory),
  ]);
  const session = found
    .filter((candidate) => !notebookSessions.has(resolve(candidate.path)))
    .find((candidate) => candidate.id === id);
  if (session === undefined) return { kind: "absent" };

  const named = notebookTarget(directory, to);
  if ("problem" in named) return { kind: "invalid", problem: named.problem };

  const imported = await importSession({ session: session.path, notebook: named.file });
  if (imported.kind !== "imported") return imported;
  return {
    kind: "promoted",
    entry: {
      path: pathWithin(directory, named.file),
      title: titleOf(imported.notebook, named.file),
      ...(imported.notebook.metadata.model !== undefined
        ? { model: imported.notebook.metadata.model }
        : {}),
    },
  };
}

/** How deleting a Chat went. */
export type Removed =
  | { readonly kind: "removed" }
  /** No Chat pi lists here has the id, or its file is already gone. */
  | { readonly kind: "absent" }
  /** The file the list named is not one this page should remove. */
  | { readonly kind: "refused"; readonly problem: string };

/**
 * Removes the Chat pi lists under `id`: the session file itself, and nothing
 * else. A Notebook promoted from it is a copy, and stays.
 *
 * A Notebook's own Agent Session is not a Chat, though pi lists it in the same
 * place and cannot tell the two apart: a Chat is work done once at the
 * terminal, and a Notebook Session's Agent Session is what its Runs' Anchors
 * address (ADR-0014), so deleting it would take every Anchor the Notebook has
 * with it and leave its Cells' rounds unreadable. What belongs to a Notebook
 * is therefore omitted from the chats listing, and any attempt to delete it
 * is refused.
 */
export async function deleteChat(
  directory: string,
  id: string,
  options: ChatsOptions = {},
): Promise<Removed> {
  const found = await SessionManager.list(directory, options.chatDirectory);
  const session = found.find((candidate) => candidate.id === id);
  if (session === undefined) return { kind: "absent" };

  const file = resolve(session.path);
  if (!file.endsWith(".jsonl")) {
    return { kind: "refused", problem: "The chat is not a session file, so it was left as it is." };
  }
  if (options.chatDirectory !== undefined && !within(resolve(options.chatDirectory), file)) {
    return {
      kind: "refused",
      problem: "The chat is not kept with the others, so it was left as it is.",
    };
  }
  if ((await servedNotebookSessions(directory)).has(file)) {
    return {
      kind: "refused",
      problem:
        "That session is a notebook's own, which its runs' anchors point into, so it was left as it is.",
    };
  }

  try {
    await unlink(file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw cause;
  }
  return { kind: "removed" };
}
