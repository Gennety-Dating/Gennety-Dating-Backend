import { createHash } from "node:crypto";
import type { InlineKeyboardMarkup } from "grammy/types";
import { Prisma, prisma, type Theme } from "@gennety/db";
import {
  VENUE_AMBIENCES,
  VENUE_DIETARY_CONSTRAINTS,
  VENUE_EXPERIENCES,
  VENUE_FORMATS,
  VENUE_INTENT_PARSER_VERSION,
  VENUE_PRICE_LIMITS,
  VENUE_SELECTION_VERSION,
  DEFAULT_MARKET,
  defaultVenueGeoTolerance,
  defaultVenueHardConstraints,
  findMarketByCityKey,
  mapVibeTagsToFacets,
  isConfirmedVenueIntent,
  normalizeVenueIntent,
  rankVenueCandidates,
  resolveVenueBridge,
  t,
  venueContextMultiplier,
  venueExposureOf,
  type VenueGeoTolerance,
  type VenueAmbience,
  type VenueCandidateFacets,
  type VenueExperience,
  type VenueFormat,
  type VenueHardConstraints,
  type VenueIntentOrigin,
  type VenueIntentV2,
  type Language,
  type VenueRankCandidate,
} from "@gennety/shared";
import { env } from "../config.js";
import { fetchWeatherForecast } from "./weather.js";
import { midpoint, haversineDistanceKm, venueSearchRadiusMeters, commuteBoundingBox } from "./geo.js";
import { callOpenAIJson } from "./openai.js";
import {
  isValidVenueCategory,
  isVenueOpenAt,
  isOfferableVenueCategory,
  OFFERABLE_CATEGORY_FILTER,
} from "./curated-venue.js";
import {
  fetchPlacePhotoName,
  searchVenueCandidates,
  type RegularOpeningHours,
  type Venue,
  type VenueCandidate,
} from "./venue.js";
import { type VenueCategory } from "./vibe-parser.js";
import { runVenueFinalizationOnce } from "./venue-finalization-flight.js";
import { buildMiniAppUrl } from "./mini-app-url.js";
import { DEMO_MODE_ENABLED } from "../demo/config.js";
import {
  assertDepartureOrigin,
  marketView,
  resolveDepartureMarket,
  venueOriginRefusal,
  type MarketView,
  type VenueOriginRefusal,
} from "./venue-origin.js";
import { sendPushToUser } from "./push.js";
import { generateAndSaveWingmanHints } from "./wingman-hint.js";
import { notifyFounderVenueSelectionFailure } from "./founder-notify.js";
import { deliverScheduledConfirmation } from "./scheduled-confirmation.js";
import { applyInitialVenueConstraintPolicy, evaluateInitialVenuePolicy } from "./initial-venue-policy.js";
import { runStatusSequence } from "./ai-stream.js";
import { applyVenueDiversity, loadVenueUsage } from "./venue-diversity.js";
import { venueSearchSteps } from "./analysis-status.js";

/**
 * Hard ceiling on the in-chat venue-search status. The selector normally
 * resolves it explicitly; this only guards against an unexpected throw leaving
 * the held beat waiting forever.
 */
const VENUE_SEARCH_STATUS_MAX_MS = 45_000;

export type VenueIntentSide = "A" | "B";
export type VenueIntentStatus = "none" | "draft" | "confirmed";

interface InterpreterPayload {
  experiences: string[];
  ambiences: string[];
  formats: string[];
  confidence: number;
}

export interface ConfirmVenueIntentInput {
  experiences: VenueExperience[];
  ambiences: VenueAmbience[];
  formats: VenueFormat[];
  hardConstraints: VenueHardConstraints;
  origin: VenueIntentOrigin;
}

export interface VenueIntentStateResponse {
  intent: VenueIntentV2 | null;
  status: VenueIntentStatus;
  partnerSubmitted: boolean;
  suggestions: Array<Pick<VenueIntentV2, "experiences" | "ambiences" | "formats">>;
  selectionError: string | null;
  /**
   * The user's launched market (PRODUCT_SPEC §3.7). Both clients centre the map
   * on it and refuse a pin outside it before the user can confirm, so the
   * refusal lands on the screen that can still fix it rather than as a dead end
   * an hour later. `null` = do not gate (see `resolveDepartureMarket`).
   */
  market: MarketView | null;
  /**
   * Demo only: the visitor may genuinely be abroad, so the block card offers a
   * one-tap "drop the pin in the city" shortcut. The gate itself is NOT waived
   * — the shortcut simply produces a valid pin (DEMO_MODE.md).
   */
  demoMode?: true;
}

const INTERPRETER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["experiences", "ambiences", "formats", "confidence"],
  properties: {
    experiences: { type: "array", maxItems: 3, items: { type: "string", enum: VENUE_EXPERIENCES } },
    ambiences: { type: "array", maxItems: 3, items: { type: "string", enum: VENUE_AMBIENCES } },
    formats: { type: "array", maxItems: 3, items: { type: "string", enum: VENUE_FORMATS } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

const INTERPRETER_PROMPT = `Classify a user's desired public first-date experience into canonical IDs.
Return JSON only. Understand English, Russian, Ukrainian, German, Polish, slang, negation, and unusual formats.
experiences: ${VENUE_EXPERIENCES.join(", ")}
ambiences: ${VENUE_AMBIENCES.join(", ")}
formats: ${VENUE_FORMATS.join(", ")}
Do not infer dietary, accessibility, alcohol, indoor/outdoor requirements, or price limits: those are confirmed separately.
Never turn an unknown request into coffee_treats. Use surprise_me only when the user explicitly delegates the choice.`;

const PRIVATE_SETTING = /\b(hotel|motel|hostel|airbnb|sauna|banya|spa|massage|my place|your place|apartment|flat|dorm|room)\b/i;

/**
 * Rung 2 of the geo ladder (PRODUCT_SPEC §3.7). 12 km is the upper bound the
 * `maxCommuteKm` type already carries, so widening to it asks nothing of the
 * pair that the product did not already consider reasonable; the fairness delta
 * widens with it so a slightly lopsided trip is not what blocks the pass.
 */
const WIDENED_COMMUTE_KM = 12;
const WIDENED_FAIRNESS_KM = 5;

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function stripForLog(intent: VenueIntentV2): Prisma.InputJsonObject {
  return {
    experiences: intent.experiences,
    ambiences: intent.ambiences,
    formats: intent.formats,
    hardConstraints: asJson(intent.hardConstraints),
    parserConfidence: intent.parserConfidence,
    parserVersion: intent.parserVersion,
    state: intent.state,
  };
}

function rolloutBucket(matchId: string): number {
  return createHash("sha256").update(`venue-intent-v2:${matchId}`).digest().readUInt32BE(0) % 100;
}

export function venueIntentMode(matchId: string): "off" | "shadow" | "live" {
  if (!env.VENUE_INTENT_V2_ENABLED) return "off";
  const bucket = rolloutBucket(matchId);
  if (bucket < env.VENUE_INTENT_V2_ROLLOUT_PERCENT) return "live";
  if (bucket < Math.min(100, env.VENUE_INTENT_V2_ROLLOUT_PERCENT + env.VENUE_INTENT_V2_SHADOW_PERCENT)) return "shadow";
  return "off";
}

async function participant(matchId: string, userId: string) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      userAId: true,
      userBId: true,
      status: true,
      venueIntentA: true,
      venueIntentB: true,
      venueSelectionError: true,
    },
  });
  if (!match) return null;
  const side: VenueIntentSide | null = match.userAId === userId ? "A" : match.userBId === userId ? "B" : null;
  return side ? { match, side } : null;
}

function parseStored(value: Prisma.JsonValue | null): VenueIntentV2 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const normalized = normalizeVenueIntent(value as unknown as VenueIntentV2);
    // Price is a product-owned initial-assignment policy, not a participant
    // constraint. Clearing legacy drafts here keeps both clients and the
    // finalizer deterministic during the compatibility window.
    normalized.hardConstraints = applyInitialVenueConstraintPolicy(normalized.hardConstraints);
    return normalized;
  } catch {
    return null;
  }
}

export async function getVenueIntentState(matchId: string, userId: string): Promise<VenueIntentStateResponse | null> {
  const own = await participant(matchId, userId);
  if (!own) return null;
  const intent = parseStored(own.side === "A" ? own.match.venueIntentA : own.match.venueIntentB);
  const partnerIntent = parseStored(own.side === "A" ? own.match.venueIntentB : own.match.venueIntentA);

  const recent = await prisma.match.findMany({
    where: {
      id: { not: matchId },
      OR: [{ userAId: userId }, { userBId: userId }],
      status: { in: ["scheduled", "completed"] },
    },
    orderBy: { updatedAt: "desc" },
    take: 6,
    select: { userAId: true, venueIntentA: true, venueIntentB: true, venueFitByA: true, venueFitByB: true },
  });
  const suggestions: VenueIntentStateResponse["suggestions"] = recent
    .filter((row) => (row.userAId === userId ? row.venueFitByA : row.venueFitByB) !== "no")
    .map((row) => parseStored(row.userAId === userId ? row.venueIntentA : row.venueIntentB))
    .filter((value): value is VenueIntentV2 => value?.state === "confirmed")
    .slice(0, 3)
    .map(({ experiences, ambiences, formats }) => ({ experiences, ambiences, formats }));
  if (suggestions.length === 0) {
    const onboarding = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        profile: { select: { fridayVibeText: true } },
        profilerAnswers: {
          where: { questionId: "f_date_spots", skipped: false },
          select: { answerText: true },
          take: 1,
        },
      },
    });
    for (const text of [onboarding?.profilerAnswers[0]?.answerText, onboarding?.profile?.fridayVibeText]) {
      const suggestion = onboardingSuggestion(text);
      if (suggestion) suggestions.push(suggestion);
    }
  }

  const market = await resolveDepartureMarket(userId);

  return {
    intent,
    status: intent?.state ?? "none",
    partnerSubmitted: partnerIntent?.state === "confirmed",
    suggestions,
    selectionError: scopedSelectionError(own.match.venueSelectionError, own.side),
    market: market ? marketView(market) : null,
    // Demo mode (DEMO_MODE.md): the flag has to travel over the wire because
    // the demo runs its own Mini App bundle built from this same source.
    ...(DEMO_MODE_ENABLED ? { demoMode: true as const } : {}),
  };
}

/** Conservative multilingual mapper for first-date suggestions; never a final selection. */
function onboardingSuggestion(text: string | null | undefined): VenueIntentStateResponse["suggestions"][number] | null {
  if (!text) return null;
  const value = text.toLocaleLowerCase();
  const experiences: VenueExperience[] = [];
  const ambiences: VenueAmbience[] = [];
  const formats: VenueFormat[] = [];
  const add = <T extends string>(list: T[], item: T): void => { if (!list.includes(item)) list.push(item); };
  if (/(coffee|café|cafe|кофе|кава|кафе|kaffee|kawa|desert|dessert|десерт)/u.test(value)) add(experiences, "coffee_treats");
  if (/(walk|park|promenade|прогул|парк|прогуля|spazier|spacer)/u.test(value)) { add(experiences, "walk_view"); add(formats, "walking"); }
  if (/(museum|gallery|art|музе|галер|искус|мистец|kunst|sztuk)/u.test(value)) add(experiences, "art_culture");
  if (/(restaurant|dinner|food|ужин|еда|вечеря|їжа|essen|kolacj|jedzen)/u.test(value)) add(experiences, "meal_discovery");
  if (/(bar|wine|cocktail|drink|бар|вино|коктей|wein|wino)/u.test(value)) add(experiences, "drinks_evening");
  if (/(game|bowling|quiz|игр|гра|spiel|kręgl|quiz)/u.test(value)) { add(experiences, "playful_activity"); add(formats, "interactive"); }
  if (/(quiet|calm|тих|спокой|спокій|ruhig|cich)/u.test(value)) add(ambiences, "quiet");
  if (/(cozy|уют|затиш|gemüt|przytul)/u.test(value)) add(ambiences, "cozy_public");
  if (/(lively|music|танц|музык|музик|lebhaft|musik|muzyk)/u.test(value)) add(ambiences, "lively");
  if (experiences.length === 0) return null;
  return { experiences: experiences.slice(0, 3), ambiences: ambiences.slice(0, 3), formats: formats.slice(0, 3) };
}

function scopedSelectionError(error: string | null, side: VenueIntentSide): string | null {
  if (!error?.startsWith("no_candidates:")) return error;
  const affected = error.split(":")[2];
  return !affected || affected.includes(side) ? error : null;
}

export async function interpretVenueIntent(
  matchId: string,
  userId: string,
  text: string,
  origin: VenueIntentOrigin | null = null,
): Promise<VenueIntentV2 | VenueOriginRefusal | null> {
  const own = await participant(matchId, userId);
  const rawText = text.trim();
  if (!own || own.match.status !== "negotiating_venue" || !rawText || rawText.length > 500) return null;

  // The departure-point gate (PRODUCT_SPEC §3.7). Checked on the DRAFT too, not
  // only on confirm: the draft's origin is what the Mini App restores on reopen
  // and what the legacy columns mirror, so letting a bad pin land here would
  // just move the refusal one screen later.
  if (origin) {
    const gate = await assertDepartureOrigin(userId, origin.lat, origin.lng);
    if (!gate.ok) return venueOriginRefusal(gate.market);
  }

  let payload: InterpreterPayload | null = null;
  if (!PRIVATE_SETTING.test(rawText)) {
    payload = await callOpenAIJson<InterpreterPayload>(INTERPRETER_PROMPT, rawText, {
      temperature: 0,
      maxTokens: 300,
      jsonSchema: { name: "venue_intent_v2", schema: INTERPRETER_SCHEMA as unknown as Record<string, unknown> },
    });
  }
  const now = new Date().toISOString();
  const draft = normalizeVenueIntent({
    rawText,
    experiences: (payload?.experiences ?? []) as VenueExperience[],
    ambiences: (payload?.ambiences ?? []) as VenueAmbience[],
    formats: (payload?.formats ?? []) as VenueFormat[],
    interpretedFacets: {
      experiences: (payload?.experiences ?? []) as VenueExperience[],
      ambiences: (payload?.ambiences ?? []) as VenueAmbience[],
      formats: (payload?.formats ?? []) as VenueFormat[],
    },
    hardConstraints: defaultVenueHardConstraints(),
    parserConfidence: payload?.confidence ?? 0,
    parserVersion: VENUE_INTENT_PARSER_VERSION,
    state: "draft",
    origin: origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng)
      ? { lat: origin.lat, lng: origin.lng, address: origin.address?.slice(0, 256) ?? null }
      : null,
    interpretedAt: now,
    confirmedAt: null,
    manualConfirmationRequired: payload == null || PRIVATE_SETTING.test(rawText),
  });

  // VENUE-1: never let a fresh interpret draft clobber an already-confirmed
  // intent — PRODUCT_SPEC states "ordinary Telegram messages cannot
  // overwrite it". The OpenAI call above takes 1-2s, so a naive "check the
  // state we read in `participant()`, then write" leaves a real race window
  // (a `confirm` call could land in that gap); take a row lock and re-check
  // immediately before the write instead, mirroring the lock+re-check idiom
  // used elsewhere in this codebase (e.g. `createProposedMatch`, the photo
  // delete handler in `public/routes/me.ts`).
  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      "SELECT id FROM matches WHERE id = $1::uuid FOR UPDATE",
      matchId,
    );
    const fresh = await tx.match.findUnique({
      where: { id: matchId },
      select: { venueIntentA: true, venueIntentB: true },
    });
    const currentRaw = own.side === "A" ? fresh?.venueIntentA ?? null : fresh?.venueIntentB ?? null;
    const current = parseStored(currentRaw);
    if (current?.state === "confirmed") {
      // Already locked in — echo it back unchanged rather than reverting to
      // a draft. The route's existing `if (!intent) 409` branch is unaffected
      // since this still returns a non-null intent.
      return current;
    }
    await tx.match.update({
      where: { id: matchId },
      data: own.side === "A" ? { venueIntentA: asJson(draft) } : { venueIntentB: asJson(draft) },
    });
    return draft;
  });
}

export async function confirmVenueIntent(
  matchId: string,
  userId: string,
  input: ConfirmVenueIntentInput,
  /**
   * `awaitFinalization: false` persists the confirmation and kicks the selector
   * in the BACKGROUND, so the caller's response returns in milliseconds.
   *
   * The Telegram Mini App uses it: the venue selector + card render take
   * seconds, and holding the HTTP response meant the Mini App sat open on a
   * spinner through the whole wait. The product wants the opposite — the app
   * closes the instant the user confirms, and the concierge narrates the search
   * with its status shimmer in the chat before the date card lands
   * (`finalizeVenueIntentV2`). iOS keeps the default `true`: its native flow
   * reads `selectionError` off this very response.
   */
  opts?: { awaitFinalization?: boolean },
): Promise<VenueIntentStateResponse | VenueOriginRefusal | null> {
  const own = await participant(matchId, userId);
  if (!own || own.match.status !== "negotiating_venue") return null;
  const draft = parseStored(own.side === "A" ? own.match.venueIntentA : own.match.venueIntentB);
  if (!draft) return null;
  const origin = input.origin;
  if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng) || Math.abs(origin.lat) > 90 || Math.abs(origin.lng) > 180) return null;
  // The departure-point gate (PRODUCT_SPEC §3.7) — the one write that actually
  // enters the pair into venue selection, so it is the one that must not be
  // bypassable by a stale bundle or a hand-rolled request.
  const gate = await assertDepartureOrigin(userId, origin.lat, origin.lng);
  if (!gate.ok) return venueOriginRefusal(gate.market);
  const confirmed = normalizeVenueIntent({
    ...draft,
    experiences: input.experiences,
    ambiences: input.ambiences,
    formats: input.formats,
    hardConstraints: applyInitialVenueConstraintPolicy(input.hardConstraints),
    origin: { lat: origin.lat, lng: origin.lng, address: origin.address?.slice(0, 256) ?? null },
    state: "confirmed",
    confirmedAt: new Date().toISOString(),
    manualConfirmationRequired: false,
  });
  const legacyCategory = experienceToLegacyCategory(confirmed.experiences[0]);
  await prisma.match.update({
    where: { id: matchId },
    data: own.side === "A"
      ? {
          venueIntentA: asJson(confirmed), vibeTextA: confirmed.rawText,
          vibeLatA: origin.lat, vibeLngA: origin.lng, vibeAddressA: origin.address,
          parsedCategoryA: legacyCategory,
        }
      : {
          venueIntentB: asJson(confirmed), vibeTextB: confirmed.rawText,
          vibeLatB: origin.lat, vibeLngB: origin.lng, vibeAddressB: origin.address,
          parsedCategoryB: legacyCategory,
        },
  });
  if (venueIntentMode(matchId) === "live") {
    if (opts?.awaitFinalization === false) {
      void tryFinalizeVenueIntentV2(matchId).catch((err) => {
        console.warn(`[venue-intent-v2] background finalization failed for ${matchId}:`, err);
      });
    } else {
      await tryFinalizeVenueIntentV2(matchId);
    }
  }
  return getVenueIntentState(matchId, userId);
}

/**
 * Load the actor's current V2 draft for the in-chat chip flow
 * (`handlers/matching/venue-intent-chat.ts`). Returns null when there is no
 * draft yet, the match isn't in venue negotiation, or the user isn't a
 * participant.
 */
export async function getVenueChatDraft(
  matchId: string,
  userId: string,
): Promise<{ side: VenueIntentSide; draft: VenueIntentV2 } | null> {
  const own = await participant(matchId, userId);
  if (!own || own.match.status !== "negotiating_venue") return null;
  const draft = parseStored(own.side === "A" ? own.match.venueIntentA : own.match.venueIntentB);
  return draft ? { side: own.side, draft } : null;
}

/**
 * Persist edited chip selections onto the actor's existing draft (in-chat
 * toggle). Mirrors interpret's lock+re-check so a concurrent `confirm` is never
 * clobbered: an already-confirmed intent is returned unchanged. State stays
 * `draft` — confirmation is a separate explicit step.
 */
export async function saveVenueChatDraft(
  matchId: string,
  userId: string,
  chips: { experiences: VenueExperience[]; ambiences: VenueAmbience[]; formats: VenueFormat[] },
): Promise<VenueIntentV2 | null> {
  const own = await participant(matchId, userId);
  if (!own || own.match.status !== "negotiating_venue") return null;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe("SELECT id FROM matches WHERE id = $1::uuid FOR UPDATE", matchId);
    const fresh = await tx.match.findUnique({
      where: { id: matchId },
      select: { venueIntentA: true, venueIntentB: true },
    });
    const current = parseStored(own.side === "A" ? fresh?.venueIntentA ?? null : fresh?.venueIntentB ?? null);
    if (!current || current.state === "confirmed") return current;
    const updated = normalizeVenueIntent({
      ...current,
      experiences: chips.experiences,
      ambiences: chips.ambiences,
      formats: chips.formats,
      state: "draft",
    });
    await tx.match.update({
      where: { id: matchId },
      data: own.side === "A" ? { venueIntentA: asJson(updated) } : { venueIntentB: asJson(updated) },
    });
    return updated;
  });
}

function experienceToLegacyCategory(experience: VenueExperience | undefined): "cafe" | "coffee_shop" | "restaurant" | "park" | "museum" | "lounge" {
  switch (experience) {
    case "coffee_treats": return "coffee_shop";
    case "meal_discovery": return "restaurant";
    case "walk_view": return "park";
    case "art_culture": return "museum";
    case "drinks_evening": return "lounge";
    default: return "cafe";
  }
}

function searchCategories(a: VenueIntentV2, b: VenueIntentV2): Array<"cafe" | "coffee_shop" | "restaurant" | "park" | "museum" | "lounge"> {
  const laneCategories = resolveVenueBridge(a, b).flatMap((lane) => {
    switch (lane) {
      case "coffee_scenic_walk": return ["coffee_shop", "park"] as const;
      case "gallery_bookstore_cafe": return ["museum", "cafe"] as const;
      case "food_near_promenade": return ["restaurant", "park"] as const;
      case "listening_gallery_bar": return ["lounge", "museum"] as const;
      case "activity_with_refreshments": return ["cafe", "museum"] as const;
      default: return [...a.experiences, ...b.experiences].map(experienceToLegacyCategory);
    }
  });
  // Drop categories the product does not offer before they reach the Places
  // fallback — otherwise an `art_culture` intent would still spend a search
  // call on museums and could surface one that the curated path excludes.
  // `cafe` backstops the case where filtering empties the list.
  const offerable = [...new Set(laneCategories)].filter((category) => isOfferableVenueCategory(category));
  return (offerable.length > 0 ? offerable : (["cafe"] as const)).slice(0, 3);
}

/**
 * Build a candidate's facet vector.
 *
 * `tags` are canonical ids (`facetTags` + `hardCapabilities`); `vibeTags` are
 * the operator's free-text vocabulary, translated through
 * `mapVibeTagsToFacets`. Before that translation the venue side of the vibe was
 * almost empty — experiences came from `category` alone, so every cafe in the
 * city was indistinguishable on the axis the user actually chose from.
 *
 * The category-derived experiences stay as the floor (a cafe IS a coffee
 * place), with tags adding on top rather than replacing.
 */
function categoryFacets(category: string, tags: string[] = [], vibeTags: string[] = []): VenueCandidateFacets {
  const tagSet = new Set(tags);
  const fromVibe = mapVibeTagsToFacets(vibeTags);
  const experienceMap: Record<string, VenueExperience[]> = {
    cafe: ["coffee_treats", "conversation"], coffee_shop: ["coffee_treats", "conversation"],
    restaurant: ["meal_discovery", "conversation"], park: ["walk_view", "conversation"],
    museum: ["art_culture", "conversation"], lounge: ["drinks_evening", "conversation"],
  };
  return {
    experiences: [...new Set([
      ...(experienceMap[category] ?? ["conversation"]),
      ...VENUE_EXPERIENCES.filter((v) => tagSet.has(v)),
      ...fromVibe.experiences,
    ])],
    ambiences: [...new Set([...VENUE_AMBIENCES.filter((v) => tagSet.has(v)), ...fromVibe.ambiences])],
    formats: [...new Set([...VENUE_FORMATS.filter((v) => tagSet.has(v)), ...fromVibe.formats])],
    dietary: VENUE_DIETARY_CONSTRAINTS.filter((v) => tagSet.has(v)),
    alcoholFree: tagSet.has("alcohol_free") ? true : null,
    stepFree: tagSet.has("step_free") ? true : null,
    // `setting` gates a HARD constraint, so it stays sourced from the
    // deterministic capability tags only — never from a soft vibe word.
    setting: tagSet.has("indoor") && tagSet.has("outdoor") ? "both" : tagSet.has("indoor") ? "indoor" : tagSet.has("outdoor") ? "outdoor" : null,
    price: VENUE_PRICE_LIMITS.find((v) => tagSet.has(v)) ?? null,
  };
}

/**
 * Is there enough evidence that this venue is OPEN at the agreed slot?
 *
 * Fails closed on unknown hours, which is the opposite of `isVenueOpenAt` — it
 * answers "does the recorded schedule exclude this instant", so no schedule
 * means yes. Both are right for their own caller: the paid venue-change board
 * offers a venue the couple is choosing with their eyes open, while this picks
 * one FOR them, sight unseen, and "we have no idea when it is open" is not a
 * good enough basis for that.
 *
 * The consequence is that public space — a street, an embankment, a park —
 * needs an explicit mark, because Google publishes no hours for any of it.
 * `always_open` is the operator saying so (`scripts/CITY_EXPANSION_PLAYBOOK.md`
 * §0b), and it is the reason this is a named function rather than the two
 * inline conditions it replaced: unnamed, the rule was invisible, and six Kyiv
 * parks sat in the catalog looking healthy and were never once assigned.
 *
 * `operator_confirmed` is weaker on purpose — it clears the evidence bar but
 * still honours a recorded schedule, for a venue whose hours we trust but did
 * not get from Places.
 */
export function hoursEvidenceAdmits(
  row: {
    hoursConfidence: string | null;
    openingHours: unknown;
    utcOffsetMinutes: number | null;
  },
  agreedTime: Date,
): boolean {
  if (row.hoursConfidence === "always_open") return true;
  if (
    row.hoursConfidence !== "operator_confirmed" &&
    (!row.openingHours || row.utcOffsetMinutes == null)
  ) {
    return false;
  }
  return isVenueOpenAt(
    row.openingHours as RegularOpeningHours | null,
    row.utcOffsetMinutes,
    agreedTime,
  );
}

interface SelectionRecord {
  rank: VenueRankCandidate;
  name: string;
  address: string;
  lat: number;
  lng: number;
  mapsUri: string;
  source: "curated" | "places";
  /** Resolved venue category — feeds the scheduled-card blurb + busy-note. */
  category: VenueCategory;
  /**
   * The REAL Google Places id, or null. Distinct from `rank.placeId`, which
   * falls back to a synthetic `curated:<id>` so ranking can dedupe — that
   * synthetic value must never be sent to Places.
   */
  placeId: string | null;
  /**
   * Cover photo resource name. Places candidates carry one from the search
   * response; curated candidates start null and are resolved from `placeId`
   * once the venue is actually chosen (one request per scheduled date).
   */
  photoName: string | null;
}

function candidateFromPlaces(row: VenueCandidate, a: VenueIntentV2, b: VenueIntentV2): SelectionRecord | null {
  if (!row.placeId || row.lat == null || row.lng == null || !row.googleMapsUri) return null;
  if (!row.openingHours || row.utcOffsetMinutes == null) return null;
  const policy = evaluateInitialVenuePolicy({
    category: row.category,
    tier: "base",
    priceLevel: row.priceLevel,
    rating: row.rating,
    reviews: row.userRatingCount,
  });
  if (!policy.eligible) return null;
  const facts = categoryFacets(row.category);
  facts.price = policy.price;
  return {
    rank: {
      id: row.placeId, placeId: row.placeId, priority: 2, rating: row.rating,
      reviews: row.userRatingCount, evidenceConfidence: 0.8,
      distanceA: haversineDistanceKm(a.origin!, { lat: row.lat, lng: row.lng }),
      distanceB: haversineDistanceKm(b.origin!, { lat: row.lat, lng: row.lng }),
      facets: facts,
    },
    name: row.name, address: row.address, lat: row.lat, lng: row.lng,
    mapsUri: row.googleMapsUri, source: "places", category: row.category,
    placeId: row.placeId, photoName: row.photos[0] ?? null,
  };
}

function minimalRelaxation(a: VenueIntentV2, b: VenueIntentV2): { key: string; sides: string } {
  // The step-free / dietary / alcohol-free branches are gone with the chips
  // themselves (`applyInitialVenueConstraintPolicy`). They used to lead this
  // list, so the one relaxation the product suggested was almost always an
  // accessibility or religious requirement — the exact thing a user cannot
  // "just relax". What is left is the indoor/outdoor setting.
  //
  // The old `commute_12_km` fallback is gone with the geo ladder (§3.7): the
  // selector now widens the commute itself, so distance can no longer be the
  // reason a run found nothing, and suggesting it would send the user to look
  // for a control that would not have helped. `vibe` is the honest catch-all —
  // neither side pinned a setting, so what is left is simply the combination
  // of what they asked for.
  if (a.hardConstraints.setting) return { key: a.hardConstraints.setting, sides: "A" };
  if (b.hardConstraints.setting) return { key: b.hardConstraints.setting, sides: "B" };
  return { key: "vibe", sides: "AB" };
}

function chipCorrectionCount(intent: VenueIntentV2): number {
  if (!intent.interpretedFacets) return 0;
  const before = new Set([...intent.interpretedFacets.experiences, ...intent.interpretedFacets.ambiences, ...intent.interpretedFacets.formats]);
  const after = new Set([...intent.experiences, ...intent.ambiences, ...intent.formats]);
  return [...before].filter((id) => !after.has(id)).length + [...after].filter((id) => !before.has(id)).length;
}

export async function tryFinalizeVenueIntentV2(matchId: string): Promise<void> {
  return runVenueFinalizationOnce(matchId, () => finalizeVenueIntentV2(matchId));
}

/** Durable retry sweep; due timestamps survive process restarts. */
export async function retryDueVenueSelections(): Promise<number> {
  if (!env.VENUE_INTENT_V2_ENABLED) return 0;
  const due = await prisma.match.findMany({
    where: {
      status: "negotiating_venue",
      venueSelectionNextRetryAt: { lte: new Date() },
      venueSelectionAttempts: { lt: 3 },
    },
    orderBy: { venueSelectionNextRetryAt: "asc" },
    take: 10,
    select: { id: true },
  });
  for (const row of due) await tryFinalizeVenueIntentV2(row.id);
  return due.length;
}

async function finalizeVenueIntentV2(matchId: string): Promise<void> {
  const started = Date.now();
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true, status: true, agreedTime: true, venueIntentA: true, venueIntentB: true,
      userA: { select: { id: true, telegramId: true, platform: true, language: true, theme: true, universityDomain: true, profile: { select: { homeCityKey: true } } } },
      userB: { select: { id: true, telegramId: true, platform: true, language: true, theme: true, universityDomain: true, profile: { select: { homeCityKey: true } } } },
    },
  });
  if (!match || match.status !== "negotiating_venue" || !match.agreedTime) return;
  const a = parseStored(match.venueIntentA);
  const b = parseStored(match.venueIntentB);
  if (!a || !b || !isConfirmedVenueIntent(a) || !isConfirmedVenueIntent(b) || !a.origin || !b.origin) return;
  const originA = a.origin;
  const originB = b.origin;
  const mid = midpoint(originA, originB);
  // Both sides have confirmed and the search is about to run, so narrate the
  // wait in the chat exactly like the legacy concierge path does: a self-
  // replacing "picking the best spot" shimmer, its final beat held `until` the
  // selection settles, then torn down before the outcome (date card or the
  // relax notice) lands. This is what lets the Mini App close the instant the
  // user confirms — the wait belongs to the chat, not to a stuck web view.
  // Shadow mode must stay invisible, so it never opens a status.
  const liveRun = venueIntentMode(matchId) === "live";
  let settleSelection: () => void = () => {};
  const selectionSettled = new Promise<void>((resolve) => {
    settleSelection = resolve;
    // Fail-safe: an unexpected throw inside the selector below would otherwise
    // leave the held final beat waiting on a promise nobody resolves, stranding
    // the status message in the chat. Unref'd so it never holds the process up.
    setTimeout(resolve, VENUE_SEARCH_STATUS_MAX_MS).unref?.();
  });
  const statusRuns: Array<Promise<unknown>> = [];
  if (liveRun) {
    const statusApi = (await import("../public/server.js")).getBotApi();
    for (const user of [match.userA, match.userB]) {
      if (!statusApi || user.telegramId <= 0n) continue;
      if (user.platform !== "telegram" && user.platform !== "both") continue;
      statusRuns.push(
        runStatusSequence(
          statusApi,
          Number(user.telegramId),
          venueSearchSteps((user.language ?? "en") as Language),
          { until: selectionSettled, untilFromStepIndex: 3, rich: true },
        ).catch(() => undefined),
      );
    }
  }
  /** Tear the shimmer down and wait for it to clear the chat. Idempotent. */
  const endSearchStatus = async (): Promise<void> => {
    settleSelection();
    await Promise.all(statusRuns);
  };
  const cityKey = match.userA.profile?.homeCityKey ?? match.userB.profile?.homeCityKey ?? null;
  const universityDomain = match.userA.universityDomain ?? match.userB.universityDomain ?? null;
  // One forecast per run, not per candidate: every candidate sits in one city
  // at one hour. Started here so it overlaps the catalog query and the Places
  // calls instead of adding its own latency; awaited at the ranking step. It
  // resolves to null on any failure and never rejects, but the guard stays as
  // a belt-and-braces against an unhandled rejection killing the process.
  const weatherPromise = fetchWeatherForecast(mid.lat, mid.lng, match.agreedTime, cityKey).catch(() => null);
  // Geographic pre-filter. A venue has to sit within the commute limit of BOTH
  // origins, so the box is the intersection of the two circles (see
  // `commuteBoundingBox`). Without it the query returned the whole city and the
  // pair's actual location had no say in which venues were even considered —
  // the single biggest reason the same handful of places kept winning.
  //
  // The LADDER (PRODUCT_SPEC §3.7). The pair's own tolerance is rung 1 and is
  // what almost every run uses. Rungs 2 and 3 exist because the geometry used
  // to be able to fail outright: two people at opposite ends of one city are
  // more than `2 * commuteLimitKm` apart, the box comes back empty, and the
  // date died over arithmetic. The widest rung is the market radius, which the
  // departure-point gate guarantees BOTH origins sit inside, so a pair inside a
  // launched city can always be served.
  const cityRadiusKm = findMarketByCityKey(cityKey)?.radiusKm ?? DEFAULT_MARKET.radiusKm;
  const geoLadder: VenueGeoTolerance[] = [
    defaultVenueGeoTolerance(a, b),
    { commuteLimitKm: WIDENED_COMMUTE_KM, fairnessDeltaKm: WIDENED_FAIRNESS_KM },
    { commuteLimitKm: cityRadiusKm, fairnessDeltaKm: cityRadiusKm },
  ];
  // The catalog query is done ONCE, at the widest rung: the box is a cheap SQL
  // pre-filter and the exact per-rung checks run in `scoreVenueCandidate`, so
  // fetching wide and narrowing in memory costs one query instead of three.
  const widestKm = Math.max(...geoLadder.map((rung) => rung.commuteLimitKm));
  const commuteLimitKm = widestKm;
  const box = commuteBoundingBox(originA, originB, commuteLimitKm);
  const curated = box
    ? await prisma.curatedVenue.findMany({
        where: {
          active: true,
          tier: "base",
          // Categories the product does not offer at all (see
          // `EXCLUDED_VENUE_CATEGORIES`) — currently museums.
          category: { notIn: OFFERABLE_CATEGORY_FILTER },
          ...(cityKey ? { cityKey } : universityDomain ? { universityDomain } : {}),
          lat: { gte: box.minLat, lte: box.maxLat },
          lng: { gte: box.minLng, lte: box.maxLng },
        },
        orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
        // Sanity bound, not a working limit: the eligibility gates below (hours,
        // open-at-slot, price evidence, quality floor) are logic rather than SQL,
        // so anything a small cap dropped would never even be considered. This
        // was `take: 60`, which on the production Kyiv catalog left 20 usable
        // venues out of 186 eligible — a block of high-priority rows with no
        // price evidence ate the budget. No city catalog comes near 2000.
        take: 2000,
      })
    : // Origins more than 2x the commute limit apart: no venue can satisfy both,
      // so skip the query rather than run one that cannot return a usable row.
      [];
  const selections: SelectionRecord[] = curated.flatMap((row) => {
    if (!row.googleMapsUri) return [];
    if (!isValidVenueCategory(row.category)) return [];
    if (!hoursEvidenceAdmits(row, match.agreedTime!)) return [];
    const tags = [...row.facetTags, ...row.hardCapabilities];
    const facets = categoryFacets(row.category, tags, row.vibeTags);
    const policy = evaluateInitialVenuePolicy({
      category: row.category,
      tier: row.tier,
      priceLevel: row.priceLevel,
      priceTags: tags,
      rating: row.rating,
      reviews: row.userRatingCount,
    });
    if (!policy.eligible) return [];
    facets.price = policy.price;
    const affinity = !!row.universityDomain && row.universityDomain === match.userA.universityDomain && row.universityDomain === match.userB.universityDomain;
    return [{
      rank: {
        id: row.id, placeId: row.placeId ?? `curated:${row.id}`, priority: Math.max(1, row.priority - (affinity ? 1 : 0)),
        rating: row.rating, reviews: row.userRatingCount, evidenceConfidence: row.hoursConfidence === "operator_confirmed" ? 1 : 0.9,
        distanceA: haversineDistanceKm(a.origin!, { lat: row.lat, lng: row.lng }),
        distanceB: haversineDistanceKm(b.origin!, { lat: row.lat, lng: row.lng }), facets,
      },
      name: row.name, address: row.address, lat: row.lat, lng: row.lng,
      mapsUri: row.googleMapsUri, source: "curated" as const,
      category: row.category as VenueCategory,
      // Cover read straight off the row — the nightly re-validation cron writes
      // it. Null only for a row the scan has not reached, which is the one case
      // that still costs the Place Details request below (`!chosen.photoName`).
      placeId: row.placeId, photoName: row.photoRefs?.[0] ?? null,
    }];
  });
  // No `.slice()` here on purpose. It used to cut the eligible set to 20 by
  // LIST POSITION (`priority ASC, updatedAt DESC`), which meant the winner was
  // drawn from the same 20 city-wide venues for every pair, ordered by a column
  // the nightly revalidation cron churns. Ranking is pure CPU over plain
  // objects, so the whole eligible set is scored and the cap moved to `ranked`
  // below — a cap by SCORE rather than by position.

  // Read BEFORE the Places fallback appends to the same array, so the funnel
  // can tell "the curated catalog is thin here" apart from "Places carried the
  // run". Both are real states with completely different fixes.
  const curatedEligible = selections.length;

  let placesCalls = 0;
  let providerFailed = false;
  const apiKey = process.env.PLACES_API_KEY;
  // A null box means the origins are further apart than even the widest rung
  // can bridge, so no candidate from anywhere can satisfy both. Only reachable
  // for a pair the departure-point gate could not apply to (a legacy account
  // with no launched market); running the provider anyway spent real money on
  // a search whose every result the ranker was about to discard.
  if (apiKey && box) {
    const radiusMeters = venueSearchRadiusMeters(haversineDistanceKm(originA, originB));
    for (const category of searchCategories(a, b)) {
      placesCalls += 1;
      try {
        const rows = await searchVenueCandidates(apiKey, { lat: mid.lat, lng: mid.lng, category, keywords: [], radiusMeters }, true);
        for (const row of rows) {
          if (!isVenueOpenAt(row.openingHours, row.utcOffsetMinutes, match.agreedTime)) continue;
          const selection = candidateFromPlaces(row, a, b);
          if (selection) selections.push(selection);
        }
      } catch {
        providerFailed = true;
        break;
      }
    }
  } else {
    providerFailed = true;
  }
  // Dedupe only — the old `.slice(0, 30)` here had the same defect as the one
  // above: it truncated by position before anything was scored.
  const deduped = [...new Map(selections.map((row) => [row.rank.placeId, row])).values()];
  // Climb the ladder: the pair's own tolerance first, widening only when that
  // pass produced nothing at all. Everything except the two geographic caps is
  // identical on each rung, so a widened run is a longer trip, never a worse
  // venue. `geoRung` is 1-based and rides into the selection log and the reason
  // line, so "how often does the engine have to stretch?" is a query, not a
  // guess — if it stops being rare, the catalog is too thin for the city.
  const rankCandidates = deduped.map((row) => row.rank);
  let geoRung = 1;
  let ranked = rankVenueCandidates(rankCandidates, a, b, geoLadder[0]);
  while (ranked.length === 0 && geoRung < geoLadder.length) {
    geoRung += 1;
    ranked = rankVenueCandidates(rankCandidates, a, b, geoLadder[geoRung - 1]!);
  }
  if (geoRung > 1 && ranked.length > 0) {
    console.warn(
      `[venue-intent-v2] ${matchId}: no venue at the pair's own commute tolerance, widened to rung ${geoRung} (${geoLadder[geoRung - 1]!.commuteLimitKm} km)`,
    );
  }

  // Season + weather. A soft reorder among comparable venues, never a filter:
  // a rained-out park sinks a few places and stays selectable, because a wrong
  // forecast or a dead provider must not be able to withhold a venue. The
  // multiplier is clamped to [0.8, 1.1] inside `venueContextMultiplier`, so it
  // can reorder near-ties and nothing more.
  const weather = env.VENUE_SEASON_WEATHER_ENABLED ? await weatherPromise : null;
  const categoryById = new Map(deduped.map((row) => [row.rank.id, row.category]));
  // UTC is safe for the season lookup as long as slots stay in the afternoon
  // and every market sits east of UTC: the grid is 13:00–19:30 Kyiv local
  // (= 10:00–17:30 UTC), so the UTC calendar day always matches the local one.
  // A market WEST of UTC would break that — an evening slot there lands on the
  // next UTC day and, on four days a year, in the next month. Revisit here when
  // one launches; the fix is the pair's `Profile.timeZone`, not a wider clamp.
  const month = match.agreedTime.getUTCMonth() + 1;
  const contextFor = (candidate: VenueRankCandidate): number => {
    if (!env.VENUE_SEASON_WEATHER_ENABLED) return 1;
    const exposure = venueExposureOf(candidate.facets.setting, categoryById.get(candidate.id) ?? null);
    return venueContextMultiplier(exposure, candidate.facets.ambiences, month, weather);
  };

  // The selection funnel, frozen into the log below (VENUE_ENGINE_IMPROVEMENT_PLAN
  // part 6). Each number answers a different question when a pair gets a poor or
  // repeated venue: was the geo box empty, did the eligibility gates eat the
  // catalog, or did the ranker simply have one option?
  const poolSizes = {
    curatedInBox: curated.length,
    curatedEligible,
    placesAdded: selections.length - curatedEligible,
    ranked: ranked.length,
    // Which rung of the geo ladder actually produced `ranked` (1 = the pair's
    // own tolerance). Anything above 1 means their departure points were too
    // far apart for a normal pick — the case that used to fail outright.
    geoRung,
  };

  // Context is folded in and the list re-sorted ONCE, so both the diversity
  // path and the argmax fallback below read the same adjusted order. Applying
  // it only inside the diversity call would silently drop the multiplier on
  // exactly the runs where that layer bailed.
  const contextRanked = ranked
    .map((row) => ({ row, adjusted: row.score.finalScore * contextFor(row.candidate) }))
    .sort((left, right) => right.adjusted - left.adjusted);

  // Diversity layer. The ranker is deterministic, so on a stable catalog it
  // answers the same thing for every pair in the city — which is how a handful
  // of venues ended up carrying nearly every date. This picks between options
  // the ranker considers near-equal, never below them (see venue-diversity.ts).
  // Best-effort: a failure here must not cost the pair their date, so it falls
  // back to the plain argmax.
  let best = contextRanked[0]?.row;
  let diversityReason = "argmax-unfiltered";
  if (contextRanked.length > 0) {
    try {
      const usage = await loadVenueUsage({
        userAId: match.userA.id,
        userBId: match.userB.id,
        agreedTime: match.agreedTime,
        candidateIds: contextRanked.map(({ row }) => row.candidate.placeId),
      });
      const decision = applyVenueDiversity(
        contextRanked.map(({ row, adjusted }) => ({
          id: row.candidate.placeId,
          score: adjusted,
          // Fit is the ranker's own verdict and is deliberately NOT context-
          // adjusted: it gates the vibe floor, and weather has no bearing on
          // whether a venue matches what the pair asked for.
          pairFit: row.score.pairFit,
          row,
        })),
        usage,
        matchId,
      );
      if (decision.chosen) {
        best = decision.chosen.row;
        diversityReason = decision.reason;
      }
    } catch (error) {
      console.warn(`[venue-intent-v2] diversity layer failed for ${matchId}, using argmax:`, error);
    }
  }

  const chosen = best ? deduped.find((row) => row.rank.id === best.candidate.id) ?? null : null;
  const mode = venueIntentMode(matchId) === "shadow" ? "shadow" : "live";
  // The winner's cover normally comes free off the row (`photoRefs`, written by
  // the nightly cron), so this pays a Places request only for a venue the scan
  // has not reached yet. Done here, while the "picking the best spot" shimmer is
  // still up, so the wait is covered. Skipped in shadow mode (which assigns
  // nothing) and for Places rows (already photographed by the search).
  if (chosen && mode === "live" && !chosen.photoName) {
    chosen.photoName = await fetchPlacePhotoName(apiKey, chosen.placeId);
  }
  // The search is over: clear the "picking the best spot" shimmer BEFORE the
  // outcome so the chat never carries two live status messages (the date-card
  // render inside `deliverScheduledConfirmation` opens its own).
  await endSearchStatus();

  if (!chosen || !best) {
    const relaxation = minimalRelaxation(a, b);
    const failure = providerFailed && selections.length === 0
      ? "provider_unavailable"
      : `no_candidates:${relaxation.key}:${relaxation.sides}`;
    const current = await prisma.match.findUnique({ where: { id: matchId }, select: { venueSelectionAttempts: true } });
    const attempts = (current?.venueSelectionAttempts ?? 0) + 1;
    const delay = [1, 5, 15][Math.min(attempts - 1, 2)]!;
    await prisma.match.update({
      where: { id: matchId },
      data: {
        venueSelectionAttempts: attempts,
        venueSelectionError: failure,
        venueSelectionNextRetryAt: failure === "provider_unavailable" && attempts < 3 ? new Date(Date.now() + delay * 60_000) : null,
      },
    });
    await prisma.venueSelectionLog.create({ data: {
      matchId, mode, parserVersion: VENUE_INTENT_PARSER_VERSION, rankerVersion: VENUE_SELECTION_VERSION,
      intentA: stripForLog(a), intentB: stripForLog(b),
      // A failed run has no candidates but still has a funnel, and this is the
      // case where the funnel matters MOST: it separates "the geo box was
      // empty" from "the box was full and the hard filters ate everything".
      topCandidates: asJson({ candidates: [], poolSizes }),
      failureReason: failure, cityKey,
      latencyMs: Date.now() - started, placesCallCount: placesCalls,
      chipCorrections: chipCorrectionCount(a) + chipCorrectionCount(b),
    } });
    if (failure.startsWith("no_candidates") || attempts >= 3) {
      await notifyVenueIntentParticipants(match, failure);
    }
    // Both failure modes reach the founder now. `no_candidates` is terminal —
    // it schedules no retry — so a pair sits in `negotiating_venue` until the
    // §3.5c stall chain cancels them 48 h later. That is a live match about to
    // be lost, and it used to be visible only in the database.
    if (failure.startsWith("no_candidates") || attempts >= 3) {
      await notifyFounderVenueSelectionFailure(matchId, failure, attempts);
    }
    return;
  }

  await prisma.venueSelectionLog.create({ data: {
    matchId, mode, parserVersion: VENUE_INTENT_PARSER_VERSION, rankerVersion: VENUE_SELECTION_VERSION,
    intentA: stripForLog(a), intentB: stripForLog(b),
    topCandidates: asJson({
      candidates: ranked.slice(0, 5).map((row) => ({ placeId: row.candidate.placeId, score: row.score })),
      poolSizes,
    }),
    selectedSource: chosen.source, selectedPlaceId: chosen.rank.placeId, cityKey,
    latencyMs: Date.now() - started, placesCallCount: placesCalls,
    chipCorrections: chipCorrectionCount(a) + chipCorrectionCount(b),
  } });
  if (mode === "shadow") return;
  // Records the context multiplier only when it actually moved the winner, so
  // the reason line stays quiet on the common case (indoor venue, or the
  // feature off) and names the factor on the runs where it mattered.
  const chosenContext = contextFor(best.candidate);
  const contextNote = chosenContext === 1 ? "" : ` context ×${chosenContext.toFixed(2)};`;
  // Named only when it fired, like the context note above: rung 1 is the
  // ordinary case and does not deserve a line, while anything wider is the
  // single most useful fact about how this venue was chosen.
  const rungNote =
    geoRung === 1 ? "" : ` widened to ${geoLadder[geoRung - 1]!.commuteLimitKm} km (rung ${geoRung});`;
  const reason = `Pair intent: ${resolveVenueBridge(a, b).join(", ")}; verified fit ${(best.score.pairFit * 100).toFixed(0)}%; route imbalance ${Math.abs(chosen.rank.distanceA - chosen.rank.distanceB).toFixed(1)} km;${contextNote}${rungNote} pick ${diversityReason} of ${ranked.length}.`;
  const committed = await prisma.match.updateMany({
    where: { id: matchId, status: "negotiating_venue" },
    data: {
      status: "scheduled", venueName: chosen.name, venueAddress: chosen.address,
      venueLat: chosen.lat, venueLng: chosen.lng, venueMidpointLat: mid.lat, venueMidpointLng: mid.lng,
      venueGoogleMapsUri: chosen.mapsUri, venuePlaceId: chosen.rank.placeId,
      venueSource: chosen.source, venueSelectionVersion: VENUE_SELECTION_VERSION,
      venueSelectionConfidence: best.score.evidenceConfidence, venueSelectionReason: reason,
      venuePhotoName: chosen.photoName,
      venueSelectionError: null, venueSelectionNextRetryAt: null,
    },
  });
  if (committed.count === 0) return;
  generateAndSaveWingmanHints(matchId).catch((error) => {
    console.warn(`[venue-intent-v2] wingman generation failed for ${matchId}:`, error);
  });
  // Deliver the rich scheduled confirmation — the SAME date-card PNG + tappable
  // `date_time` entity + Maps/Change-venue keyboard + grounded venue blurb +
  // founder feed as the legacy concierge path (services/scheduled-confirmation.ts),
  // instead of a bare "venue ready + link" text. Telegram-only (the helper
  // no-ops mobile targets); any render failure degrades to text inside it, so
  // scheduling never wedges.
  const api = (await import("../public/server.js")).getBotApi();
  if (api) {
    const venueForCard: Venue = {
      name: chosen.name,
      address: chosen.address,
      googleMapsUri: chosen.mapsUri,
      lat: chosen.lat,
      lng: chosen.lng,
      photoName: chosen.photoName,
      rating: chosen.rank.rating ?? null,
      userRatingCount: chosen.rank.reviews ?? null,
      placeId: chosen.rank.placeId,
      source: chosen.source,
    };
    const keywords = [...new Set<string>([...a.experiences, ...b.experiences])];
    await deliverScheduledConfirmation(api, matchId, {
      venue: venueForCard,
      category: chosen.category,
      keywords,
    }).catch((error) => {
      console.warn(`[venue-intent-v2] scheduled confirmation failed for ${matchId}:`, error);
    });
  }
  // Mobile participants still get the lightweight push (the rich card is
  // Telegram-only); skip the redundant Telegram plain-text for `scheduled`
  // since deliverScheduledConfirmation already owns that surface.
  await notifyVenueIntentParticipants(
    match,
    "scheduled",
    { venueName: chosen.name, mapsUri: chosen.mapsUri },
    { telegram: false },
  );
}

type VenueIntentNotificationMatch = {
  id: string;
  userA: { id: string; telegramId: bigint; platform: string; language: string | null; theme?: Theme | null };
  userB: { id: string; telegramId: bigint; platform: string; language: string | null; theme?: Theme | null };
};

/**
 * The way back into the venue screen, attached to every non-scheduled outcome.
 * Built here rather than imported from `handlers/matching/venue-negotiation.ts`
 * to keep this service free of a handler import cycle; the URL builder is the
 * shared one, so the link carries the caller's current language + theme like
 * every other Mini App entry point.
 */
function buildVenueRetryKeyboard(
  matchId: string,
  lang: Language,
  theme: Theme,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      {
        text: t(lang, "venueConciergeBtnMap"),
        web_app: { url: buildMiniAppUrl("location", { lang, theme, query: { match: matchId } }) },
      },
    ]],
  };
}

const VENUE_NOTICE = {
  en: {
    scheduled: (name: string, uri: string) => `Your date spot is ready: ${name}\n${uri}`,
    no_candidates: "I couldn't find a verified place that matches what you both asked for. Reopen the venue screen and widen it a little — a different setting, or one fewer must-have.",
    provider_unavailable: "The venue provider is still unavailable after several retries. Your date is not scheduled yet; I'll keep the match safe and let the team know.",
  },
  ru: {
    scheduled: (name: string, uri: string) => `Место для свидания готово: ${name}\n${uri}`,
    no_candidates: "Не удалось найти проверенное место под то, что вы оба выбрали. Открой экран места и чуть расширь запрос — другой формат или на одно пожелание меньше.",
    provider_unavailable: "Сервис мест всё ещё недоступен после нескольких попыток. Свидание пока не назначено; матч остаётся в безопасном ожидании.",
  },
  uk: {
    scheduled: (name: string, uri: string) => `Місце для побачення готове: ${name}\n${uri}`,
    no_candidates: "Не вдалося знайти перевірене місце під те, що ви обоє обрали. Відкрий екран місця й трохи розшир запит — інший формат або на одне побажання менше.",
    provider_unavailable: "Сервіс місць досі недоступний після кількох спроб. Побачення ще не призначене; матч залишається в безпечному очікуванні.",
  },
  de: {
    scheduled: (name: string, uri: string) => `Euer Treffpunkt steht fest: ${name}\n${uri}`,
    no_candidates: "Ich konnte keinen verifizierten Ort finden, der zu euren beiden Wünschen passt. Öffne den Ortsbildschirm und mach die Auswahl etwas weiter - ein anderes Format oder ein Muss weniger.",
    provider_unavailable: "Der Ortsdienst ist nach mehreren Versuchen weiterhin nicht verfügbar. Das Date ist noch nicht geplant und das Match bleibt sicher in Wartestellung.",
  },
  pl: {
    scheduled: (name: string, uri: string) => `Miejsce na randkę jest gotowe: ${name}\n${uri}`,
    no_candidates: "Nie udało się znaleźć zweryfikowanego miejsca pasującego do tego, co oboje wybraliście. Otwórz ekran miejsca i poszerz nieco wybór - inny format albo o jedno wymaganie mniej.",
    provider_unavailable: "Usługa miejsc nadal jest niedostępna po kilku próbach. Randka nie została jeszcze zaplanowana, a dopasowanie bezpiecznie czeka.",
  },
} as const;

async function notifyVenueIntentParticipants(
  match: VenueIntentNotificationMatch,
  state: string,
  venue?: { venueName: string; mapsUri: string },
  opts?: { telegram?: boolean },
): Promise<void> {
  const api = (await import("../public/server.js")).getBotApi();
  const affected = state.startsWith("no_candidates:") ? state.split(":")[2] : null;
  await Promise.all([match.userA, match.userB].map(async (user, index) => {
    const side = index === 0 ? "A" : "B";
    if (affected && !affected.includes(side)) return;
    const locale = user.language && user.language in VENUE_NOTICE
      ? user.language as keyof typeof VENUE_NOTICE
      : "en";
    const copy = VENUE_NOTICE[locale];
    const text = state === "scheduled" && venue
      ? copy.scheduled(venue.venueName, venue.mapsUri)
      : state.startsWith("no_candidates")
        ? copy.no_candidates
        : copy.provider_unavailable;
    if (opts?.telegram !== false && api && user.telegramId > 0n && (user.platform === "telegram" || user.platform === "both")) {
      // A failure the user is asked to fix has to carry the way to fix it. The
      // notice used to be a bare `sendMessage` telling them to "reopen the
      // venue screen" — a screen whose only entry point had scrolled away by
      // then, since the concierge prompt is sent when the stage OPENS.
      const retry =
        state === "scheduled"
          ? {}
          : { reply_markup: buildVenueRetryKeyboard(match.id, locale, user.theme ?? "dark") };
      await api.sendMessage(Number(user.telegramId), text, retry).catch(() => undefined);
    }
    if (user.platform === "mobile" || user.platform === "both") {
      await sendPushToUser(user.id, {
        title: state === "scheduled" ? "Gennety · Venue ready" : "Gennety · Venue update",
        body: text,
        data: { type: "venue_intent", matchId: match.id },
      }).catch(() => false);
    }
  }));
}
