import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { CITY_CATALOG, type CityStatus } from "@gennety/shared";

// ---------------------------------------------------------------------------
// GET /admin/cities            — the catalog itself (the users-list filter)
// GET /admin/analytics/waitlist — how many people are waiting, per city
// ---------------------------------------------------------------------------
// Two different questions, deliberately not one endpoint. The catalog is a
// constant the dashboard needs to render a filter (and to render it in a stable
// order without hardcoding a city list of its own). The waitlist is a count
// that changes every hour.
//
// This is NOT the same view as `/admin/analytics/cities`, which distributes the
// EXISTING user base across cities by departure pin / matching city. Nobody on
// the waitlist has a matching city — that is the whole point of being on it —
// so they appear in neither the `homeCityKey` buckets nor the pin buckets, and
// folding the two together would double a launched city's meaning: "people we
// serve here" and "people who want us here" are different numbers and drive
// different decisions.
// ---------------------------------------------------------------------------

export interface CityCatalogRow {
  cityKey: string;
  city: string;
  countryCode: string;
  status: CityStatus;
}

export interface WaitlistCityRow extends CityCatalogRow {
  /** People currently waiting for this city. */
  total: number;
  male: number;
  female: number;
  unknown: number;
  /** When the first and most recent person joined; null for an empty city. */
  firstJoinedAt: string | null;
  lastJoinedAt: string | null;
}

export interface WaitlistDistribution {
  /** Everyone on the waitlist, across every city. */
  totalWaiting: number;
  /** Waitlist cities with at least one person, busiest first. */
  cities: WaitlistCityRow[];
  /**
   * Rows whose `cityKey` is no longer in the catalog — a city that launched (or
   * was renamed) while people were still waiting on the old key. Normally
   * empty; when it is not, it is a migration to run, not a display bug to hide.
   */
  orphaned: Array<{ cityKey: string; total: number }>;
}

interface WaitlistLeadInput {
  cityKey: string;
  city: string;
  countryCode: string;
  gender: string | null;
  createdAt: Date;
}

/**
 * Pure aggregation — no prisma, no express — so it can be unit-tested with
 * plain fixtures, the same shape `computeCityDistribution` uses.
 *
 * Every waitlist city in the catalog gets a row even at zero: "nobody in
 * Dresden yet" is an answer the founder needs, and a table that silently omits
 * empty cities cannot distinguish it from "Dresden is not on the list".
 */
export function computeWaitlistDistribution(
  leads: WaitlistLeadInput[],
): WaitlistDistribution {
  const rows = new Map<string, WaitlistCityRow>();
  for (const city of CITY_CATALOG) {
    if (city.status !== "waitlist") continue;
    rows.set(city.cityKey, {
      cityKey: city.cityKey,
      city: city.city,
      countryCode: city.countryCode,
      status: city.status,
      total: 0,
      male: 0,
      female: 0,
      unknown: 0,
      firstJoinedAt: null,
      lastJoinedAt: null,
    });
  }

  const orphaned = new Map<string, number>();

  for (const lead of leads) {
    const row = rows.get(lead.cityKey);
    if (!row) {
      orphaned.set(lead.cityKey, (orphaned.get(lead.cityKey) ?? 0) + 1);
      continue;
    }
    row.total++;
    if (lead.gender === "male") row.male++;
    else if (lead.gender === "female") row.female++;
    else row.unknown++;

    const joined = lead.createdAt.toISOString();
    if (!row.firstJoinedAt || joined < row.firstJoinedAt) row.firstJoinedAt = joined;
    if (!row.lastJoinedAt || joined > row.lastJoinedAt) row.lastJoinedAt = joined;
  }

  const cities = Array.from(rows.values()).sort(
    (a, b) => b.total - a.total || a.city.localeCompare(b.city),
  );

  return {
    totalWaiting: leads.length,
    cities,
    orphaned: Array.from(orphaned.entries())
      .map(([cityKey, total]) => ({ cityKey, total }))
      .sort((a, b) => b.total - a.total),
  };
}

export const cityWaitlistRouter: Router = Router();

/**
 * The city catalog, in display order. Served rather than compiled into the
 * dashboard for the same reason the Mini App is served it: a new city goes live
 * with the server, and a list that lives in two repos eventually disagrees with
 * itself.
 */
cityWaitlistRouter.get("/admin/cities", (_req: Request, res: Response) => {
  const cities: CityCatalogRow[] = CITY_CATALOG.map((city) => ({
    cityKey: city.cityKey,
    city: city.city,
    countryCode: city.countryCode,
    status: city.status,
  }));
  res.json({ cities });
});

cityWaitlistRouter.get(
  "/admin/analytics/waitlist",
  async (_req: Request, res: Response) => {
    try {
      // Deliberately uncached, unlike `/admin/analytics/cities`: this table is
      // small (one row per waiting person), and its whole job is to answer
      // "how much demand is there right now" — a ten-minute-old answer is the
      // one thing it must not give.
      const leads = await prisma.cityWaitlistEntry.findMany({
        select: {
          cityKey: true,
          city: true,
          countryCode: true,
          createdAt: true,
          user: { select: { gender: true } },
        },
      });

      res.json(
        computeWaitlistDistribution(
          leads.map((lead) => ({
            cityKey: lead.cityKey,
            city: lead.city,
            countryCode: lead.countryCode,
            createdAt: lead.createdAt,
            gender: lead.user?.gender ?? null,
          })),
        ),
      );
    } catch (err) {
      console.error("[admin] waitlist error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
