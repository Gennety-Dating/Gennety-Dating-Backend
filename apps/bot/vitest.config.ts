import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@gennety/shared": resolve(__dirname, "../../packages/shared/src"),
      "@gennety/db": resolve(__dirname, "../../packages/db/src"),
      "@gennety/db/test-utils": resolve(
        __dirname,
        "../../packages/db/src/test-utils",
      ),
    },
  },
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.ts"],
    /** Integration tests live separately — exclude them from `vitest run`. */
    exclude: ["src/**/*.integration.test.ts"],
    testTimeout: 10_000,
    clearMocks: true,
  },
});
