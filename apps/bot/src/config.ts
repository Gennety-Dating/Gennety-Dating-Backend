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
  /// Telegram username of the bot (without @). Used to build the
  /// `https://t.me/<username>` redirect URL passed to Persona Hosted Flow,
  /// so users land back in the bot chat after finishing verification.
  /// Empty value disables the redirect (Persona just shows its "thank you"
  /// page and the user closes the tab manually).
  BOT_USERNAME: process.env.BOT_USERNAME ?? "",
  DATABASE_URL: required("DATABASE_URL"),
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? process.env.SMTP_PASS ?? "",
  SMTP_FROM: process.env.SMTP_FROM ?? "onboarding@resend.dev",
  // When true, OTP emails are logged to the bot's console instead of sent via
  // Resend. Lets local dev work even with SMTP_PASS shared from prod (.env).
  OTP_LOG_TO_CONSOLE: process.env.OTP_LOG_TO_CONSOLE === "true",
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
  /// Supabase Storage bucket for profile photos (separate from selfies so
  /// moderation policy can differ — profile photos are shown to matches,
  /// selfies are only seen by admins). Expected to be PRIVATE; reads go
  /// through short-lived signed URLs.
  SUPABASE_PHOTO_BUCKET: process.env.SUPABASE_PHOTO_BUCKET ?? "profile-photos",
  /// Supabase Storage bucket for Aether Concierge multimodal chat attachments
  /// (user-uploaded images sent as part of a `/v1/chat/message` turn). Expected
  /// to be PRIVATE; the chat endpoint fetches signed URLs (5 min TTL) just
  /// long enough for the OpenAI vision call to dereference them.
  SUPABASE_CHAT_BUCKET: process.env.SUPABASE_CHAT_BUCKET ?? "chat-attachments",

  // ── Persona liveness / biometric verification (Phase 6.3) ────
  /// Master kill switch for the Persona step. When false (default), the bot
  /// skips the verification CTA entirely and activates users straight after
  /// `finalize_onboarding`. When true, the credentials below must also be
  /// set — otherwise the CTA falls through to the main menu (defensive: a
  /// half-configured deploy never strands users at a broken Persona link).
  ENABLE_PERSONA_VERIFICATION: process.env.ENABLE_PERSONA_VERIFICATION === "true",
  /// Inquiry Template id from the Persona Dashboard — defines which steps the
  /// user goes through (selfie + government ID + liveness). Empty value
  /// disables the verification feature: users auto-activate after onboarding.
  PERSONA_TEMPLATE_ID: process.env.PERSONA_TEMPLATE_ID ?? "",
  /// Sandbox vs production environment id from the Persona Dashboard. The
  /// `PERSONA_API_KEY` must belong to the same environment or API calls 401.
  PERSONA_ENVIRONMENT_ID: process.env.PERSONA_ENVIRONMENT_ID ?? "",
  /// Server-to-server API key. Not required for the hosted-flow URL (which is
  /// fully client-constructed from template-id + environment-id + reference-id)
  /// but needed if we ever call Persona's REST API to re-read inquiry details.
  PERSONA_API_KEY: process.env.PERSONA_API_KEY ?? "",
  /// Shared secret for validating incoming webhook HMAC signatures
  /// (`Persona-Signature: t=<ts>,v1=<hex>` header). Rotate per webhook in the
  /// dashboard — different from `PERSONA_API_KEY`.
  PERSONA_WEBHOOK_SECRET: process.env.PERSONA_WEBHOOK_SECRET ?? "",
  /// Base URL of the Persona hosted flow. Override only if Persona migrates
  /// their user-facing domain.
  PERSONA_HOSTED_URL_BASE: process.env.PERSONA_HOSTED_URL_BASE ?? "https://withpersona.com/verify",

  // ── Face matching (Persona-selfie ↔ profile photos) ──────────
  /// Provider used by `services/face-match.ts`. `rekognition` calls AWS
  /// Rekognition CompareFaces. `disabled` short-circuits every call to
  /// `{ ok: true, similarity: 1, faceFound: true }` so the rest of the
  /// pipeline runs unchanged in local dev / CI without AWS credentials.
  FACE_MATCH_PROVIDER: (process.env.FACE_MATCH_PROVIDER ?? "disabled") as
    | "rekognition"
    | "disabled",
  /// Minimum similarity (0..1) for an automatic `verified` decision when
  /// comparing the Persona selfie against a profile photo. Defaults to
  /// 0.85 — AWS recommends ≥80 for security-grade applications; we lean
  /// slightly stricter because dating-profile mismatches have higher harm
  /// than the friction of a manual review.
  FACE_MATCH_THRESHOLD_VERIFY: Number(process.env.FACE_MATCH_THRESHOLD_VERIFY ?? "0.85"),
  /// Lower bound (0..1) for the manual-review band. Scores in
  /// [REVIEW, VERIFY) flip the user to `pending_review` (admin moderates
  /// in dashboard); scores below this are auto-rejected.
  FACE_MATCH_THRESHOLD_REVIEW: Number(process.env.FACE_MATCH_THRESHOLD_REVIEW ?? "0.75"),

  // ── AWS (Rekognition CompareFaces) ───────────────────────────
  /// IAM user with `rekognition:CompareFaces` + `rekognition:DetectFaces`.
  /// See AGENTS.md for the IAM policy template. Empty values disable the
  /// SDK client (provider falls through to `disabled` semantics even when
  /// `FACE_MATCH_PROVIDER=rekognition`).
  AWS_REGION: process.env.AWS_REGION ?? "eu-central-1",
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "",
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "",

  // ── Dev-only: skip corporate-email OTP for specific Telegram IDs ──
  /// Comma-separated list of Telegram IDs that get a synthetic verified email
  /// at /start time, so the agent skips the email step entirely. Lets the
  /// developer onboard a SECOND test account without owning a second .edu
  /// address. MUST stay empty in production — the corporate-email gate is a
  /// core principle (PRODUCT_SPEC.md §Core Principles). Configured only in
  /// `.env.local`. The bot logs a loud warning at startup if non-empty.
  DEV_OTP_BYPASS_TELEGRAM_IDS: parseTelegramIdSet(process.env.DEV_OTP_BYPASS_TELEGRAM_IDS),
} as const;

function parseTelegramIdSet(raw: string | undefined): ReadonlySet<bigint> {
  if (!raw) return new Set();
  const ids = new Set<bigint>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      ids.add(BigInt(trimmed));
    } catch {
      console.warn(`[config] DEV_OTP_BYPASS_TELEGRAM_IDS: ignoring invalid id "${trimmed}"`);
    }
  }
  return ids;
}
