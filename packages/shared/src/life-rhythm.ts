/**
 * Life rhythm — "Tempo Sync" (decision journal 2026-09-24, variant B).
 *
 * The iOS client reads 28 days of Apple Health STEP history (hourly buckets,
 * wheelchair pushes counted as steps), reduces it ON THE DEVICE, and sends
 * exactly two coarse tags plus how many days of data they rest on. Nothing
 * else ever leaves the phone: no step counts, no sleep, no workout types, no
 * timestamps finer than "the upload happened".
 *
 * Why two tags and not a vector: nine cells are robust to the noise a phone
 * step counter carries (a week of flu, a desk job, a car commute), nothing can
 * be reconstructed from them, and each is explainable to the person in one
 * sentence on their own "Твой темп" card. The obligations of health data stay
 * (GDPR Art. 9 — see `legal/`), but the harm of a leak is the smallest it can
 * be.
 *
 * What the tags are used for, and the ONLY things:
 *   1. ranking inside the venue sampling band (Tier 2, `venueTier2Multiplier`);
 *   2. a centred, tie-breaking multiplier in candidate scoring
 *      (`rhythmMultiplier`), shipped at weight 0 until the new privacy policy
 *      is published (`legal/privacy-policy.md` §6 promised the opposite).
 * The readers are fenced by `apps/bot/src/services/rhythm/boundary.test.ts`:
 * never a prompt, never the partner, never an admin per-user read.
 *
 * Pure and env-free, like `relationship-intent.ts`: the engine passes the
 * weights and decides whether a factor is live.
 */

import type { VenueFormat, VenueIntentV2 } from "./venue-intent.js";

/** Bumped when the on-device reduction changes meaning; stored per row. */
export const RHYTHM_ALGO_VERSION = 1 as const;
/** The history window the device reduces, in days. */
export const RHYTHM_WINDOW_DAYS = 28 as const;
/**
 * Days with step data required before a profile is sent at all. Below this a
 * week of illness or travel IS the profile, so the client sends nothing and
 * the person stays on the base algorithm — indistinguishable, on purpose, from
 * someone who declined Health access (iOS never tells an app which it was).
 */
export const RHYTHM_MIN_COVERAGE_DAYS = 10 as const;
/**
 * A profile not refreshed for this long is treated as absent everywhere, and
 * the nightly retention sweep deletes it. The client refreshes on foreground
 * at most daily, so only someone who stopped opening the iOS app — or moved to
 * the Telegram client for good — ever ages out.
 */
export const RHYTHM_STALE_AFTER_DAYS = 35 as const;

/**
 * Median daily steps over the covered days, bucketed on the device:
 *   calm      < 5 000
 *   moderate  5 000 – 9 999
 *   active    ≥ 10 000
 * Index IS the position on the axis — do not reorder.
 */
export const RHYTHM_ACTIVITY_LEVELS = ["calm", "moderate", "active"] as const;
/**
 * The hour the day's movement is centred on (midpoint of the 10 %–90 %
 * cumulative-steps window), median over free days (Saturday/Sunday) when there
 * are at least four, otherwise over all days:
 *   early         midpoint < 13:30
 *   intermediate  13:30 – 15:59
 *   late          ≥ 16:00
 * `null` when fewer than six days carry enough steps to place a midpoint.
 * Index IS the position on the axis — do not reorder.
 */
export const RHYTHM_CHRONOTYPES = ["early", "intermediate", "late"] as const;
/** Where the tags came from. A CoreMotion fallback would be a second value. */
export const RHYTHM_SOURCES = ["healthkit"] as const;
/**
 * Versions of the consent sheet the client may report. The text lives in the
 * iOS app; this list is what the server accepts, so an unknown version (a
 * client shipping new copy the policy does not cover yet) is refused rather
 * than silently recorded as consent to something nobody reviewed.
 */
export const RHYTHM_CONSENT_VERSIONS = ["2026-09-25"] as const;

export type RhythmActivity = (typeof RHYTHM_ACTIVITY_LEVELS)[number];
export type RhythmChronotype = (typeof RHYTHM_CHRONOTYPES)[number];
export type RhythmSource = (typeof RHYTHM_SOURCES)[number];
export type RhythmConsentVersion = (typeof RHYTHM_CONSENT_VERSIONS)[number];

/** The two tags, as every scorer reads them. */
export interface RhythmTags {
  activity: RhythmActivity;
  chronotype: RhythmChronotype | null;
}

/** `PUT /v1/me/rhythm` body, validated. */
export interface RhythmUpload extends RhythmTags {
  algoVersion: typeof RHYTHM_ALGO_VERSION;
  windowDays: typeof RHYTHM_WINDOW_DAYS;
  coverageDays: number;
  source: RhythmSource;
  consentVersion: RhythmConsentVersion;
}

export type RhythmUploadParse =
  | { ok: true; value: RhythmUpload }
  | { ok: false; error: string };

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/**
 * Strict: every field must arrive with its exact type (no `"12"` for 12), and
 * an unknown key is refused rather than ignored — a client that starts sending
 * raw step counts must fail loudly here, not have them quietly dropped while
 * it believes they are stored.
 */
export function parseRhythmUpload(body: unknown): RhythmUploadParse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "expected an object" };
  }
  const fields = body as Record<string, unknown>;
  const allowed = new Set([
    "algoVersion",
    "windowDays",
    "coverageDays",
    "activity",
    "chronotype",
    "source",
    "consentVersion",
  ]);
  const unknown = Object.keys(fields).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return { ok: false, error: `unknown field: ${unknown.sort().join(", ")}` };

  if (fields.algoVersion !== RHYTHM_ALGO_VERSION) {
    return { ok: false, error: `algoVersion must be ${RHYTHM_ALGO_VERSION}` };
  }
  if (fields.windowDays !== RHYTHM_WINDOW_DAYS) {
    return { ok: false, error: `windowDays must be ${RHYTHM_WINDOW_DAYS}` };
  }
  const coverage = fields.coverageDays;
  if (
    typeof coverage !== "number" ||
    !Number.isInteger(coverage) ||
    coverage < RHYTHM_MIN_COVERAGE_DAYS ||
    coverage > RHYTHM_WINDOW_DAYS
  ) {
    return {
      ok: false,
      error: `coverageDays must be an integer in [${RHYTHM_MIN_COVERAGE_DAYS}, ${RHYTHM_WINDOW_DAYS}]`,
    };
  }
  if (!oneOf(RHYTHM_ACTIVITY_LEVELS, fields.activity)) {
    return { ok: false, error: `activity must be one of ${RHYTHM_ACTIVITY_LEVELS.join(", ")}` };
  }
  // Absent means null: the iOS client's generated `Encodable` omits a nil
  // optional rather than writing `null`, and both say "could not be placed".
  const chronotype = fields.chronotype === undefined ? null : fields.chronotype;
  if (chronotype !== null && !oneOf(RHYTHM_CHRONOTYPES, chronotype)) {
    return {
      ok: false,
      error: `chronotype must be null or one of ${RHYTHM_CHRONOTYPES.join(", ")}`,
    };
  }
  if (!oneOf(RHYTHM_SOURCES, fields.source)) {
    return { ok: false, error: `source must be one of ${RHYTHM_SOURCES.join(", ")}` };
  }
  if (!oneOf(RHYTHM_CONSENT_VERSIONS, fields.consentVersion)) {
    return { ok: false, error: "unknown consentVersion" };
  }
  return {
    ok: true,
    value: {
      algoVersion: RHYTHM_ALGO_VERSION,
      windowDays: RHYTHM_WINDOW_DAYS,
      coverageDays: coverage,
      activity: fields.activity,
      chronotype: chronotype as RhythmChronotype | null,
      source: fields.source,
      consentVersion: fields.consentVersion,
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a profile synced at `syncedAt` still counts at `now`. */
export function isRhythmFresh(syncedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - syncedAt.getTime() <= RHYTHM_STALE_AFTER_DAYS * DAY_MS;
}

/** The oldest `syncedAt` that still counts at `now`. */
export function rhythmFreshCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - RHYTHM_STALE_AFTER_DAYS * DAY_MS);
}

/**
 * Narrow two stored strings back to tags, or `null` when either is not a value
 * this version knows (a row written by a newer algorithm, a hand edit). Unknown
 * is absent, never a guess.
 */
export function rhythmTagsFrom(
  activity: string | null | undefined,
  chronotype: string | null | undefined,
): RhythmTags | null {
  if (!oneOf(RHYTHM_ACTIVITY_LEVELS, activity)) return null;
  if (chronotype === null || chronotype === undefined) return { activity, chronotype: null };
  if (!oneOf(RHYTHM_CHRONOTYPES, chronotype)) return null;
  return { activity, chronotype };
}

// ---------------------------------------------------------------------------
// Matching — the centred multiplier
// ---------------------------------------------------------------------------

/** Share of the similarity carried by activity when both chronotypes are known. */
export const RHYTHM_ACTIVITY_SHARE = 0.6 as const;
export const RHYTHM_CHRONOTYPE_SHARE = 0.4 as const;
/**
 * Hard ceiling on the matching weight. At 0.1 the factor moves a score by at
 * most ±10 % — a tie-breaker between neighbours, never a reason to cross a
 * league (V_league alone spans ×0.05–×1). Anything louder would make "connect
 * Apple Health" a lever over who you meet, which is not what the person
 * consented to.
 */
export const RHYTHM_MATCH_WEIGHT_MAX = 0.1 as const;

/**
 * How alike two rhythms are, in [0, 1] (1 = same activity and chronotype).
 * `null` when EITHER side has no profile — the caller must then stay neutral.
 *
 *   sim = 1 − (0.6·dActivity + 0.4·dChronotype) / 2       both chronotypes known
 *   sim = 1 − dActivity / 2                                otherwise
 *
 * where each d is the distance between positions on its 3-point axis (0–2).
 * A missing chronotype drops the term rather than counting as a mismatch.
 */
export function rhythmSimilarity(
  a: RhythmTags | null | undefined,
  b: RhythmTags | null | undefined,
): number | null {
  if (!a || !b) return null;
  const dActivity = Math.abs(
    RHYTHM_ACTIVITY_LEVELS.indexOf(a.activity) - RHYTHM_ACTIVITY_LEVELS.indexOf(b.activity),
  );
  if (a.chronotype === null || b.chronotype === null) return 1 - dActivity / 2;
  const dChronotype = Math.abs(
    RHYTHM_CHRONOTYPES.indexOf(a.chronotype) - RHYTHM_CHRONOTYPES.indexOf(b.chronotype),
  );
  return 1 - (RHYTHM_ACTIVITY_SHARE * dActivity + RHYTHM_CHRONOTYPE_SHARE * dChronotype) / 2;
}

/**
 * The scoring multiplier, CENTRED on 1: `1 + w·(2·sim − 1)`, in `[1 − w, 1 + w]`.
 *
 * Centred on purpose, unlike `intentMultiplier`'s `[floor, 1]`: a factor that
 * can only damp pairs where BOTH sides have data makes connecting Apple Health
 * a pure loss against everyone who did not — the person who shared more would
 * be matched less. Centred, the expected effect of connecting is zero; it only
 * leans a person toward similar rhythms.
 *
 * Exactly 1 when similarity is unknown (either side has no profile — every
 * Telegram-only account) or the weight is 0 (the launch value). The weight is
 * clamped to `[0, RHYTHM_MATCH_WEIGHT_MAX]`.
 */
export function rhythmMultiplier(similarity: number | null, weight: number): number {
  if (similarity === null || !Number.isFinite(similarity)) return 1;
  const w = !Number.isFinite(weight) || weight <= 0 ? 0 : Math.min(weight, RHYTHM_MATCH_WEIGHT_MAX);
  if (w === 0) return 1;
  const sim = Math.min(1, Math.max(0, similarity));
  return 1 + w * (2 * sim - 1);
}

// ---------------------------------------------------------------------------
// Venues — Tier 2
// ---------------------------------------------------------------------------

/**
 * The rhythm a date is planned around: the CALMER of the two known profiles —
 * the same "protect the less comfortable one" rule as `0.6·min` in `pairFit`.
 * One side known → that side (a nearer entrance helps a calm person and costs
 * an active partner nothing they would notice). Neither → `null`, and Tier 2
 * does nothing.
 */
export function pairLeadActivity(
  a: RhythmTags | null | undefined,
  b: RhythmTags | null | undefined,
): RhythmActivity | null {
  const known = [a, b].filter((tags): tags is RhythmTags => Boolean(tags));
  if (known.length === 0) return null;
  return known
    .map((tags) => tags.activity)
    .reduce((calmer, next) =>
      RHYTHM_ACTIVITY_LEVELS.indexOf(next) < RHYTHM_ACTIVITY_LEVELS.indexOf(calmer) ? next : calmer,
    );
}

/** What Tier 2 reads about a venue. Every field may be unknown. */
export interface VenueTier2Facts {
  /** Walking metres from the nearest metro / rail entrance (OSM enrichment). */
  transitWalkM: number | null;
  /** A pedestrian street, park or embankment within a short walk (OSM). */
  pedestrianNearby: boolean | null;
  /** The venue's own format facets. */
  formats: readonly VenueFormat[];
}

/** Transit distances that read as "at the entrance" / "a real walk". */
export const TIER2_TRANSIT_NEAR_M = 400 as const;
export const TIER2_TRANSIT_FAR_M = 1200 as const;

/**
 * Did either person already say something about MOVEMENT (walk vs sit)? Then
 * their own words decide it — they are already in `pairFit` — and Tier 2 keeps
 * its hands off that dimension. An explicit wish always beats inferred data.
 */
export function pairChoseMovement(
  a: Pick<VenueIntentV2, "formats" | "experiences"> | null | undefined,
  b: Pick<VenueIntentV2, "formats" | "experiences"> | null | undefined,
): boolean {
  return [a, b].some(
    (intent) =>
      !!intent &&
      (intent.formats.includes("walking") ||
        intent.formats.includes("seated") ||
        intent.experiences.includes("walk_view")),
  );
}

function transitFit(walkM: number | null): number | null {
  if (walkM === null || !Number.isFinite(walkM)) return null;
  if (walkM <= TIER2_TRANSIT_NEAR_M) return 1;
  if (walkM >= TIER2_TRANSIT_FAR_M) return 0;
  return 1 - (walkM - TIER2_TRANSIT_NEAR_M) / (TIER2_TRANSIT_FAR_M - TIER2_TRANSIT_NEAR_M);
}

/**
 * How well a venue suits the pair's lead rhythm, in [0, 1]; 0.5 is neutral.
 *
 *   calm     — access (near a transit entrance) and a seated format;
 *   active   — somewhere to walk (a walking format, or a pedestrian street /
 *              park / embankment next door);
 *   moderate — neutral: nothing to lean on.
 *
 * Each dimension with no data contributes nothing (neutral), so an unenriched
 * catalog makes Tier 2 a no-op rather than a bias toward whichever rows happen
 * to carry data. `movementChosen` removes the movement dimension entirely.
 */
export function venueTier2Fit(
  lead: RhythmActivity | null,
  venue: VenueTier2Facts,
  movementChosen: boolean,
): number {
  if (lead === null || lead === "moderate") return 0.5;
  const parts: number[] = [];
  if (lead === "calm") {
    const access = transitFit(venue.transitWalkM);
    if (access !== null) parts.push(access);
    if (!movementChosen && venue.formats.includes("seated")) parts.push(1);
    else if (!movementChosen && venue.formats.includes("walking")) parts.push(0);
  } else {
    if (!movementChosen) {
      const walkable = venue.formats.includes("walking") || venue.pedestrianNearby === true;
      if (walkable) parts.push(1);
      else if (venue.pedestrianNearby === false) parts.push(0.25);
    }
  }
  if (parts.length === 0) return 0.5;
  return parts.reduce((sum, value) => sum + value, 0) / parts.length;
}

/**
 * Tier 2's effect on a venue's weight INSIDE the sampling band: centred on 1,
 * `1 + w·(2·fit − 1)`, `w` clamped to [0, 0.9] so the weight stays positive.
 * It never moves a venue into or out of the band — the band is decided on the
 * Tier 1 score alone — so an explicit wish cannot be overridden by more than
 * the band's own 5 %.
 */
export function venueTier2Multiplier(fit: number, weight: number): number {
  const w = !Number.isFinite(weight) || weight <= 0 ? 0 : Math.min(weight, 0.9);
  if (w === 0 || !Number.isFinite(fit)) return 1;
  const f = Math.min(1, Math.max(0, fit));
  return 1 + w * (2 * f - 1);
}
