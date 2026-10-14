import {
  type AgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  VERSION,
  createAgentSession,
  getAgentDir,
  hasTrustRequiringProjectResources,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";

import { contextUsage } from "../pi/context.js";
import { createAssistantTextStream } from "../pi/streaming.js";
import { decideTrust } from "../pi/trust.js";
import { failureOf, summariseTurn } from "../pi/turn.js";
import {
  type Agent,
  type AgentSetup,
  type CellResult,
  type ContextUsage,
  type Retry,
  TurnFailure,
  type TurnOptions,
} from "./agent.js";
import type { Environment } from "./environment.js";

// Derived from pi's own signature rather than imported: the model type lives in
// @earendil-works/pi-ai, which is pi's dependency and not ours to pin.
type Model = Parameters<AgentSession["setModel"]>[0];

/**
 * Pi's settings as the machine has them, read once and never written back.
 *
 * Pi saves a model switch as the user's new default — `setModel` writes the
 * provider and model to settings.json, and the thinking level with them. That
 * is right for someone at pi's own prompt choosing what to work with, and wrong
 * for a Cell asking for a cheaper model than the Cell before it: a Notebook
 * should leave the machine as it found it, the same way ADR-0010 has it leave
 * the declared environment. So pi is given a copy to write to and the copy is
 * dropped with the Run. It is still pi that reads the files, so what is copied
 * is exactly what pi would otherwise have run on.
 */
function settingsForRun(workspace: string, agentDir: string): SettingsManager {
  const onDisk = SettingsManager.create(workspace, agentDir);
  const held = new Map<string, string>([
    ["global", JSON.stringify(onDisk.getGlobalSettings())],
    ["project", JSON.stringify(onDisk.getProjectSettings())],
  ]);
  return SettingsManager.fromStorage({
    withLock(scope, fn) {
      const next = fn(held.get(scope));
      if (next !== undefined) held.set(scope, next);
    },
  });
}

/** Whether two models are the same one, by the pair that names a model. */
const sameModel = (a: Model | undefined, b: Model | undefined) =>
  a !== undefined && b !== undefined && a.provider === b.provider && a.id === b.id;

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
export async function createPiAgent(options: AgentSetup): Promise<Agent> {
  const { workspace } = options;
  const agentDir = getAgentDir();
  const trustStore = new ProjectTrustStore(agentDir);
  const settingsManager = settingsForRun(workspace, agentDir);

  const decision = decideTrust({
    workspace,
    ...(options.trust !== undefined ? { asked: options.trust } : {}),
    recorded: trustStore.get(workspace),
    standing: settingsManager.getDefaultProjectTrust(),
    gated: hasTrustRequiringProjectResources(workspace),
  });
  if (!decision.ok) throw new Error(decision.problem);
  if (decision.record) trustStore.set(workspace, decision.trusted);

  const { systemPrompt, skills } = options;
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    // In place of whatever pi would have found, `SYSTEM.md` included; pi still
    // adds the Workspace's context files and its Skills after it.
    ...(systemPrompt !== undefined ? { systemPromptOverride: () => systemPrompt } : {}),
    // Filtered from what pi loaded, so a Skill in the set that pi never found
    // is absent from the Environment below and reported missing as it should be.
    ...(skills !== undefined
      ? {
          skillsOverride: (loaded) => ({
            ...loaded,
            skills: loaded.skills.filter((skill) => skills.includes(skill.name)),
          }),
        }
      : {}),
  });
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

  /**
   * The model the session opened on — pi's own default, or the one the session
   * being reopened was left on — which is what a turn that names none runs on.
   * Captured now, because a turn that names one moves the session off it.
   *
   * Pi reopens a session on the model it last recorded, so a reopened session is
   * on its own model only because every override before it was undone before
   * the turn after it began. That is what `restore` below is for.
   */
  const own = session.model;

  /** The model a Notebook names, `provider/model`, as pi's own `--model` reads it. */
  const resolveModel = (named: string): Model => {
    const { model, error } = resolveCliModel({
      cliModel: named,
      modelRuntime: session.modelRuntime,
    });
    if (model === undefined) throw new Error(error ?? `No model named "${named}" is available.`);
    return model;
  };

  /**
   * Puts the session on the model a turn asks for. Throws when the machine has
   * no key for the model's provider, which is the Cell's failure to record: the
   * Notebook asked for what the machine has not.
   */
  const takeOn = async (named: string): Promise<void> => {
    const wanted = resolveModel(named);
    if (!sameModel(wanted, session.model)) await session.setModel(wanted);
  };

  /**
   * Puts the session back on its own model once an override's turn is over, so
   * the override is the Cell's alone — for the next Cell, and for a later Run
   * reopening this session, which pi opens on whatever model the session last
   * recorded. Nothing to go back to when pi opened with no model at all: the
   * session then stays where the override left it, which is at least somewhere
   * the next turn can be taken.
   */
  const restore = async (): Promise<void> => {
    if (own === undefined || sameModel(own, session.model)) return;
    await session.setModel(own);
  };

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

    async prompt(body: string, turnOptions: TurnOptions = {}): Promise<CellResult> {
      const { signal, model, mode, onText, onToolCall } = turnOptions;
      // Before anything is subscribed to or counted: a model that cannot be had
      // is the agent declining the turn, not a turn that was taken and failed.
      if (model !== undefined) await takeOn(model);

      const stream = createAssistantTextStream();
      // Pi's own retries, as pi announces each one. Pi decides what is transient
      // and how long to wait; what is kept here is only that it happened, and
      // what the attempt it gave up on had failed with.
      const retries: Retry[] = [];

      // `abort` stops the run pi has in hand and waits for the agent to come to
      // rest, after which `prompt` below resolves. Only a stop that found a run
      // in hand counts as having stopped anything: pi checks credentials before
      // starting the run, and settles the session after it, and a signal that
      // fires in either gap has stopped nothing. In the gap before, it is acted
      // on again the moment the run does start; in the gap after, the turn is
      // over and its result stands.
      let stopped = false;
      const stop = () => {
        if (session.isIdle) return;
        stopped = true;
        void session.abort().catch(() => undefined);
      };
      signal?.addEventListener("abort", stop, { once: true });

      const unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_start" && signal?.aborted) stop();
        if (event.type === "auto_retry_start") retries.push({ error: event.errorMessage });
        // As pi starts the tool, with the arguments it validated: the same
        // call `summariseTurn` reads off the message afterwards, heard now.
        if (event.type === "tool_execution_start") {
          onToolCall?.({ name: event.toolName, input: event.args ?? null });
        }
        const revealed = stream.accept(event);
        if (revealed) onText?.(revealed);
      });

      const before = session.messages.length;
      /** The system prompt the turn was given, read once the turn has settled. */
      let systemPrompt = "";
      /** How full the window was on the model the turn ran on, before an override is undone. */
      let context: ContextUsage | undefined;
      // Plan may look, and Ask may not act. The session's own tools return
      // with the turn, so the Cell after this one is not left in this one's mode.
      const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
      const ownTools = mode === "plan" || mode === "ask" ? session.getActiveToolNames() : undefined;
      if (ownTools !== undefined) {
        session.setActiveToolsByName(
          mode === "plan" ? ownTools.filter((name) => READ_ONLY_TOOLS.has(name)) : [],
        );
      }
      try {
        await session.prompt(body);
      } finally {
        unsubscribe();
        signal?.removeEventListener("abort", stop);
        const given = session.systemPrompt;
        systemPrompt = typeof given === "string" ? given.trim() : "";
        const window = session.model?.contextWindow;
        context = contextUsage({
          systemPrompt: typeof given === "string" ? given : "",
          tools: session.agent.state.tools,
          messages: session.messages,
          ...(typeof window === "number" ? { window } : {}),
        });
        if (ownTools !== undefined) session.setActiveToolsByName(ownTools);
        // However the turn went: the session is off its model only for as long
        // as the override's turn lasts. Recorded in the session after the turn's
        // messages, so that the Anchor read below is past it and a Run forking
        // there reopens on the session's own model rather than the override.
        if (model !== undefined) await restore();
      }

      const turn = session.messages.slice(before);
      const summary = summariseTurn(turn);

      // Read off the stop rather than off the messages, because a turn stopped
      // while pi was waiting to retry leaves no message saying so. What the turn
      // had spent by then is on the messages it did leave, and is spent.
      if (stopped) throw TurnFailure.aborted(retries, summary.usage, systemPrompt, context);

      const ended = failureOf(turn);
      if (ended !== undefined)
        throw new TurnFailure(ended, retries, false, summary.usage, systemPrompt, context);

      // The entry the turn left the session's leaf on, which is the Anchor: the
      // point a later Run forks at to put a Cell back in this context.
      const anchor = session.sessionManager.getLeafId();

      return {
        text: stream.text(),
        ...summary,
        retries,
        ...(systemPrompt !== "" ? { systemPrompt } : {}),
        ...(context !== undefined ? { context } : {}),
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
