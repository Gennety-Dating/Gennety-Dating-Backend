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
  /// Optional animated checkmark emoji shown next to the partner's name
  /// in the match-pitch photo caption when their `verificationStatus` is
  /// `verified`. Empty value falls back to a static `✓` glyph (no entity).
  /// Picked from a public Telegram emoji pack — operator selects the visual.
  CUSTOM_EMOJI_VERIFIED_ID: process.env.CUSTOM_EMOJI_VERIFIED_ID ?? "",
  MESSAGE_EFFECT_MATCH_ID: process.env.MESSAGE_EFFECT_MATCH_ID ?? "5104841245755180586",
  /// Optional Bot API 7.6+ message effect attached to the post-date feedback
  /// DM. Uses a different effect id from `MESSAGE_EFFECT_MATCH_ID` so the
  /// "your match accepted" sparkle and "tell us how it went" reaction read
  /// as distinct moments. Empty falls through to no effect.
  MESSAGE_EFFECT_FEEDBACK_ID: process.env.MESSAGE_EFFECT_FEEDBACK_ID ?? "",
  WEBAPP_URL: process.env.WEBAPP_URL ?? "https://example.invalid/calendar",
  /// URL of the post-date Feedback Mini App bundle. When unset, derived from
  /// `WEBAPP_URL` by appending `/feedback.html` — Caddy serves both the
  /// calendar and the feedback bundle from the same `/var/www/dating-app`
  /// root in production. Override only if the feedback bundle is hosted
  /// elsewhere (e.g. a separate Caddy site).
  WEBAPP_FEEDBACK_URL:
    process.env.WEBAPP_FEEDBACK_URL ??
    `${process.env.WEBAPP_URL ?? "https://example.invalid/calendar"}/feedback.html`,
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
  /// Minimum number of profile photos (with detectable faces) that must
  /// score ≥ FACE_MATCH_THRESHOLD_VERIFY for the user to land on the
  /// `verified` branch. Photos without a detected face (group shots,
  /// landscapes) are excluded from the count rather than treated as
  /// hard fails. A single solid match is strong evidence; ops can raise
  /// this to require multiple corroborating angles. Range ≥ 1.
  FACE_MATCH_MIN_VERIFIED_PHOTOS: Math.max(
    1,
    Number(process.env.FACE_MATCH_MIN_VERIFIED_PHOTOS ?? "1"),
  ),

  // ── Cold-start Elo seeding via vision (SCUT-FBP5500-style) ──
  /// Master flag for the AI vision pass that seeds `Profile.eloScore` on the
  /// `verified` branch of the verification pipeline. Disabled by default so
  /// the feature can ship dark; flip to `true` after backfill is approved.
  /// When false, all newly verified users keep the Elo default of 500 and
  /// `eloSeededAt` stays null — no OpenAI call, no surprises.
  ELO_VISION_SEED_ENABLED: process.env.ELO_VISION_SEED_ENABLED === "true",

  // ── AWS (Rekognition CompareFaces) ───────────────────────────
  /// IAM user with `rekognition:CompareFaces` + `rekognition:DetectFaces`.
  /// See AGENTS.md for the IAM policy template. Empty values disable the
  /// SDK client (provider falls through to `disabled` semantics even when
  /// `FACE_MATCH_PROVIDER=rekognition`).
  AWS_REGION: process.env.AWS_REGION ?? "eu-central-1",
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "",
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "",

  // ── Date Ticket (premium post-accept screen + mock payment) ──
  /// Master flag for the Date Ticket gate. When false (default), mutual
  /// accept goes straight to the Calendar Mini App exactly as before — the
  /// whole feature ships dark. When true, both users must pay (mock) for a
  /// $6.99 ticket before scheduling unlocks. Telegram-only in v1 (the mobile
  /// decision path still schedules directly).
  TICKET_FEATURE_ENABLED: process.env.TICKET_FEATURE_ENABLED === "true",
  /// Payment backend. `mock` (default) fully simulates Stripe with no
  /// credentials — `services/ticket-payment.ts` mints a fake clientSecret and
  /// trusts the client confirm. `stripe` is the production path (real
  /// PaymentIntent + webhook), gated behind the `// TODO: Stripe Production
  /// Mode` branches and not yet implemented.
  TICKET_PAYMENT_MODE: (process.env.TICKET_PAYMENT_MODE ?? "mock") as "mock" | "stripe",
  /// Per-ticket price in cents. Mirrored onto `Match.ticketPriceCents` at
  /// offer time so an in-flight match keeps its quoted price even if this
  /// changes mid-deploy.
  TICKET_PRICE_CENTS: Number(process.env.TICKET_PRICE_CENTS ?? "699"),
  /// How long the second side has to pay once the first has (the `partial`
  /// window) before the ticket-expiry cron refunds the payer and opens the
  /// Calendar for free. Fractional hours allowed for fast manual testing.
  TICKET_PAYMENT_WINDOW_HOURS: Number(process.env.TICKET_PAYMENT_WINDOW_HOURS ?? "24"),
  // TODO: Stripe Production Mode — populate from the Stripe dashboard and keep
  // out of git (.env only). Switching to live payments is: set these +
  // TICKET_PAYMENT_MODE=stripe + fill the `case "stripe"` branches in
  // services/ticket-payment.ts + add the /v1/webhooks/stripe raw-body route.
  //   STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "",
  //   STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY ?? "",
  //   STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? "",

  // ── Pre-date coordination (T-60m contact-exchange / anonymous proxy) ──
  /// Master flag for the pre-date coordination step. When false (default), no
  /// coordination offer is ever sent and the proxy relay is inert — the whole
  /// feature ships dark. When true, the female participant (or first tapper in
  /// a same-sex pair) is offered, ~1h before the date, three ways to find each
  /// other on-site: share my Telegram, request the partner's, or an anonymous
  /// bot-relayed chat. Telegram-only in v1 (PRODUCT_SPEC.md §Phase 4).
  COORDINATION_FEATURE_ENABLED: process.env.COORDINATION_FEATURE_ENABLED === "true",

  // ── Venue change (female-exclusive one-shot venue swap) ──────
  /// Master flag for the post-schedule "Change venue" step. When false
  /// (default), the scheduled-date DM is identical for both sides and no
  /// venue-change button/endpoints do anything — the feature ships dark.
  /// When true, the female participant (or first tapper in a same-sex female
  /// pair) gets a "Change venue" button on her scheduled-date card, can pick
  /// an alternative within VENUE_CHANGE_RADIUS_KM of the original venue with a
  /// mandatory comment, and the male accepts or declines (decline cancels the
  /// match). Telegram-only in v1 (PRODUCT_SPEC.md §3.7).
  VENUE_CHANGE_FEATURE_ENABLED: process.env.VENUE_CHANGE_FEATURE_ENABLED === "true",

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
