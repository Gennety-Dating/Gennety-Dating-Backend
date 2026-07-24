import { createHash } from "node:crypto";
import { Prisma, prisma } from "@gennety/db";
import {
  VENUE_AMBIENCES,
  VENUE_DIETARY_CONSTRAINTS,
  VENUE_EXPERIENCES,
  VENUE_FORMATS,
  VENUE_INTENT_PARSER_VERSION,
  VENUE_PRICE_LIMITS,
  VENUE_SELECTION_VERSION,
  defaultVenueHardConstraints,
  isConfirmedVenueIntent,
  normalizeVenueIntent,
  rankVenueCandidates,
  resolveVenueBridge,
  type VenueAmbience,
  type VenueCandidateFacets,
  type VenueExperience,
  type VenueFormat,
  type VenueHardConstraints,
  type VenueIntentOrigin,
  type VenueIntentV2,
  type VenueRankCandidate,
} from "@gennety/shared";
import { env } from "../config.js";
import { midpoint, haversineDistanceKm, venueSearchRadiusMeters } from "./geo.js";
import { callOpenAIJson } from "./openai.js";
import { isValidVenueCategory, isVenueOpenAt } from "./curated-venue.js";
import {
  searchVenueCandidates,
  type RegularOpeningHours,
  type Venue,
  type VenueCandidate,
} from "./venue.js";
import { type VenueCategory } from "./vibe-parser.js";
import { runVenueFinalizationOnce } from "./venue-finalization-flight.js";
import { sendPushToUser } from "./push.js";
import { generateAndSaveWingmanHints } from "./wingman-hint.js";
import { notifyFounderVenueSelectionFailure } from "./founder-notify.js";
import { deliverScheduledConfirmation } from "./scheduled-confirmation.js";
import { applyInitialVenueConstraintPolicy, evaluateInitialVenuePolicy } from "./initial-venue-policy.js";

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

  return {
    intent,
    status: intent?.state ?? "none",
    partnerSubmitted: partnerIntent?.state === "confirmed",
    suggestions,
    selectionError: scopedSelectionError(own.match.venueSelectionError, own.side),
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
): Promise<VenueIntentV2 | null> {
  const own = await participant(matchId, userId);
  const rawText = text.trim();
  if (!own || own.match.status !== "negotiating_venue" || !rawText || rawText.length > 500) return null;

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
): Promise<VenueIntentStateResponse | null> {
  const own = await participant(matchId, userId);
  if (!own || own.match.status !== "negotiating_venue") return null;
  const draft = parseStored(own.side === "A" ? own.match.venueIntentA : own.match.venueIntentB);
  if (!draft) return null;
  const origin = input.origin;
  if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng) || Math.abs(origin.lat) > 90 || Math.abs(origin.lng) > 180) return null;
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
  if (venueIntentMode(matchId) === "live") await tryFinalizeVenueIntentV2(matchId);
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
  return [...new Set(laneCategories)].slice(0, 3);
}

function categoryFacets(category: string, tags: string[] = []): VenueCandidateFacets {
  const tagSet = new Set(tags);
  const experienceMap: Record<string, VenueExperience[]> = {
    cafe: ["coffee_treats", "conversation"], coffee_shop: ["coffee_treats", "conversation"],
    restaurant: ["meal_discovery", "conversation"], park: ["walk_view", "conversation"],
    museum: ["art_culture", "conversation"], lounge: ["drinks_evening", "conversation"],
  };
  return {
    experiences: [...new Set([...(experienceMap[category] ?? ["conversation"]), ...VENUE_EXPERIENCES.filter((v) => tagSet.has(v))])],
    ambiences: VENUE_AMBIENCES.filter((v) => tagSet.has(v)),
    formats: VENUE_FORMATS.filter((v) => tagSet.has(v)),
    dietary: VENUE_DIETARY_CONSTRAINTS.filter((v) => tagSet.has(v)),
    alcoholFree: tagSet.has("alcohol_free") ? true : null,
    stepFree: tagSet.has("step_free") ? true : null,
    setting: tagSet.has("indoor") && tagSet.has("outdoor") ? "both" : tagSet.has("indoor") ? "indoor" : tagSet.has("outdoor") ? "outdoor" : null,
    price: VENUE_PRICE_LIMITS.find((v) => tagSet.has(v)) ?? null,
  };
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
  photoUrl: string | null;
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
    photoUrl: null, photoName: row.photos[0] ?? null,
  };
}

function minimalRelaxation(a: VenueIntentV2, b: VenueIntentV2): { key: string; sides: string } {
  const affected = (predicate: (hard: VenueHardConstraints) => boolean): string =>
    `${predicate(a.hardConstraints) ? "A" : ""}${predicate(b.hardConstraints) ? "B" : ""}`;
  const stepSides = affected((hard) => hard.stepFree);
  if (stepSides) return { key: "step_free", sides: stepSides };
  if (a.hardConstraints.dietary.length) return { key: a.hardConstraints.dietary[0]!, sides: "A" };
  if (b.hardConstraints.dietary.length) return { key: b.hardConstraints.dietary[0]!, sides: "B" };
  const alcoholSides = affected((hard) => hard.alcoholFree);
  if (alcoholSides) return { key: "alcohol_free", sides: alcoholSides };
  if (a.hardConstraints.setting) return { key: a.hardConstraints.setting, sides: "A" };
  if (b.hardConstraints.setting) return { key: b.hardConstraints.setting, sides: "B" };
  return { key: "commute_12_km", sides: "AB" };
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
      userA: { select: { id: true, telegramId: true, platform: true, language: true, universityDomain: true, profile: { select: { homeCityKey: true } } } },
      userB: { select: { id: true, telegramId: true, platform: true, language: true, universityDomain: true, profile: { select: { homeCityKey: true } } } },
    },
  });
  if (!match || match.status !== "negotiating_venue" || !match.agreedTime) return;
  const a = parseStored(match.venueIntentA);
  const b = parseStored(match.venueIntentB);
  if (!a || !b || !isConfirmedVenueIntent(a) || !isConfirmedVenueIntent(b) || !a.origin || !b.origin) return;
  const originA = a.origin;
  const originB = b.origin;
  const mid = midpoint(originA, originB);
  const cityKey = match.userA.profile?.homeCityKey ?? match.userB.profile?.homeCityKey ?? null;
  const universityDomain = match.userA.universityDomain ?? match.userB.universityDomain ?? null;
  const curated = await prisma.curatedVenue.findMany({
    where: {
      active: true,
      tier: "base",
      ...(cityKey ? { cityKey } : universityDomain ? { universityDomain } : {}),
    },
    orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
    // Read past temporarily ineligible/stale rows, then cap the eligible base
    // pool below. Invalid rows must not crowd good base venues out of ranking.
    take: 60,
  });
  const selections: SelectionRecord[] = curated.flatMap((row) => {
    if (!row.googleMapsUri) return [];
    if (!isValidVenueCategory(row.category)) return [];
    if (row.hoursConfidence !== "always_open" && row.hoursConfidence !== "operator_confirmed" && (!row.openingHours || row.utcOffsetMinutes == null)) return [];
    if (row.hoursConfidence !== "always_open" && !isVenueOpenAt(row.openingHours as RegularOpeningHours | null, row.utcOffsetMinutes, match.agreedTime!)) return [];
    const tags = [...row.facetTags, ...row.hardCapabilities];
    const facets = categoryFacets(row.category, tags);
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
      photoUrl: row.photoUrl, photoName: null,
    }];
  }).slice(0, 20);

  let placesCalls = 0;
  let providerFailed = false;
  const apiKey = process.env.PLACES_API_KEY;
  if (apiKey) {
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
  const deduped = [...new Map(selections.map((row) => [row.rank.placeId, row])).values()].slice(0, 30);
  const ranked = rankVenueCandidates(deduped.map((row) => row.rank), a, b);
  const best = ranked[0];
  const chosen = best ? deduped.find((row) => row.rank.id === best.candidate.id) ?? null : null;
  const mode = venueIntentMode(matchId) === "shadow" ? "shadow" : "live";

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
      intentA: stripForLog(a), intentB: stripForLog(b), topCandidates: [], failureReason: failure,
      latencyMs: Date.now() - started, placesCallCount: placesCalls,
      chipCorrections: chipCorrectionCount(a) + chipCorrectionCount(b),
    } });
    if (failure.startsWith("no_candidates") || attempts >= 3) {
      await notifyVenueIntentParticipants(match, failure);
    }
    if (failure === "provider_unavailable" && attempts >= 3) {
      await notifyFounderVenueSelectionFailure(matchId, failure, attempts);
    }
    return;
  }

  await prisma.venueSelectionLog.create({ data: {
    matchId, mode, parserVersion: VENUE_INTENT_PARSER_VERSION, rankerVersion: VENUE_SELECTION_VERSION,
    intentA: stripForLog(a), intentB: stripForLog(b),
    topCandidates: asJson(ranked.slice(0, 5).map((row) => ({ placeId: row.candidate.placeId, score: row.score }))),
    selectedSource: chosen.source, selectedPlaceId: chosen.rank.placeId,
    latencyMs: Date.now() - started, placesCallCount: placesCalls,
    chipCorrections: chipCorrectionCount(a) + chipCorrectionCount(b),
  } });
  if (mode === "shadow") return;
  const reason = `Pair intent: ${resolveVenueBridge(a, b).join(", ")}; verified fit ${(best.score.pairFit * 100).toFixed(0)}%; route imbalance ${Math.abs(chosen.rank.distanceA - chosen.rank.distanceB).toFixed(1)} km.`;
  const committed = await prisma.match.updateMany({
    where: { id: matchId, status: "negotiating_venue" },
    data: {
      status: "scheduled", venueName: chosen.name, venueAddress: chosen.address,
      venueLat: chosen.lat, venueLng: chosen.lng, venueMidpointLat: mid.lat, venueMidpointLng: mid.lng,
      venueGoogleMapsUri: chosen.mapsUri, venuePlaceId: chosen.rank.placeId,
      venueSource: chosen.source, venueSelectionVersion: VENUE_SELECTION_VERSION,
      venueSelectionConfidence: best.score.evidenceConfidence, venueSelectionReason: reason,
      venuePhotoUrl: chosen.photoUrl, venuePhotoName: chosen.photoName,
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
      photoUrl: chosen.photoUrl,
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
  userA: { id: string; telegramId: bigint; platform: string; language: string | null };
  userB: { id: string; telegramId: bigint; platform: string; language: string | null };
};

const VENUE_NOTICE = {
  en: {
    scheduled: (name: string, uri: string) => `Your date spot is ready: ${name}\n${uri}`,
    no_candidates: "I couldn't find a verified place that satisfies every required condition. Reopen the venue screen and relax the suggested condition.",
    provider_unavailable: "The venue provider is still unavailable after several retries. Your date is not scheduled yet; I'll keep the match safe and let the team know.",
  },
  ru: {
    scheduled: (name: string, uri: string) => `Место для свидания готово: ${name}\n${uri}`,
    no_candidates: "Не удалось найти проверенное место со всеми обязательными условиями. Откройте экран выбора места и ослабьте предложенное ограничение.",
    provider_unavailable: "Сервис мест всё ещё недоступен после нескольких попыток. Свидание пока не назначено; матч остаётся в безопасном ожидании.",
  },
  uk: {
    scheduled: (name: string, uri: string) => `Місце для побачення готове: ${name}\n${uri}`,
    no_candidates: "Не вдалося знайти перевірене місце з усіма обов'язковими умовами. Відкрийте екран місця й послабте запропоноване обмеження.",
    provider_unavailable: "Сервіс місць досі недоступний після кількох спроб. Побачення ще не призначене; матч залишається в безпечному очікуванні.",
  },
  de: {
    scheduled: (name: string, uri: string) => `Euer Treffpunkt steht fest: ${name}\n${uri}`,
    no_candidates: "Ich konnte keinen verifizierten Ort finden, der alle Pflichtbedingungen erfüllt. Öffne den Ortsbildschirm und lockere die vorgeschlagene Bedingung.",
    provider_unavailable: "Der Ortsdienst ist nach mehreren Versuchen weiterhin nicht verfügbar. Das Date ist noch nicht geplant und das Match bleibt sicher in Wartestellung.",
  },
  pl: {
    scheduled: (name: string, uri: string) => `Miejsce na randkę jest gotowe: ${name}\n${uri}`,
    no_candidates: "Nie udało się znaleźć zweryfikowanego miejsca spełniającego wszystkie wymagania. Otwórz ekran miejsca i poluzuj sugerowane ograniczenie.",
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
      await api.sendMessage(Number(user.telegramId), text).catch(() => undefined);
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
