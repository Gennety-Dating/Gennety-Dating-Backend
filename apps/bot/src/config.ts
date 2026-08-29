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

/**
 * An env var that is an OVERRIDE, not a default: unset resolves to `null` so the
 * read site can fall back to whatever owns the real value (today: the cadence
 * profile, `CADENCE.rematch*`).
 *
 * Distinct from the `Number(process.env.X ?? "N")` pattern used everywhere else
 * in this file, which cannot tell "unset" from "explicitly set to N" — and that
 * difference is the whole point here: a weekly-tuned literal baked in as a
 * default silently survives a `DROP_CADENCE` flip.
 *
 * `"0"` is a real value and stays `0`; only unset/empty becomes `null`. A
 * non-numeric value also becomes `null` rather than `NaN`, since `NaN` would
 * pass a `?? ` fallback and then poison every comparison downstream.
 */
function optionalNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export const env = {
  BOT_TOKEN: required("BOT_TOKEN"),
  /// Telegram username of the bot (without @). Used to build `t.me/<username>`
  /// deep links (referral invites, coordination contact exchange).
  BOT_USERNAME: process.env.BOT_USERNAME ?? "",
  DATABASE_URL: required("DATABASE_URL"),
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? process.env.SMTP_PASS ?? "",
  SMTP_FROM: process.env.SMTP_FROM ?? "onboarding@resend.dev",
  // When true, OTP emails are logged to the bot's console instead of sent via
  // Resend. Lets local dev work even with SMTP_PASS shared from prod (.env).
  OTP_LOG_TO_CONSOLE: process.env.OTP_LOG_TO_CONSOLE === "true",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  /// Server-owned onboarding fact collector. Enable in Development first;
  /// production can keep the legacy LLM-driven flow during staged rollout.
  ONBOARDING_FACT_COLLECTOR_ENABLED:
    process.env.ONBOARDING_FACT_COLLECTOR_ENABLED === "true",
  /// AI-memory export (the Magic Prompt / "import your ChatGPT memory" branch,
  /// PRODUCT_SPEC §1.1/§1.3). **On by default** — this is long-standing product
  /// behavior, so only an explicit `AI_MEMORY_EXPORT_ENABLED=false` turns it
  /// off. When off, every surface behaves exactly as it already does for a user
  /// who *declined*: the onboarding Mini App skips the AI-memory choice screen,
  /// `POST /v1/telegram-onboarding/ai-memory` 404s, the collector marks
  /// `ai_memory` + `context_dump` complete/skipped (photos follow the vibe
  /// questions directly), and the legacy onboarding agent never requests or
  /// accepts a Magic Prompt paste. Nothing is written to the DB because of the
  /// flag: `User.aiMemoryExportPreference` stays whatever it was, so flipping
  /// the flag back on restores the branch with no migration or backfill.
  /// Profiles built while it is off use the deterministic fallback summary +
  /// embedding, exactly like a declined user.
  AI_MEMORY_EXPORT_ENABLED: process.env.AI_MEMORY_EXPORT_ENABLED !== "false",
  /// Registration v2: the sign-up fork + phone (Telegram one-tap) rail for the
  /// general track. Off (default) → the university-email gate is the only
  /// registration path and the bot ignores `message.contact` shares, exactly
  /// as before. Ship dark; flip at launch together with the fork Mini App.
  PHONE_AUTH_ENABLED: process.env.PHONE_AUTH_ENABLED === "true",
  /// "Continue with Telegram" in the native app (Telegram's official OIDC
  /// Login SDK). This is the bot's Client ID from @BotFather → Web Login, and
  /// it is the `aud` every ID token is checked against — a token minted for
  /// another bot must never authenticate here. Empty → the endpoint answers
  /// 503 and the client hides the button (`features.telegramAuth`).
  /// Deliberately NOT paired with a client secret: we verify an already-issued
  /// ID token against Telegram's public keys and never exchange a code.
  TELEGRAM_LOGIN_CLIENT_ID: process.env.TELEGRAM_LOGIN_CLIENT_ID ?? "",
  /// Which rail tries first for the native app's phone codes. Founder
  /// decision 2026-07-18: **twilio** (SMS) is the primary; "telegram" flips
  /// back to Gateway-first. Whichever is primary, the other configured rail
  /// remains the automatic fallback.
  PHONE_CODE_PRIMARY_PROVIDER:
    process.env.PHONE_CODE_PRIMARY_PROVIDER === "telegram" ? "telegram" : "twilio",
  /// Telegram Gateway (gateway.telegram.org) — optional secondary rail
  /// (~$0.01/code, arrives as an official Telegram service message). Empty →
  /// Gateway is never used.
  TELEGRAM_GATEWAY_TOKEN: process.env.TELEGRAM_GATEWAY_TOKEN ?? "",
  /// Twilio Verify — the PRIMARY phone-code rail. All three must be set for
  /// SMS to be available; no Twilio phone number is needed (Verify manages
  /// sending and code checking).
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ?? "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? "",
  TWILIO_VERIFY_SERVICE_SID: process.env.TWILIO_VERIFY_SERVICE_SID ?? "",
  /// App Store Server API (StoreKit 2 ticket purchases + refund webhooks).
  /// Key from App Store Connect → Users and Access → Integrations →
  /// In-App Purchase. All four required for the verification rail; without
  /// them /v1/tickets/appstore answers 503 and nothing else is affected.
  APPSTORE_KEY_PATH: process.env.APPSTORE_KEY_PATH ?? "",
  APPSTORE_KEY_ID: process.env.APPSTORE_KEY_ID ?? "",
  APPSTORE_ISSUER_ID: process.env.APPSTORE_ISSUER_ID ?? "",
  APPSTORE_BUNDLE_ID: process.env.APPSTORE_BUNDLE_ID ?? "com.gennety.ios",
  /// "sandbox" (default — TestFlight/dev purchases) | "production".
  APPSTORE_ENVIRONMENT: process.env.APPSTORE_ENVIRONMENT ?? "sandbox",
  /// Consumable product → ticket count pairs; matches the full product id
  /// or its last dot-segment (com.gennety.ios.ticket_3 ≡ ticket_3).
  APPSTORE_TICKET_PRODUCTS:
    process.env.APPSTORE_TICKET_PRODUCTS ?? "ticket_1:1,ticket_3:3,ticket_6:6",
  /// Native iOS forced-update kill switch, served pre-auth by
  /// `GET /v1/app/config` as `minSupportedIosVersion`. A client build whose
  /// version compares lower must block behind an "update the app" screen.
  /// Empty (default) → no forced update. Set e.g. "1.2.0" only when an old
  /// build must be retired (broken contract, security issue).
  IOS_MIN_SUPPORTED_APP_VERSION: process.env.IOS_MIN_SUPPORTED_APP_VERSION ?? "",
  /// Registration v2: mandatory liveness. On → the verification CTA
  /// carries no Skip button and the legacy soft-skip callbacks refuse with a
  /// "verification is required" notice, so activation happens ONLY through the
  /// pipeline's `verified` outcome. Existing users with a persisted legacy
  /// `verificationSkippedAt` remain grandfathered by the pool gate.
  MANDATORY_VERIFICATION_ENABLED:
    process.env.MANDATORY_VERIFICATION_ENABLED === "true",
  /// Custom emoji id that leads each rich "thinking" shimmer block — the
  /// animated Telegram AI emoji recommended for `RichBlockThinking`
  /// (https://t.me/addemoji/AIActions). Rendered as `<tg-emoji>` inside
  /// `<tg-thinking>`, with the step's plain glyph (🧠/🔍/…) as the non-Premium /
  /// pre-10.1 fallback. Empty → the plain glyph leads with no animation.
  ///
  /// This is the LAST fallback of the per-step chain, read by `ai-stream.ts` on
  /// the ordinary product paths (Profiler questions, verification, date card) —
  /// not a demo-only knob, so emptying it changes what real users see.
  ///
  /// A per-step env slot per beat (`CUSTOM_EMOJI_AI_ROUTE/VENUE/CONFIRM/CARD/
  /// SPARKLE_ID`) used to sit here and was removed 2026-08-14: the ids had
  /// already moved into the baked `AI_EMOJI` map (`services/ai-emoji.ts`),
  /// nothing ever read the slots, and production had one of them set — a
  /// setting that looked live and did nothing. A step's icon is one edit in
  /// that map; it is a product choice, not per-deployment config.
  CUSTOM_EMOJI_THINKING_ID: process.env.CUSTOM_EMOJI_THINKING_ID ?? "",
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
  /// Optional animated emoji shown as the icon of the "My date" main-menu row
  /// (the primary-styled row that appears only while the user has a live
  /// match). Empty value → the row still renders (💫 in the label), just with
  /// no `icon_custom_emoji_id`. Picked from a public Telegram emoji pack.
  CUSTOM_EMOJI_DATE_ID: process.env.CUSTOM_EMOJI_DATE_ID ?? "",
  /// Empty by default → no floating-hearts animation on match-accept messages.
  /// Set a Telegram effect id via env to re-enable.
  MESSAGE_EFFECT_MATCH_ID: process.env.MESSAGE_EFFECT_MATCH_ID ?? "",
  /// Bot API 7.6+ message effect played on the MUTUAL-match reveal — the one
  /// message that tells a user the sympathy went both ways (the Date Ticket
  /// card when the gate is on, the celebratory Calendar card when it's off).
  /// Distinct from `MESSAGE_EFFECT_MATCH_ID` (that one rides the individual
  /// "you accepted, waiting on them" receipt, which must stay quiet — it
  /// reveals nothing about the partner, per the blind-decision invariant).
  /// Defaults to ❤️ falling hearts; set empty to disable (the reveal still
  /// sends, just without the animation).
  MESSAGE_EFFECT_MUTUAL_ID:
    process.env.MESSAGE_EFFECT_MUTUAL_ID ?? "5159385139981059251",
  /// Optional Bot API 7.6+ message effect attached to the post-date feedback
  /// DM. Uses a different effect id from `MESSAGE_EFFECT_MATCH_ID` so the
  /// "your match accepted" sparkle and "tell us how it went" reaction read
  /// as distinct moments. Empty falls through to no effect.
  MESSAGE_EFFECT_FEEDBACK_ID: process.env.MESSAGE_EFFECT_FEEDBACK_ID ?? "",
  /// Optional Bot API 7.6+ message effect played on the "you earned a free
  /// Date Ticket" reward DM (4+ photos / added a profile video). Empty falls
  /// through to no effect — the reward still sends, just without the animation.
  MESSAGE_EFFECT_TICKET_ID: process.env.MESSAGE_EFFECT_TICKET_ID ?? "",
  /// Optional Bot API 7.6+ message effect played on the welcome-gift DM (the
  /// "your first ticket is on me" message sent as a pre-roll before a new
  /// user's first match pitch). Defaults to the 🎉 confetti effect; override
  /// with another id (e.g. ❤️ `5159385139981059251`) or set empty to disable
  /// (the gift DM still sends, just without the animation).
  MESSAGE_EFFECT_GIFT_ID: process.env.MESSAGE_EFFECT_GIFT_ID ?? "5046509860389126442",
  /// Optional Bot API 7.6+ message effect played on the paid-Rematch "found
  /// someone" DM — the payoff at the end of the §3.11 search animation, and the
  /// only celebratory beat that whole flow has.
  ///
  /// Deliberately NOT on the offer card that asks for the money: §3.5b records
  /// the founder decision that a decorative flourish beside a request for
  /// payment reads as marketing rather than as a receipt. Ships EMPTY like
  /// `MESSAGE_EFFECT_MATCH_ID` / `_TICKET_ID` / `_FEEDBACK_ID`, so the feature
  /// is inert until an id is chosen and set in `/opt/gennety/.env`.
  MESSAGE_EFFECT_REMATCH_ID: process.env.MESSAGE_EFFECT_REMATCH_ID ?? "",
  WEBAPP_URL: process.env.WEBAPP_URL?.trim() || "https://example.invalid/calendar",
  /// URL of the post-date Feedback Mini App bundle. When unset, derived from
  /// `WEBAPP_URL` by appending `/feedback.html` — Caddy serves both the
  /// calendar and the feedback bundle from the same `/var/www/dating-app`
  /// root in production. Override only if the feedback bundle is hosted
  /// elsewhere (e.g. a separate Caddy site).
  WEBAPP_FEEDBACK_URL:
    process.env.WEBAPP_FEEDBACK_URL?.trim() ||
    `${process.env.WEBAPP_URL?.trim() || "https://example.invalid/calendar"}/feedback.html`,
  ADMIN_API_KEY: process.env.ADMIN_API_KEY ?? "",
  ADMIN_PORT: Number(process.env.ADMIN_PORT ?? "3100"),
  /// Allowed browser origin(s) for the admin analytics dashboard
  /// (comma-separated). Defaults to empty — an unset/`*` value makes
  /// `admin/server.ts` deny cross-origin requests rather than echo a
  /// wildcard from an authenticated admin surface (audit M3). Set this to
  /// the concrete dashboard origin in production.
  ADMIN_DASHBOARD_ORIGIN: process.env.ADMIN_DASHBOARD_ORIGIN ?? "",
  /// Telegram id тестовых аккаунтов через запятую (свой, QA, демо).
  /// Классификатор здоровья базы исключает их из ВСЕХ знаменателей, поэтому
  /// незаполненное значение тихо завышает конверсию — ровно тот баг, из-за
  /// которого activeRate делился на всех подряд. Только чтение/аналитика:
  /// на продукт, матчинг и рассылки не влияет.
  ADMIN_TEST_TELEGRAM_IDS: process.env.ADMIN_TEST_TELEGRAM_IDS ?? "",

  // ── Public `/v1/*` API for the mobile app ─────────────────────
  JWT_SECRET: process.env.JWT_SECRET ?? "",
  JWT_ACCESS_TTL: process.env.JWT_ACCESS_TTL ?? "15m",
  JWT_REFRESH_TTL: process.env.JWT_REFRESH_TTL ?? "30d",
  PUBLIC_PORT: Number(process.env.PUBLIC_PORT ?? "3101"),
  /// Allowed browser origin(s) for the public `/v1/*` API (comma-separated).
  /// Empty (default) → cross-origin browser requests are DENIED (audit L3),
  /// mirroring the admin surface, instead of echoing a wildcard. An explicit
  /// `*` still works but logs a warning. Native mobile clients send no `Origin`
  /// header and are unaffected either way. In production set this to the concrete
  /// browser origins: the Mini App host (WEBAPP_URL) plus any web signup site.
  PUBLIC_CORS_ORIGIN: process.env.PUBLIC_CORS_ORIGIN ?? "",

  // ── Founder notifications (private ops feed) ─────────────────
  /// Master switch for the founder-notify feed (new-registration profile card,
  /// weekly-matches report link, date-scheduled cards). Off (default) → all
  /// three notifiers are inert no-ops, so the feature ships dark. See
  /// `services/founder-notify.ts`, PRODUCT_SPEC is unaffected (ops-only).
  FOUNDER_NOTIFY_ENABLED: process.env.FOUNDER_NOTIFY_ENABLED === "true",
  /// Bot token of the SEPARATE founder bot (created in BotFather) used to DM
  /// the founder. Kept distinct from `BOT_TOKEN` so the founder ops feed is
  /// isolated from the user-facing @gennetybot — and because `file_id`s are
  /// per-bot, the founder bot always uploads raw bytes, never re-sends a
  /// @gennetybot `file_id`. Empty → the feed is inert even if the flag is on.
  FOUNDER_BOT_TOKEN: process.env.FOUNDER_BOT_TOKEN ?? "",
  /// Numeric Telegram chat id of the founder (their personal chat with the
  /// founder bot). The founder must `/start` the founder bot once so it may DM
  /// them. Empty → the feed is inert.
  FOUNDER_TELEGRAM_ID: process.env.FOUNDER_TELEGRAM_ID ?? "",
  /// Absolute base URL of the public `/v1/*` API, used to build the tokenized
  /// weekly-matches report link sent to the founder (`GET /v1/founder/report/
  /// :token`). Defaults to the production public API host.
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? "https://dating-api.gennety.com",
  /// Absolute base URL of the admin dashboard itself (NOT the API —
  /// `ADMIN_DASHBOARD_ORIGIN` above is a comma-separated CORS allowlist and
  /// unsuitable for building a link). Used only by the weekly ad-spend
  /// reminder to link straight to `/ad-spend`. Empty (default) → the
  /// reminder still sends, just without a clickable link.
  ADMIN_DASHBOARD_URL: process.env.ADMIN_DASHBOARD_URL ?? "",

  /// Expo Push Service access token (https://expo.dev/accounts/…/settings/access-tokens).
  /// Optional — unset disables push dispatch.
  /// Direct APNs (token-based .p8) — the push rail for the native iOS app
  /// and the only rail for Live Activity updates. All four required for
  /// pushes to leave the process (`apnsConfigured()`); environment picks the
  /// host: "sandbox" (default — TestFlight/dev builds) or "production".
  APNS_KEY_PATH: process.env.APNS_KEY_PATH ?? "",
  APNS_KEY_ID: process.env.APNS_KEY_ID ?? "",
  APNS_TEAM_ID: process.env.APNS_TEAM_ID ?? "",
  APNS_BUNDLE_ID: process.env.APNS_BUNDLE_ID ?? "com.gennety.ios",
  APNS_ENVIRONMENT: process.env.APNS_ENVIRONMENT ?? "sandbox",
  /// Supabase Storage bucket for selfie uploads.
  SUPABASE_URL: process.env.SUPABASE_URL ?? "",
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  SUPABASE_SELFIE_BUCKET: process.env.SUPABASE_SELFIE_BUCKET ?? "selfies",
  /// Supabase Storage bucket for profile photos (separate from selfies so
  /// moderation policy can differ — profile photos are shown to matches,
  /// selfies are only seen by admins). Expected to be PRIVATE; reads go
  /// through short-lived signed URLs.
  SUPABASE_PHOTO_BUCKET: process.env.SUPABASE_PHOTO_BUCKET ?? "profile-photos",
  /// Supabase Storage bucket for the mobile chat agent's multimodal attachments
  /// (user-uploaded images sent as part of a `/v1/chat/message` turn). Expected
  /// to be PRIVATE; the chat endpoint fetches signed URLs (5 min TTL) just
  /// long enough for the OpenAI vision call to dereference them.
  SUPABASE_CHAT_BUCKET: process.env.SUPABASE_CHAT_BUCKET ?? "chat-attachments",
  /// Supabase Storage bucket for voice prompts uploaded by a NATIVE client
  /// (VOICE_PROMPT_PRODUCT_SPEC.md). Telegram-recorded prompts never land here
  /// — those live as a `file_id`, Telegram is the store. Expected to be
  /// PRIVATE; playback goes through short-lived signed URLs.
  ///
  /// Must be named explicitly in `.env.demo`. The demo env is assembled as
  /// production's `.env` plus that file, so any bucket it does not name is
  /// INHERITED from production — which is exactly how the demo spent its first
  /// day writing into production storage (deploy.md, 2026-08-06).
  SUPABASE_VOICE_BUCKET: process.env.SUPABASE_VOICE_BUCKET ?? "voice-prompts",

  // ── AWS Rekognition Face Liveness (identity provider) ────────
  /// Master switch for the Face Liveness step — the provider that captures the
  /// reference selfie and proves a live human is in front of the camera.
  /// Production-like processes fail closed unless this is true (see
  /// `identityTrustConfigurationErrors`).
  FACE_LIVENESS_ENABLED: process.env.FACE_LIVENESS_ENABLED === "true",
  /// Region for Face Liveness ONLY — deliberately separate from `AWS_REGION`.
  /// Face Liveness is not served in every Rekognition region: our
  /// `AWS_REGION=eu-central-1` (Frankfurt) does NOT have it, and returns a
  /// message-less `AccessDeniedException` that reads exactly like an IAM
  /// problem. `eu-west-1` (Ireland) is the only EU region that serves it, and
  /// also hosts our Supabase project — so the selfie stays in one EU region.
  /// The on-device detector MUST stream to the same region the session was
  /// created in, so this value is handed to the client verbatim.
  FACE_LIVENESS_REGION: process.env.FACE_LIVENESS_REGION ?? "eu-west-1",
  /// Minimum liveness confidence (0..1) for the check to count as passed. AWS
  /// returns 0..100; we normalise on read, mirroring `face-match.ts`. Below
  /// this the check is RETRYABLE (a new session), never `rejected` — a shaky
  /// capture is not an impostor.
  FACE_LIVENESS_MIN_CONFIDENCE: Number(
    process.env.FACE_LIVENESS_MIN_CONFIDENCE ?? "0.8",
  ),
  /// IAM role the backend assumes to mint the short-lived credentials the
  /// on-device Amplify component uses to sign its Rekognition stream. Scoped
  /// to `rekognition:StartFaceLivenessSession` only — see deploy.md.
  LIVENESS_STS_ROLE_ARN: process.env.LIVENESS_STS_ROLE_ARN ?? "",
  /// Lifetime of those credentials. AWS floors AssumeRole at 900s, which is
  /// also plenty: a liveness session itself expires after 3 minutes.
  LIVENESS_CREDENTIALS_TTL_SECONDS: Math.max(
    900,
    Number(process.env.LIVENESS_CREDENTIALS_TTL_SECONDS ?? "900"),
  ),

  // ── Face matching (liveness selfie ↔ profile photos) ─────────
  /// Provider used by `services/face-match.ts`. `rekognition` calls AWS
  /// Rekognition CompareFaces. `disabled` short-circuits every call to
  /// `{ ok: true, similarity: 1, faceFound: true }` so the rest of the
  /// pipeline runs unchanged in local dev / CI without AWS credentials.
  FACE_MATCH_PROVIDER: (process.env.FACE_MATCH_PROVIDER ?? "disabled") as
    | "rekognition"
    | "disabled",
  /// Minimum similarity (0..1) for an automatic `verified` decision when
  /// comparing the verified liveness selfie against a profile photo. Defaults to
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
  /// Unified photo/video validation. Strict upload-time validation is the
  /// product default; set explicitly to "false" only for local emergency tests.
  PROFILE_MEDIA_VALIDATION_ENABLED:
    process.env.PROFILE_MEDIA_VALIDATION_ENABLED !== "false",

  /// Voice prompts (VOICE_PROMPT_PRODUCT_SPEC.md). Default OFF: this adds a
  /// step to a live onboarding funnel and a message to every pitch, so it ships
  /// dark and is flipped deliberately. With it off the collector never asks,
  /// the pitch sends nothing extra, and the `/v1/*` routes 404 — an existing
  /// row keeps its data and simply stops being read.
  VOICE_PROMPT_ENABLED: process.env.VOICE_PROMPT_ENABLED === "true",
  /// Deprecated emergency rollback toggle. Upload handlers now fail closed and
  /// never publish media after a provider or local-processing failure.
  PROFILE_MEDIA_VALIDATION_FAIL_OPEN:
    process.env.PROFILE_MEDIA_VALIDATION_FAIL_OPEN === "true",
  PROFILE_VIDEO_MAX_ANALYSIS_FRAMES: Math.max(
    6,
    Math.min(
      24,
      Number(process.env.PROFILE_VIDEO_MAX_ANALYSIS_FRAMES ?? "24"),
    ),
  ),
  PROFILE_VIDEO_VALIDATION_TIMEOUT_MS: Math.max(
    10_000,
    Number(process.env.PROFILE_VIDEO_VALIDATION_TIMEOUT_MS ?? "60000"),
  ),

  // ── Cold-start Elo seeding via vision (SCUT-FBP5500-style) ──
  /// Master flag for the AI vision pass that seeds `Profile.eloScore` on the
  /// `verified` branch of the verification pipeline. Disabled by default so
  /// the feature can ship dark; flip to `true` after backfill is approved.
  /// When false, all newly verified users keep the Elo default of 500 and
  /// `eloSeededAt` stays null — no OpenAI call, no surprises.
  ELO_VISION_SEED_ENABLED: process.env.ELO_VISION_SEED_ENABLED === "true",

  // ── AWS (Rekognition: face match + Face Liveness) ────────────
  /// IAM user with `rekognition:CompareFaces`, `DetectFaces`,
  /// `DetectModerationLabels`, `CreateFaceLivenessSession`,
  /// `GetFaceLivenessSessionResults`, plus `sts:AssumeRole` on
  /// `LIVENESS_STS_ROLE_ARN`.
  /// See deploy.md for the IAM policy template. Empty values disable the
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
  /// Master flag for Type Radar (PRODUCT_SPEC §Type Radar). When false
  /// (default), the onboarding radar screen is skipped and its `/v1/radar/*`
  /// routes 404 — the whole feature ships dark. When true, onboarding collects
  /// the visual appearance-preference calibration; the `V_type` match multiplier
  /// stays a shadow no-op until `TYPE_PREF_FLOOR` is lowered below 1 (read
  /// directly by the match engine, mirroring `AGE_RANGE_PREF_*`).
  TYPE_RADAR_ENABLED: process.env.TYPE_RADAR_ENABLED === "true",
  /// The ~10s "thinking state" status sequence played in chat after the radar
  /// Mini App closes (PRODUCT_SPEC §Type Radar). On by default; rides
  /// `TYPE_RADAR_ENABLED` (the submit route 404s when the radar is off). Set
  /// `false` to drop straight to the next onboarding question — a kill switch
  /// for a purely cosmetic beat that nonetheless holds the user ~10s, flippable
  /// with `pm2 restart --update-env` rather than a redeploy.
  RADAR_THINKING_ENABLED: process.env.RADAR_THINKING_ENABLED !== "false",
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
  /// Famine single-ticket discount (PRODUCT_SPEC §3.5b). Granted on the 2nd
  /// consecutive no-match week; discounts one ticket by this percent for this
  /// many days. Literal defaults mirror `FAMINE_DISCOUNT_PCT` /
  /// `FAMINE_DISCOUNT_TTL_DAYS` in `@gennety/shared` (config.ts deliberately has
  /// no shared import — it loads first); env only overrides for ops tuning, like
  /// `TICKET_PRICE_CENTS` above. Inert unless `TICKET_FEATURE_ENABLED`.
  FAMINE_DISCOUNT_PCT: Number(process.env.FAMINE_DISCOUNT_PCT ?? "77"),
  FAMINE_DISCOUNT_TTL_DAYS: Number(process.env.FAMINE_DISCOUNT_TTL_DAYS ?? "30"),
  /// Telegram Stars (XTR) — the REAL production payment rail for Date Tickets.
  /// When false (default) the store + date gate keep the mock/stripe flow; when
  /// true, "My Tickets" shows native in-chat Star invoice buttons (1/3/6
  /// bundles) that credit the wallet on `successful_payment`, and the §3.5b date
  /// gate pays natively via `WebApp.openInvoice`. Stars is the primary rail —
  /// the mock survives only as the `TICKET_STARS_ENABLED=false` fallback (the
  /// PAY-1 guard 404s the mock intent/confirm routes while Stars is on). Only
  /// meaningful with `TICKET_FEATURE_ENABLED`. Needs no merchant account /
  /// provider token (empty provider token + `currency: "XTR"`).
  TICKET_STARS_ENABLED: process.env.TICKET_STARS_ENABLED === "true",
  /// Star price (XTR) per store bundle, as `<count>:<stars>` pairs. Default
  /// `1:350,3:830,6:1350` (~350⭐/ticket ≈ $5–7, matching the $6.99 anchor, with
  /// the same bundle discount as the USD bundles). The date gate derives its
  /// per-scope price from the 1-ticket entry (self/partner = 1×, both = 2×).
  /// Override e.g. `TICKET_BUNDLE_STARS=1:250,3:590,6:960`.
  TICKET_BUNDLE_STARS: parseStarBundles(process.env.TICKET_BUNDLE_STARS),
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

  // ── Venue change v2 (paid multiplayer venue picking) ─────────
  /// Master flag for the post-schedule "Change venue" board. When false
  /// (default), the scheduled-date DM carries no venue-change button and the
  /// endpoints refuse — the feature ships dark. When true, BOTH sides'
  /// scheduled cards carry a "Change venue" web_app button into the shared
  /// likes board (calendar mechanics: multi-pick hearts, live peer visibility,
  /// overlap = agreement). A settled change costs VENUE_CHANGE_STARS; hetero
  /// pairs — the man pays (plus the female-only express unilateral swap),
  /// same-sex — the initiator pays. Decline/lapse never cancels the match —
  /// the original venue simply stands. Telegram-only (PRODUCT_SPEC.md §3.7b).
  VENUE_CHANGE_FEATURE_ENABLED: process.env.VENUE_CHANGE_FEATURE_ENABLED === "true",
  /// Venue Intent V2 rollout. Master enables the new draft/confirm APIs;
  /// deterministic bucketing controls live and shadow selection independently.
  VENUE_INTENT_V2_ENABLED: process.env.VENUE_INTENT_V2_ENABLED === "true",
  VENUE_INTENT_V2_SHADOW_PERCENT: Math.max(
    0,
    Math.min(100, Number(process.env.VENUE_INTENT_V2_SHADOW_PERCENT ?? "0")),
  ),
  VENUE_INTENT_V2_ROLLOUT_PERCENT: Math.max(
    0,
    Math.min(100, Number(process.env.VENUE_INTENT_V2_ROLLOUT_PERCENT ?? "0")),
  ),
  /// Telegram Stars (XTR) price of one settled venue change — one flat price
  /// for every path (agreed board pick, express). Env-tunable at launch.
  VENUE_CHANGE_STARS: Number(process.env.VENUE_CHANGE_STARS ?? "150"),

  // ── Prime Time (paid evening band in the calendar) ───────────
  /// Master flag for PRIME_TIME_PRODUCT_SPEC.md. When false (default) nothing
  /// in the calendar is locked and the unlock endpoints 404 — the feature ships
  /// dark. Additionally inert without PREMIUM_FEATURE_ENABLED: the pass is only
  /// half the offer, and locking a band whose subscription alternative cannot be
  /// bought is a paywall with one path missing.
  PRIME_TIME_ENABLED: process.env.PRIME_TIME_ENABLED === "true",
  /// How many of the day's LAST time slots are locked. 3 → 18:30 / 19:00 /
  /// 19:30 out of the 14-slot day, i.e. 18 of the grid's 84 cells. Read as a
  /// suffix of CALENDAR_TIME_SLOTS, never as a second list of hours.
  PRIME_TIME_SLOT_COUNT: Math.max(
    0,
    Math.min(14, Number(process.env.PRIME_TIME_SLOT_COUNT ?? "3")),
  ),
  /// Telegram Stars (XTR) price of one pass. 50⭐ is exactly one minimum Stars
  /// top-up. There is deliberately NO USD display env: at both documented rates
  /// ($0.02/⭐ ticket, $0.024/⭐ premium) 50⭐ costs the user $1.00–$1.20, so any
  /// "$0.99" label would under-promise the charge — the one wrong price
  /// deploy.md forbids. The Mini App shows Stars, and Telegram names the real
  /// sum in its own payment sheet.
  PRIME_TIME_STARS: Number(process.env.PRIME_TIME_STARS ?? "50"),

  // ── Venue observability + context (VENUE_ENGINE_IMPROVEMENT_PLAN 5.3 / 6) ──
  /// Weekly "one venue is taking the city" alert into the founder ops DM.
  /// Off by default; also inert unless FOUNDER_NOTIFY_ENABLED, which is the
  /// only delivery channel. The `/admin/analytics/venue-concentration` view
  /// and the `poolSizes` funnel in the selection log are NOT gated by this —
  /// they are data, useful whether or not anyone is being paged.
  VENUE_CONCENTRATION_ALERT_ENABLED:
    process.env.VENUE_CONCENTRATION_ALERT_ENABLED === "true",
  /// Share (%) of a city's assignments one venue may take before it is worth
  /// a message. Deliberately a soft signal, not a hard rule: at low volume a
  /// high share is arithmetic, so the alert reports the sample size too.
  VENUE_CONCENTRATION_ALERT_THRESHOLD_PCT: Math.max(
    1,
    Math.min(100, Number(process.env.VENUE_CONCENTRATION_ALERT_THRESHOLD_PCT ?? "15")),
  ),
  VENUE_CONCENTRATION_ALERT_WINDOW_DAYS: Math.max(
    1,
    Math.min(90, Number(process.env.VENUE_CONCENTRATION_ALERT_WINDOW_DAYS ?? "7")),
  ),
  /// Season + weather as a SOFT ranking multiplier (PRODUCT_SPEC §3.7,
  /// VENUE_ENGINE_IMPROVEMENT_PLAN 5.3). Never a filter: a rained-out park
  /// sinks a few places, it is never removed — a wrong forecast or a provider
  /// outage must not be able to withhold a venue. Off → multiplier is a
  /// constant 1.0 and no forecast is ever requested.
  VENUE_SEASON_WEATHER_ENABLED: process.env.VENUE_SEASON_WEATHER_ENABLED === "true",
  /// Upper bound on how long a venue selection may wait for the forecast. The
  /// run continues weather-blind past it rather than making the pair wait.
  VENUE_WEATHER_TIMEOUT_MS: Math.max(
    250,
    Number(process.env.VENUE_WEATHER_TIMEOUT_MS ?? "2500"),
  ),
  /// In-memory forecast cache TTL. Two pairs in the same city on the same date
  /// share one upstream call; the cache is per-process and resets on restart,
  /// exactly like `usage-limiter`.
  VENUE_WEATHER_CACHE_TTL_MS: Math.max(
    60_000,
    Number(process.env.VENUE_WEATHER_CACHE_TTL_MS ?? "3600000"),
  ),

  // ── Gennety Premium (recurring subscription, §Premium) ─────
  /// Master flag for Gennety Premium. When false (default), no premium menu
  /// row, no premium purchase surface, and every venue is treated as `base`
  /// (premium-tier venues are hidden from the venue-change catalog). When true,
  /// the venue-change board shows premium venues locked, offers subscription
  /// (Telegram Stars recurring / iOS StoreKit), and waives the change fee for
  /// subscribers. Standalone per-user entitlement (`services/premium.ts`).
  PREMIUM_FEATURE_ENABLED: process.env.PREMIUM_FEATURE_ENABLED === "true",
  /// Приём клиентской воронки нативного приложения (`POST /v1/client/events`).
  /// Дефолт — ВЫКЛЮЧЕНО, и это не осторожность: privacy manifest приложения
  /// сейчас заявляет, что аналитических данных мы не собираем. Включение сбора
  /// раньше правки манифеста и анкеты App Privacy сделало бы это заявление
  /// ложным (iOS `docs/appstore-review-notes.md` §7).
  CLIENT_EVENTS_ENABLED: process.env.CLIENT_EVENTS_ENABLED === "true",
  /// Telegram Stars (XTR) monthly price of a Gennety Premium subscription
  /// (`subscription_period` is fixed at 30 days by Telegram). 750⭐ is what
  /// Telegram's own Star store charges for $17.99, which is why the two values
  /// below move together: the display price is not a marketing number, it is
  /// what the user actually pays to acquire the Stars this subscription spends.
  /// Env-tunable; keep within Telegram's per-subscription Star ceiling.
  PREMIUM_STARS: Number(process.env.PREMIUM_STARS ?? "750"),
  /// Human-readable price shown in premium copy (the Stars amount is the actual
  /// charge; this is display-only). Must reflect the real cost of PREMIUM_STARS
  /// at Telegram's in-app Star rate — 750⭐ = $17.99 — so we never under-promise
  /// the charge (a cheaper label over a 750⭐ purchase would mislead). Change
  /// one and you must change the other.
  PREMIUM_PRICE_USD_DISPLAY: process.env.PREMIUM_PRICE_USD_DISPLAY ?? "$17.99",
  /// StoreKit 2 auto-renewable subscription product id for the native iOS app.
  /// Matched by full id or last dot-segment (mirrors APPSTORE_TICKET_PRODUCTS).
  PREMIUM_APPSTORE_PRODUCT_ID:
    process.env.PREMIUM_APPSTORE_PRODUCT_ID ?? "premium_monthly",

  // ── Rematch (paid on-demand re-run of the matching engine) ─────
  /// Master flag for Rematch (REMATCH_PRODUCT_SPEC.md). When false (default),
  /// nothing renders, the invoice route refuses, and a `rematch:` payload that
  /// somehow arrives is refunded — the feature ships dark. When true, a man who
  /// was left unpaired by the weekly batch or whose match ended badly can pay
  /// once to re-run the engine for himself. The woman never buys and never sees
  /// a price: she receives an ordinary pitch wrapped in gift framing.
  /// Telegram-only in v1 (explicit decision — Stars is a Telegram rail).
  REMATCH_FEATURE_ENABLED: process.env.REMATCH_FEATURE_ENABLED === "true",
  /// Telegram Stars (XTR) price of one rematch. 150⭐ matches VENUE_CHANGE_STARS
  /// and the ticket rate ($6.99 / 350⭐ = $0.02/⭐ → 150⭐ ≈ $3.00 ≈ the $2.99
  /// founder price). NB: PREMIUM_STARS documents a more conservative
  /// $0.024/⭐ small-pack rate, at which 150⭐ bills nearer $3.59. If we want the
  /// strict "never under-promise the charge" convention Premium follows, either
  /// drop this to 125 or raise REMATCH_PRICE_USD_DISPLAY — both are env-only.
  REMATCH_STARS: Number(process.env.REMATCH_STARS ?? "150"),
  /// Human-readable price shown in the offer copy (the Stars amount is the
  /// actual charge; this is display-only).
  REMATCH_PRICE_USD_DISPLAY: process.env.REMATCH_PRICE_USD_DISPLAY ?? "$2.99",
  /// The four D3 limits below are `null` when unset, and that is load-bearing:
  /// they are ops OVERRIDES over the active cadence profile
  /// (`CADENCE.rematch*`), not the source of truth. `services/rematch.ts`
  /// resolves `env ?? CADENCE`, so an unset var follows `DROP_CADENCE`
  /// automatically instead of pinning a weekly-tuned number under a daily drop.
  ///
  /// The resolution deliberately lives at the READ site rather than here:
  /// `config.ts` must stay the first module evaluated (dotenv ordering), so it
  /// can never safely import `@gennety/shared`. See cadence.ts's own header.
  ///
  /// A literal `0` is a real value, not "unset" — `REMATCH_PRE_BATCH_BLACKOUT_HOURS=0`
  /// disables the blackout, and must not silently fall back to the profile.
  ///
  /// D3 limit: paid rematches allowed per rolling window, per buyer. Caps both
  /// pool burn (every rematch permanently consumes one never-seen candidate via
  /// the lifetime pair ban) and the "paid swipe app" failure mode.
  REMATCH_MAX_PER_WEEK: optionalNumber(process.env.REMATCH_MAX_PER_WEEK),
  /// D3 cooldown: minimum hours between two paid rematches by the same buyer.
  /// Specifically prevents decline-and-instantly-retry, which is what preserves
  /// the weight of a decision.
  REMATCH_COOLDOWN_HOURS: optionalNumber(process.env.REMATCH_COOLDOWN_HOURS),
  /// Candidate protection: a woman who already received a rematch-sourced pitch
  /// within this many days is excluded from rematch candidate pools. The
  /// single-live-match invariant stops SIMULTANEOUS matches but not a series, so
  /// without this a popular candidate could be serially gift-pitched.
  ///
  /// This is the one D3 limit that must NOT scale with how often he can buy: it
  /// protects HER, and in a thin pool a cap that tracks his purchase frequency
  /// turns one candidate into everyone's punching bag.
  REMATCH_GIFT_CAP_DAYS: optionalNumber(process.env.REMATCH_GIFT_CAP_DAYS),
  /// Blackout before the drop. The batch is globally greedy-optimal; a
  /// single-seeker rematch shortly before it can take a candidate the optimal
  /// pairing needed. Set to 0 to disable.
  REMATCH_PRE_BATCH_BLACKOUT_HOURS: optionalNumber(
    process.env.REMATCH_PRE_BATCH_BLACKOUT_HOURS,
  ),
  /// Lookback window for choosing the `failed` gift framing (her most recent
  /// match ended `cancelled`/`expired` within this many days).
  REMATCH_FAILED_LOOKBACK_DAYS: Number(
    process.env.REMATCH_FAILED_LOOKBACK_DAYS ?? "14",
  ),

  // ── Synthetic test profiles (friends-and-family production test) ─────
  /// Master flag for the synthetic FILL — the drop batch's second pass, which
  /// offers a hand-seeded test profile to a real user the real pool left
  /// unpaired (PRODUCT_SPEC §3.1c). Off by default, so shipping the code ships
  /// no behavior: with this false the second pass never runs and the seeded
  /// rows (if any) sit inert, excluded from every candidate query anyway.
  ///
  /// This is the whole kill switch. Flipping it back to false stops new
  /// synthetic pairings instantly; matches already in flight resolve through
  /// the ordinary decline/expiry paths.
  SYNTHETIC_FILL_ENABLED: process.env.SYNTHETIC_FILL_ENABLED === "true",
  /// How long a synthetic partner waits before declining, measured from
  /// `Match.dispatchedAt` (NOT from the human's answer — the schema carries no
  /// timestamp for that, and `peerWaitStartedAt*` belongs to the peer-wait
  /// worker under a single-writer rule).
  ///
  /// It only ever fires once the human has actually committed, so this is a
  /// floor on how fast the answer comes back rather than a timer of its own.
  /// A few minutes of hold is deliberate: it lets the real user see the §3.6b
  /// peer-wait shimmer, which is itself part of what the test is checking.
  SYNTHETIC_DECLINE_DELAY_MS: Number(
    process.env.SYNTHETIC_DECLINE_DELAY_MS ?? String(20 * 60 * 1000),
  ),
  /// Sweep cadence for the auto-decline worker. Registered only when
  /// `SYNTHETIC_FILL_ENABLED` — a production without the flag schedules no
  /// extra cron at all.
  SYNTHETIC_PARTNER_CRON_SCHEDULE:
    process.env.SYNTHETIC_PARTNER_CRON_SCHEDULE ?? "* * * * *",

  // ── Launch events (LAUNCH_EVENTS_PRODUCT_SPEC.md) ────────────────────
  /// Master flag for the offline launch-event subsystem: waitlist admission,
  /// the founder moderation hub, and (later phases) ticketing, the door
  /// scanner and in-event rounds.
  ///
  /// Ships OFF, and OFF is genuinely inert rather than merely quiet: the
  /// verification pipeline's admission hook returns immediately, so a
  /// registration cannot land in a queue nobody is watching, and no admin
  /// route is reachable. The tables exist and stay empty.
  EVENTS_FEATURE_ENABLED: process.env.EVENTS_FEATURE_ENABLED === "true",
  /// HMAC key for door-entry QR codes. **Its own secret, never `JWT_SECRET`** —
  /// the demo once inherited production's JWT key and made every `/v1/*` token
  /// cross-valid (DEMO_MODE.md → the isolation gate), and the lesson recorded
  /// there is that every new secret gets its own key AND a line in
  /// `deploy-demo.sh`'s MUST_DIFFER list. Empty while the feature is off; the
  /// ticket routes refuse to mint or verify a code without it rather than
  /// signing with a blank string, which would make every forgery valid.
  EVENT_QR_SECRET: process.env.EVENT_QR_SECRET ?? "",
  /// The post-event feedback incentive (LAUNCH_EVENTS §11) — the same
  /// single-ticket discount mechanism the famine perk uses, deliberately not a
  /// second one. Smaller than famine's 77% because it buys a minute of the
  /// user's time rather than apologising for a week without a match, and
  /// because the two share ONE slot: the grant only ever fills an empty one
  /// (`services/ticket-discount.ts`), so a modest number can never displace a
  /// large one. Inert unless BOTH `EVENTS_FEATURE_ENABLED` and
  /// `TICKET_FEATURE_ENABLED`.
  EVENT_FEEDBACK_DISCOUNT_PCT: Number(process.env.EVENT_FEEDBACK_DISCOUNT_PCT ?? "40"),
  EVENT_FEEDBACK_DISCOUNT_TTL_DAYS: Number(
    process.env.EVENT_FEEDBACK_DISCOUNT_TTL_DAYS ?? "30",
  ),

  // ── Bonus Campus Drop (§Campus Radar) ────────────────────────────────
  /// An out-of-cycle drop for one university whose verified cohort just grew.
  /// Ships OFF: it is a second entry point into the allocator, and the reason
  /// Rematch carries a pre-batch blackout is that a single-cohort run can take
  /// a candidate the globally-optimal Thursday batch needed.
  CAMPUS_DROP_ENABLED: process.env.CAMPUS_DROP_ENABLED === "true",
  /// How many students a campus must newly verify inside the window to earn a
  /// drop. Low enough to fire on a real campus push, high enough that two
  /// friends signing up together do not trigger one.
  CAMPUS_DROP_GROWTH_THRESHOLD: Number(
    process.env.CAMPUS_DROP_GROWTH_THRESHOLD ?? "6",
  ),
  /// The window that growth is measured over.
  CAMPUS_DROP_WINDOW_HOURS: Number(process.env.CAMPUS_DROP_WINDOW_HOURS ?? "48"),
  /// How long a campus waits between bonus drops. Derived state: the anchor is
  /// the newest `campus` match for that domain, so there is no counter to drift.
  CAMPUS_DROP_COOLDOWN_HOURS: Number(
    process.env.CAMPUS_DROP_COOLDOWN_HOURS ?? "168",
  ),
  /// Hours before the ordinary drop in which a campus drop stands down — the
  /// same protection `REMATCH_PRE_BATCH_BLACKOUT_HOURS` gives the batch, and
  /// for the same reason.
  CAMPUS_DROP_PRE_BATCH_BLACKOUT_HOURS: Number(
    process.env.CAMPUS_DROP_PRE_BATCH_BLACKOUT_HOURS ?? "6",
  ),
  CAMPUS_DROP_CRON_SCHEDULE: process.env.CAMPUS_DROP_CRON_SCHEDULE ?? "30 * * * *",

  // ── Date card (shareable PNG for a fully scheduled date) ─────
  /// Master flag for the date-card feature. When false (default), the
  /// scheduled-date confirmation is the existing plain-text DM. When true, both
  /// users get a rendered PNG "date card" (partner photo + venue photo +
  /// meeting details) sent screenshot/forward-protected, with a Share button
  /// that re-sends a copy with the partner's face blurred (PRODUCT_SPEC.md §3.7).
  /// Telegram-only in v1. A render failure falls back to the text card so
  /// scheduling never wedges.
  DATE_CARD_FEATURE_ENABLED: process.env.DATE_CARD_FEATURE_ENABLED === "true",

  // ── Match card (collage PNG set replacing the pitch photo album) ─────
  /// When true, the match-pitch photo album is replaced by the rendered
  /// collage card set (services/match-card): card 1 = photo + name/vibe panel,
  /// following cards = one full-bleed photo each. Any copy/render/send failure
  /// falls back to the plain protected media group, so pitch dispatch never
  /// wedges. Default off; flip on for the dev bot first.
  MATCH_CARD_FEATURE_ENABLED: process.env.MATCH_CARD_FEATURE_ENABLED === "true",

  // ── Referral program ("Give a date, get a date") ─────
  /// Master flag for the referral system (PRODUCT_SPEC §Referral). Default off.
  /// Rides the already-on TICKET_FEATURE_ENABLED + PREMIUM_FEATURE_ENABLED (it
  /// pays rewards in Date Tickets AND complimentary Premium months). When true:
  /// the "Invite a friend" menu row + referral Mini App appear, referral
  /// deep-links attribute, the invitee gets a welcome Premium month on the
  /// onboarding wow screen, and the referrer earns the milestone ladder as each
  /// invited friend clears verification.
  REFERRAL_FEATURE_ENABLED: process.env.REFERRAL_FEATURE_ENABLED === "true",
  /// Complimentary Premium months gifted to an INVITED user (shown on the
  /// onboarding wow screen, granted + active immediately). Default 1.
  REFERRAL_INVITEE_PREMIUM_MONTHS: Math.max(
    0,
    Number(process.env.REFERRAL_INVITEE_PREMIUM_MONTHS ?? "1"),
  ),
  /// Milestone ladder ("<count>:<ticketsDelta>:<monthsDelta>,…"). Reward is
  /// granted to the referrer AT each verified-friend count. Default ladder
  /// 1→1/1, 3→1/1, 5→1/1, 10→2/2 (cumulative 1/1, 2/2, 3/3, 5/5).
  REFERRAL_LADDER: parseReferralLadder(process.env.REFERRAL_LADDER),
  /// Anti-abuse: max referral reward events credited to one referrer per rolling
  /// 24h. Invited friends beyond this are still counted but reward is deferred/
  /// skipped. Default 3.
  REFERRAL_DAILY_REWARD_CAP: Math.max(
    0,
    Number(process.env.REFERRAL_DAILY_REWARD_CAP ?? "3"),
  ),

  /// Independent promo-code program (see PROMO_CODES_PRODUCT_SPEC.md). When
  /// true: `?start=promo_<CODE>` deep-links attribute as `promo:<CODE>`, the
  /// richer promo wow screen shows in onboarding, and a new user is granted a
  /// Date Ticket + Premium months at that screen. No-op when off.
  PROMO_FEATURE_ENABLED: process.env.PROMO_FEATURE_ENABLED === "true",
  /// Reward a promo code grants when its own row leaves a value unset (also the
  /// `scripts/promo-codes.mjs` create defaults). Ticket = 1, Premium = 3 months.
  PROMO_DEFAULT_TICKETS: Math.max(0, Number(process.env.PROMO_DEFAULT_TICKETS ?? "1")),
  PROMO_DEFAULT_PREMIUM_MONTHS: Math.max(
    0,
    Number(process.env.PROMO_DEFAULT_PREMIUM_MONTHS ?? "3"),
  ),
  /// iOS deferred-deep-link attribution window: how long a landing-page
  /// fingerprint stays matchable to a first-launch claim. Default 60 min.
  PROMO_ATTRIBUTION_TTL_MIN: Math.max(
    1,
    Number(process.env.PROMO_ATTRIBUTION_TTL_MIN ?? "60"),
  ),
  /// Emergency escape hatch (default off). Surfaces a tiny "Have a promo code?"
  /// manual-entry field in onboarding on both clients — a pre-wired fallback for
  /// when the auto (iOS clipboard/fingerprint) attribution miss rate hurts.
  PROMO_MANUAL_ENTRY_ENABLED: process.env.PROMO_MANUAL_ENTRY_ENABLED === "true",
  /// App Store product URL the promo landing page (`GET /v1/promo/:code`)
  /// bounces an iOS visitor to after stashing the clipboard code + fingerprint.
  /// Empty → the landing shows the code + "open the app" copy without a redirect.
  ///
  /// Validated at load: the landing page interpolates this into an `href` and a
  /// `location.href` assignment, so a typo'd or hostile value would become
  /// stored XSS on a public page. A non-`https:` value is dropped to "" with a
  /// warning rather than rendered.
  PROMO_APP_STORE_URL: safeHttpsUrl(
    process.env.PROMO_APP_STORE_URL,
    "PROMO_APP_STORE_URL",
  ),

  /// Dev-only preview switch. When true, the `/previewlocation` bot command is
  /// live: it DMs the sender the venue location-picker Mini App button pointed
  /// at a throwaway match id, purely to eyeball the Location Mini App inside
  /// Telegram without driving a real match to `negotiating_venue`. Default off
  /// so it stays dark in production; enable only for a design-review session.
  DEV_MINIAPP_PREVIEW_ENABLED: process.env.DEV_MINIAPP_PREVIEW_ENABLED === "true",

  // ── Anti-spam / LLM token-budget protection ──────────────────
  /// Master flag for the per-user Telegram flood guard (Layer 1). When true
  /// (default), text/voice messages are rate-limited per user with the loose
  /// thresholds below — only a scripted flood trips them, never a human filling
  /// the questionnaire. Inline-button taps are never throttled. Drops happen
  /// before any LLM call or DB write, so this protects both OpenAI spend and
  /// `messageHistory`/`Message` bloat. Set "false" to disable entirely.
  BOT_RATE_LIMIT_ENABLED: process.env.BOT_RATE_LIMIT_ENABLED !== "false",
  /// Burst flood window — messages allowed per `BOT_FLOOD_BURST_WINDOW_MS`
  /// before drops kick in. 40/60s ≈ one message every 1.5s for a full minute,
  /// far above human typing.
  BOT_FLOOD_BURST_LIMIT: Number(process.env.BOT_FLOOD_BURST_LIMIT ?? "40"),
  BOT_FLOOD_BURST_WINDOW_MS: Number(process.env.BOT_FLOOD_BURST_WINDOW_MS ?? "60000"),
  /// Sustained flood window — messages allowed per
  /// `BOT_FLOOD_SUSTAINED_WINDOW_MS` (catches a slow grind under the burst cap).
  BOT_FLOOD_SUSTAINED_LIMIT: Number(process.env.BOT_FLOOD_SUSTAINED_LIMIT ?? "300"),
  BOT_FLOOD_SUSTAINED_WINDOW_MS: Number(
    process.env.BOT_FLOOD_SUSTAINED_WINDOW_MS ?? "3600000",
  ),
  /// Master flag for the per-user daily OpenAI token budget (Layer 2). When
  /// true (default), a user over `LLM_USER_DAILY_TOKEN_BUDGET` tokens in the
  /// rolling 24h window is gently told to come back tomorrow. Counted from the
  /// exact `usage.total_tokens` OpenAI returns (services/openai-fetch.ts).
  LLM_TOKEN_BUDGET_ENABLED: process.env.LLM_TOKEN_BUDGET_ENABLED !== "false",
  /// Per-user token ceiling per 24h. ~3–6× a heavy legit day; only abuse hits it.
  LLM_USER_DAILY_TOKEN_BUDGET: Number(
    process.env.LLM_USER_DAILY_TOKEN_BUDGET ?? "180000",
  ),
  /// Process-wide hourly token ceiling (Layer 3 global breaker). 0 (default)
  /// disables it; set a large value in prod as a coordinated-attack bill cap.
  /// When exceeded, user-facing LLM turns are deferred at the entry middlewares.
  LLM_GLOBAL_HOURLY_TOKEN_BUDGET: Number(
    process.env.LLM_GLOBAL_HOURLY_TOKEN_BUDGET ?? "0",
  ),

  // ── Demo mode (DEMO_MODE.md) ────────────────────────────────
  /// Master switch for the investor/friends demo runtime. **Production never
  /// sets this.** It is not a feature flag in the ordinary sense — it declares
  /// that this whole PROCESS is a demo: a separate bot token, a separate
  /// database, a separate port, a separate Mini App host. Every demo behavior
  /// in the codebase is gated on it, and `assertDemoIsolation()`
  /// (`demo/config.ts`) refuses to boot a demo process that is configured in a
  /// way which could reach real people or real money.
  ///
  /// It also makes this a non-production runtime for
  /// `identityTrustConfigurationErrors` below — demo deliberately waves the
  /// liveness verdict through, so it must be honest about that rather than
  /// pretending to satisfy the production identity gate.
  DEMO_MODE_ENABLED: process.env.DEMO_MODE_ENABLED === "true",
  /// How long the puppet partner "thinks" before answering, per step. Sized so
  /// the peer-wait shimmer (PRODUCT_SPEC §3.6b) is genuinely on screen and read
  /// — the action handlers start it immediately, so a visitor sees the real
  /// "waiting on your partner" beat rather than an instant robotic reply.
  DEMO_PEER_DELAY_MS: Math.max(
    1_000,
    Number(process.env.DEMO_PEER_DELAY_MS ?? "12000"),
  ),
  /// Driver poll interval. The driver re-derives whose turn it is from the match
  /// row on every tick rather than tracking state, so this is a pure latency
  /// knob. `0` disables the driver (the demo bot then behaves like a normal
  /// bot with no partner, useful for debugging onboarding alone).
  DEMO_TICK_MS: Math.max(0, Number(process.env.DEMO_TICK_MS ?? "3000")),

  // ── Dev-only: skip corporate-email OTP for specific Telegram IDs ──
  /// Comma-separated list of Telegram IDs that get a synthetic verified email
  /// at /start time, so the agent skips the email step entirely. Lets the
  /// developer onboard a SECOND test account without owning a second .edu
  /// address. MUST stay empty in production — the corporate-email gate is a
  /// core principle (PRODUCT_SPEC.md §Core Principles). Configured only in
  /// `.env.local`. The bot logs a loud warning at startup if non-empty.
  DEV_OTP_BYPASS_TELEGRAM_IDS: parseTelegramIdSet(process.env.DEV_OTP_BYPASS_TELEGRAM_IDS),
} as const;

export interface IdentityTrustConfiguration {
  OTP_LOG_TO_CONSOLE: boolean;
  DEV_OTP_BYPASS_TELEGRAM_IDS: ReadonlySet<bigint>;
  DEMO_MODE_ENABLED: boolean;
  MANDATORY_VERIFICATION_ENABLED: boolean;
  FACE_LIVENESS_ENABLED: boolean;
  LIVENESS_STS_ROLE_ARN: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  FACE_MATCH_PROVIDER: "rekognition" | "disabled";
  PROFILE_MEDIA_VALIDATION_ENABLED: boolean;
}

/**
 * Fail closed before a production-like bot starts accepting users or running
 * the weekly matcher. Vitest sets NODE_ENV=test; the supported local launcher
 * explicitly sets NODE_ENV=development and OTP_LOG_TO_CONSOLE=true. Every
 * other runtime is treated as production-like so a debug env flag or missing
 * NODE_ENV cannot silently disable the identity trust boundary.
 *
 * Demo mode (DEMO_MODE.md) is the third recognised non-production runtime. It
 * deliberately waves the liveness verdict through, so it must declare itself a
 * non-production runtime rather than pretend to satisfy this gate. That is only
 * safe because the exemption is not self-certifying: `assertDemoIsolation()`
 * (`demo/config.ts`) runs FIRST at boot and refuses a demo-flagged process that
 * still carries production's own settings. So flipping `DEMO_MODE_ENABLED=true`
 * in the production `.env` does not quietly disable identity verification — it
 * stops the process from starting at all, which is the failure mode we want.
 */
export function identityTrustConfigurationErrors(
  config: IdentityTrustConfiguration = env,
  runtime = process.env.NODE_ENV,
): string[] {
  if (runtime === "test") return [];
  if (runtime === "development" && config.OTP_LOG_TO_CONSOLE) return [];
  if (config.DEMO_MODE_ENABLED) return [];

  const errors: string[] = [];
  if (config.OTP_LOG_TO_CONSOLE) {
    errors.push("OTP_LOG_TO_CONSOLE must be false outside development");
  }
  if (config.DEV_OTP_BYPASS_TELEGRAM_IDS.size > 0) {
    errors.push("DEV_OTP_BYPASS_TELEGRAM_IDS must be empty outside development");
  }
  if (!config.MANDATORY_VERIFICATION_ENABLED) {
    errors.push("MANDATORY_VERIFICATION_ENABLED must be true");
  }
  if (!config.FACE_LIVENESS_ENABLED) {
    errors.push("FACE_LIVENESS_ENABLED must be true");
  }
  // Face Liveness has no sandbox/production key split to police (that was the
  // Persona-era `ALLOW_SANDBOX_PERSONA` escape hatch, now gone with the
  // provider). What it does need is real credentials and the role whose
  // short-lived grant lets a device stream its video — without either, the
  // verification CTA would open a Mini App that cannot start a check.
  for (const [name, value] of [
    ["AWS_ACCESS_KEY_ID", config.AWS_ACCESS_KEY_ID],
    ["AWS_SECRET_ACCESS_KEY", config.AWS_SECRET_ACCESS_KEY],
    ["LIVENESS_STS_ROLE_ARN", config.LIVENESS_STS_ROLE_ARN],
  ] as const) {
    if (!value) errors.push(`${name} must be configured`);
  }
  if (config.FACE_MATCH_PROVIDER !== "rekognition") {
    errors.push("FACE_MATCH_PROVIDER must be rekognition");
  }
  if (!config.PROFILE_MEDIA_VALIDATION_ENABLED) {
    errors.push("PROFILE_MEDIA_VALIDATION_ENABLED must be true");
  }
  return errors;
}

export function assertIdentityTrustConfiguration(
  config: IdentityTrustConfiguration = env,
  runtime = process.env.NODE_ENV,
): void {
  const errors = identityTrustConfigurationErrors(config, runtime);
  if (errors.length > 0) {
    throw new Error(
      `Unsafe identity verification configuration:\n- ${errors.join("\n- ")}`,
    );
  }
}

/**
 * Parse `TICKET_BUNDLE_STARS` ("<count>:<stars>,…") into a count→Stars map.
 * Falls back to the default (1→350, 3→830, 6→1350) when unset or fully invalid;
 * invalid individual pairs are skipped. Star amounts are whole XTR (not cents).
 */
function parseStarBundles(raw: string | undefined): Readonly<Record<number, number>> {
  const fallback: Record<number, number> = { 1: 350, 3: 830, 6: 1350 };
  if (!raw) return fallback;
  const out: Record<number, number> = {};
  for (const pair of raw.split(",")) {
    const [c, s] = pair.split(":");
    const count = Number((c ?? "").trim());
    const stars = Number((s ?? "").trim());
    if (Number.isInteger(count) && count > 0 && Number.isInteger(stars) && stars > 0) {
      out[count] = stars;
    }
  }
  return Object.keys(out).length > 0 ? out : fallback;
}

/** One rung of the referral milestone ladder (PRODUCT_SPEC §Referral). */
export interface ReferralLadderRung {
  /** Verified-friend count at which this rung's reward is granted. */
  atCount: number;
  /** Date Tickets granted to the referrer when this rung is reached. */
  tickets: number;
  /** Complimentary Premium months granted to the referrer at this rung. */
  months: number;
}

/**
 * Parse `REFERRAL_LADDER` ("<count>:<ticketsDelta>:<monthsDelta>,…") into a
 * count-sorted rung list. Falls back to the default ladder
 * (1→1/1, 3→1/1, 5→1/1, 10→2/2) when unset or fully invalid; invalid individual
 * rungs are skipped. Deltas are what the referrer gains AT that verified-friend
 * count (cumulative totals are 1/1, 2/2, 3/3, 5/5).
 */
function parseReferralLadder(raw: string | undefined): readonly ReferralLadderRung[] {
  const fallback: ReferralLadderRung[] = [
    { atCount: 1, tickets: 1, months: 1 },
    { atCount: 3, tickets: 1, months: 1 },
    { atCount: 5, tickets: 1, months: 1 },
    { atCount: 10, tickets: 2, months: 2 },
  ];
  if (!raw) return fallback;
  const out: ReferralLadderRung[] = [];
  for (const rung of raw.split(",")) {
    const [c, t, m] = rung.split(":");
    const atCount = Number((c ?? "").trim());
    const tickets = Number((t ?? "").trim());
    const months = Number((m ?? "").trim());
    if (
      Number.isInteger(atCount) &&
      atCount > 0 &&
      Number.isInteger(tickets) &&
      tickets >= 0 &&
      Number.isInteger(months) &&
      months >= 0 &&
      (tickets > 0 || months > 0)
    ) {
      out.push({ atCount, tickets, months });
    }
  }
  if (out.length === 0) return fallback;
  out.sort((a, b) => a.atCount - b.atCount);
  return out;
}

/**
 * Accept an operator-supplied URL only if it is a well-formed `https:` URL.
 *
 * Used for values that get interpolated into HTML we serve publicly, where a
 * `javascript:` scheme (or a value carrying a quote that breaks out of an
 * attribute) would turn a config typo into stored XSS. Returns "" and warns
 * rather than throwing — the affected surfaces all degrade gracefully when the
 * URL is absent, and refusing to boot over a cosmetic landing-page link would
 * be a worse trade.
 */
function safeHttpsUrl(raw: string | undefined, name: string): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  try {
    if (new URL(value).protocol === "https:") return value;
  } catch {
    // fall through to the warning below
  }
  console.warn(`[config] ${name} is not a valid https: URL — ignoring it.`);
  return "";
}

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
