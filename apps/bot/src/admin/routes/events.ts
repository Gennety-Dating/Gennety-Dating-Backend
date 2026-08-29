import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { isSupportedCityKey, cityKeyToTimeZone, isValidTimeZone } from "@gennety/shared";
import { env } from "../../config.js";
import { isUuid } from "../utils/uuid.js";
import { classifyAllUsers } from "../utils/user-health-source.js";
import {
  ADMITTED_TIERS,
  isAdmissionPolicy,
  loadCohort,
  tierOneApplication,
  type AdmissionTier,
} from "../../services/event-admission.js";

/**
 * `/admin/events` — the founder's launch-event hub
 * (LAUNCH_EVENTS_PRODUCT_SPEC.md §5).
 *
 * Two conventions this router inherits rather than invents:
 *
 * - **Test and synthetic accounts are excluded on READ, never at write time.**
 *   The pipeline's percentages are denominated in real applicants, using the
 *   same `classifyAllUsers` verdict `/admin/analytics/monetization` already
 *   uses — two definitions of "test account" would eventually show two
 *   different funnels on two tabs. The raw application list still shows them,
 *   flagged, because the list is a ledger.
 * - **An empty denominator is `null`, never `0`.** "Nobody has applied yet"
 *   and "nobody who applied got in" are different statements.
 */

const LOG_PREFIX = "[admin][events]";

const EVENT_STATUSES = ["draft", "upcoming", "live", "concluded", "cancelled"] as const;
type EventStatus = (typeof EVENT_STATUSES)[number];

/**
 * Which lifecycle moves are legal. Written out rather than derived from an
 * ordering because two of them are not sequential: an event may be cancelled
 * from any live-ish state, and `concluded` is terminal — a concluded event
 * that could be reopened would let a door scanner admit people to a party
 * that already happened.
 */
const LEGAL_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  draft: ["upcoming", "cancelled"],
  upcoming: ["live", "cancelled"],
  live: ["concluded", "cancelled"],
  concluded: [],
  cancelled: [],
};

function isEventStatus(value: unknown): value is EventStatus {
  return typeof value === "string" && (EVENT_STATUSES as readonly string[]).includes(value);
}

function parseDate(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function serializeEvent(row: {
  id: string;
  cityKey: string;
  kind: string;
  status: string;
  title: string;
  curatedVenueId: string | null;
  venueName: string;
  venueAddress: string;
  venueLat: number;
  venueLng: number;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  capacity: number;
  admissionPolicy: string;
  autoApplyOnVerification: boolean;
  targetMaleShare: number | null;
  ratioTolerance: number;
  autoApproveScore: number | null;
  reviewFloorScore: number | null;
  admissionOpensAt: Date | null;
  admissionClosesAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...row,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    admissionOpensAt: row.admissionOpensAt?.toISOString() ?? null,
    admissionClosesAt: row.admissionClosesAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The whole router is gated on the master flag. A 404 rather than a 403: with
 * the subsystem off these paths are not part of the API surface at all, which
 * is also what makes "flag off is genuinely inert" checkable from outside.
 */
function requireFeature(res: Response): boolean {
  if (!env.EVENTS_FEATURE_ENABLED) {
    res.status(404).json({ error: "Not found" });
    return false;
  }
  return true;
}

export const eventsRouter: Router = Router();

eventsRouter.get("/admin/events", async (req: Request, res: Response) => {
  if (!requireFeature(res)) return;
  try {
    const cityKey = typeof req.query.cityKey === "string" ? req.query.cityKey : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;

    const rows = await prisma.event.findMany({
      where: { ...(cityKey ? { cityKey } : {}), ...(status ? { status } : {}) },
      orderBy: { startsAt: "desc" },
      take: 200,
    });
    res.json({ data: rows.map(serializeEvent), total: rows.length });
  } catch (err) {
    console.error(`${LOG_PREFIX} list error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

eventsRouter.post("/admin/events", async (req: Request, res: Response) => {
  if (!requireFeature(res)) return;
  try {
    const body = req.body as Record<string, unknown>;
    const cityKey = typeof body.cityKey === "string" ? body.cityKey.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const venueName = typeof body.venueName === "string" ? body.venueName.trim() : "";
    const venueAddress = typeof body.venueAddress === "string" ? body.venueAddress.trim() : "";
    const venueLat = Number(body.venueLat);
    const venueLng = Number(body.venueLng);
    const startsAt = parseDate(body.startsAt);
    const endsAt = parseDate(body.endsAt);
    const capacity = Number(body.capacity);
    const admissionPolicy = body.admissionPolicy ?? "manual";

    // A market the product has not launched is refused here rather than at the
    // door: matching is same-city, so an event outside a launched market is a
    // room nobody in it can be matched out of afterwards — the same reasoning
    // that gates registration (PRODUCT_SPEC §1.3).
    if (!isSupportedCityKey(cityKey)) {
      res.status(400).json({ error: "cityKey must be a launched market" });
      return;
    }
    if (!title || !venueName || !venueAddress) {
      res.status(400).json({ error: "title, venueName and venueAddress are required" });
      return;
    }
    if (!Number.isFinite(venueLat) || !Number.isFinite(venueLng)) {
      res.status(400).json({ error: "venueLat/venueLng must be numbers" });
      return;
    }
    if (!startsAt || !endsAt || endsAt <= startsAt) {
      res.status(400).json({ error: "startsAt/endsAt must be valid dates with endsAt > startsAt" });
      return;
    }
    if (!Number.isInteger(capacity) || capacity <= 0) {
      res.status(400).json({ error: "capacity must be a positive integer" });
      return;
    }
    if (!isAdmissionPolicy(admissionPolicy)) {
      res.status(400).json({ error: "admissionPolicy must be open | manual | scored" });
      return;
    }

    const targetMaleShare =
      body.targetMaleShare === null || body.targetMaleShare === undefined
        ? null
        : Number(body.targetMaleShare);
    if (targetMaleShare !== null && !(targetMaleShare >= 0 && targetMaleShare <= 1)) {
      res.status(400).json({ error: "targetMaleShare must be null or within [0,1]" });
      return;
    }

    const autoApproveScore =
      body.autoApproveScore === null || body.autoApproveScore === undefined
        ? null
        : Number(body.autoApproveScore);
    const reviewFloorScore =
      body.reviewFloorScore === null || body.reviewFloorScore === undefined
        ? null
        : Number(body.reviewFloorScore);
    for (const [name, value] of [
      ["autoApproveScore", autoApproveScore],
      ["reviewFloorScore", reviewFloorScore],
    ] as const) {
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 100)) {
        res.status(400).json({ error: `${name} must be null or an integer within [0,100]` });
        return;
      }
    }
    // A review floor above the auto-approve bar is not a stricter event, it is
    // an unreachable `pending_review` band — refuse it rather than let the
    // founder discover it as an empty moderation queue.
    if (autoApproveScore !== null && reviewFloorScore !== null && reviewFloorScore > autoApproveScore) {
      res.status(400).json({ error: "reviewFloorScore must be <= autoApproveScore" });
      return;
    }

    const timeZone =
      typeof body.timeZone === "string" && isValidTimeZone(body.timeZone)
        ? body.timeZone
        : cityKeyToTimeZone(cityKey);

    const row = await prisma.event.create({
      data: {
        cityKey,
        kind: typeof body.kind === "string" && body.kind.trim() ? body.kind.trim() : "launch",
        title,
        curatedVenueId:
          typeof body.curatedVenueId === "string" && isUuid(body.curatedVenueId)
            ? body.curatedVenueId
            : null,
        venueName,
        venueAddress,
        venueLat,
        venueLng,
        startsAt,
        endsAt,
        timeZone,
        capacity,
        admissionPolicy,
        autoApplyOnVerification: body.autoApplyOnVerification === true,
        targetMaleShare,
        ...(typeof body.ratioTolerance === "number" ? { ratioTolerance: body.ratioTolerance } : {}),
        autoApproveScore,
        reviewFloorScore,
        admissionOpensAt: parseDate(body.admissionOpensAt) ?? null,
        admissionClosesAt: parseDate(body.admissionClosesAt) ?? null,
      },
    });
    res.json({ data: serializeEvent(row) });
  } catch (err) {
    console.error(`${LOG_PREFIX} create error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

eventsRouter.patch("/admin/events/:id", async (req: Request, res: Response) => {
  if (!requireFeature(res)) return;
  try {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) {
      res.status(400).json({ error: "id must be a UUID" });
      return;
    }
    const body = req.body as Record<string, unknown>;

    // A status move is a compare-and-set on the value we believe we are moving
    // away from, so two dashboard tabs cannot advance the lifecycle twice —
    // and an illegal move is refused by name rather than silently ignored.
    if (body.status !== undefined) {
      if (!isEventStatus(body.status)) {
        res.status(400).json({ error: `status must be one of ${EVENT_STATUSES.join(", ")}` });
        return;
      }
      const current = await prisma.event.findUnique({ where: { id }, select: { status: true } });
      if (!current) {
        res.status(404).json({ error: "Event not found" });
        return;
      }
      if (current.status !== body.status) {
        const from = isEventStatus(current.status) ? current.status : "draft";
        if (!LEGAL_TRANSITIONS[from].includes(body.status)) {
          res.status(409).json({ error: `cannot move ${current.status} → ${body.status}` });
          return;
        }
        const claimed = await prisma.event.updateMany({
          where: { id, status: current.status },
          data: { status: body.status },
        });
        if (claimed.count === 0) {
          res.status(409).json({ error: "status changed underneath — re-read and retry" });
          return;
        }
      }
    }

    const data: Record<string, unknown> = {};
    if (typeof body.title === "string" && body.title.trim()) data.title = body.title.trim();
    if (Number.isInteger(body.capacity) && (body.capacity as number) > 0) data.capacity = body.capacity;
    if (isAdmissionPolicy(body.admissionPolicy)) data.admissionPolicy = body.admissionPolicy;
    if (typeof body.autoApplyOnVerification === "boolean") {
      data.autoApplyOnVerification = body.autoApplyOnVerification;
    }
    if (body.targetMaleShare === null) data.targetMaleShare = null;
    else if (typeof body.targetMaleShare === "number" && body.targetMaleShare >= 0 && body.targetMaleShare <= 1) {
      data.targetMaleShare = body.targetMaleShare;
    }
    if (typeof body.ratioTolerance === "number" && body.ratioTolerance >= 0 && body.ratioTolerance <= 1) {
      data.ratioTolerance = body.ratioTolerance;
    }
    const closes = parseDate(body.admissionClosesAt);
    if (closes) data.admissionClosesAt = closes;

    const row = Object.keys(data).length
      ? await prisma.event.update({ where: { id }, data })
      : await prisma.event.findUnique({ where: { id } });
    if (!row) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    res.json({ data: serializeEvent(row) });
  } catch (err) {
    console.error(`${LOG_PREFIX} update error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * The live funnel for one event: how many applied, where they sit, how the
 * admitted set is balanced, and how far into capacity it is.
 *
 * The score histogram is DECILES, not a per-user list. A list of names beside
 * attractiveness scores is a spreadsheet waiting to be exported; the founder
 * needs the shape of the distribution to tune thresholds, and the per-applicant
 * number is already on the card in the moderation grid where a decision is
 * actually being made.
 */
eventsRouter.get("/admin/events/:id/pipeline", async (req: Request, res: Response) => {
  if (!requireFeature(res)) return;
  try {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) {
      res.status(400).json({ error: "id must be a UUID" });
      return;
    }
    const event = await prisma.event.findUnique({ where: { id } });
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }

    const [health, applications] = await Promise.all([
      classifyAllUsers(),
      prisma.waitlistApplication.findMany({
        where: { eventId: id },
        select: {
          userId: true,
          tier: true,
          scoreAtTiering: true,
          genderAtTiering: true,
          decidedBy: true,
        },
      }),
    ]);

    // One class, not two: `user-health.ts` files synthetic stand-ins under
    // `test` (its `test_synthetic_profile` rule), so there is no separate
    // classification to exclude — and adding one here would be a second
    // definition of "not a real user" living beside the canonical one.
    const excluded = new Set(
      health.users.filter((u) => u.verdict.classification === "test").map((u) => u.id),
    );

    const real = applications.filter((a) => !excluded.has(a.userId));
    const byTier: Record<string, number> = {};
    let admittedTotal = 0;
    let admittedMale = 0;
    let admittedFemale = 0;
    let autoDecided = 0;
    let manualDecided = 0;
    const scores: number[] = [];

    for (const app of real) {
      byTier[app.tier] = (byTier[app.tier] ?? 0) + 1;
      if ((ADMITTED_TIERS as readonly string[]).includes(app.tier)) {
        admittedTotal += 1;
        if (app.genderAtTiering === "male") admittedMale += 1;
        if (app.genderAtTiering === "female") admittedFemale += 1;
        if (app.decidedBy === "auto") autoDecided += 1;
        else if (app.decidedBy) manualDecided += 1;
      }
      if (typeof app.scoreAtTiering === "number") scores.push(app.scoreAtTiering);
    }

    const deciles = new Array(10).fill(0) as number[];
    for (const score of scores) {
      const bucket = Math.min(9, Math.floor(score / 10));
      deciles[bucket] += 1;
    }

    res.json({
      event: serializeEvent(event),
      applicants: {
        total: real.length,
        byTier,
        excludedTestUsers: applications.length - real.length,
      },
      admitted: {
        total: admittedTotal,
        capacity: event.capacity,
        // null, not 0: a capacity of zero would be a misconfigured event, and
        // "nobody admitted yet" is not "0% full" of nothing.
        fillPct: event.capacity > 0 ? Math.round((admittedTotal / event.capacity) * 1000) / 10 : null,
        male: admittedMale,
        female: admittedFemale,
        maleShare: admittedTotal > 0 ? Math.round((admittedMale / admittedTotal) * 1000) / 1000 : null,
        targetMaleShare: event.targetMaleShare,
        autoDecided,
        manualDecided,
      },
      scores: {
        counted: scores.length,
        avg: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
        deciles,
      },
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} pipeline error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** The moderation grid: one card per applicant, newest first within a tier. */
eventsRouter.get("/admin/events/:id/applications", async (req: Request, res: Response) => {
  if (!requireFeature(res)) return;
  try {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) {
      res.status(400).json({ error: "id must be a UUID" });
      return;
    }
    const tier = typeof req.query.tier === "string" ? req.query.tier : undefined;
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);

    const rows = await prisma.waitlistApplication.findMany({
      where: { eventId: id, ...(tier ? { tier } : {}) },
      orderBy: [{ scoreAtTiering: "desc" }, { createdAt: "asc" }],
      take: limit,
      select: {
        id: true,
        tier: true,
        scoreAtTiering: true,
        genderAtTiering: true,
        tieredAt: true,
        decidedBy: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            firstName: true,
            age: true,
            gender: true,
            verificationStatus: true,
            profile: { select: { photos: true, homeCityKey: true } },
          },
        },
      },
    });

    res.json({
      data: rows.map((row) => ({
        id: row.id,
        tier: row.tier,
        scoreAtTiering: row.scoreAtTiering,
        genderAtTiering: row.genderAtTiering,
        tieredAt: row.tieredAt?.toISOString() ?? null,
        decidedBy: row.decidedBy,
        createdAt: row.createdAt.toISOString(),
        user: {
          id: row.user.id,
          firstName: row.user.firstName,
          age: row.user.age,
          gender: row.user.gender,
          verificationStatus: row.user.verificationStatus,
          homeCityKey: row.user.profile?.homeCityKey ?? null,
          photos: row.user.profile?.photos ?? [],
        },
      })),
      total: rows.length,
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} applications error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const DECISION_TIERS: Record<string, AdmissionTier> = {
  approve: "approved",
  waitlist: "waitlisted",
  revoke: "revoked",
};

eventsRouter.post(
  "/admin/events/:id/applications/:appId/decide",
  async (req: Request, res: Response) => {
    if (!requireFeature(res)) return;
    try {
      const { id, appId } = req.params as { id: string; appId: string };
      if (!isUuid(id) || !isUuid(appId)) {
        res.status(400).json({ error: "id and appId must be UUIDs" });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const action = typeof body.action === "string" ? body.action : "";
      const target = DECISION_TIERS[action];
      if (!target) {
        res.status(400).json({ error: "action must be approve | waitlist | revoke" });
        return;
      }
      const actor = typeof body.actor === "string" && body.actor.trim() ? body.actor.trim() : "admin";

      const result = await prisma.$transaction(async (tx) => {
        const app = await tx.waitlistApplication.findUnique({
          where: { id: appId },
          select: {
            id: true,
            eventId: true,
            tier: true,
            scoreAtTiering: true,
            genderAtTiering: true,
            user: {
              select: {
                gender: true,
                profile: { select: { eloScore: true, eloSeededAt: true, eloSeedDetails: true } },
              },
            },
            event: { select: { capacity: true } },
          },
        });
        if (!app || app.eventId !== id) return { error: "not_found" as const };
        if (app.tier === target) return { ok: true as const, tier: target };
        // A screening (unverified) applicant cannot be approved by hand
        // either. Mandatory liveness is a product invariant, and an admin
        // button is not an exception to it.
        if (target === "approved" && app.tier === "screening") {
          return { error: "not_verified" as const };
        }

        if (target === "approved") {
          const rows = await tx.waitlistApplication.groupBy({
            by: ["genderAtTiering"],
            where: { eventId: id, tier: { in: ADMITTED_TIERS as string[] } },
            _count: { _all: true },
          });
          const admitted = rows.reduce((sum, row) => sum + row._count._all, 0);
          if (admitted >= app.event.capacity) return { error: "at_capacity" as const };
        }

        // Freeze the decision's inputs if tiering never did (an application
        // decided straight out of `screening` by hand, say). Never overwrite a
        // frozen value: the whole point is that a decision keeps the basis it
        // was made on.
        const gender =
          app.genderAtTiering ??
          (app.user.gender === "male" || app.user.gender === "female" ? app.user.gender : null);

        const claimed = await tx.waitlistApplication.updateMany({
          where: { id: appId, tier: app.tier },
          data: {
            tier: target,
            genderAtTiering: gender,
            tieredAt: new Date(),
            decidedBy: actor,
          },
        });
        if (claimed.count === 0) return { error: "conflict" as const };
        return { ok: true as const, tier: target, from: app.tier };
      });

      if ("error" in result) {
        const status =
          result.error === "not_found" ? 404 : result.error === "conflict" ? 409 : 422;
        res.status(status).json({ error: result.error });
        return;
      }
      console.log(`${LOG_PREFIX} decided`, { eventId: id, appId, tier: result.tier, actor });
      res.json({ ok: true, tier: result.tier });
    } catch (err) {
      console.error(`${LOG_PREFIX} decide error:`, err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * Bulk-approve every `pending_review` applicant at or above a score.
 *
 * Capacity-bounded and ordered by score, so a bulk action can never oversell
 * the room: it approves the best `remaining` applicants and reports how many
 * it left behind rather than silently truncating.
 */
eventsRouter.post("/admin/events/:id/bulk-approve", async (req: Request, res: Response) => {
  if (!requireFeature(res)) return;
  try {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) {
      res.status(400).json({ error: "id must be a UUID" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const minScore = Number(body.minScore);
    if (!Number.isInteger(minScore) || minScore < 0 || minScore > 100) {
      res.status(400).json({ error: "minScore must be an integer within [0,100]" });
      return;
    }
    const actor = typeof body.actor === "string" && body.actor.trim() ? body.actor.trim() : "admin";

    const event = await prisma.event.findUnique({ where: { id }, select: { capacity: true } });
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    const cohort = await loadCohort(id);
    const remaining = Math.max(0, event.capacity - cohort.admittedTotal);
    if (remaining === 0) {
      res.json({ approved: 0, skippedAtCapacity: null, reason: "at_capacity" });
      return;
    }

    const eligible = await prisma.waitlistApplication.findMany({
      where: { eventId: id, tier: "pending_review", scoreAtTiering: { gte: minScore } },
      orderBy: [{ scoreAtTiering: "desc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    const take = eligible.slice(0, remaining);

    let approved = 0;
    for (const app of take) {
      // Per-row CAS rather than one `updateMany`: the capacity budget was
      // computed once, so each write still has to prove the row is where we
      // left it. A founder deciding the same application in another tab loses
      // one row, not the batch.
      const claimed = await prisma.waitlistApplication.updateMany({
        where: { id: app.id, tier: "pending_review" },
        data: { tier: "approved", tieredAt: new Date(), decidedBy: actor },
      });
      approved += claimed.count;
    }

    console.log(`${LOG_PREFIX} bulk-approve`, { eventId: id, minScore, approved, actor });
    res.json({ approved, skippedAtCapacity: Math.max(0, eligible.length - take.length) });
  } catch (err) {
    console.error(`${LOG_PREFIX} bulk-approve error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Re-run automatic tiering for every `screening` application on this event.
 *
 * The repair path: applications whose owner verified while the feature flag
 * was off, or while an event's policy was still being configured, sit in
 * `screening` with nothing scheduled to pick them up (the only automatic
 * trigger is the verification pipeline, which has already run for them).
 */
eventsRouter.post("/admin/events/:id/retier", async (req: Request, res: Response) => {
  if (!requireFeature(res)) return;
  try {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) {
      res.status(400).json({ error: "id must be a UUID" });
      return;
    }
    const pending = await prisma.waitlistApplication.findMany({
      where: { eventId: id, tier: "screening" },
      select: { id: true },
      take: 1000,
    });
    const moved: Record<string, number> = {};
    for (const app of pending) {
      const tier = await tierOneApplication(app.id);
      if (tier && tier !== "screening") moved[tier] = (moved[tier] ?? 0) + 1;
    }
    res.json({ scanned: pending.length, moved });
  } catch (err) {
    console.error(`${LOG_PREFIX} retier error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});
