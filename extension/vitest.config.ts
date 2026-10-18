import { defineConfig } from "vitest/config";

// Unit tests only. Browser-driven tests live in tests/integration and need a
// real display, a built bundle and an ephemeral fixture server, so they must not
// be swept into the default run.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "tests/integration/**"],
    setupFiles: ["tests/setup.ts"],
  },
});