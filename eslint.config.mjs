import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * `apps/bot/src/services/` is the layer the bot handlers, the public and admin
 * APIs and the workers are built on. A service importing one of those layers is
 * a dependency pointing the wrong way — it is how the `prime-time` ↔
 * `handlers/matching/scheduler` cycle appeared, and why seven dynamic
 * `import()`s exist only to dodge cycles.
 *
 * New such imports are an error. The ones that exist today are the explicit
 * baseline below: per file, the exact modules it already imports (static
 * imports and re-exports; the rule does not see dynamic `import()`). Shrink it
 * when a dependency is moved down into a service; never grow it.
 */
const SERVICES_LAYER_BASELINE = {
  "announcements.ts": ["workers/quiet-hours.js"],
  "appstore-venue-change.ts": ["handlers/matching/venue-change.js"],
  "chat-profile-tools.ts": ["workers/embedding-refresh.js"],
  "date-lifecycle.ts": ["handlers/matching/venue-change.js"],
  "device-tokens.ts": ["public/jwt.js"],
  "dispatch-queue.ts": ["handlers/matching/pitch.js"],
  "expiry-notify.ts": ["handlers/matching/rematch.js"],
  "former-match.ts": ["handlers/matching/negative-constraints.js"],
  "frequent-places.ts": ["public/places-photo.js", "public/showcase-photos.js"],
  "match-drop-push.ts": ["public/partner-photos.js"],
  "match-engine.ts": ["workers/embedding-refresh.js"],
  "menu-agent.ts": [
    "handlers/date/feedback.js",
    "handlers/matching/venue-change.js",
    "handlers/menu/city-switch.js",
    "workers/embedding-refresh.js",
  ],
  "moderation.ts": ["handlers/matching/negative-constraints.js", "public/jwt.js"],
  "no-match-notifier.ts": [
    "handlers/matching/rematch.js",
    "handlers/menu/city-switch.js",
    "workers/quiet-hours.js",
  ],
  "onboarding-agent.ts": ["public/otp.js", "workers/re-engagement-schedule.js"],
  "post-date-feedback.ts": ["handlers/date/feedback.js"],
  "prompt-builder.ts": ["admin/utils/cache.js"],
  "rejection-feedback.ts": ["handlers/matching/negative-constraints.js"],
  "safety-tombstone.ts": ["public/jwt.js"],
  "scheduled-confirmation.ts": ["handlers/matching/venue-change.js"],
  "status-banner-refresh.ts": ["handlers/menu/city-switch.js"],
  "stranded-handoff.ts": ["handlers/matching/scheduler.js", "handlers/matching/ticket-gate.js"],
  "synthetic-profiles.ts": ["workers/embedding-refresh.js"],
  "time-agreement-activity.ts": ["handlers/matching/scheduler.js"],
  "venue-change-activity.ts": [
    "handlers/matching/venue-change.js",
    "workers/peer-wait-venue-change.js",
  ],
  "verification-pipeline.ts": ["handlers/menu/main.js"],
  "verified-email.ts": ["public/otp.js"],
  "voice-prompt.ts": ["workers/embedding-refresh.js"],
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `no-restricted-imports` for a services file, allowing only `allowed`. */
function servicesLayerRule(allowed = []) {
  const exempt =
    allowed.length > 0
      ? `(?!(?:\\.\\./)+(?:${allowed.map(escapeRegex).join("|")})$)`
      : "";
  return [
    "error",
    {
      patterns: [
        {
          regex: `^${exempt}(?:\\.\\./)+(?:handlers|public|workers|admin)/`,
          message:
            "services/ must not import the handlers, public, workers or admin layers built on it — move the dependency into a service (see SERVICES_LAYER_BASELINE in eslint.config.mjs).",
        },
      ],
    },
  ];
}

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/build/**", "**/out/**", "**/node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // TypeScript already resolves ambient Node/DOM globals accurately.
      "no-undef": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.integration.test.ts",
      "**/test-setup.ts",
    ],
    rules: {
      // Test doubles often need deliberately partial structural shims.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["apps/bot/src/services/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: { "no-restricted-imports": servicesLayerRule() },
  },
  ...Object.entries(SERVICES_LAYER_BASELINE).map(([file, allowed]) => ({
    files: [`apps/bot/src/services/${file}`],
    rules: { "no-restricted-imports": servicesLayerRule(allowed) },
  })),
);
