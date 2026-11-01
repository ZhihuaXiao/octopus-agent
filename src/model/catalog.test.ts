import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createModelCatalog, type ModelCatalog, type ModelProbeRuntime } from "./catalog.js";

describe("ModelCatalog", () => {
  let tempDir: string;
  let catalog: ModelCatalog;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "octo-catalog-test-"));
    catalog = createModelCatalog({ agentDirectory: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads an empty page with default thinking levels and APIs", async () => {
    const pageResult = await catalog.page();
    expect(pageResult.ok).toBe(true);
    if (!pageResult.ok) return;
    expect(pageResult.value.apis.length).toBeGreaterThan(0);
    expect(pageResult.value.thinkingLevels).toContain("medium");
    expect(pageResult.value.providers).toEqual([]);
  });

  it("saves custom providers and their models", async () => {
    const saveResult = await catalog.saveProviders([
      {
        id: "custom-openai",
        baseUrl: "https://api.openai.com/v1",
        api: "openai-completions",
        models: [
          { id: "gpt-4o", contextWindow: 128000 },
          { id: "gpt-4o-mini", contextWindow: 64000 },
        ],
      },
    ]);
    expect(saveResult.ok).toBe(true);

    const pageResult = await catalog.page();
    expect(pageResult.ok).toBe(true);
    if (!pageResult.ok) return;
    expect(pageResult.value.providers.length).toBe(1);
    expect(pageResult.value.providers[0]?.id).toBe("custom-openai");
    expect(pageResult.value.providers[0]?.models.length).toBe(2);
  });

  it("saves and removes API keys in auth.json", async () => {
    const saveKeyResult = await catalog.saveKey("anthropic", "sk-test-key-12345");
    expect(saveKeyResult.ok).toBe(true);

    const authFile = join(tempDir, "auth.json");
    const content = JSON.parse(await readFile(authFile, "utf8"));
    expect(content.anthropic?.key ?? content.anthropic).toBe("sk-test-key-12345");

    const removeKeyResult = await catalog.removeKey("anthropic");
    expect(removeKeyResult.ok).toBe(true);

    const afterRemove = JSON.parse(await readFile(authFile, "utf8"));
    expect(afterRemove.anthropic).toBeUndefined();
  });

  it("probes model availability using an injected runtime adapter", async () => {
    // Add custom provider
    await catalog.saveProviders([
      {
        id: "mock-provider",
        baseUrl: "https://mock.api/v1",
        api: "openai-completions",
        models: [{ id: "mock-model" }],
      },
    ]);

    const fakeRuntime: ModelProbeRuntime = {
      getModel(provider: string, id: string) {
        return { provider, id, name: id };
      },
      getModels() {
        return [{ provider: "mock-provider", id: "mock-model", name: "mock-model" }];
      },
      async listCredentials() {
        return [{ providerId: "mock-provider" }];
      },
      async completeSimple() {
        return {
          stopReason: "stop",
          usage: { input: 1, output: 1 },
        };
      },
    };

    const testCatalog = createModelCatalog({
      agentDirectory: tempDir,
      runtime: fakeRuntime,
    });

    const probeResult = await testCatalog.test("mock-provider", "mock-model");
    expect(probeResult.ok).toBe(true);
    if (!probeResult.ok) return;
    expect(probeResult.value.available).toBe(true);
    expect(probeResult.value.inputTokens).toBe(1);
    expect(probeResult.value.outputTokens).toBe(1);
  });

  it("manages model enabled preferences", async () => {
    // Cannot enable model without API key or custom provider
    const failEnable = await catalog.setEnabled("anthropic", "claude-3", true);
    expect(failEnable.ok).toBe(false);

    // Save key first
    await catalog.saveKey("anthropic", "test-key");

    // Add model to custom provider so isConfigured succeeds
    await catalog.saveProviders([
      {
        id: "anthropic",
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        models: [{ id: "claude-3" }],
      },
    ]);

    const successEnable = await catalog.setEnabled("anthropic", "claude-3", true);
    expect(successEnable.ok).toBe(true);

    const pageResult = await catalog.page();
    expect(pageResult.ok).toBe(true);
    if (!pageResult.ok) return;
    expect(pageResult.value.modelEnabled["anthropic/claude-3"]).toBe(true);
  });
});
