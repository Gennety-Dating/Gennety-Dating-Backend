/**
 * Vitest config for integration tests.
 *
 * Run: pnpm --filter @gennety/bot test:integration
 *
 * Requires the test database to be up:
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://gennety:gennety@localhost:5433/gennety_test pnpm --filter @gennety/db db:push
 */
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@gennety/shared": resolve(__dirname, "../../packages/shared/src"),
      "@gennety/db": resolve(__dirname, "../../packages/db/src"),
      "@gennety/db/test-integration": resolve(
        __dirname,
        "../../packages/db/src/test-integration",
      ),
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    // Every integration file owns the same disposable database and truncates
    // it in beforeEach. Parallel files can erase each other's fixtures.
    fileParallelism: false,
    testTimeout: 30_000,
    setupFiles: ["./src/test-setup.ts"],
    /** Load test env vars. */
    env: {
      DATABASE_URL:
        "postgresql://gennety:gennety@localhost:5433/gennety_test",
    },
  },
});
