import {
  DefaultPackageManager,
  DefaultResourceLoader,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  VERSION,
  createAgentSession,
  getAgentDir,
  hasTrustRequiringProjectResources,
} from "@earendil-works/pi-coding-agent";

import { createAssistantTextStream } from "../pi/streaming.js";
import { decideTrust } from "../pi/trust.js";
import { isRecord } from "../util/guards.js";
import {
  type Agent,
  type AgentSetup,
  type CellResult,
  type ToolCall,
  type Usage,
} from "./agent.js";
import type { Environment } from "./environment.js";

export interface PiAgentOptions extends AgentSetup {
  /** Called with each fragment of text as it arrives, for streaming output. */
  onText?: (text: string) => void;
}

/**
 * Reads what one turn cost and did.
 *
 * A turn is several messages, not one: pi appends an assistant message per
 * provider request and a `toolResult` between them, so the tool calls and most
 * of the tokens are in messages *before* the closing one. Fields are narrowed
 * here rather than typed against pi's own union, matching `pi/streaming.ts`;
 * the live suite is what proves these names still hold.
 */
function summariseTurn(turn: readonly unknown[]): Omit<CellResult, "text"> {
  const assistantMessages = turn.filter(isRecord).filter((message) => message.role === "assistant");

  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls: ToolCall[] = [];

  for (const message of assistantMessages) {
    if (isRecord(message.usage)) {
      const { input, output } = message.usage;
      if (typeof input === "number") usage.inputTokens += input;
      if (typeof output === "number") usage.outputTokens += output;
    }

    if (!Array.isArray(message.content)) continue;
    for (const block of (message.content as unknown[]).filter(isRecord)) {
      if (block.type !== "toolCall") continue;
      toolCalls.push({
        name: typeof block.name === "string" ? block.name : "",
        input: block.arguments ?? null,
      });
    }
  }

  // `responseModel` is what the provider actually served, which is the point:
  // providers rotate versions under a stable name.
  const last = assistantMessages.at(-1);
  const responseModel = last?.responseModel ?? last?.model;

  return { toolCalls, usage, model: typeof responseModel === "string" ? responseModel : "" };
}

/**
 * The agent boundary over pi's SDK, embedded in-process per ADR-0001.
 *
 * One session serves the whole Notebook, which is what gives Cells the shared
 * context a later Cell relies on when it says "now do the same for the others".
 * A Run carrying on from an earlier one reopens that session rather than
 * starting a fresh one, because an Anchor names an entry inside a particular
 * session file and addresses nothing anywhere else. An Isolated Cell is this
 * same function called again for that Cell alone (ADR-0016): nothing here knows
 * which it is making, because a session made for one Cell is set up no
 * differently from a session made for a Notebook.
 *
 * Pi's resource loading is driven here rather than left to `createAgentSession`
 * to arrange for itself, because loading is where the Workspace's trust
 * decision is taken and where its Skills and Packages become knowable. Doing it
 * a step earlier is what lets the session be told the decision instead of
 * falling back on the no that pi returns when nothing can be asked.
 */
export async function createPiAgent(options: PiAgentOptions): Promise<Agent> {
  const { workspace } = options;
  const agentDir = getAgentDir();
  const trustStore = new ProjectTrustStore(agentDir);
  const settingsManager = SettingsManager.create(workspace, agentDir);

  const decision = decideTrust({
    workspace,
    ...(options.trust !== undefined ? { asked: options.trust } : {}),
    recorded: trustStore.get(workspace),
    standing: settingsManager.getDefaultProjectTrust(),
    gated: hasTrustRequiringProjectResources(workspace),
  });
  if (!decision.ok) throw new Error(decision.problem);
  if (decision.record) trustStore.set(workspace, decision.trusted);

  const resourceLoader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager });
  await resourceLoader.reload({ resolveProjectTrust: async () => decision.trusted });

  const { session } = await createAgentSession({
    cwd: workspace,
    settingsManager,
    resourceLoader,
    // Only what the Notebook declares, when it declares anything. An empty list
    // is a Notebook asking for an agent with no tools, which pi's own default
    // would otherwise quietly overrule.
    ...(options.tools !== undefined ? { tools: [...options.tools] } : {}),
    // Left to pi unless a session is being reopened, so that where a new one is
    // filed stays pi's decision rather than becoming ours to keep in step.
    ...(options.agentSession !== undefined
      ? { sessionManager: SessionManager.open(options.agentSession, undefined, workspace) }
      : {}),
  });

  const packageManager = new DefaultPackageManager({ cwd: workspace, agentDir, settingsManager });

  const environment: Environment = {
    piVersion: VERSION,
    // What the session will actually offer, rather than what was asked for: a
    // declared tool pi does not have is absent from this and reported as such.
    tools: session.getActiveToolNames(),
    skills: resourceLoader.getSkills().skills.map((skill) => skill.name),
    packages: packageManager
      .listConfiguredPackages()
      .filter((installed) => installed.installedPath !== undefined)
      .map((installed) => installed.source),
    trusted: decision.trusted,
  };

  return {
    environment,

    // Read on each ask rather than captured once: pi reassigns the session file
    // when a session is replaced, and a Run Record naming the file pi has since
    // stopped writing to would point a later Run at a stale branch.
    get agentSession() {
      return session.sessionFile;
    },

    async prompt(body: string): Promise<CellResult> {
      const stream = createAssistantTextStream();
      const unsubscribe = session.subscribe((event) => {
        const revealed = stream.accept(event);
        if (revealed) options.onText?.(revealed);
      });

      const before = session.messages.length;
      try {
        await session.prompt(body);
      } finally {
        unsubscribe();
      }

      // The entry the turn left the session's leaf on, which is the Anchor: the
      // point a later Run forks at to put a Cell back in this context.
      const anchor = session.sessionManager.getLeafId();

      return {
        text: stream.text(),
        ...summariseTurn(session.messages.slice(before)),
        ...(anchor !== null ? { anchor } : {}),
      };
    },

    async resumeFrom(anchor: string | undefined): Promise<void> {
      // The root entry, whose parent is nothing, is where an empty context sits.
      // Navigating to it is how pi is asked for one, since a session that has
      // been reopened has its leaf at the end of what it already holds.
      const root = session.sessionManager.getEntries().find((entry) => entry.parentId === null);
      const target = anchor ?? root?.id;
      if (target === undefined) return;

      // `navigateTree` moves the leaf and rebuilds the context from it, leaving
      // every entry in place: what the session held past the anchor stays in it
      // as an abandoned branch. No summary is asked for, so no model is needed
      // and nothing is spent on getting back to where a cell began.
      const { cancelled } = await session.navigateTree(target);

      // An extension may decline the move, and a Run that carried on regardless
      // would run the cell against the wrong context while its record claimed
      // the anchor. Failing to arrive has to be louder than arriving.
      if (cancelled) {
        throw new Error(`Pi declined to move the agent session back to entry ${target}.`);
      }
    },

    async dispose(): Promise<void> {
      session.dispose();
    },
  };
}
