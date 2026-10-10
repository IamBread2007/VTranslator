import { defineConfig } from "vitest/config";

// Chrome refuses --load-extension in headless, so these tests need a display and
// a much longer budget than a unit test. Serialised because each harness launch
// owns a Chromium profile and a fixture port.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});