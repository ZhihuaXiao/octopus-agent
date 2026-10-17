import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createAgentSession } from "@earendil-works/pi-coding-agent";

import { customThinking, enableCustomThinking } from "./model-window.js";

/**
 * Pi clamps a custom model that never set `reasoning` to thinking off, which is
 * why a round then has no thought to show. Allowing the model to think, before
 * it is selected, is what keeps the level the user set.
 */
describe("a custom model's thinking level", () => {
  it("stays off until the model is allowed to think, and a later model keeps it", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "octo-think-agent-"));
    const cwd = await mkdtemp(join(tmpdir(), "octo-think-cwd-"));
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "panel",
        defaultModel: "luna",
        defaultThinkingLevel: "high",
      }),
    );
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          panel: {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "test-key",
            models: [{ id: "luna" }, { id: "sol" }, { id: "quiet", reasoning: false }],
          },
        },
      }),
    );

    const { session } = await createAgentSession({ cwd, agentDir, noTools: "all" });
    try {
      expect(session.model?.provider).toBe("panel");
      expect(session.model?.id).toBe("luna");
      expect(session.thinkingLevel).toBe("off");

      const model = session.model;
      expect(model).toBeDefined();
      if (model === undefined) return;
      enableCustomThinking(model, await customThinking(agentDir, "panel", "luna"), "high");
      session.setThinkingLevel("high");
      expect(session.thinkingLevel).toBe("high");

      const quiet = session.modelRuntime.getModel("panel", "quiet");
      expect(quiet?.reasoning).toBe(false);
      if (quiet === undefined) return;
      await session.setModel(quiet);
      expect(session.thinkingLevel).toBe("off");

      const sol = session.modelRuntime.getModel("panel", "sol");
      expect(sol).toBeDefined();
      if (sol === undefined) return;
      enableCustomThinking(sol, await customThinking(agentDir, "panel", "sol"), "high");
      await session.setModel(sol);
      expect(session.thinkingLevel).toBe("high");
    } finally {
      session.dispose();
    }
  });
});
