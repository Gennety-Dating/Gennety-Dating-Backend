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
  /// Server-owned onboarding fact collector. Enable in Development first;
  /// production can keep the legacy LLM-driven flow during staged rollout.
  ONBOARDING_FACT_COLLECTOR_ENABLED:
    process.env.ONBOARDING_FACT_COLLECTOR_ENABLED === "true",
  /// Registration v2: the sign-up fork + phone (Telegram one-tap) rail for the
  /// general track. Off (default) → the university-email gate is the only
  /// registration path and the bot ignores `message.contact` shares, exactly
  /// as before. Ship dark; flip at launch together with the fork Mini App.
  PHONE_AUTH_ENABLED: process.env.PHONE_AUTH_ENABLED === "true",
  /// Telegram Gateway (gateway.telegram.org) — PRIMARY delivery rail for the
  /// native app's phone verification codes (~$0.01/code, arrives as an
  /// official Telegram service message). Empty → Gateway is skipped and the
  /// Twilio SMS fallback below is the only rail.
  TELEGRAM_GATEWAY_TOKEN: process.env.TELEGRAM_GATEWAY_TOKEN ?? "",
  /// Twilio Verify — SMS FALLBACK for phone codes (numbers without Telegram,
  /// Gateway outages, or the user's explicit "send SMS instead"). All three
  /// must be set for the SMS rail to be available; no Twilio phone number is
  /// needed (Verify manages sending and code checking).
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ?? "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? "",
  TWILIO_VERIFY_SERVICE_SID: process.env.TWILIO_VERIFY_SERVICE_SID ?? "",
  /// Native iOS forced-update kill switch, served pre-auth by
  /// `GET /v1/app/config` as `minSupportedIosVersion`. A client build whose
  /// version compares lower must block behind an "update the app" screen.
  /// Empty (default) → no forced update. Set e.g. "1.2.0" only when an old
  /// build must be retired (broken contract, security issue).
  IOS_MIN_SUPPORTED_APP_VERSION: process.env.IOS_MIN_SUPPORTED_APP_VERSION ?? "",
  /// Registration v2: mandatory Persona liveness. On → the verification CTA
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
  /// pre-10.1 fallback. Empty → the plain glyph leads with no animation. Only
  /// consulted by explicit rich-draft demos.
  CUSTOM_EMOJI_THINKING_ID: process.env.CUSTOM_EMOJI_THINKING_ID ?? "",
  /// Optional per-step AIActions emoji ids for the multi-beat "thinking"
  /// sequences (https://t.me/addemoji/AIActions, 48 variants). Each leads one
  /// progress step instead of the single shared `CUSTOM_EMOJI_THINKING_ID`, so a
  /// sequence can show a distinct animated AI icon per beat (e.g. route → check →
  /// card → sparkle for the date-card render). Resolution order per step is
  /// `StatusStep.emojiId` → these slots → `CUSTOM_EMOJI_THINKING_ID` → plain
  /// glyph. Empty (default) → the step's plain Unicode glyph leads, no animation,
  /// so nothing breaks before ids are filled in. Source ids with the
  /// `list-ai-emojis` dev script. Only consulted by explicit rich-draft demos.
  CUSTOM_EMOJI_AI_ROUTE_ID: process.env.CUSTOM_EMOJI_AI_ROUTE_ID ?? "",
  CUSTOM_EMOJI_AI_VENUE_ID: process.env.CUSTOM_EMOJI_AI_VENUE_ID ?? "",
  CUSTOM_EMOJI_AI_CONFIRM_ID: process.env.CUSTOM_EMOJI_AI_CONFIRM_ID ?? "",
  CUSTOM_EMOJI_AI_CARD_ID: process.env.CUSTOM_EMOJI_AI_CARD_ID ?? "",
  CUSTOM_EMOJI_AI_SPARKLE_ID: process.env.CUSTOM_EMOJI_AI_SPARKLE_ID ?? "",
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
  /// Allowed browser origin(s) for the admin analytics dashboard
  /// (comma-separated). Defaults to empty — an unset/`*` value makes
  /// `admin/server.ts` deny cross-origin requests rather than echo a
  /// wildcard from an authenticated admin surface (audit M3). Set this to
  /// the concrete dashboard origin in production.
  ADMIN_DASHBOARD_ORIGIN: process.env.ADMIN_DASHBOARD_ORIGIN ?? "",

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
  /// Supabase Storage bucket for Aether Concierge multimodal chat attachments
  /// (user-uploaded images sent as part of a `/v1/chat/message` turn). Expected
  /// to be PRIVATE; the chat endpoint fetches signed URLs (5 min TTL) just
  /// long enough for the OpenAI vision call to dereference them.
  SUPABASE_CHAT_BUCKET: process.env.SUPABASE_CHAT_BUCKET ?? "chat-attachments",

  // ── Persona liveness / biometric verification (Phase 6.3) ────
  /// Master switch for the Persona step. Production-like processes fail closed
  /// at startup unless this and mandatory verification are enabled with live
  /// credentials. Local/test environments may still turn it off explicitly.
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
  /// Founder-approved escape hatch: lets a production-like process boot with a
  /// Persona SANDBOX key. Sandbox inquiries are test flows, not real KYC —
  /// every `verified` granted while this is on carries no identity guarantee
  /// and stays `verified` in the database after the flag is removed. The
  /// startup assertion logs a loud warning whenever the override is active.
  /// Only the sandbox-key check is waived; every other identity trust
  /// requirement still fails closed.
  ALLOW_SANDBOX_PERSONA: process.env.ALLOW_SANDBOX_PERSONA === "true",
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
  /// Unified photo/video validation. Strict upload-time validation is the
  /// product default; set explicitly to "false" only for local emergency tests.
  PROFILE_MEDIA_VALIDATION_ENABLED:
    process.env.PROFILE_MEDIA_VALIDATION_ENABLED !== "false",
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
  /// Telegram Stars (XTR) price of one settled venue change — one flat price
  /// for every path (agreed board pick, express). Env-tunable at launch.
  VENUE_CHANGE_STARS: Number(process.env.VENUE_CHANGE_STARS ?? "150"),

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
  MANDATORY_VERIFICATION_ENABLED: boolean;
  ENABLE_PERSONA_VERIFICATION: boolean;
  PERSONA_TEMPLATE_ID: string;
  PERSONA_ENVIRONMENT_ID: string;
  PERSONA_API_KEY: string;
  PERSONA_WEBHOOK_SECRET: string;
  ALLOW_SANDBOX_PERSONA: boolean;
  FACE_MATCH_PROVIDER: "rekognition" | "disabled";
  PROFILE_MEDIA_VALIDATION_ENABLED: boolean;
}

/**
 * Fail closed before a production-like bot starts accepting users or running
 * the weekly matcher. Vitest sets NODE_ENV=test; the supported local launcher
 * explicitly sets NODE_ENV=development and OTP_LOG_TO_CONSOLE=true. Every
 * other runtime is treated as production-like so a debug env flag or missing
 * NODE_ENV cannot silently disable the identity trust boundary.
 */
export function identityTrustConfigurationErrors(
  config: IdentityTrustConfiguration = env,
  runtime = process.env.NODE_ENV,
): string[] {
  if (runtime === "test") return [];
  if (runtime === "development" && config.OTP_LOG_TO_CONSOLE) return [];

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
  if (!config.ENABLE_PERSONA_VERIFICATION) {
    errors.push("ENABLE_PERSONA_VERIFICATION must be true");
  }
  for (const [name, value] of [
    ["PERSONA_TEMPLATE_ID", config.PERSONA_TEMPLATE_ID],
    ["PERSONA_ENVIRONMENT_ID", config.PERSONA_ENVIRONMENT_ID],
    ["PERSONA_API_KEY", config.PERSONA_API_KEY],
    ["PERSONA_WEBHOOK_SECRET", config.PERSONA_WEBHOOK_SECRET],
  ] as const) {
    if (!value) errors.push(`${name} must be configured`);
  }
  if (
    /^persona_sand/i.test(config.PERSONA_API_KEY) &&
    !config.ALLOW_SANDBOX_PERSONA
  ) {
    errors.push("PERSONA_API_KEY must be a production key, not persona_sand*");
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
  if (
    runtime !== "test" &&
    config.ALLOW_SANDBOX_PERSONA &&
    /^persona_sand/i.test(config.PERSONA_API_KEY)
  ) {
    console.warn(
      "⚠️  ALLOW_SANDBOX_PERSONA override active: Persona is running with a " +
        "SANDBOX key. Identity verification is a TEST flow, not real KYC — " +
        "every `verified` granted now has no identity guarantee and will " +
        "persist after switching to a production key. Remove the override " +
        "as soon as a live Persona key is configured.",
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
