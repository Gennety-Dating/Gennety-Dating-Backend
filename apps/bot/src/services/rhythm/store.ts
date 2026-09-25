import { prisma } from "@gennety/db";
import {
  rhythmFreshCutoff,
  rhythmTagsFrom,
  type RhythmTags,
  type RhythmUpload,
} from "@gennety/shared";
import { env } from "../../config.js";

/**
 * The ONE module that touches `user_rhythm_profiles` (Tempo Sync, decision
 * journal 2026-09-24). Everything else reads rhythm through the functions
 * below, and `boundary.test.ts` next to this file fails the build when a new
 * file starts reading it directly — or starts importing this module without
 * being on the allow-list.
 *
 * Two kinds of read, deliberately separate:
 *   - the OWNER's view (`readOwnRhythm`) — their own tags plus dates, for the
 *     "Твой темп" card in iOS Settings;
 *   - the SCORERS' view (`loadRhythmTags`) — tags only, keyed by user id, for
 *     the match engine and venue Tier 2. No dates, no coverage, no consent:
 *     a scorer has no use for them, so they are not handed out.
 *
 * Both treat a profile older than `RHYTHM_STALE_AFTER_DAYS` as absent.
 */

/** What the owner sees about their own rhythm. Never sent to anyone else. */
export interface OwnRhythmView {
  activity: RhythmTags["activity"];
  chronotype: RhythmTags["chronotype"];
  coverageDays: number;
  /** ISO time of the last sync, server clock. */
  syncedAt: string;
  /** ISO time the person first agreed to the current consent version. */
  consentedAt: string;
}

interface StoredRow {
  activity: string;
  chronotype: string | null;
  coverageDays: number;
  syncedAt: Date;
  consentedAt: Date;
}

function ownView(row: StoredRow): OwnRhythmView | null {
  const tags = rhythmTagsFrom(row.activity, row.chronotype);
  if (!tags) return null;
  return {
    activity: tags.activity,
    chronotype: tags.chronotype,
    coverageDays: row.coverageDays,
    syncedAt: row.syncedAt.toISOString(),
    consentedAt: row.consentedAt.toISOString(),
  };
}

const OWN_SELECT = {
  activity: true,
  chronotype: true,
  coverageDays: true,
  syncedAt: true,
  consentedAt: true,
} as const;

/**
 * Store (replace) a person's rhythm. The consent stamp survives a re-sync of
 * the same consent version and is re-stamped when the version changes — the
 * row always says when the person agreed to the text that covers it.
 */
export async function saveRhythm(
  userId: string,
  upload: RhythmUpload,
  now: Date = new Date(),
): Promise<OwnRhythmView> {
  const existing = await prisma.userRhythmProfile.findUnique({
    where: { userId },
    select: { consentVersion: true, consentedAt: true },
  });
  const consentedAt =
    existing && existing.consentVersion === upload.consentVersion ? existing.consentedAt : now;
  const data = {
    activity: upload.activity,
    chronotype: upload.chronotype,
    coverageDays: upload.coverageDays,
    algoVersion: upload.algoVersion,
    source: upload.source,
    consentVersion: upload.consentVersion,
    consentedAt,
    syncedAt: now,
  };
  const row = await prisma.userRhythmProfile.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
    select: OWN_SELECT,
  });
  // The parser admitted only known values, so this cannot be null.
  return ownView(row)!;
}

/** The owner's own profile, or null when there is none or it went stale. */
export async function readOwnRhythm(
  userId: string,
  now: Date = new Date(),
): Promise<OwnRhythmView | null> {
  const row = await prisma.userRhythmProfile.findFirst({
    where: { userId, syncedAt: { gte: rhythmFreshCutoff(now) } },
    select: OWN_SELECT,
  });
  return row ? ownView(row) : null;
}

/** Forget a person's rhythm. Returns whether a row existed. */
export async function deleteRhythm(userId: string): Promise<boolean> {
  const result = await prisma.userRhythmProfile.deleteMany({ where: { userId } });
  return result.count > 0;
}

/**
 * Fresh tags for a set of people — the scorers' read. Missing, stale and
 * unparseable rows are simply absent from the map; callers read "absent" as
 * neutral. One indexed query regardless of the set's size; none at all while
 * `TEMPO_SYNC_ENABLED` is off.
 */
export async function loadRhythmTags(
  userIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, RhythmTags>> {
  const tags = new Map<string, RhythmTags>();
  // The kill switch covers reads too: with Tempo Sync off, rows collected while
  // it was on must stop steering anything the moment the flag drops.
  if (!env.TEMPO_SYNC_ENABLED || userIds.length === 0) return tags;
  const rows = await prisma.userRhythmProfile.findMany({
    where: { userId: { in: [...userIds] }, syncedAt: { gte: rhythmFreshCutoff(now) } },
    select: { userId: true, activity: true, chronotype: true },
  });
  for (const row of rows) {
    const parsed = rhythmTagsFrom(row.activity, row.chronotype);
    if (parsed) tags.set(row.userId, parsed);
  }
  return tags;
}

/**
 * Data minimisation: a profile nobody refreshed for `RHYTHM_STALE_AFTER_DAYS`
 * is already invisible to every reader, so keeping it serves no purpose — the
 * nightly retention sweep deletes it. One row per person at most, on an
 * indexed column, so a single statement is enough. Runs regardless of the
 * feature flag: switching Tempo Sync off must not freeze health data in place.
 */
export async function deleteStaleRhythms(now: Date = new Date()): Promise<number> {
  const result = await prisma.userRhythmProfile.deleteMany({
    where: { syncedAt: { lt: rhythmFreshCutoff(now) } },
  });
  return result.count;
}
