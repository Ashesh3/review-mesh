import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
    // Native SDK/process fixtures are resource-heavy on Windows. Bound parallel
    // workers so real process deadlines measure behavior rather than CPU starvation.
    maxWorkers: 2,
  },
});
