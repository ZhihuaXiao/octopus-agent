// @ts-check

/**
 * @typedef {{ provider: string, id: string, name: string }} ModelChoice
 * @typedef {{ id: string, contextWindow?: number, enabled?: boolean }} CustomModel
 * @typedef {{
 *   id: string, baseUrl: string, api: string,
 *   apiKeySet: boolean, apiKeyFromCommand: boolean,
 *   models: CustomModel[],
 * }} CustomProvider
 * @typedef {{
 *   defaultProvider?: string, defaultModel?: string, defaultThinking?: string,
 *   thinkingLevels: string[], apis: string[], models: ModelChoice[], keyed: string[],
 *   modelEnabled?: Record<string, boolean>, providers: CustomProvider[],
 * }} ModelPage
 */

/** @param {ModelPage} page @param {string} provider */
export function modelsForProvider(page, provider) {
  return page.models.filter((model) => model.provider === provider);
}

/** @param {ModelPage} page */
export function providerIds(page) {
  return [
    ...new Set([
      ...page.models.map((model) => model.provider),
      ...page.providers.map((provider) => provider.id),
      ...page.keyed,
    ]),
  ];
}

/** @param {ModelPage | undefined} page @param {string} provider */
export function providerKeyed(page, provider) {
  return (
    page?.keyed.includes(provider) === true ||
    page?.providers.some((entry) => entry.id === provider && entry.apiKeySet) === true
  );
}

/** @param {string} baseUrl */
export function localEndpoint(baseUrl) {
  try {
    return ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Model visibility is opt-in, independent of stored credentials. Explicit
 * preferences win over legacy custom model selections; unset models stay off.
 * @param {{ provider: string, id: string }} model @param {ModelPage | undefined} page
 */
export function modelEnabled(model, page) {
  const preference = page?.modelEnabled?.[`${model.provider}/${model.id}`];
  if (typeof preference === "boolean") return preference;
  const custom = page?.providers.find((provider) => provider.id === model.provider);
  return custom?.models.find((entry) => entry.id === model.id)?.enabled === true;
}

/** @param {{ provider: string, id: string }} model @param {ModelPage | undefined} page */
export function configuredChoice(model, page) {
  return (
    providerKeyed(page, model.provider) ||
    page?.providers.some((provider) => provider.id === model.provider) === true
  );
}

/**
 * GET includes credential flags; POST accepts only editable fields. The full
 * provider set is sent on every save, and omitted keys preserve stored secrets.
 * @param {CustomProvider[]} providers
 */
export function providerEdits(providers) {
  return providers.map((provider) => ({
    id: provider.id,
    baseUrl: provider.baseUrl,
    api: provider.api,
    models: provider.models.map((model) => ({ ...model })),
  }));
}

/** @param {string} value @param {number} fallback */
export function contextTokens(value, fallback) {
  if (value.trim() === "") return fallback;
  const tokens = Number(value);
  if (!Number.isSafeInteger(tokens) || tokens < 1) {
    throw new Error("Context window must be a positive whole number of tokens.");
  }
  return tokens;
}

/** @param {{ id: string, baseUrl: string, api: string, models: CustomModel[] }} provider @param {string[]} apis */
export function validateProvider(provider, apis) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider.id)) {
    throw new Error(
      "Provider identifier must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens.",
    );
  }
  let url;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS endpoint base URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Enter a valid HTTP or HTTPS endpoint base URL.");
  }
  if (!apis.includes(provider.api)) throw new Error("Choose a supported API protocol.");
  if (
    (provider.api === "openai-completions" && /\/chat\/completions\/?$/.test(url.pathname)) ||
    (provider.api === "google-generative-ai" && url.pathname.includes("/chat/completions"))
  ) {
    throw new Error("Use the service base URL, without /chat/completions.");
  }
  if (provider.models.length === 0 || provider.models.some((model) => model.id.trim() === "")) {
    throw new Error("Add at least one model ID to this provider.");
  }
  if (new Set(provider.models.map((model) => model.id.trim())).size !== provider.models.length) {
    throw new Error("Each model ID must be unique within its provider.");
  }
  for (const model of provider.models) {
    if (model.contextWindow !== undefined) contextTokens(String(model.contextWindow), 200_000);
  }
}
