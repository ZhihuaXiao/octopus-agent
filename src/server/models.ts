/**
 * Pi's model settings, read and written from the browser.
 *
 * A Notebook can name a model, and a Cell can name its own, but the model a
 * Run uses when neither does — and every custom provider a Run can name — is
 * pi's, kept in pi's own files: the default in `settings.json`, and providers
 * the user added in `models.json`. This is those files, so they can be set
 * from the page rather than only at pi's prompt. A key is never sent back:
 * the page is told that one is set, and a blank field leaves the one on disk
 * alone. A key written as a shell command is left untouched too, because this
 * page does not run commands to find a credential.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CONTEXT_WINDOW, contextWindowTokens } from "../pi/model-window.js";
import { isRecord } from "../util/guards.js";

const MODELS_FILE = "models.json";

/** The APIs pi's `models.json` accepts for a custom provider. */
export const PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

/** The thinking levels pi records as its default. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type ProviderApi = (typeof PROVIDER_APIS)[number];

export interface ModelChoice {
  readonly provider: string;
  readonly id: string;
  /** What pi calls the model, when that differs from its id. */
  readonly name: string;
}

export interface CustomModel {
  readonly id: string;
  /** Tokens. A model that left this unset is reported as the default, 200,000. */
  readonly contextWindow: number;
}

/** One model in a save. A missing window keeps one already stored, or the default. */
export interface ModelEdit {
  readonly id: string;
  readonly contextWindow?: number;
}

/** One custom provider as the page draws it. The key itself is not here. */
export interface CustomProvider {
  readonly id: string;
  readonly baseUrl: string;
  readonly api: string;
  /** Whether a key is already stored. A blank field on save keeps it. */
  readonly apiKeySet: boolean;
  /** The stored key is a command pi runs. This page will not show or replace it unless a new key is typed. */
  readonly apiKeyFromCommand: boolean;
  readonly models: readonly CustomModel[];
}

/** What the Models dialog is drawn from. */
export interface ModelPage {
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly defaultThinking?: string;
  readonly thinkingLevels: readonly string[];
  readonly apis: readonly string[];
  readonly models: readonly ModelChoice[];
  /** Providers that already have a stored credential. The key itself is not included. */
  readonly keyed: readonly string[];
  readonly providers: readonly CustomProvider[];
}

export interface DefaultEdit {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: string;
}

export interface ProviderEdit {
  readonly id: string;
  readonly baseUrl: string;
  readonly api: string;
  /** A new key. Absent leaves the stored one; never a command for this page to run. */
  readonly apiKey?: string;
  /** Forget the stored key. Ignored when `apiKey` is sent. */
  readonly clearApiKey?: boolean;
  readonly models: readonly ModelEdit[];
}

export type ModelResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

const modelsPath = (agentDirectory: string) => join(agentDirectory, MODELS_FILE);

const isApi = (value: string): value is ProviderApi =>
  (PROVIDER_APIS as readonly string[]).includes(value);

const isThinking = (value: string): value is ThinkingLevel =>
  (THINKING_LEVELS as readonly string[]).includes(value);

const providerName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A base URL that would make pi ask for a path the provider does not have.
 * The OpenAI API adds `/chat/completions` itself, so a base URL that already
 * ends there is requested twice. The Google API appends `/models/…` to the
 * version root, so a chat-completions address there is not a model endpoint.
 */
function baseUrlProblem(id: string, api: string, baseUrl: URL): string | undefined {
  const path = baseUrl.pathname.replace(/\/+$/, "");
  if (api === "openai-completions" && path.endsWith("/chat/completions")) {
    return `Provider "${id}" includes /chat/completions in its base URL. The OpenAI API adds that path itself, so the base URL should end at /v1.`;
  }
  if (api === "google-generative-ai" && path.includes("/chat/completions")) {
    return `Provider "${id}" is set to the Google API, but its base URL is an OpenAI chat completions address. Use the openai-completions API and a base URL that ends at /v1.`;
  }
  return undefined;
}

/** Pi's default, and every model it can name, including providers in `models.json`. */
export async function readModelPage(agentDirectory: string): Promise<ModelResult<ModelPage>> {
  const settings = SettingsManager.create(agentDirectory, agentDirectory);
  const listed = await listModels(agentDirectory);
  if (!listed.ok) return listed;
  const providers = await readProviders(agentDirectory);
  if (!providers.ok) return providers;

  const thinking = settings.getDefaultThinkingLevel();
  const provider = settings.getDefaultProvider();
  const model = settings.getDefaultModel();
  return {
    ok: true,
    value: {
      ...(provider !== undefined ? { defaultProvider: provider } : {}),
      ...(model !== undefined ? { defaultModel: model } : {}),
      ...(thinking !== undefined ? { defaultThinking: thinking } : {}),
      thinkingLevels: THINKING_LEVELS,
      apis: PROVIDER_APIS,
      models: listed.value.models,
      keyed: listed.value.keyed,
      providers: providers.value,
    },
  };
}

/** Writes the default a Run uses when neither the Notebook nor the Cell names a model. */
export async function saveDefaultModel(
  agentDirectory: string,
  edit: DefaultEdit,
): Promise<ModelResult<undefined>> {
  if (!providerName.test(edit.provider) || edit.model.trim() === "") {
    return { ok: false, problem: "Name the provider and the model." };
  }
  if (edit.thinking !== undefined && !isThinking(edit.thinking)) {
    return {
      ok: false,
      problem: `Thinking must be one of ${THINKING_LEVELS.join(", ")}.`,
    };
  }

  const listed = await listModels(agentDirectory);
  if (!listed.ok) return listed;
  const known = listed.value.models.some(
    (model) => model.provider === edit.provider && model.id === edit.model,
  );
  if (!known) {
    return {
      ok: false,
      problem: `No model ${edit.provider}/${edit.model}. Add it as a provider first, or choose one that is listed.`,
    };
  }

  const settings = SettingsManager.create(agentDirectory, agentDirectory);
  settings.setDefaultModelAndProvider(edit.provider, edit.model);
  if (edit.thinking !== undefined) settings.setDefaultThinkingLevel(edit.thinking);
  await settings.flush();
  const errors = settings.drainErrors();
  const [error] = errors;
  if (error !== undefined) return { ok: false, problem: error.error.message };
  return { ok: true, value: undefined };
}

/**
 * Writes the custom providers, the whole set: one absent from `edits` is
 * removed. A provider's key is kept when the edit does not send a new one.
 */
export async function saveProviders(
  agentDirectory: string,
  edits: readonly ProviderEdit[],
): Promise<ModelResult<undefined>> {
  const read = await readModelsFile(agentDirectory);
  if (!read.ok) return read;

  const seen = new Set<string>();
  const next: Record<string, unknown> = {};
  for (const edit of edits) {
    if (!providerName.test(edit.id)) {
      return {
        ok: false,
        problem: `Provider name "${edit.id}" must start with a letter or digit.`,
      };
    }
    if (seen.has(edit.id)) return { ok: false, problem: `Provider "${edit.id}" is named twice.` };
    seen.add(edit.id);

    let baseUrl: URL;
    try {
      baseUrl = new URL(edit.baseUrl);
    } catch {
      return { ok: false, problem: `Provider "${edit.id}" needs a base URL.` };
    }
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      return { ok: false, problem: `Provider "${edit.id}" needs an http or https base URL.` };
    }
    const baseProblem = baseUrlProblem(edit.id, edit.api, baseUrl);
    if (baseProblem !== undefined) return { ok: false, problem: baseProblem };
    if (!isApi(edit.api)) {
      return { ok: false, problem: `Provider "${edit.id}" needs an API pi knows.` };
    }
    if (edit.apiKey?.startsWith("!")) {
      return {
        ok: false,
        problem: `Provider "${edit.id}" cannot store a key as a shell command from this page.`,
      };
    }
    const modelEdits = edit.models.flatMap((model) => {
      const id = model.id.trim();
      return id === ""
        ? []
        : [
            {
              id,
              ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
            },
          ];
    });
    const modelIds = modelEdits.map((model) => model.id);
    if (modelIds.length === 0) {
      return { ok: false, problem: `Provider "${edit.id}" needs at least one model id.` };
    }
    if (new Set(modelIds).size !== modelIds.length) {
      return { ok: false, problem: `Provider "${edit.id}" names the same model twice.` };
    }
    for (const model of modelEdits) {
      if (model.contextWindow === undefined) continue;
      if (contextWindowTokens(model.contextWindow) === undefined) {
        return {
          ok: false,
          problem: `Model "${model.id}" needs a context window of at least 1 token.`,
        };
      }
    }

    const existing = read.value.providers[edit.id];
    const provider: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
    provider.baseUrl = edit.baseUrl.trim();
    provider.api = edit.api;
    if (edit.apiKey !== undefined && edit.apiKey !== "") provider.apiKey = edit.apiKey;
    else if (edit.clearApiKey === true) delete provider.apiKey;

    const previous = new Map(
      (Array.isArray(provider.models) ? provider.models : []).flatMap((model) =>
        isRecord(model) && typeof model.id === "string" ? [[model.id, model] as const] : [],
      ),
    );
    provider.models = modelEdits.map((model) => {
      const stored = previous.get(model.id);
      const tokens =
        model.contextWindow ??
        contextWindowTokens(isRecord(stored) ? stored.contextWindow : undefined) ??
        DEFAULT_CONTEXT_WINDOW;
      return { ...(isRecord(stored) ? stored : {}), id: model.id, contextWindow: tokens };
    });
    next[edit.id] = provider;
  }

  await mkdir(dirname(modelsPath(agentDirectory)), { recursive: true });
  await writeFile(
    modelsPath(agentDirectory),
    `${JSON.stringify({ ...read.value.rest, providers: next }, null, 2)}\n`,
    "utf8",
  );
  return { ok: true, value: undefined };
}

/**
 * Whether `provider`/`id` is a model the user can already call: its provider
 * has a stored credential, or it is a custom provider they added. A model pi
 * merely knows about is not.
 */
export async function isConfiguredModel(
  agentDirectory: string,
  provider: string,
  id: string,
): Promise<ModelResult<boolean>> {
  const listed = await listModels(agentDirectory);
  if (!listed.ok) return listed;
  const known = listed.value.models.some((model) => model.provider === provider && model.id === id);
  if (!known) return { ok: true, value: false };
  if (listed.value.keyed.includes(provider)) return { ok: true, value: true };
  const providers = await readProviders(agentDirectory);
  if (!providers.ok) return providers;
  return { ok: true, value: providers.value.some((item) => item.id === provider) };
}

/**
 * What one availability check found. `inputTokens` and `outputTokens` are what
 * the provider reported for the check itself.
 */
export interface ModelProbe {
  readonly available: boolean;
  /** Why it did not answer, when `available` is false. */
  readonly problem?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * The whole check: one character in, and one token allowed out. Thinking is
 * left off, so a provider that can answer at that size spends nothing more.
 * One is the smallest cap pi will send.
 */
const PROBE_TEXT = ".";
const PROBE_TOKENS = 1;
const PROBE_TIMEOUT_MS = 30_000;

type ProbeMessage = Awaited<ReturnType<ModelRuntime["completeSimple"]>>;

const modelAnswered = (message: ProbeMessage) =>
  message.stopReason === "stop" ||
  message.stopReason === "length" ||
  message.stopReason === "toolUse";

/**
 * Asks a configured model whether it answers. The model must be one the user
 * can already call: its provider has a stored key, or it is a custom provider
 * they added. Anything else is refused before a request is made.
 */
export async function testConfiguredModel(
  agentDirectory: string,
  provider: string,
  id: string,
): Promise<ModelResult<ModelProbe>> {
  if (!providerName.test(provider) || id.trim() === "" || id !== id.trim()) {
    return { ok: false, problem: "Name the model as provider and model." };
  }
  const configured = await isConfiguredModel(agentDirectory, provider, id);
  if (!configured.ok) return configured;
  if (!configured.value) {
    return {
      ok: false,
      problem: `No configured model ${provider}/${id}. Choose one whose provider has a stored key, or a custom provider.`,
    };
  }

  const runtime = await openRuntime(agentDirectory);
  if (!runtime.ok) return runtime;
  const model = runtime.value.getModel(provider, id);
  if (model === undefined) return { ok: false, problem: `No model ${provider}/${id}.` };

  let message: ProbeMessage;
  try {
    message = await runtime.value.completeSimple(
      model,
      { messages: [{ role: "user", content: PROBE_TEXT, timestamp: Date.now() }] },
      {
        maxTokens: PROBE_TOKENS,
        maxRetries: 0,
        cacheRetention: "none",
        timeoutMs: PROBE_TIMEOUT_MS,
        // Pi names the cap `max_completion_tokens` for a generic OpenAI-compatible
        // URL. Many proxies only read `max_tokens`, and would otherwise answer at
        // their own length. Official OpenAI rejects having both, so it is left as pi sent it.
        onPayload: (payload, probed) => {
          if (probed.api !== "openai-completions" || probed.baseUrl.includes("api.openai.com")) {
            return undefined;
          }
          if (!isRecord(payload) || typeof payload.max_completion_tokens !== "number") {
            return undefined;
          }
          if (payload.max_tokens !== undefined) return undefined;
          return { ...payload, max_tokens: payload.max_completion_tokens };
        },
      },
    );
  } catch (cause) {
    return {
      ok: true,
      value: {
        available: false,
        problem: cause instanceof Error ? cause.message : String(cause),
        inputTokens: 0,
        outputTokens: 0,
      },
    };
  }

  const available = modelAnswered(message);
  return {
    ok: true,
    value: {
      available,
      ...(available
        ? {}
        : { problem: message.errorMessage ?? `The model stopped: ${message.stopReason}.` }),
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
    },
  };
}

/** Stores an API key for a provider the way pi's `/login` does, in `auth.json`. */
export async function saveProviderKey(
  agentDirectory: string,
  provider: string,
  apiKey: string,
): Promise<ModelResult<undefined>> {
  if (!providerName.test(provider)) return { ok: false, problem: "Name the provider." };
  const key = apiKey.trim();
  if (key === "") return { ok: false, problem: "The key is empty." };
  if (key.startsWith("!")) {
    return { ok: false, problem: "A key cannot be a shell command from this page." };
  }

  const runtime = await openRuntime(agentDirectory);
  if (!runtime.ok) return runtime;
  const known = runtime.value.getModels().some((model) => model.provider === provider);
  if (!known) return { ok: false, problem: `No provider "${provider}".` };

  let answered = false;
  try {
    await runtime.value.login(provider, "api_key", {
      prompt: (asked) => {
        if (answered || (asked.type !== "secret" && asked.type !== "text")) {
          return Promise.reject(
            new Error(`Pi also asks "${asked.message}", which this page cannot answer.`),
          );
        }
        answered = true;
        return Promise.resolve(key);
      },
      notify: () => undefined,
    });
  } catch (cause) {
    return { ok: false, problem: cause instanceof Error ? cause.message : String(cause) };
  }
  return { ok: true, value: undefined };
}

async function listModels(
  agentDirectory: string,
): Promise<ModelResult<{ models: ModelChoice[]; keyed: string[] }>> {
  const runtime = await openRuntime(agentDirectory);
  if (!runtime.ok) return runtime;

  const models = runtime.value
    .getModels()
    .map((model) => ({ provider: model.provider, id: model.id, name: model.name }))
    .sort((a, b) =>
      a.provider === b.provider
        ? a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0
        : a.provider < b.provider
          ? -1
          : 1,
    );
  const credentials = await runtime.value.listCredentials();
  return {
    ok: true,
    value: { models, keyed: credentials.map((credential) => credential.providerId).sort() },
  };
}

async function openRuntime(agentDirectory: string): Promise<ModelResult<ModelRuntime>> {
  try {
    return {
      ok: true,
      value: await ModelRuntime.create({
        modelsPath: modelsPath(agentDirectory),
        authPath: join(agentDirectory, "auth.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      }),
    };
  } catch (cause) {
    return { ok: false, problem: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function readProviders(agentDirectory: string): Promise<ModelResult<CustomProvider[]>> {
  const read = await readModelsFile(agentDirectory);
  if (!read.ok) return read;
  const providers = Object.entries(read.value.providers).flatMap(([id, value]) => {
    if (!isRecord(value)) return [];
    const apiKey = typeof value.apiKey === "string" ? value.apiKey : undefined;
    const models = Array.isArray(value.models)
      ? value.models.flatMap((model) =>
          isRecord(model) && typeof model.id === "string"
            ? [
                {
                  id: model.id,
                  contextWindow: contextWindowTokens(model.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
                },
              ]
            : [],
        )
      : [];
    return [
      {
        id,
        baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
        api: typeof value.api === "string" ? value.api : "",
        apiKeySet: apiKey !== undefined && apiKey !== "",
        apiKeyFromCommand: apiKey?.startsWith("!") === true,
        models,
      },
    ];
  });
  return { ok: true, value: providers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}

interface ModelsFile {
  readonly rest: Record<string, unknown>;
  readonly providers: Record<string, unknown>;
}

async function readModelsFile(agentDirectory: string): Promise<ModelResult<ModelsFile>> {
  let text: string;
  try {
    text = await readFile(modelsPath(agentDirectory), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, value: { rest: {}, providers: {} } };
    }
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, problem: `${MODELS_FILE} is not JSON, so it was left unchanged.` };
  }
  if (!isRecord(parsed)) {
    return { ok: false, problem: `${MODELS_FILE} is not an object, so it was left unchanged.` };
  }
  const { providers: raw, ...rest } = parsed;
  if (raw !== undefined && !isRecord(raw)) {
    return {
      ok: false,
      problem: `${MODELS_FILE} has no providers object, so it was left unchanged.`,
    };
  }
  return { ok: true, value: { rest, providers: isRecord(raw) ? raw : {} } };
}
