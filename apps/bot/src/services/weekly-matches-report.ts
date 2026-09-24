import { prisma } from "@gennety/db";
import { MAX_PHOTOS } from "@gennety/shared";



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
    photoRefs: (user.profile?.photos ?? []).slice(0, MAX_PHOTOS),
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
