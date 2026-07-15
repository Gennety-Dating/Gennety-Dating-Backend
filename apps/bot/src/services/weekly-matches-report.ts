import { prisma } from "@gennety/db";

/**
 * Weekly founder matches report (PII, ops-only). The single assembler shared by
 * the tokenized report page (`GET /v1/founder/report/:token`) and the admin
 * dashboard view (`GET /admin/analytics/weekly-matches`). Deliberately excludes
 * `psychologicalSummary` / the AI-memory dump — only ordinary facts, photo
 * refs, and the vision attractiveness score.
 *
 * Photo `refs` are Telegram `file_id`s or Supabase paths; each surface streams
 * them through its own authenticated media proxy (report page:
 * `/v1/founder/report/:token/media?ref=`, dashboard: `/admin/media?type=
 * telegram&ref=`), so no image bytes are embedded in the snapshot.
 */

export interface WeeklyMatchesUserCard {
  userId: string;
  firstName: string | null;
  age: number | null;
  gender: string | null;
  city: string | null;
  verificationStatus: string;
  /** 0..100 vision attractiveness score (null until the Elo vision seed ran). */
  attractiveness: number | null;
  /** Telegram file_id / Supabase path refs (served via a media proxy). */
  photoRefs: string[];
}

export interface WeeklyMatchesPair {
  matchId: string;
  status: string;
  synergyScore: number | null;
  synergyReason: string | null;
  createdAtIso: string;
  users: [WeeklyMatchesUserCard, WeeklyMatchesUserCard];
}

export interface WeeklyMatchesReport {
  pairs: WeeklyMatchesPair[];
}

interface BuildArgs {
  /** Explicit match ids (used by the weekly cron with `result.matchIds`). */
  matchIds?: string[];
  /** Or a created-at window (used by the admin dashboard's `weekOf` query). */
  since?: Date;
  until?: Date;
}

const MAX_PHOTOS_PER_USER = 6;

function attractivenessFromSeed(details: unknown): number | null {
  if (details && typeof details === "object" && "score" in details) {
    const s = (details as { score?: unknown }).score;
    if (typeof s === "number") return Math.round(s);
  }
  return null;
}

function toUserCard(user: {
  id: string;
  firstName: string | null;
  age: number | null;
  gender: string | null;
  verificationStatus: string;
  profile: {
    homeCity: string | null;
    photos: string[];
    eloSeedDetails: unknown;
  } | null;
}): WeeklyMatchesUserCard {
  return {
    userId: user.id,
    firstName: user.firstName,
    age: user.age,
    gender: user.gender,
    city: user.profile?.homeCity ?? null,
    verificationStatus: user.verificationStatus,
    attractiveness: attractivenessFromSeed(user.profile?.eloSeedDetails),
    photoRefs: (user.profile?.photos ?? []).slice(0, MAX_PHOTOS_PER_USER),
  };
}

export async function buildWeeklyMatchesReport(
  args: BuildArgs,
): Promise<WeeklyMatchesReport> {
  const where =
    args.matchIds && args.matchIds.length > 0
      ? { id: { in: args.matchIds } }
      : {
          createdAt: {
            ...(args.since ? { gte: args.since } : {}),
            ...(args.until ? { lt: args.until } : {}),
          },
        };

  const userSelect = {
    id: true,
    firstName: true,
    age: true,
    gender: true,
    verificationStatus: true,
    profile: {
      select: { homeCity: true, photos: true, eloSeedDetails: true },
    },
  } as const;

  const matches = await prisma.match.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      synergyScore: true,
      synergyReason: true,
      createdAt: true,
      userA: { select: userSelect },
      userB: { select: userSelect },
    },
  });

  const pairs: WeeklyMatchesPair[] = matches.map((m) => ({
    matchId: m.id,
    status: m.status,
    synergyScore: m.synergyScore ?? null,
    synergyReason: m.synergyReason ?? null,
    createdAtIso: m.createdAt.toISOString(),
    users: [toUserCard(m.userA), toUserCard(m.userB)],
  }));

  return { pairs };
}
