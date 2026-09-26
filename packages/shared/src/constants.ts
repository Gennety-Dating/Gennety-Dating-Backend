export const APP_NAME = "Gennety Dating";

/** Allowed university email domains (extend as needed) */
export const ALLOWED_EMAIL_DOMAINS = [
  ".edu",
  ".ac.uk",
  ".edu.au",
  ".ac.jp",
  ".edu.cn",
  ".ac.in",
  ".edu.ua",
  ".edu.ru",
  "kpi.ua",
  "knu.ua",
  // Kharkiv universities whose student/corporate mail domains do not end in an
  // allowed suffix above. `isAllowedEmail` matches on `endsWith`, so each base
  // domain also admits student subdomains (e.g. `@student.karazin.ua`).
  "karazin.ua", // V. N. Karazin Kharkiv National University
  "kpi.kharkov.ua", // NTU "Kharkiv Polytechnic Institute" (KhPI)
  "nure.ua", // Kharkiv National University of Radio Electronics (NURE)
] as const;

/** OTP validity window in milliseconds (10 minutes) */
export const OTP_TTL_MS = 10 * 60 * 1000;

/** OTP digit length */
export const OTP_LENGTH = 6;

/**
 * Durable per-address budget for email codes over a rolling 24 hours.
 *
 * The in-memory limiters in front of the email rail are keyed on address + IP
 * and forget everything on restart, so on their own they bound one address
 * from one network, not one address. These two are counted from `EmailOtp`
 * rows inside the per-address advisory lock (`public/otp.ts`), which makes them
 * the ceiling that survives a restart and an IP pool.
 *
 * - `EMAIL_OTP_DAILY_CAP` — codes issued to one address. An honest person asks
 *   for one, occasionally two or three when mail is slow; ten is far above that
 *   and still stops a mailbox being bombed.
 * - `EMAIL_OTP_DAILY_FAILED_ATTEMPTS_CAP` — wrong guesses against one address,
 *   summed across its codes. Each code already dies after five, but a fresh code
 *   used to be one request away, so the per-code cap bounded nothing per day.
 *   Twenty typos a day is generous; twenty guesses at a six-digit code is a
 *   1-in-50,000 shot.
 */
export const EMAIL_OTP_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
export const EMAIL_OTP_DAILY_CAP = 10;
export const EMAIL_OTP_DAILY_FAILED_ATTEMPTS_CAP = 20;

/**
 * Anti-SMS-pumping ceilings for the phone rail (`services/phone-verification.ts`,
 * `public/rate-limit.ts`). Every send costs money, and the per-number limits
 * the rail already had do nothing against a script that walks through numbers.
 *
 * - `PHONE_OTP_IP_HOURLY_LIMIT` — code requests from one address across ALL
 *   numbers. A household or a carrier NAT legitimately shares one, hence not 3.
 * - `PHONE_OTP_GLOBAL_HOURLY_CAP` — codes sent product-wide in the last hour,
 *   counted durably from `PhoneOtp` rows. Sized well above launch-scale signup
 *   bursts; reaching it means pumping, not popularity, and it pages the founder.
 */
export const PHONE_OTP_IP_HOURLY_LIMIT = 10;
export const PHONE_OTP_GLOBAL_HOURLY_CAP = 100;
export const PHONE_OTP_GLOBAL_WINDOW_MS = 60 * 60 * 1000;

/**
 * Min/max photos allowed during onboarding.
 *
 * `MIN_PHOTOS` is a hard floor, and the ONE place it is written: the collector,
 * the photo stage, the photo managers, the verification pipeline's activation
 * gate, `/v1/me/photos`, the `ui_hint` contract and the onboarding state
 * endpoint all read it, so raising it moves every surface at once (a bound in
 * two places eventually disagrees with itself — the same rule the age/height
 * limits follow).
 *
 * Two consequences of ever changing it, both learned rather than guessed:
 * accounts that finished onboarding at the OLD minimum are never demoted —
 * `persistOutcome` writes `status` only when activating, so a legacy profile
 * stays `active` and simply cannot delete its way further down — and the value
 * must stay below `PHOTO_BONUS_TICKET_THRESHOLD`, or the bonus is earned by
 * clearing the mandatory floor and stops being a reward for anything.
 */
export const MIN_PHOTOS = 4;
export const MAX_PHOTOS = 10;

/**
 * How many times one face-match run re-scores when the profile photos changed
 * between its snapshot and its locked persist (audit A13-H12).
 *
 * A verdict is only ever written for the photo set it actually scored, so a
 * photo edit landing mid-run makes the run score the new set again with the
 * reference selfie it already holds. The bound exists for someone editing
 * photos continuously: past it the run parks the user in the retryable
 * `pending` state (reference recorded, so their next edit reruns normally)
 * instead of spending Rekognition calls in a loop.
 */
export const VERIFICATION_PHOTO_RACE_MAX_ATTEMPTS = 3;

/**
 * Profile-photo count that earns the one-time onboarding ticket bonus
 * (Date Ticket monetization, gated by `TICKET_FEATURE_ENABLED`). Reaching this
 * many face-validated photos grants +1 free ticket. This deliberately stays
 * below MAX_PHOTOS: the reward is earned at 6 photos, while users may keep
 * adding optional photos up to the 10-photo profile limit.
 */
export const PHOTO_BONUS_TICKET_THRESHOLD = 6;

/**
 * Registration v2 student loyalty: free Date Tickets granted once when a
 * university email is verified (the student track's welcome perk — the
 * general/phone track gets none). Gated by `TICKET_FEATURE_ENABLED`;
 * idempotent via the `student_bonus` TicketLedger claim.
 */
export const STUDENT_BONUS_TICKETS = 2;

/** Telegram Live Photo profile-media limits (Bot API 10.0) */
export const LIVE_PHOTO_MAX_DURATION_SECONDS = 10;
export const LIVE_PHOTO_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Profile video limits.
 *
 * The video is display-only: the bot stores its Telegram `file_id` and
 * re-sends it, so accepting and showing a large video has NO bot-side size cap
 * (Telegram hosts the file). The size ceiling only matters for the *safety
 * validation* path (`PROFILE_MEDIA_VALIDATION_ENABLED`), which downloads the
 * video via Bot API `getFile` — and the standard cloud Bot API `getFile`
 * refuses files over 20 MB.
 *
 * Raised to 100 MB (from 20 MB) because validation is currently off, so nothing
 * downloads the file. IMPORTANT: if `PROFILE_MEDIA_VALIDATION_ENABLED` is turned
 * on, videos between 20 MB and this ceiling will fail the `getFile` download
 * (rejected as "processing unavailable") unless the bot is pointed at a
 * self-hosted Telegram Bot API server, which raises the `getFile` limit to ~2 GB.
 */
export const PROFILE_VIDEO_MAX_DURATION_SECONDS = 60;
export const PROFILE_VIDEO_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
export const PROFILE_MEDIA_VALIDATION_VERSION = 1;
/**
 * Native-rail profile video (`POST /v1/me/video`, iOS). Tighter than the
 * Telegram ceiling above on purpose:
 * - 50 MB is the Bot API's upload cap for `sendVideo`/`sendMediaGroup` with a
 *   file body. A native video has no Telegram `file_id`, so the pitch sends its
 *   bytes; anything larger could never reach a Telegram partner.
 * - 3 s is a floor the bot never had: in the app the video is recorded with a
 *   button, and a sub-3-second clip is a mis-tap, not a pitch.
 */
export const PROFILE_VIDEO_NATIVE_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
export const PROFILE_VIDEO_NATIVE_MIN_DURATION_SECONDS = 3;

/** Profile media validation thresholds (upload-time gates). */
export const FACE_SIMILARITY_THRESHOLD = 0.6;
export const DUPLICATE_HASH_DISTANCE = 8;
export const VIDEO_FACE_PRESENCE_THRESHOLD = 0.25;
export const VIDEO_IDENTITY_MATCH_THRESHOLD = 0.5;
export const VIDEO_SAMPLE_TARGET_FRAMES = 12;

/**
 * Voice prompt bounds (VOICE_PROMPT_PRODUCT_SPEC.md).
 *
 * Unlike the profile video, this clip is not merely display-only: its
 * transcript reaches the matching embedding, and the audio itself plays inside
 * a pitch. So both ends of the duration range are product decisions rather than
 * platform limits.
 *
 * The FLOOR exists because anything under three seconds is a misfire — a
 * mis-held mic button, not an answer — and shipping one into a pitch reads as
 * a broken feature rather than as a short person.
 *
 * The CEILING is the listener's, not the recorder's. The copy asks for ~15
 * seconds; 30 is the spec's Hinge-parity bound (voice-prompts.md §5.2), restored
 * by founder decision 2026-09-14 after the first build had shipped 60 without a
 * journal entry. The native recorder stops itself here, so this is also the
 * longest clip a partner is ever asked to sit through. It is deliberately far
 * below `voiceHandler`'s own MAX_VOICE_DURATION_SEC (300), which bounds a
 * transcription request rather than a profile element, so the two must not be
 * conflated.
 *
 * The BYTE ceiling is a safety-path limit in the same sense as the profile
 * video's: the validation path downloads the clip via Bot API `getFile` (or
 * from our bucket, for a native upload), so it has to stay well inside the
 * 20 MB cloud limit. 2 MB is ~8x the worst case a 30-second Opus note or a
 * 32 kbps AAC clip actually produces, so it only ever catches something
 * pathological.
 */
export const VOICE_PROMPT_MIN_DURATION_SECONDS = 3;
export const VOICE_PROMPT_MAX_DURATION_SECONDS = 30;
export const VOICE_PROMPT_TARGET_DURATION_SECONDS = 15;
export const VOICE_PROMPT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

/**
 * Native voice-prompt commits (`POST /v1/me/voice-prompt`) per user per hour
 * (audit A13-L14). Every commit runs a Whisper transcription, text moderation,
 * a storage upload and an embedding refresh, so it is metered like the profile
 * video. Higher than the video's six because re-recording a 15-second answer a
 * few times until it sounds right is the ordinary way people use this screen.
 */
export const VOICE_PROMPT_UPLOADS_PER_HOUR = 10;

/**
 * Peaks in the precomputed waveform.
 *
 * Telegram draws its own waveform and ignores this entirely; it exists so the
 * native iOS player can render bars before a single audio byte is fetched.
 * Forty is what fits a full-width iOS row at a legible bar width — fewer reads
 * as a chart, more as noise.
 */
export const VOICE_PROMPT_WAVEFORM_BUCKETS = 40;

/**
 * Ticket store bundles for the pre-purchase Mini App. `priceCents` is the
 * TOTAL charged for the bundle; per-ticket price is `priceCents / count`.
 * These are the USD reference prices: the Telegram product sells bundles for
 * Stars (`TICKET_BUNDLE_STARS`) and iOS through StoreKit; the USD figures
 * price the famine discount and the demo / development no-charge shelf.
 *
 * The bundle totals are the single price less a STATED discount, rounded to the
 * cent — not a round per-ticket price whose discount fell out of the division.
 * The store's badge derives its percent from these numbers
 * (`storeBundles` in the Mini App), so they must round back to 20 and 35.
 *   1 ticket  — $8.49  ($8.49/ea)
 *   3 tickets — $20.37 ($6.79/ea, -20%)
 *   6 tickets — $33.12 ($5.52/ea, -35%)
 */
export const TICKET_BUNDLES = [
  { count: 1, priceCents: 849 },
  { count: 3, priceCents: 2037 },
  { count: 6, priceCents: 3312 },
] as const;

export type TicketBundleSize = (typeof TICKET_BUNDLES)[number]["count"];

/** Look up a bundle by its ticket count; null for an unknown size. */
export function ticketBundleFor(
  count: number,
): { count: number; priceCents: number } | null {
  return TICKET_BUNDLES.find((b) => b.count === count) ?? null;
}

/**
 * "Famine" single-ticket discount (Date Ticket monetization, gated by
 * `TICKET_FEATURE_ENABLED`). A one-time loyalty perk granted when a user is
 * eligible-but-unpaired for a second consecutive famine notice (no-match tier >=
 * `CADENCE.famineDiscountMinTier`, the only threshold the code reads). It
 * discounts a SINGLE ticket purchase — the date gate's `self` scope and the
 * store's "1 ticket" bundle — by `FAMINE_DISCOUNT_PCT`%, valid
 * `FAMINE_DISCOUNT_TTL_DAYS` days, consumed on the first such purchase. See
 * PRODUCT_SPEC.md §3.5b.
 */
export const FAMINE_DISCOUNT_PCT = 77;
export const FAMINE_DISCOUNT_TTL_DAYS = 30;

/**
 * D10 — pool exhaustion. Days without a dispatched match after which the
 * system pauses matching for a user instead of repeating the same famine DM
 * forever (`services/pool-exhaustion.ts`). A day-count, not a `CADENCE`
 * field: this many days means this many days regardless of whether batches
 * run weekly or daily — see DAILY_MATCHING_IMPLEMENTATION_PLAN.md §D10 for
 * the reasoning (an honest "the pool is empty right now" message plus a real
 * pause, not an indefinite escalating famine tier with no way out).
 *
 * 28, not the "e.g. 14" originally floated in planning, because `computeTier`
 * is denominated in `CADENCE.famineNoticeIntervalMs` — 7 days under BOTH the
 * `weekly` and the `daily` profile (match daily, apologise weekly) — so tier 2
 * (the discount threshold) sits at day 14 and tier 3 at day 21 whatever the
 * drop cadence. A pause threshold at 14 would fire at the exact same instant as
 * the discount and make tier 3 structurally unreachable (the pause would
 * always win the race, since it's checked first). 28 days lets every user
 * see the full existing ladder — tier 1 (day 7) -> tier 2 + discount (day
 * 14) -> tier 3 (day 21) — before the pause takes over where an unbounded
 * tier-3-forever loop used to be.
 */
export const FAMINE_PAUSE_AFTER_DAYS = 28;

/**
 * Version of the user-facing legal documents in force, stamped onto
 * `User.policyVersion` at the moment consent is recorded.
 *
 * GDPR Art. 7(1) puts the burden on us to demonstrate WHAT a user agreed to,
 * and `consentedAt` alone cannot do that once the documents change — a
 * timestamp proves only that something was accepted. The Terms and the Privacy
 * Policy share one version string because the consent screen accepts them with
 * a single checkbox; a document set that ever splits needs two columns, not a
 * looser value here.
 *
 * **Bump this whenever `legal/privacy-policy.md` or `legal/terms-of-service.md`
 * changes materially**, and publish the same version to the website.
 */
export const LEGAL_DOCS_VERSION = "2026-09-26";

/** Age boundaries */
export const MIN_AGE = 18;
export const MAX_AGE = 55;

/**
 * Height boundaries, in centimetres.
 *
 * One source of truth for FOUR readers that must agree or the product
 * contradicts itself: the collector's `height_out_of_range` validation, the
 * native client's `height_wheel` `ui_hint` bounds, the Telegram Mini App's
 * height drum (which reads them from `/v1/telegram-onboarding/state`), and the
 * concierge agent's `save_profile_data` tool.
 *
 * The fourth was missed when this constant was introduced and stayed a literal
 * — with WIDER bounds (120..230). A height of 135 written by the agent was
 * accepted and then unrepresentable: neither the iOS wheel nor the Mini App
 * drum could show it, it could not be chosen again, and the first profile edit
 * snapped it into range. A number nobody can re-enter is worse than a refusal.
 */
export const MIN_HEIGHT_CM = 140;
export const MAX_HEIGHT_CM = 220;

/** Edit profile length limits */
export const MAX_BIO_LENGTH = 500;
export const MAX_PARTNER_PREFERENCES_LENGTH = 500;
export const MAX_MAJOR_LENGTH = 100;

/**
 * Интересы: сколько штук и какой длины.
 *
 * Числа жили в ТРЁХ местах тремя разными наборами: публичный API отвергал
 * >10 и >50 жёстким 400, агент-консьерж молча резал до 12×48, iOS молча брал
 * первые 10. Разошлись не пределы, а последствия: консьерж записывал 12
 * интересов, человек открывал приложение, сохранял профиль — и два
 * исчезали навсегда. Комментарий в самом `ProfileModel` предупреждал, что
 * это единственное место, где можно молча испортить данные.
 *
 * Взяты числа публичного API: он контракт, его же держит iOS, и только
 * агент был выбросом. Соседние `MAX_BIO_LENGTH` / `MAX_MAJOR_LENGTH` лежат
 * здесь с самого начала — эти просто не доехали.
 */
export const MAX_HOBBIES = 10;
export const MAX_HOBBY_LENGTH = 50;

/** Phase 4: Date lifecycle timing */
/**
 * How many hours before the date the ice-breakers land, together with a
 * reminder that the date can still be cancelled (and its button).
 *
 * NOT a gate on cancelling: a `scheduled` date can be cancelled from the
 * moment it is booked (founder decision 2026-09-26 — nothing in the server or
 * either client ever blocked it before T-5h; only the copy said "the window is
 * open"). This number times a message and the venue-change cutoff, nothing else.
 */
export const DATE_ALERT_HOURS = 5;
/** How many hours before the date the safety reminder is sent to female users */
export const PRE_DATE_SAFETY_HOURS = 1.5;
/** How many hours before the date the "Wingman" insider tip is revealed */
export const PRE_DATE_WINGMAN_HOURS = 1.5;
/** How many hours after the date we send the feedback prompt */
export const FEEDBACK_DELAY_HOURS = 24;

/** Phase 4: Pre-date coordination timing (feature-flagged) */
/**
 * How many hours before the date the anonymous proxy chat opens for both sides
 * — for EVERY scheduled date (founder decision 2026-09-26: the T-3h
 * questionnaire that decided whether a pair got the chat, and offered to swap
 * Telegram handles instead, is gone).
 *
 * One hour rather than thirty minutes (2026-09-04): the window's job is "how
 * do we find each other", and an hour is the point at which someone starts
 * actually travelling, which is when "I'm running ten minutes late" becomes
 * worth saying.
 *
 * A side-effect worth naming: this pulls the `chat_open` Live Activity stage
 * off T-30m, where it used to land in the same tick as the spotter beat
 * (`DATE_DAY_SPOTTER_LEAD_MINUTES`) from a different sweep. The two now fire
 * half an hour apart, in the order `DateDayStage` declares them.
 */
export const PROXY_OPEN_HOURS = 1;
/** How many hours after the agreed time the anonymous proxy chat auto-closes */
export const PROXY_CLOSE_AFTER_HOURS = 2;
/** Max characters relayed per proxy message (matches the emergency-reason clamp) */
export const PROXY_MAX_MESSAGE_LEN = 1000;

/** Phase 3.7: Concierge venue negotiation (`negotiating_venue`) */
/**
 * The least runway a date may still have at the moment its venue is locked in
 * (`scheduled`). Checked by every venue finalizer and by the lapse sweep.
 *
 * The venue stage has no deadline of its own, while the calendar guard only
 * runs when the time is LOCKED. A pair that locked 13:30 at noon and confirmed
 * the venue at 14:00 was therefore scheduled for a date that had already
 * happened — the failure the calendar guard exists to prevent, one step later.
 * Such a pair goes back to the calendar with a fresh grid instead.
 *
 * Half an hour rather than hours, deliberately. The pre-date rails catch up on
 * any date still in the future (the safety brief fires inside its window, not
 * at an exact instant), so the lead only has to cover "can the pair still see
 * the card and get there". A longer lead would overrule the calendar's own
 * rule that a same-day slot a few hours out is legitimate (`MIN_SLOT_LEAD_MS`
 * in `handlers/matching/scheduler.ts`).
 */
export const VENUE_FINALIZE_MIN_LEAD_MS = 30 * 60 * 1000;
/**
 * How many `negotiating_venue` rows whose time has already run out one sweep
 * sends back to the calendar. Each costs two chat messages and a calendar
 * card per side, so a backlog drains over a few ticks rather than as a burst.
 */
export const VENUE_LAPSE_SWEEP_BATCH = 20;
/**
 * How many times Venue Intent V2 tries to select a venue on its own before it
 * stops retrying (a provider outage, or the selector itself throwing). After
 * the last attempt the row keeps no retry, the pair is told how to try again,
 * and the §3.5c stall ceiling owns the match from there.
 */
export const VENUE_SELECTION_MAX_ATTEMPTS = 3;
/**
 * Backoff between those attempts, in minutes, indexed by the attempt that just
 * failed (1st → 1 min, 2nd → 5 min, the rest → 15 min). A process restart does
 * not lose it: the due time is written to `venueSelectionNextRetryAt`.
 */
export const VENUE_SELECTION_RETRY_DELAYS_MINUTES: readonly number[] = [1, 5, 15];

/** Phase 3.7: Venue change (feature-flagged, female-exclusive one-shot) */
/**
 * Radius (km) around the original auto-assigned venue within which the
 * female may pick an alternative. The original venue is already the
 * fairness-balanced commute center, so a tight 3 km keeps each side's travel
 * time within ~±10–15 min and covers the nearest metro stops.
 */
export const VENUE_CHANGE_RADIUS_KM = 3;
/**
 * Wider radius (km) used for `premium`-tier venues only. The premium pool is
 * small and hand-picked — 18 distinct venues in Kyiv against 109 base — so a
 * flat 3 km leaves whole districts with only a handful of them in range (10 of
 * 18 from Podil, measured). The board pins `VENUE_CHANGE_PREMIUM_PINNED` + a
 * couple more, and it must fill those slots with DIFFERENT places; reaching a
 * little further is the honest way to do that. Base and `alternative` stay at
 * `VENUE_CHANGE_RADIUS_KM` — a slightly longer trip is a fair trade for the
 * nicer venue a user is deliberately choosing, not something to impose on the
 * default. See PRODUCT_SPEC.md §3.7b / §3.8.
 */
export const VENUE_CHANGE_PREMIUM_RADIUS_KM = 5;
/**
 * Hours the male has to accept/decline a proposed venue change before it
 * auto-expires. The effective deadline is `min(now + this, agreedTime -
 * DATE_ALERT_HOURS)` — the change must always resolve before the T-5h
 * ice-breaker / emergency window opens on the (possibly stale) venue.
 */
export const VENUE_CHANGE_TTL_HOURS = 12;
/**
 * How many venue changes may SETTLE on one date (PRODUCT_SPEC §3.7b). The board
 * used to close for good after the first one; two is "we picked, then we
 * reconsidered", which is a real thing couples do, without becoming a venue
 * carousel the partner gets a new card for every hour.
 *
 * A code constant rather than env on purpose: it is the ONLY thing bounding a
 * pair whose changes are free — a Premium subscriber, and every demo visitor
 * (DEMO_MODE.md settles the board free because Stars has no mock rail). For
 * everyone else the price is a second, softer bound, and the T-5h cutoff is a
 * third. A lapse costs nothing and does not count against this.
 */
export const VENUE_CHANGE_MAX_PER_DATE = 2;
// `VENUE_CHANGE_MIN_COMMENT_LEN` and `VENUE_CHANGE_MAX_COMMENT_LEN` were here
// and are gone (audit 2026-09-06, «мёртвая спецификация»).
//
// They described "the mandatory explanation comment the female must write" for
// a venue change. There is no such step: the implementation says so in as many
// words — "No free text anywhere — the board carries no comment channel" — and
// neither constant was read anywhere in the product.
//
// This file is read as the spec for these rules, so a constant here is a
// requirement, not a note. Leaving two that describe a step nobody built means
// the next edit builds against them.

/**
 * The venue-change lock-screen card (iOS `venue_change` Live Activity,
 * decision 2026-09-22).
 *
 * RESTART: iOS keeps a Live Activity active for at most 8 hours. A card that
 * still applies after this many hours is ended and push-started afresh, half an
 * hour inside the system cap so the replacement lands before the old one is
 * frozen. A board can stay open for days, so without this the card would go
 * dead mid-round while still claiming to be live.
 */
export const VENUE_CHANGE_ACTIVITY_RESTART_HOURS = 7.5;
/**
 * How long a card stays on the lock screen after its round RESOLVED (settled,
 * or an agreement lapsed) — long enough to read the outcome. A board that
 * merely closed is dismissed at once: there is nothing to read.
 */
export const VENUE_CHANGE_ACTIVITY_RESOLVED_DISMISS_MINUTES = 15;
/** Partner picks named on the card; the rest ride as a count. */
export const VENUE_CHANGE_ACTIVITY_PICK_NAMES_MAX = 3;
/**
 * Longest venue name put on the card. Names come from Google Places and can be
 * long; Apple drops a Live Activity payload over 4096 bytes WITHOUT an error,
 * so the worst case (five names, Cyrillic at two bytes a character) is capped
 * here and frozen by a test rather than trusted.
 */
export const VENUE_CHANGE_ACTIVITY_NAME_MAX_CHARS = 80;

/** Gennety Premium (§Premium, feature-flagged). */
/**
 * Telegram Stars subscription period, in seconds. Telegram Stars subscriptions
 * currently support ONLY a 30-day period, so this is fixed (not env-tunable).
 * The monthly price (Stars) is env-tunable (`PREMIUM_STARS`).
 */
export const PREMIUM_SUBSCRIPTION_PERIOD_SECONDS = 2_592_000;

/**
 * How close to the end of a live Telegram Stars subscription period the
 * pre-checkout stops refusing a second recurring purchase. A duplicate
 * subscription is refused because it would charge every month and buy nothing;
 * the refusal is lifted for this last stretch of the period so that, were
 * Telegram ever to route an auto-renewal of the SAME subscription through
 * pre-checkout, the renewal could never be the thing declined.
 */
export const PREMIUM_RENEWAL_CHECKOUT_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Promo codes are for NEW accounts (PROMO_CODES_PRODUCT_SPEC): the iOS deferred
 * claim attributes a code only within this long after the account was created
 * (and only before onboarding is completed). Wide enough for the landing page →
 * App Store → install → first launch trip, narrow enough that an existing
 * account cannot pick up a public code.
 */
export const PROMO_DEFERRED_CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Referrers the hourly held-reward sweep examines per tick. Rewards held back
 * by the daily velocity cap are released by this sweep (and by the referrer
 * opening their referral screen); the budget keeps one tick bounded.
 */
export const REFERRAL_RELEASE_SWEEP_BATCH = 200;

/**
 * Phase 1b: Profiler (PRODUCT_SPEC §Phase 1b). Timed batches of gender-specific
 * Q&A harvested after onboarding to fuel icebreakers and date-planning hints.
 * NOT an input to the matching algorithm. All values are deliberately exported
 * config (not hard-coded inside the scheduler) so product can tune cadence and
 * the icebreaker weighting without touching logic.
 */
/** Delay after onboarding completion before the first Profiler question fires. */
export const PROFILER_ENTRY_DELAY_MS = 10 * 60 * 1000;
/** Normal-mode batch size (spec allows 3–4; we send up to this many per window). */
export const PROFILER_BATCH_SIZE_NORMAL = 3;
/** Rush-mode batch size when a drop is inside `CADENCE.profilerRushWindowMs` (spec 1–2). */
export const PROFILER_BATCH_SIZE_RUSH = 2;
/** Local wall-clock hour of the morning batch window. */
export const PROFILER_MORNING_HOUR = 9;
/** Local wall-clock hour of the evening batch window. */
export const PROFILER_EVENING_HOUR = 18;
/** Max characters stored for a single free-text Profiler answer. */
export const PROFILER_MAX_ANSWER_LEN = 1000;
/**
 * How long an unanswered Profiler question stays "active" before the worker
 * treats the silence as an implicit skip and re-opens the schedule.
 *
 * Without this the Profiler dead-locks: a sent question sets
 * `profilerActiveQuestionId` and the dispatch sweep only picks users whose
 * active question is null, so one ignored question silences the Profiler for
 * that user forever.
 *
 * Sized to the daily window rhythm rather than to "maybe they'll answer
 * tomorrow": at a full day, one ignored morning question cost the user the
 * whole day of Profiler. At 6h an ignored morning question is reclaimed in
 * time for the evening window. A late genuine answer is not lost by the
 * shorter deadline — it lands through the reply-to path
 * (`profilerQuestionMessageId`), which does not depend on the question still
 * being active.
 */
export const PROFILER_STALL_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/**
 * How long plain text is *unconditionally* treated as the answer to the
 * question on screen.
 *
 * The real bound on capture is not this clock — it is that the window is
 * cleared the moment the user does anything else at all (a command, a menu tap,
 * another flow). That is what stops a question asked hours ago from swallowing
 * an unrelated message; a user who went off and did something has stated that
 * the question is no longer what they are talking about.
 *
 * Past this window, with nothing having happened since, the question is still
 * on screen and its Skip button still works, so plain text is still recorded —
 * unless it reads as a question aimed at the bot. Before that rule the 4.5 h
 * between this window and `PROFILER_STALL_TIMEOUT_MS` was a stretch where the
 * question looked answerable and was not: the text went to the concierge agent
 * and the question died at the stall sweep. See `shouldCaptureProfilerAnswer`.
 */
export const PROFILER_ANSWER_WINDOW_MS = 90 * 60 * 1000;
/**
 * Debounce window for free-text Profiler answers. People split one thought
 * across several messages ("люблю кино" + "и музыку"); without coalescing,
 * each message would be consumed as the answer to a *different* question and
 * would fire a new question in return. Mirrors the onboarding photo/context
 * batchers, which solve the same problem.
 */
export const PROFILER_ANSWER_DEBOUNCE_MS = 2500;
/**
 * Icebreaker / hint generation weighting (spec §5.3). `priority` weights
 * scale how much a partner's answer is emphasised; `penalty` coefficients
 * down-weight an answer when a pairwise incompatibility is detected. Hand-set
 * here, never inlined in the generator.
 */
export const PROFILER_PRIORITY_WEIGHTS: Record<"high" | "medium" | "low", number> = {
  high: 1.0,
  medium: 0.5,
  low: 0.2,
};
export const PROFILER_PENALTY_COEFFICIENTS = {
  /** Communication-style incompatibility between the pair. */
  commStyleMismatch: -0.8,
  /** Day-rhythm (lark/owl) incompatibility between the pair. */
  dayRhythmMismatch: -0.4,
};

/**
 * Max total characters accepted for a Magic-Prompt response. The cap bounds
 * session-row growth and stops abuse loops while leaving ample headroom for
 * the structured profile payload.
 */
export const MAX_DUMP_BUFFER_CHARS = 32_000;

/** History management — controls memory window sent to the LLM */
/** Max total messages to send to the LLM API in a single call (safety cap) */
export const MAX_HISTORY_FOR_API = 80;
/** When stored history exceeds this, old messages are summarized */
export const SUMMARIZE_THRESHOLD = 50;
/** Number of recent messages always preserved during summarization/truncation */
export const KEEP_RECENT_MESSAGES = 30;
/**
 * Max messages the menu agent keeps in `User.messageHistory` (A13-L9).
 *
 * The agent APPENDS each turn to the stored transcript and trims the oldest
 * past this cap. It is a storage bound, not a memory window: what is replayed
 * to the model is the far smaller 24 h / 12-message window in `menu-agent.ts`.
 * The column used to be overwritten with that window every turn, which erased
 * the onboarding transcript and every older agent turn the admin dialogs viewer
 * reads. Unbounded growth is not the answer either — the column rides every
 * agent turn's read and every row of the admin dialogs list — so it is capped.
 */
export const AGENT_STORED_HISTORY_MAX_MESSAGES = 200;

/**
 * How long a refund still owned by a sweep defers account deletion (A13-H14).
 *
 * Payment rows outlive the account, but the Telegram id a Stars refund is sent
 * to does not — so deleting while a refund is in flight would strand the money.
 * A younger refund makes deletion answer "try again later". One older than this
 * has failed for a week; that is an ops problem, and a person's erasure is not
 * held hostage to it: deletion proceeds and the founder gets the row ids.
 */
export const ACCOUNT_DELETION_REFUND_DEFER_DAYS = 7;

/**
 * How long a deleted account's safety tombstones (keyed hashes of its Telegram
 * id / phone / email, with its moderation status, strikes, and the link to
 * reports and blocks filed against it) are kept (A13-H14). Stated in the
 * privacy policy's retention table — change both together.
 */
export const SAFETY_TOMBSTONE_RETENTION_MONTHS = 24;

/**
 * How many chats' Telegram updates (and out-of-band chat work) may run at once
 * (A13-H9). Per-chat order is kept by the chat queue; this is the ceiling ACROSS
 * chats, so a burst queues for a slot instead of starting hundreds of agent
 * turns, Whisper calls and Prisma queries in one process at the same moment.
 * Sixteen is a deliberate middle: one slot was the outage (every chat waited
 * for the slowest), and the process shares one small database pool with the
 * public API and every cron.
 */
export const BOT_CONCURRENT_CHAT_TASKS = 16;

/**
 * How long a graceful shutdown waits for in-flight chat work, running cron
 * ticks and open HTTP requests before it exits anyway (A13-M21). Must stay below
 * PM2's `kill_timeout` for the process, or PM2 SIGKILLs the drain half-way.
 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000;

/**
 * A `proposed` match still carrying `dispatchedAt = null` this long after it was
 * created is treated as stranded by a dead dispatch (a crash or deploy mid-run)
 * and resumed (A13-H7). Half an hour clears every live path that creates a row
 * and dispatches it moments later (drop batch, Rematch), with room to spare.
 */
export const STRANDED_PROPOSAL_AFTER_MS = 30 * 60 * 1000;

/** Stranded proposals resumed per sweep — bounds one tick to minutes of pacing. */
export const STRANDED_PROPOSAL_SWEEP_BATCH = 100;

/**
 * How long after a drop its "no match" notice may still be sent (A13-H10,
 * A13-M22). The notice waits for the drop's dispatch and stops at quiet hours,
 * so it can legitimately finish the next morning; past a day it is no longer
 * news about THIS drop, and a pending run is dropped instead of retried. Also
 * the window in which a restarted process re-arms a notice it may have lost.
 */
export const NO_MATCH_NOTICE_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
