import { describe, expect, it } from "vitest";
import {
  configuredChoice,
  contextTokens,
  localEndpoint,
  modelEnabled,
  modelsForProvider,
  providerEdits,
  providerIds,
  providerKeyed,
  validateProvider,
  type ModelPage,
} from "../../client/model-settings.js";

const page: ModelPage = {
  thinkingLevels: ["off", "medium", "high"],
  apis: ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"],
  models: [
    { provider: "anthropic", id: "built-in", name: "Built-in" },
    { provider: "anthropic", id: "extra", name: "Extra" },
    { provider: "Azure", id: "vendor/model:latest", name: "Deployment" },
    { provider: "unkeyed", id: "model", name: "model" },
  ],
  keyed: ["anthropic", "oauth-only"],
  providers: [
    {
      id: "anthropic",
      baseUrl: "https://proxy.example",
      api: "anthropic-messages",
      apiKeySet: false,
      apiKeyFromCommand: false,
      models: [{ id: "extra", contextWindow: 123456, enabled: false }],
    },
    {
      id: "Azure",
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      apiKeySet: false,
      apiKeyFromCommand: false,
      models: [{ id: "vendor/model:latest", contextWindow: 128000 }],
    },
    {
      id: "empty-catalog",
      baseUrl: "https://example.com/v1",
      api: "openai-completions",
      apiKeySet: true,
      apiKeyFromCommand: true,
      models: [{ id: "unknown" }],
    },
  ],
};

describe("provider hub catalog", () => {
  it("groups the catalog, persisted providers, and credentials without duplicate built-in overrides", () => {
    expect(providerIds(page)).toEqual([
      "anthropic",
      "Azure",
      "unkeyed",
      "empty-catalog",
      "oauth-only",
    ]);
    expect(modelsForProvider(page, "anthropic").map((model) => model.id)).toEqual([
      "built-in",
      "extra",
    ]);
    expect(modelsForProvider(page, "empty-catalog")).toEqual([]);
  });

  it("keeps provider IDs case-sensitive and slash-containing model IDs intact", () => {
    expect(modelsForProvider(page, "Azure")[0]?.id).toBe("vendor/model:latest");
    expect(modelsForProvider(page, "azure")).toEqual([]);
  });

  it("allows configured local models without credentials, but not unconfigured built-ins", () => {
    expect(providerKeyed(page, "Azure")).toBe(false);
    expect(configuredChoice({ provider: "Azure", id: "vendor/model:latest" }, page)).toBe(true);
    expect(configuredChoice({ provider: "unkeyed", id: "model" }, page)).toBe(false);
    expect(providerKeyed(page, "empty-catalog")).toBe(true);
    expect(providerKeyed(page, "oauth-only")).toBe(true);
  });

  it("uses visibility preferences before legacy custom model flags", () => {
    const model = { provider: "anthropic", id: "extra" };
    expect(modelEnabled(model, page)).toBe(false);
    expect(modelEnabled(model, { ...page, modelEnabled: { "anthropic/extra": true } })).toBe(true);
    expect(
      modelEnabled(
        { provider: "Azure", id: "vendor/model:latest" },
        { ...page, modelEnabled: { "Azure/vendor/model:latest": false } },
      ),
    ).toBe(false);
    expect(modelEnabled({ provider: "anthropic", id: "built-in" }, page)).toBe(true);
  });

  it.each(["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8000/v1"])(
    "recognizes loopback endpoint %s",
    (url) => {
      expect(localEndpoint(url)).toBe(true);
    },
  );

  it.each([
    "https://localhost.evil.example/v1",
    "https://example.com/localhost",
    "https://127.0.0.1.example/v1",
    "not a URL",
  ])("does not mistake %s for a local server", (url) => {
    expect(localEndpoint(url)).toBe(false);
  });
});

describe("provider hub persistence", () => {
  it("sends every provider without GET-only flags or fabricated credentials", () => {
    const edits = providerEdits(page.providers);
    expect(edits).toHaveLength(3);
    expect(edits[2]).toEqual({
      id: "empty-catalog",
      baseUrl: "https://example.com/v1",
      api: "openai-completions",
      models: [{ id: "unknown" }],
    });
    for (const edit of edits) {
      expect(edit).not.toHaveProperty("apiKeySet");
      expect(edit).not.toHaveProperty("apiKeyFromCommand");
      expect(edit).not.toHaveProperty("apiKey");
    }
  });

  it("isolates failed or pending edits from the loaded model page", () => {
    const edits = providerEdits(page.providers);
    edits[0]!.baseUrl = "https://changed.example";
    edits[0]!.models[0]!.contextWindow = 1;
    edits[1]!.models.push({ id: "new-model" });
    expect(page.providers[0]!.baseUrl).toBe("https://proxy.example");
    expect(page.providers[0]!.models[0]!.contextWindow).toBe(123456);
    expect(page.providers[1]!.models).toHaveLength(1);
  });

  it("accepts exact positive token counts and defaults only blank input", () => {
    expect(contextTokens("123456", 200000)).toBe(123456);
    expect(contextTokens(" ", 200000)).toBe(200000);
    for (const value of ["0", "-1", "1.5", "200k", "Infinity", "9007199254740992"]) {
      expect(() => contextTokens(value, 200000)).toThrow("positive whole number");
    }
  });

  it("accepts protocol-specific base paths, not just /v1", () => {
    for (const baseUrl of [
      "https://proxy.example",
      "https://example.com/api/v1",
      "http://localhost:1234/v1",
    ]) {
      expect(() =>
        validateProvider(
          {
            id: "Azure.Proxy-1",
            baseUrl,
            api: "openai-completions",
            models: [{ id: "vendor/model:latest", contextWindow: 123456 }],
          },
          page.apis,
        ),
      ).not.toThrow();
    }
  });

  it("rejects invalid identifiers, URLs, protocols, context windows, and empty model sets", () => {
    const valid = {
      id: "local",
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      models: [{ id: "llama" }],
    };
    for (const invalid of [
      { id: "has spaces" },
      { id: "../local" },
      { baseUrl: "file:///etc/passwd" },
      { baseUrl: "invalid" },
      { api: "unsupported" },
      { models: [] },
      { models: [{ id: " " }] },
      { models: [{ id: "llama" }, { id: " llama " }] },
      { models: [{ id: "llama", contextWindow: 0 }] },
      { baseUrl: "https://example.com/v1/chat/completions" },
    ]) {
      expect(() => validateProvider({ ...valid, ...invalid }, page.apis)).toThrow();
    }
    expect(() =>
      validateProvider(
        {
          ...valid,
          api: "google-generative-ai",
          baseUrl: "https://example.com/chat/completions/v1",
        },
        page.apis,
      ),
    ).toThrow("base URL");
    expect(() =>
      validateProvider(
        { ...valid, api: "openai-responses", baseUrl: "https://example.com/openai/v1" },
        page.apis,
      ),
    ).not.toThrow();
  });
});
