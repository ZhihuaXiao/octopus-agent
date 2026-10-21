import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { namedModel } from "./named-model.js";

/** A runtime over a `models.json` holding one custom provider, `Azure`. */
async function runtimeWithAzure(): Promise<ModelRuntime> {
  const agentDir = await mkdtemp(join(tmpdir(), "octo-named-"));
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        Azure: {
          baseUrl: "https://example.openai.azure.com/openai/v1",
          api: "openai-responses",
          apiKey: "azure-key",
          models: [{ id: "gpt-6-sol" }],
        },
      },
    }),
  );
  return ModelRuntime.create({
    modelsPath: join(agentDir, "models.json"),
    authPath: join(agentDir, "auth.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
}

/**
 * Pi's catalog has its own `azure`, offering the same model id as the custom
 * provider above. A Notebook naming the custom one must run on it: pi's
 * `--model` parsing takes the first provider that matches the prefix without
 * regard to case, which is the built-in, whose provider has no key.
 */
describe("the model a Notebook names", () => {
  it("takes the provider it names, not pi's built-in spelled in another case", async () => {
    const runtime = await runtimeWithAzure();
    const { model } = namedModel(runtime, "Azure/gpt-6-sol");
    expect(model?.provider).toBe("Azure");
    expect(model?.baseUrl).toBe("https://example.openai.azure.com/openai/v1");
    expect(runtime.getModel("azure", "gpt-6-sol")?.baseUrl).not.toBe(model?.baseUrl);
  });

  it("leaves a name that is not a provider and a model to pi", async () => {
    const runtime = await runtimeWithAzure();
    const { error } = namedModel(runtime, "gpt-6-sol");
    expect(error).toMatch(/ambiguous/);
  });
});
