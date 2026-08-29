import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { isSupportedCityKey } from "@gennety/shared";

/**
 * Event admission — who gets on the door list for a launch event, and why.
 *
 * @see LAUNCH_EVENTS_PRODUCT_SPEC.md §4 (the admission engine), §14 (the
 *      founder decisions this file implements: manual/open policy, no paid
 *      ticket, score as a sort key rather than a gate).
 *
 * Two properties are the whole design and are easy to break by accident:
 *
 * 1. **The attractiveness score is READ, never computed here.** It is the
 *    0..100 figure the vision pass already produced once, at verification
 *    (`services/elo-seed.ts` → `Profile.eloSeedDetails.score`). This module
 *    must never call OpenAI: a second scoring pass would cost money per
 *    applicant AND could disagree with the score the matching engine's
 *    `V_league` is already using for the same person.
 *
 * 2. **Nothing here can admit an unverified account.** `screening` is the only
 *    tier an unverified applicant can hold, and it re-tiers for free when the
 *    verification pipeline activates them. Mandatory liveness is a product
 *    invariant (PRODUCT_SPEC §1.4) and an event is not allowed to route
 *    around it.
 */

const LOG_PREFIX = "[event-admission]";

export const ADMISSION_TIERS = [
  "screening",
  "auto_approved",
  "pending_review",
  "waitlisted",
  "approved",
  "revoked",
] as const;
export type AdmissionTier = (typeof ADMISSION_TIERS)[number];

export const ADMISSION_POLICIES = ["open", "manual", "scored"] as const;
export type AdmissionPolicy = (typeof ADMISSION_POLICIES)[number];

/** The two tiers that put someone on the door list. */
export const ADMITTED_TIERS: readonly AdmissionTier[] = ["auto_approved", "approved"];

export function isAdmissionPolicy(value: unknown): value is AdmissionPolicy {
  return typeof value === "string" && (ADMISSION_POLICIES as readonly string[]).includes(value);
}

export function isAdmissionTier(value: unknown): value is AdmissionTier {
  return typeof value === "string" && (ADMISSION_TIERS as readonly string[]).includes(value);
}

/**
 * Below this many admitted people the gender balancer does not gate at all.
 *
 * Not a nicety: a share is meaningless on a tiny cohort. Without a floor the
 * FIRST applicant to an event with a 0.5 target is 100% or 0% male, i.e. 0.5
 * away from target, i.e. auto-approval is refused for literally everyone until
 * a human intervenes — the balancer would deadlock the event it exists to
 * balance. Same arithmetic the venue-concentration alert already reasons about
 * ("two of three dates in one place is 66%"): report the number, do not act on
 * it until there is enough of it to mean something.
 */
export const RATIO_GATE_MIN_COHORT = 10;

export interface AdmissionEventRules {
  admissionPolicy: AdmissionPolicy;
  capacity: number;
  targetMaleShare: number | null;
  ratioTolerance: number;
  autoApproveScore: number | null;
  reviewFloorScore: number | null;
}

/** Live counts of the ADMITTED set (`auto_approved` + `approved`). */
export interface AdmissionCohort {
  admittedTotal: number;
  admittedMale: number;
}

export interface AdmissionApplicant {
  verified: boolean;
  /** 0..100 from `eloSeedDetails.score`; null when never seeded. */
  score: number | null;
  gender: "male" | "female" | null;
}

/**
 * The whole tiering decision, as a pure function of (applicant, event rules,
 * cohort snapshot). Everything that reads the database lives in the service
 * below, so this is unit-testable without Prisma, a clock, or a network.
 */
export function tierApplication(
  applicant: AdmissionApplicant,
  event: AdmissionEventRules,
  cohort: AdmissionCohort,
): AdmissionTier {
  // 1. Verification is the floor, and it is not negotiable by any policy.
  if (!applicant.verified) return "screening";

  // 2. Capacity before policy: a full event cannot auto-admit under ANY
  //    policy, including `open`. Waitlisted rather than pending_review —
  //    there is nothing for a human to decide while the room is full, and
  //    a revoke/cancellation is what re-opens the question.
  if (cohort.admittedTotal >= event.capacity) return "waitlisted";

  // 3. Policy decides whether this applicant is a candidate for the automatic
  //    lane at all.
  let candidate: boolean;
  switch (event.admissionPolicy) {
    case "open":
      // "The ticket costs nothing, it is just the condition" — a verified
      // applicant is admitted, subject only to capacity (2) and the ratio
      // balancer (4) below.
      candidate = true;
      break;
    case "manual":
      // The score is a sort key in the hub, never a gate. Every verified
      // applicant is handed to a human.
      return "pending_review";
    case "scored": {
      // Missing score routes to a HUMAN, never to `waitlisted`. A gap in our
      // own data is not evidence about the applicant, and the alternative
      // silently rejects every account seeded before `eloSeedDetails` existed.
      // Same principle as the verification pipeline's rule 4: an outage of
      // ours is never charged to the user.
      if (applicant.score === null) return "pending_review";
      if (event.autoApproveScore !== null && applicant.score >= event.autoApproveScore) {
        candidate = true;
        break;
      }
      if (event.reviewFloorScore !== null && applicant.score >= event.reviewFloorScore) {
        return "pending_review";
      }
      // Thresholds unset under a `scored` policy is a misconfigured event, not
      // a rejection — hand it to a human rather than waitlist silently.
      if (event.autoApproveScore === null && event.reviewFloorScore === null) {
        return "pending_review";
      }
      return "waitlisted";
    }
  }

  if (!candidate) return "pending_review";

  // 4. The demographic balancer. It only ever DOWNGRADES an auto-approval to
  //    a human decision — it never waitlists, because a strong applicant
  //    arriving at an awkward moment for the ratio is exactly the case a
  //    founder should see rather than have silently discarded.
  return passesRatioGate(applicant.gender, event, cohort) ? "auto_approved" : "pending_review";
}

/**
 * Would admitting this person keep the admitted set inside its ratio target?
 *
 * The second clause is the non-obvious one and it is load-bearing: once a
 * cohort has drifted outside tolerance, a naive "must land inside tolerance"
 * test blocks EVERY further auto-approval — including the underrepresented
 * gender, i.e. the only admissions that could bring it back. So an admission
 * that moves the share TOWARD the target is always allowed, even from outside
 * the band. A balancer that cannot correct itself is not a balancer.
 */
export function passesRatioGate(
  gender: "male" | "female" | null,
  event: AdmissionEventRules,
  cohort: AdmissionCohort,
): boolean {
  const target = event.targetMaleShare;
  if (target === null) return true;
  // An unknown gender carries no information about the ratio, so it cannot be
  // the thing that unbalances it. Gating on it would punish the user for a
  // profile field this subsystem does not own.
  if (gender === null) return true;
  if (cohort.admittedTotal < RATIO_GATE_MIN_COHORT) return true;

  const projectedTotal = cohort.admittedTotal + 1;
  const projectedMale = cohort.admittedMale + (gender === "male" ? 1 : 0);
  const projectedDrift = Math.abs(projectedMale / projectedTotal - target);
  if (projectedDrift <= event.ratioTolerance) return true;

  const currentDrift = Math.abs(cohort.admittedMale / cohort.admittedTotal - target);
  return projectedDrift < currentDrift;
}

/**
 * Pull the frozen-at-tiering score out of whatever the profile actually holds.
 *
 * `eloSeedDetails.score` is the real 0..100 figure. Legacy rows seeded before
 * that column existed carry only `eloScore`, so it is inverted back through
 * the documented band (`mapScoreToElo`: 0..100 → 200..800). A profile with
 * neither returns null, which `tierApplication` routes to a human.
 */
export function readAttractivenessScore(profile: {
  eloScore: number | null;
  eloSeededAt: Date | null;
  eloSeedDetails: unknown;
}): number | null {
  const details = profile.eloSeedDetails;
  if (details && typeof details === "object" && "score" in details) {
    const raw = (details as { score: unknown }).score;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.max(0, Math.min(100, Math.round(raw)));
    }
  }
  // Only trust `eloScore` as a score proxy when it was actually SEEDED. An
  // unseeded profile sits at the schema default of 500, which would invert to
  // a confident-looking 50 — a fabricated median, not a measurement.
  if (profile.eloSeededAt !== null && typeof profile.eloScore === "number") {
    const pct = ((profile.eloScore - 200) / (800 - 200)) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }
  return null;
}

/** Snapshot the admitted counts an event's tiering decisions are made against. */
export async function loadCohort(eventId: string): Promise<AdmissionCohort> {
  const rows = await prisma.waitlistApplication.groupBy({
    by: ["genderAtTiering"],
    where: { eventId, tier: { in: ADMITTED_TIERS as string[] } },
    _count: { _all: true },
  });
  let admittedTotal = 0;
  let admittedMale = 0;
  for (const row of rows) {
    admittedTotal += row._count._all;
    if (row.genderAtTiering === "male") admittedMale += row._count._all;
  }
  return { admittedTotal, admittedMale };
}

function toRules(event: {
  admissionPolicy: string;
  capacity: number;
  targetMaleShare: number | null;
  ratioTolerance: number;
  autoApproveScore: number | null;
  reviewFloorScore: number | null;
}): AdmissionEventRules {
  return {
    // A value the DB somehow holds that is not a known policy is treated as
    // `manual` — the one policy that cannot admit anyone on its own.
    admissionPolicy: isAdmissionPolicy(event.admissionPolicy) ? event.admissionPolicy : "manual",
    capacity: event.capacity,
    targetMaleShare: event.targetMaleShare,
    ratioTolerance: event.ratioTolerance,
    autoApproveScore: event.autoApproveScore,
    reviewFloorScore: event.reviewFloorScore,
  };
}

/**
 * Events currently accepting applications in a market. `admissionOpensAt` /
 * `admissionClosesAt` are independent of the event's own clock, so an event can
 * take applications for a fortnight and run for four hours.
 */
export async function openEventsForMarket(cityKey: string, now: Date) {
  if (!isSupportedCityKey(cityKey)) return [];
  return prisma.event.findMany({
    where: {
      cityKey,
      status: { in: ["draft", "upcoming"] },
      endsAt: { gt: now },
      OR: [{ admissionOpensAt: null }, { admissionOpensAt: { lte: now } }],
      AND: [{ OR: [{ admissionClosesAt: null }, { admissionClosesAt: { gt: now } }] }],
    },
    orderBy: { startsAt: "asc" },
  });
}

/**
 * Tier one application, in a transaction, with the cohort read inside it.
 *
 * The write is a compare-and-set on the tier we believe we are moving away
 * from, so a founder deciding this application in the dashboard at the same
 * moment as the verification pipeline tiers it produces ONE transition rather
 * than a lost update. The loser re-reads on the next call; nothing retries in
 * a loop.
 *
 * `expectedTier` defaults to `screening` because that is the only transition
 * this function is ever asked to make automatically — an already-decided
 * application is never silently re-tiered by a photo edit.
 */
export async function tierOneApplication(
  applicationId: string,
  expectedTier: AdmissionTier = "screening",
): Promise<AdmissionTier | null> {
  return prisma.$transaction(async (tx) => {
    const app = await tx.waitlistApplication.findUnique({
      where: { id: applicationId },
      select: {
        id: true,
        eventId: true,
        tier: true,
        user: {
          select: {
            gender: true,
            verificationStatus: true,
            verificationSkippedAt: true,
            profile: { select: { eloScore: true, eloSeededAt: true, eloSeedDetails: true } },
          },
        },
        event: {
          select: {
            admissionPolicy: true,
            capacity: true,
            targetMaleShare: true,
            ratioTolerance: true,
            autoApproveScore: true,
            reviewFloorScore: true,
          },
        },
      },
    });
    if (!app || app.tier !== expectedTier) return null;

    // The match-pool predicate, verbatim: `verified`, or the explicit
    // grandfathered pre-flip skip cohort (PRODUCT_SPEC §1.4). Anything else is
    // not admissible to a room full of strangers.
    const verified =
      app.user.verificationStatus === "verified" ||
      (app.user.verificationStatus === "unverified" && app.user.verificationSkippedAt !== null);

    const gender = app.user.gender === "male" || app.user.gender === "female" ? app.user.gender : null;
    const score = app.user.profile ? readAttractivenessScore(app.user.profile) : null;

    const rows = await tx.waitlistApplication.groupBy({
      by: ["genderAtTiering"],
      where: { eventId: app.eventId, tier: { in: ADMITTED_TIERS as string[] } },
      _count: { _all: true },
    });
    let admittedTotal = 0;
    let admittedMale = 0;
    for (const row of rows) {
      admittedTotal += row._count._all;
      if (row.genderAtTiering === "male") admittedMale += row._count._all;
    }

    const tier = tierApplication({ verified, score, gender }, toRules(app.event), {
      admittedTotal,
      admittedMale,
    });
    if (tier === expectedTier) return tier;

    const claimed = await tx.waitlistApplication.updateMany({
      where: { id: applicationId, tier: expectedTier },
      data: {
        tier,
        // Only freeze the inputs on a real decision. A row bounced back to
        // `screening` has decided nothing and must not carry a score that
        // looks like it did.
        ...(tier === "screening"
          ? {}
          : { scoreAtTiering: score, genderAtTiering: gender, tieredAt: new Date(), decidedBy: "auto" }),
      },
    });
    return claimed.count === 1 ? tier : null;
  });
}

/**
 * Called from the verification pipeline's `verified` branch, beside the
 * referral settlement and on the same contract: best-effort, never blocks
 * activation, no-op when the feature is off.
 *
 * Does two things, in this order:
 *   1. auto-applies the freshly-verified user to any open event in their
 *      market that asked for it (`autoApplyOnVerification`);
 *   2. tiers every `screening` application they hold — including one they
 *      created themselves before verifying, which is the ordinary path.
 *
 * The hook lives at ACTIVATION rather than at onboarding completion because
 * the admission condition is a verified profile: a user who never clears
 * liveness should never appear in a founder's moderation queue at all.
 */
export async function settleEventApplicationsOnVerified(userId: string): Promise<void> {
  if (!env.EVENTS_FEATURE_ENABLED) return;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, profile: { select: { homeCityKey: true } } },
  });
  if (!user) return;

  const cityKey = user.profile?.homeCityKey ?? null;
  const now = new Date();

  if (cityKey) {
    const events = await openEventsForMarket(cityKey, now);
    for (const event of events) {
      if (!event.autoApplyOnVerification) continue;
      try {
        await prisma.waitlistApplication.create({ data: { eventId: event.id, userId } });
      } catch {
        // Unique (eventId, userId): they already applied. That is the
        // idempotency, not an error — swallow and let the tiering pass below
        // pick the existing row up.
      }
    }
  }

  const pending = await prisma.waitlistApplication.findMany({
    where: { userId, tier: "screening" },
    select: { id: true },
  });
  for (const app of pending) {
    try {
      const tier = await tierOneApplication(app.id);
      if (tier) console.log(`${LOG_PREFIX} tiered`, { applicationId: app.id, userId, tier });
    } catch (err) {
      // One event's tiering failing must not cost the user the others, and
      // must never cost them their activation.
      console.warn(`${LOG_PREFIX} tiering threw (swallowed)`, { applicationId: app.id, userId, err });
    }
  }
}
