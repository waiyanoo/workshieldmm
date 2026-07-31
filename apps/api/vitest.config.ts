import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: { NODE_ENV: "test", LOG_LEVEL: "silent" },
    // Clears leftover rate-limit counters so a previous run's budget doesn't
    // fail this one with 429s.
    setupFiles: ["src/test/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // These are integration tests against a real Postgres; run serially so
    // they don't race on shared tables.
    fileParallelism: false,
  },
});
