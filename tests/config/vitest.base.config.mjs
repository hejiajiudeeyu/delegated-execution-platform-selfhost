import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    clearMocks: true,
    testTimeout: 10000,
    hookTimeout: 10000
  }
});
