import { env } from "../config.js";

/**
 * Demo mode — the flag, and the guard that makes it safe.
 *
 * `DEMO_MODE_ENABLED` does not describe a feature. It declares that this whole
 * PROCESS is the demo runtime (DEMO_MODE.md): its own bot token, its own
 * database, its own port, its own Mini App host. Production never sets it.
 *
 * The flag disables real safety properties — most importantly it waves the
 * liveness verdict through (`identityTrustConfigurationErrors` treats demo as a
 * non-production runtime). A flag that powerful must not be self-certifying, so
 * `assertDemoIsolation()` runs before anything else at boot and refuses to start
 * a demo-flagged process that still carries production's own settings.
 *
 * The practical consequence, and the reason this file exists: setting
 * `DEMO_MODE_ENABLED=true` in the PRODUCTION `.env` does not quietly turn off
 * identity verification for real users. It stops the process from booting, with
 * a message naming exactly which production setting gave it away.
 */

export const DEMO_MODE_ENABLED = env.DEMO_MODE_ENABLED;

export interface DemoIsolationConfig {
  FOUNDER_NOTIFY_ENABLED: boolean;
  TICKET_STARS_ENABLED: boolean;
  ADMIN_API_KEY: string;
}

/**
 * The settings a demo process must NOT have. Each one is a channel through
 * which demo traffic could reach the real world:
 *
 *   - founder notifications DM a real human's real ops chat, and the demo would
 *     announce every fake registration, freeze and scheduled date into it;
 *   - Telegram Stars moves real money out of a visitor's real Telegram balance;
 *   - the admin API is the production analytics/moderation surface, and a demo
 *     process has no business exposing one (its numbers would be fiction).
 *
 * Deliberately NOT checked here: the database URL and the bot token. We cannot
 * know production's values from inside the process, so a check would be
 * security theatre. `logDemoBanner()` prints both instead — the first lines of
 * the log name the bot and the database host, so a misconfigured `.env` is
 * something you see immediately rather than discover from your users.
 */
export function demoIsolationErrors(
  config: DemoIsolationConfig = env,
): string[] {
  const errors: string[] = [];
  if (config.FOUNDER_NOTIFY_ENABLED) {
    errors.push(
      "FOUNDER_NOTIFY_ENABLED must be false in demo mode " +
        "(the demo would DM fake registrations into the real founder ops chat)",
    );
  }
  if (config.TICKET_STARS_ENABLED) {
    errors.push(
      "TICKET_STARS_ENABLED must be false in demo mode " +
        "(demo payments must never move real Telegram Stars — use TICKET_PAYMENT_MODE=mock)",
    );
  }
  if (config.ADMIN_API_KEY) {
    errors.push(
      "ADMIN_API_KEY must be empty in demo mode " +
        "(the demo process must not expose an analytics/moderation surface)",
    );
  }
  return errors;
}

export function assertDemoIsolation(config: DemoIsolationConfig = env): void {
  const errors = demoIsolationErrors(config);
  if (errors.length > 0) {
    throw new Error(
      "DEMO_MODE_ENABLED is set, but this process is configured like " +
        "production. Refusing to start:\n- " +
        errors.join("\n- ") +
        "\n\nIf you are seeing this on the production droplet, remove " +
        "DEMO_MODE_ENABLED from /opt/gennety/.env — demo mode belongs to the " +
        "separate /opt/gennety-demo deployment (see DEMO_MODE.md).",
    );
  }
}

/** Host + database name of a Postgres URL, never the credentials. */
export function describeDatabase(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const database = url.pathname.replace(/^\//, "") || "(default)";
    return `${url.host}/${database}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/**
 * Printed at boot so the two things no automated check can verify — which bot
 * and which database — are impossible to miss.
 */
export function logDemoBanner(botUsername: string): void {
  const lines = [
    "════════════════════════════════════════════════════════",
    "  DEMO MODE — this is NOT production",
    `  bot:      @${botUsername || "unknown"}`,
    `  database: ${describeDatabase(env.DATABASE_URL)}`,
    `  webapp:   ${env.WEBAPP_URL}`,
    `  port:     ${env.PUBLIC_PORT}`,
    "  Liveness verdicts are forced to pass. Payments are simulated.",
    "  The match partner is a puppet. Do not point this at real users.",
    "════════════════════════════════════════════════════════",
  ];
  for (const line of lines) console.log(line);
}
