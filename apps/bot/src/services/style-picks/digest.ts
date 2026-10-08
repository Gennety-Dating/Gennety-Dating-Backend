import { prisma } from "@gennety/db";
import {
  ARCHETYPES,
  STYLE_DIGEST_TEXT_MAX_CHARS,
  profilerQuestionById,
  type StylePicksDigest,
} from "@gennety/shared";
import { env } from "../../config.js";

/**
 * Vibe Check, step 1: the person, reduced to what a stylist needs — built
 * deterministically, no model involved (decision journal 2026-10-08).
 *
 * **What never gets in, and the tests hold it:** music of any provider (the
 * pinned tracks are display-only — the `ai-boundary.test.ts` guard; this
 * file does not even select them), the Elo / attractiveness score and its seed
 * details, the Health-derived rhythm, the name, contact details, photos and
 * every id. The photo-derived signal is the clothing `archetype` alone — a tag
 * the vision tagger already stored; no photo is ever sent for this.
 *
 * Places: the categories of venues the person actually went to on a date (the
 * date map's source, `Match.dateAttended*`), and — only while
 * `STYLE_PICKS_FREQUENT_PLACES_ENABLED` and the person's own opt-in are both
 * on — of their frequently visited catalog places. Categories and vibe tags,
 * never a venue name or a day.
 */

/** Profiler questions whose answers say something about style or life rhythm. */
export const STYLE_QUESTION_IDS = [
  "f_date_spots",
  "f_chronotype",
  "f_travel",
  "f_flowers",
  "m_passions",
  "m_sport",
  "m_chronotype",
  "m_friends_say",
  "m_travel",
] as const;

const ANSWER_MAX_CHARS = 120;
const ANSWERS_MAX = 5;
const LIST_MAX = 6;
const ITEM_MAX_CHARS = 40;
const PLACE_VIBES_MAX = 5;

/**
 * Anchor tags extracted from the vibe answers can say "music". It is the
 * person's own words, not a streaming service — but "music is out of every AI
 * input" is simpler to keep true than a distinction, so it is dropped.
 */
const DROPPED_ANCHORS = new Set(["music"]);

/** The raw rows a digest is built from — exactly what `loadStyleDigestSource` selects. */
export interface StyleDigestSource {
  gender: "male" | "female" | null;
  preference: "men" | "women" | "both" | null;
  age: number | null;
  profile: {
    appearanceTags: unknown;
    energyAxis: number | null;
    orientationAxis: number | null;
    socialRole: string | null;
    anchorTags: string[];
    hobbies: string[];
    psychologicalSummary: string | null;
  } | null;
  answers: Array<{ questionId: string; answerText: string | null }>;
  /** One entry per distinct place (attended date or frequent place). */
  places: Array<{ category: string; vibeTags: string[] }>;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

export function ageBand(age: number | null): string | null {
  if (age == null || !Number.isFinite(age) || age < 18) return null;
  if (age <= 21) return "18-21";
  if (age <= 25) return "22-25";
  if (age <= 30) return "26-30";
  if (age <= 35) return "31-35";
  return "36+";
}

function axisBand<T extends string>(value: number | null, low: T, mid: T, high: T): T | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value <= -0.25) return low;
  if (value >= 0.25) return high;
  return mid;
}

function archetypeOf(tags: unknown): string | null {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return null;
  const value = (tags as Record<string, unknown>).archetype;
  return typeof value === "string" && (ARCHETYPES as readonly string[]).includes(value) ? value : null;
}

function cleanList(values: string[], drop?: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = clip(raw, ITEM_MAX_CHARS);
    const key = value.toLowerCase();
    if (!value || seen.has(key) || drop?.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= LIST_MAX) break;
  }
  return out;
}

/** How many independent things the digest knows beyond gender. */
export function digestSignalCount(digest: StylePicksDigest): number {
  return [
    digest.archetype != null,
    digest.tempo != null || digest.focus != null,
    digest.anchors.length + digest.hobbies.length > 0,
    digest.about != null,
    digest.answers.length > 0,
    digest.places.length > 0,
  ].filter(Boolean).length;
}

/** Below this the picks would be generic — the route answers 204 instead. */
export const STYLE_DIGEST_MIN_SIGNALS = 2;

/**
 * Pure: rows → digest, or null when the profile is too thin for a personal
 * selection (no gender, or fewer than two signals).
 */
export function buildStyleDigest(source: StyleDigestSource): StylePicksDigest | null {
  if (!source.gender) return null;
  const profile = source.profile;

  const categoryCounts = new Map<string, number>();
  const vibeCounts = new Map<string, number>();
  for (const place of source.places) {
    categoryCounts.set(place.category, (categoryCounts.get(place.category) ?? 0) + 1);
    for (const vibe of place.vibeTags) vibeCounts.set(vibe, (vibeCounts.get(vibe) ?? 0) + 1);
  }
  const byCount = (a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0]);

  const answers: StylePicksDigest["answers"] = [];
  const wanted = new Set<string>(STYLE_QUESTION_IDS);
  for (const row of source.answers) {
    const text = row.answerText?.trim();
    if (!text || !wanted.has(row.questionId)) continue;
    const question = profilerQuestionById(row.questionId);
    if (!question) continue;
    answers.push({ question: question.text.en, answer: clip(text, ANSWER_MAX_CHARS) });
  }
  answers.sort((a, b) => a.question.localeCompare(b.question));

  const summary = profile?.psychologicalSummary?.trim();
  const digest: StylePicksDigest = {
    gender: source.gender === "male" ? "man" : "woman",
    lookingFor: source.preference,
    ageBand: ageBand(source.age),
    archetype: archetypeOf(profile?.appearanceTags),
    tempo: axisBand(profile?.energyAxis ?? null, "calm", "balanced", "energetic"),
    focus: axisBand(profile?.orientationAxis ?? null, "experience", "balanced", "connection"),
    socialRole: profile?.socialRole ? clip(profile.socialRole, ITEM_MAX_CHARS) : null,
    anchors: cleanList(profile?.anchorTags ?? [], DROPPED_ANCHORS),
    hobbies: cleanList(profile?.hobbies ?? []),
    places: [...categoryCounts.entries()].sort(byCount).map(([category, count]) => ({ category, count })),
    placeVibes: [...vibeCounts.entries()].sort(byCount).slice(0, PLACE_VIBES_MAX).map(([vibe]) => vibe),
    about: summary ? clip(summary, STYLE_DIGEST_TEXT_MAX_CHARS) : null,
    answers: answers.slice(0, ANSWERS_MAX),
  };
  return digestSignalCount(digest) >= STYLE_DIGEST_MIN_SIGNALS ? digest : null;
}

/** The rows, from the database. Returns null for an unknown user. */
export async function loadStyleDigestSource(
  userId: string,
): Promise<{ source: StyleDigestSource; language: string } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      gender: true,
      preference: true,
      age: true,
      language: true,
      frequentPlacesOptIn: true,
      profile: {
        select: {
          appearanceTags: true,
          energyAxis: true,
          orientationAxis: true,
          socialRole: true,
          anchorTags: true,
          hobbies: true,
          psychologicalSummary: true,
        },
      },
      profilerAnswers: {
        where: { questionId: { in: [...STYLE_QUESTION_IDS] }, skipped: false },
        select: { questionId: true, answerText: true },
      },
    },
  });
  if (!user) return null;

  const attended = await prisma.match.findMany({
    where: {
      venuePlaceId: { not: null },
      OR: [
        { userAId: userId, dateAttendedA: true },
        { userBId: userId, dateAttendedB: true },
      ],
    },
    select: { venuePlaceId: true },
    take: 50,
  });
  const placeIds = new Set(attended.map((m) => m.venuePlaceId).filter((id): id is string => !!id));

  if (env.STYLE_PICKS_FREQUENT_PLACES_ENABLED && user.frequentPlacesOptIn) {
    const visits = await prisma.userPlaceVisit.findMany({
      where: { userId },
      select: { placeId: true },
      distinct: ["placeId"],
      take: 50,
    });
    for (const visit of visits) placeIds.add(visit.placeId);
  }

  const places: StyleDigestSource["places"] = [];
  if (placeIds.size > 0) {
    // The catalog holds one row per university domain — dedupe by place id.
    const rows = await prisma.curatedVenue.findMany({
      where: { placeId: { in: [...placeIds] } },
      select: { placeId: true, category: true, vibeTags: true },
    });
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.placeId || seen.has(row.placeId)) continue;
      seen.add(row.placeId);
      places.push({ category: row.category, vibeTags: row.vibeTags });
    }
  }

  return {
    language: user.language ?? "en",
    source: {
      gender: user.gender,
      preference: user.preference,
      age: user.age,
      profile: user.profile,
      answers: user.profilerAnswers,
      places,
    },
  };
}
