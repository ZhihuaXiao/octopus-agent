import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The live suite talks to a real provider, so it is slow by nature and
    // skips itself when no credentials are present.
    testTimeout: 60_000,
  },
});
