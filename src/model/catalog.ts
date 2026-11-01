/**
 * Model Catalog: manages configured LLM providers, model preferences,
 * API credentials, and probe verification under pi's agent directory.
 *
 * Encapsulates settings.json, models.json, and auth.json persistence,
 * with an optional probe runtime adapter at the seam for fast, deterministic
 * testing without live network connections.
 */

import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CONTEXT_WINDOW, contextWindowTokens } from "../pi/model-window.js";
import { isRecord } from "../util/guards.js";
import { OWNER_DIR, OWNER_FILE, mkdirOwner } from "../util/owner.js";

const MODELS_FILE = "models.json";
const PREFERENCES_FILE = "model-preferences.json";

export const PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ProviderApi = (typeof PROVIDER_APIS)[number];

export interface ModelChoice {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
}

export interface CustomModel {
  readonly id: string;
  readonly contextWindow: number;
  readonly enabled?: boolean | undefined;
}

export interface ModelEdit {
  readonly id: string;
  readonly contextWindow?: number | undefined;
  readonly enabled?: boolean | undefined;
}

export interface CustomProvider {
  readonly id: string;
  readonly baseUrl: string;
  readonly api: string;
  readonly apiKeySet: boolean;
  readonly apiKeyFromCommand: boolean;
  readonly models: readonly CustomModel[];
}

export interface ModelPage {
  readonly defaultProvider?: string | undefined;
  readonly defaultModel?: string | undefined;
  readonly defaultThinking?: string | undefined;
  readonly thinkingLevels: readonly string[];
  readonly apis: readonly string[];
  readonly models: readonly ModelChoice[];
  readonly keyed: readonly string[];
  readonly modelEnabled: Readonly<Record<string, boolean>>;
  readonly providers: readonly CustomProvider[];
}

export interface DefaultEdit {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: string | undefined;
}

export interface ProviderEdit {
  readonly id: string;
  readonly baseUrl: string;
  readonly api: string;
  readonly apiKey?: string | undefined;
  readonly clearApiKey?: boolean | undefined;
  readonly models: readonly ModelEdit[];
}

export interface ModelProbe {
  readonly available: boolean;
  readonly problem?: string | undefined;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type CatalogResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string; readonly status?: 400 | 404 | 422 | undefined };

const PROBE_TEXT = ".";
const PROBE_TOKENS = 1;
const PROBE_TIMEOUT_MS = 30_000;

const providerName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isApi = (value: string): value is ProviderApi =>
  (PROVIDER_APIS as readonly string[]).includes(value);
const isThinking = (value: string): value is ThinkingLevel =>
  (THINKING_LEVELS as readonly string[]).includes(value);

const modelsPath = (agentDirectory: string) => join(agentDirectory, MODELS_FILE);
const preferencesPath = (agentDirectory: string) => join(agentDirectory, PREFERENCES_FILE);

interface ModelsFile {
  readonly rest: Record<string, unknown>;
  readonly providers: Record<string, unknown>;
}

async function readModelsFile(agentDirectory: string): Promise<CatalogResult<ModelsFile>> {
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
  return { ok: true, value: { rest, providers: raw ?? {} } };
}

async function readModelPreferences(
  agentDirectory: string,
): Promise<CatalogResult<Record<string, boolean>>> {
  let text: string;
  try {
    text = await readFile(preferencesPath(agentDirectory), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: {} };
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, problem: `${PREFERENCES_FILE} is not JSON, so it was left unchanged.` };
  }
  if (!isRecord(parsed)) return { ok: true, value: {} };
  const entries: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "boolean") entries[key] = value;
  }
  return { ok: true, value: entries };
}

async function writeModelPreferences(
  agentDirectory: string,
  preferences: Record<string, boolean>,
): Promise<CatalogResult<void>> {
  const file = preferencesPath(agentDirectory);
  try {
    await mkdirOwner(dirname(file));
    await writeFile(file, `${JSON.stringify(preferences, null, 2)}\n`, {
      encoding: "utf8",
      mode: OWNER_FILE,
    });
    await chmod(file, OWNER_FILE);
    await chmod(dirname(file), OWNER_DIR);
    return { ok: true, value: undefined };
  } catch (cause) {
    return { ok: false, problem: `Could not save preferences: ${String(cause)}` };
  }
}

async function readProviders(agentDirectory: string): Promise<CatalogResult<CustomProvider[]>> {
  const read = await readModelsFile(agentDirectory);
  if (!read.ok) return read;
  const providers: CustomProvider[] = [];
  for (const [id, value] of Object.entries(read.value.providers)) {
    if (!isRecord(value)) continue;
    const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : "";
    const api = typeof value.api === "string" ? value.api : "";
    const apiKey = typeof value.apiKey === "string" ? value.apiKey : undefined;
    const models: CustomModel[] = [];
    if (Array.isArray(value.models)) {
      for (const model of value.models) {
        if (!isRecord(model) || typeof model.id !== "string") continue;
        const tokens = contextWindowTokens(model.contextWindow) ?? DEFAULT_CONTEXT_WINDOW;
        const enabled = typeof model.enabled === "boolean" ? model.enabled : undefined;
        models.push({
          id: model.id,
          contextWindow: tokens,
          ...(enabled !== undefined ? { enabled } : {}),
        });
      }
    }
    const hasCommand = isRecord(value.apiKeyCommand);
    const isCommandKey = apiKey?.startsWith("!") === true;
    providers.push({
      id,
      baseUrl,
      api,
      apiKeySet: (apiKey !== undefined && apiKey !== "") || hasCommand,
      apiKeyFromCommand: isCommandKey || hasCommand,
      models,
    });
  }
  return { ok: true, value: providers.sort((a, b) => a.id.localeCompare(b.id)) };
}

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

export interface ModelProbeRuntime {
  completeSimple(
    model: any,
    request: any,
    options: any,
  ): Promise<{
    stopReason: string;
    errorMessage?: string;
    usage: { input: number; output: number };
  }>;
  getModel(provider: string, id: string): any;
  getModels(): readonly any[];
  listCredentials(): Promise<readonly any[]>;
  login?(provider: string, type: string, handlers: any): Promise<void>;
  logout?(provider: string): Promise<void>;
}

export interface ModelCatalogOptions {
  readonly agentDirectory: string;
  readonly runtime?: ModelProbeRuntime | undefined;
}

export interface ModelCatalog {
  readonly agentDirectory: string;
  page(): Promise<CatalogResult<ModelPage>>;
  setDefault(edit: DefaultEdit): Promise<CatalogResult<void>>;
  saveProviders(edits: readonly ProviderEdit[]): Promise<CatalogResult<void>>;
  saveKey(provider: string, apiKey: string): Promise<CatalogResult<void>>;
  removeKey(provider: string): Promise<CatalogResult<void>>;
  setEnabled(provider: string, model: string, enabled: boolean): Promise<CatalogResult<void>>;
  test(provider: string, model: string): Promise<CatalogResult<ModelProbe>>;
  isConfigured(provider: string, model: string): Promise<CatalogResult<boolean>>;
}

export function createModelCatalog(options: ModelCatalogOptions): ModelCatalog {
  const agentDirectory = options.agentDirectory;
  const customRuntime = options.runtime;

  const openRuntime = async (): Promise<CatalogResult<any>> => {
    if (customRuntime !== undefined) return { ok: true, value: customRuntime };
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
  };

  const listModels = async (): Promise<
    CatalogResult<{ models: ModelChoice[]; keyed: string[] }>
  > => {
    const runtime = await openRuntime();
    if (!runtime.ok) return runtime;

    const models = runtime.value
      .getModels()
      .map((model: any) => ({ provider: model.provider, id: model.id, name: model.name }))
      .sort((a: any, b: any) =>
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
    const providers = await readProviders(agentDirectory);
    if (!providers.ok) return providers;
    const keyed = new Set<string>(credentials.map((cred: any) => cred.providerId));
    for (const provider of providers.value) {
      if (provider.apiKeySet) keyed.add(provider.id);
    }
    return { ok: true, value: { models, keyed: [...keyed].sort() } };
  };

  return {
    agentDirectory,

    async page(): Promise<CatalogResult<ModelPage>> {
      const settings = SettingsManager.create(agentDirectory, agentDirectory);
      const listed = await listModels();
      if (!listed.ok) return listed;
      const providers = await readProviders(agentDirectory);
      if (!providers.ok) return providers;
      const preferences = await readModelPreferences(agentDirectory);
      if (!preferences.ok) return preferences;

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
          modelEnabled: preferences.value,
          providers: providers.value,
        },
      };
    },

    async setDefault(edit: DefaultEdit): Promise<CatalogResult<void>> {
      if (!providerName.test(edit.provider) || edit.model.trim() === "") {
        return { ok: false, problem: "Name the provider and the model.", status: 400 };
      }
      if (edit.thinking !== undefined && !isThinking(edit.thinking)) {
        return {
          ok: false,
          problem: `Thinking must be one of ${THINKING_LEVELS.join(", ")}.`,
          status: 400,
        };
      }

      const listed = await listModels();
      if (!listed.ok) return listed;
      const known = listed.value.models.some(
        (model) => model.provider === edit.provider && model.id === edit.model,
      );
      if (!known) {
        return {
          ok: false,
          problem: `No model ${edit.provider}/${edit.model}. Add it as a provider first, or choose one that is listed.`,
          status: 422,
        };
      }

      const settings = SettingsManager.create(agentDirectory, agentDirectory);
      settings.setDefaultModelAndProvider(edit.provider, edit.model);
      if (edit.thinking !== undefined) settings.setDefaultThinkingLevel(edit.thinking);
      await settings.flush();
      const errors = settings.drainErrors();
      const [error] = errors;
      if (error !== undefined) return { ok: false, problem: error.error.message, status: 422 };
      return { ok: true, value: undefined };
    },

    async setEnabled(provider: string, id: string, enabled: boolean): Promise<CatalogResult<void>> {
      if (!providerName.test(provider) || id.trim() === "" || id !== id.trim()) {
        return { ok: false, problem: "Name the provider and the model.", status: 400 };
      }
      const preferences = await readModelPreferences(agentDirectory);
      if (!preferences.ok) return preferences;

      const configured = await this.isConfigured(provider, id);
      if (!configured.ok) return configured;
      if (!configured.value && enabled) {
        return {
          ok: false,
          problem: `Cannot enable ${provider}/${id} without an API key. Store one first.`,
          status: 422,
        };
      }

      const updated = { ...preferences.value, [`${provider}/${id}`]: enabled };
      return writeModelPreferences(agentDirectory, updated);
    },

    async saveProviders(edits: readonly ProviderEdit[]): Promise<CatalogResult<void>> {
      const read = await readModelsFile(agentDirectory);
      if (!read.ok) return read;

      const seen = new Set<string>();
      const next: Record<string, unknown> = {};
      for (const edit of edits) {
        if (!providerName.test(edit.id)) {
          return {
            ok: false,
            problem: `Provider name "${edit.id}" must start with a letter or digit.`,
            status: 422,
          };
        }
        if (seen.has(edit.id)) {
          return { ok: false, problem: `Provider "${edit.id}" is named twice.`, status: 422 };
        }
        seen.add(edit.id);

        let parsedUrl: URL;
        try {
          parsedUrl = new URL(edit.baseUrl);
        } catch {
          return {
            ok: false,
            problem: `Provider "${edit.id}" needs a base URL.`,
            status: 422,
          };
        }
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          return {
            ok: false,
            problem: `Provider "${edit.id}" needs an http or https base URL.`,
            status: 422,
          };
        }
        const problem = baseUrlProblem(edit.id, edit.api, parsedUrl);
        if (problem !== undefined) return { ok: false, problem, status: 422 };
        if (!isApi(edit.api)) {
          return {
            ok: false,
            problem: `Provider "${edit.id}" needs an API pi knows.`,
            status: 422,
          };
        }
        if (edit.apiKey?.startsWith("!")) {
          return {
            ok: false,
            problem: `Provider "${edit.id}" cannot store a key as a shell command from this page.`,
            status: 422,
          };
        }

        const modelEdits = (edit.models ?? []).flatMap((model) => {
          const id = model.id.trim();
          return id === ""
            ? []
            : [
                {
                  id,
                  ...(model.contextWindow !== undefined
                    ? { contextWindow: model.contextWindow }
                    : {}),
                  ...(model.enabled !== undefined ? { enabled: model.enabled } : {}),
                },
              ];
        });
        const modelIds = modelEdits.map((m) => m.id);
        if (modelIds.length === 0) {
          return {
            ok: false,
            problem: `Provider "${edit.id}" needs at least one model id.`,
            status: 422,
          };
        }
        if (new Set(modelIds).size !== modelIds.length) {
          return {
            ok: false,
            problem: `Provider "${edit.id}" names the same model twice.`,
            status: 422,
          };
        }
        for (const model of modelEdits) {
          if (
            model.contextWindow !== undefined &&
            contextWindowTokens(model.contextWindow) === undefined
          ) {
            return {
              ok: false,
              problem: `Model "${model.id}" needs a context window of at least 1 token.`,
              status: 422,
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
          (Array.isArray(provider.models) ? provider.models : []).flatMap((m) =>
            isRecord(m) && typeof m.id === "string" ? [[m.id, m] as const] : [],
          ),
        );
        provider.models = modelEdits.map((m) => {
          const stored = previous.get(m.id);
          const tokens =
            m.contextWindow ??
            contextWindowTokens(isRecord(stored) ? stored.contextWindow : undefined) ??
            DEFAULT_CONTEXT_WINDOW;
          const enabled =
            m.enabled ??
            (isRecord(stored) && typeof stored.enabled === "boolean" ? stored.enabled : undefined);
          return {
            ...(isRecord(stored) ? stored : {}),
            id: m.id,
            contextWindow: tokens,
            ...(enabled !== undefined ? { enabled } : {}),
          };
        });
        next[edit.id] = provider;
      }

      const file = modelsPath(agentDirectory);
      await mkdirOwner(dirname(file));
      await writeFile(
        file,
        `${JSON.stringify({ ...read.value.rest, providers: next }, null, 2)}\n`,
        { encoding: "utf8", mode: OWNER_FILE },
      );
      await chmod(file, OWNER_FILE);
      await chmod(dirname(file), OWNER_DIR);
      return { ok: true, value: undefined };
    },

    async isConfigured(provider: string, id: string): Promise<CatalogResult<boolean>> {
      const listed = await listModels();
      if (!listed.ok) return listed;
      const known = listed.value.models.some((m) => m.provider === provider && m.id === id);
      if (!known) return { ok: true, value: false };
      if (listed.value.keyed.includes(provider)) return { ok: true, value: true };
      const providers = await readProviders(agentDirectory);
      if (!providers.ok) return providers;
      return { ok: true, value: providers.value.some((item) => item.id === provider) };
    },

    async test(provider: string, id: string): Promise<CatalogResult<ModelProbe>> {
      if (!providerName.test(provider) || id.trim() === "" || id !== id.trim()) {
        return { ok: false, problem: "Name the model as provider and model.", status: 400 };
      }
      const configured = await this.isConfigured(provider, id);
      if (!configured.ok) return configured;
      if (!configured.value) {
        return {
          ok: false,
          problem: `No configured model ${provider}/${id}. Choose one whose provider has a stored key, or a custom provider.`,
          status: 422,
        };
      }

      const runtime = await openRuntime();
      if (!runtime.ok) return runtime;
      const model = runtime.value.getModel(provider, id);
      if (model === undefined) {
        return { ok: false, problem: `No model ${provider}/${id}.`, status: 422 };
      }

      let message;
      try {
        message = await runtime.value.completeSimple(
          model,
          { messages: [{ role: "user", content: PROBE_TEXT, timestamp: Date.now() }] },
          {
            maxTokens: PROBE_TOKENS,
            maxRetries: 0,
            cacheRetention: "none",
            timeoutMs: PROBE_TIMEOUT_MS,
            onPayload: (payload: any, probed: any) => {
              if (
                probed.api !== "openai-completions" ||
                probed.baseUrl.includes("api.openai.com")
              ) {
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

      const available =
        message.stopReason === "stop" ||
        message.stopReason === "length" ||
        message.stopReason === "toolUse";
      return {
        ok: true,
        value: {
          available,
          ...(available
            ? {}
            : { problem: message.errorMessage ?? `The model stopped: ${message.stopReason}.` }),
          inputTokens: message.usage?.input ?? 0,
          outputTokens: message.usage?.output ?? 0,
        },
      };
    },

    async saveKey(provider: string, apiKey: string): Promise<CatalogResult<void>> {
      if (!providerName.test(provider)) {
        return { ok: false, problem: "Name the provider.", status: 400 };
      }
      const key = apiKey.trim();
      if (key === "") {
        return { ok: false, problem: "The key is empty.", status: 400 };
      }
      if (key.startsWith("!")) {
        return {
          ok: false,
          problem: "A key cannot be a shell command from this page.",
          status: 400,
        };
      }

      const runtime = await openRuntime();
      if (!runtime.ok) return runtime;
      const known = runtime.value.getModels().some((model: any) => model.provider === provider);
      if (!known) {
        return { ok: false, problem: `No provider "${provider}".`, status: 422 };
      }

      let answered = false;
      try {
        await runtime.value.login(provider, "api_key", {
          prompt: (asked: any) => {
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
        return {
          ok: false,
          problem: cause instanceof Error ? cause.message : String(cause),
          status: 422,
        };
      }
      return { ok: true, value: undefined };
    },

    async removeKey(provider: string): Promise<CatalogResult<void>> {
      if (!providerName.test(provider)) {
        return { ok: false, problem: "Name the provider.", status: 400 };
      }
      const runtime = await openRuntime();
      if (!runtime.ok) return runtime;
      try {
        await runtime.value.logout(provider);
      } catch (cause) {
        return {
          ok: false,
          problem: cause instanceof Error ? cause.message : String(cause),
          status: 422,
        };
      }

      const read = await readModelsFile(agentDirectory);
      if (!read.ok) return read;
      const entry = read.value.providers[provider];
      if (!isRecord(entry) || entry.apiKey === undefined) return { ok: true, value: undefined };
      const { apiKey: _apiKey, ...kept } = entry;
      const file = modelsPath(agentDirectory);
      await mkdirOwner(dirname(file));
      await writeFile(
        file,
        `${JSON.stringify(
          { ...read.value.rest, providers: { ...read.value.providers, [provider]: kept } },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: OWNER_FILE },
      );
      await chmod(file, OWNER_FILE);
      await chmod(dirname(file), OWNER_DIR);
      return { ok: true, value: undefined };
    },
  };
}
