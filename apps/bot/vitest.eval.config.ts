import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Live-model evals — NOT part of `pnpm test`. They call OpenAI with the real
 * key and cost money; run them on purpose before shipping a prompt change:
 *
 *   pnpm --filter @gennety/bot eval:chat
 *
 * See `evals/chat-agent.eval.ts` for what they check and how.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@gennety/shared": resolve(__dirname, "../../packages/shared/src"),
      "@gennety/db": resolve(__dirname, "../../packages/db/src"),
    },
  },
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./evals/setup.ts"],
    include: ["evals/**/*.eval.ts"],
    testTimeout: 240_000,
    // One scenario at a time: they share the in-memory database and the
    // per-user turn lock, and the provider rate limit is shared anyway.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
