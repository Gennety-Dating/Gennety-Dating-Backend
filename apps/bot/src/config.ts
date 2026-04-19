import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

// Load .env.local first (local development overrides). dotenv does not
// overwrite already-set keys, so values here win over .env below.
const localEnv = resolve(workspaceRoot, ".env.local");
if (existsSync(localEnv)) {
  config({ path: localEnv });
}
config({ path: resolve(workspaceRoot, ".env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  BOT_TOKEN: required("BOT_TOKEN"),
  DATABASE_URL: required("DATABASE_URL"),
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? process.env.SMTP_PASS ?? "",
  SMTP_FROM: process.env.SMTP_FROM ?? "onboarding@resend.dev",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  CUSTOM_EMOJI_LIKE_ID: process.env.CUSTOM_EMOJI_LIKE_ID ?? "",
  CUSTOM_EMOJI_DISLIKE_ID: process.env.CUSTOM_EMOJI_DISLIKE_ID ?? "",
  CUSTOM_EMOJI_MENU_ID: process.env.CUSTOM_EMOJI_MENU_ID ?? "",
  CUSTOM_EMOJI_ACCEPT_ID: process.env.CUSTOM_EMOJI_ACCEPT_ID ?? "",
  CUSTOM_EMOJI_DECLINE_ID: process.env.CUSTOM_EMOJI_DECLINE_ID ?? "",
  MESSAGE_EFFECT_MATCH_ID: process.env.MESSAGE_EFFECT_MATCH_ID ?? "5104841245755180586",
  WEBAPP_URL: process.env.WEBAPP_URL ?? "https://example.invalid/calendar",
  ADMIN_API_KEY: process.env.ADMIN_API_KEY ?? "",
  ADMIN_PORT: Number(process.env.ADMIN_PORT ?? "3100"),
  ADMIN_DASHBOARD_ORIGIN: process.env.ADMIN_DASHBOARD_ORIGIN ?? "*",

  // ── Public `/v1/*` API for the mobile app ─────────────────────
  JWT_SECRET: process.env.JWT_SECRET ?? "",
  JWT_ACCESS_TTL: process.env.JWT_ACCESS_TTL ?? "15m",
  JWT_REFRESH_TTL: process.env.JWT_REFRESH_TTL ?? "30d",
  PUBLIC_PORT: Number(process.env.PUBLIC_PORT ?? "3101"),
  PUBLIC_CORS_ORIGIN: process.env.PUBLIC_CORS_ORIGIN ?? "*",
  /// Expo Push Service access token (https://expo.dev/accounts/…/settings/access-tokens).
  /// Optional — unset disables push dispatch.
  EXPO_ACCESS_TOKEN: process.env.EXPO_ACCESS_TOKEN ?? "",
  /// Supabase Storage bucket for selfie uploads.
  SUPABASE_URL: process.env.SUPABASE_URL ?? "",
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  SUPABASE_SELFIE_BUCKET: process.env.SUPABASE_SELFIE_BUCKET ?? "selfies",
} as const;
