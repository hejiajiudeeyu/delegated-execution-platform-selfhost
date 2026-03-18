import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.base.config.mjs";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["tests/e2e/**/*.test.js"],
      setupFiles: ["tests/e2e/setup.js"],
      fileParallelism: false,
      sequence: {
        shuffle: false
      }
    }
  })
);
