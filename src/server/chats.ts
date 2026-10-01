/**
 * The Chats pi has had in the served directory, and promoting one of them
 * into a Notebook.
 *
 * A Chat is an Agent Session pi wrote at the terminal, kept in pi's own place
 * for the directory it happened in. Promoting one is importing it: the same
 * `importSession` the command line's `import` is, given the file pi's list
 * names rather than one typed by hand, so that the person at the browser need
 * not go looking under `~/.pi` for it. Pi's list is read and its files are
 * copied, never written (ADR-0022).
 */

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { importSession } from "../import/pi-session.js";
import { titleOf } from "../notebook/notebook.js";
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
 * The Chats pi has had in `directory`, the latest first, as pi lists them.
 * Pi makes its directory for them when it is not yet there — an empty
 * directory pi makes itself the moment it runs there, and not a session file.
 */
export async function listChats(
  directory: string,
  options: ChatsOptions = {},
): Promise<ChatEntry[]> {
  const found = await SessionManager.list(directory, options.chatDirectory);
  return found.map((session) => ({
    id: session.id,
    ...(session.name !== undefined ? { name: session.name } : {}),
    firstMessage: session.firstMessage,
    messages: session.messageCount,
    created: session.created.toISOString(),
    modified: session.modified.toISOString(),
  }));
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
  const found = await SessionManager.list(directory, options.chatDirectory);
  const session = found.find((candidate) => candidate.id === id);
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
