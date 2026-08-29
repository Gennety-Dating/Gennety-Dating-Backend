import { describe, it, expect } from "vitest";
import {
  RATIO_GATE_MIN_COHORT,
  passesRatioGate,
  readAttractivenessScore,
  tierApplication,
  type AdmissionApplicant,
  type AdmissionCohort,
  type AdmissionEventRules,
} from "./event-admission.js";

/**
 * Pure admission logic — no Prisma, no clock, no network.
 *
 * Every `it` here corresponds to a property that is silent when broken: a
 * wrong tier does not throw, it just quietly admits or refuses the wrong
 * person, and nobody finds out until someone is standing at a door.
 */

const OPEN: AdmissionEventRules = {
  admissionPolicy: "open",
  capacity: 100,
  targetMaleShare: null,
  ratioTolerance: 0.08,
  autoApproveScore: null,
  reviewFloorScore: null,
};
const MANUAL: AdmissionEventRules = { ...OPEN, admissionPolicy: "manual" };
const SCORED: AdmissionEventRules = {
  ...OPEN,
  admissionPolicy: "scored",
  autoApproveScore: 70,
  reviewFloorScore: 50,
};

const EMPTY: AdmissionCohort = { admittedTotal: 0, admittedMale: 0 };
const verified = (over: Partial<AdmissionApplicant> = {}): AdmissionApplicant => ({
  verified: true,
  score: 80,
  gender: "male",
  ...over,
});

describe("tierApplication — verification is the floor", () => {
  it("keeps an unverified applicant in screening under EVERY policy", () => {
    for (const rules of [OPEN, MANUAL, SCORED]) {
      expect(tierApplication(verified({ verified: false }), rules, EMPTY)).toBe("screening");
    }
  });

  it("does not let a perfect score buy past verification", () => {
    expect(tierApplication({ verified: false, score: 100, gender: "female" }, SCORED, EMPTY)).toBe(
      "screening",
    );
  });
});

describe("tierApplication — capacity", () => {
  it("waitlists once the room is full, even under the open policy", () => {
    const full: AdmissionCohort = { admittedTotal: 100, admittedMale: 50 };
    expect(tierApplication(verified(), OPEN, full)).toBe("waitlisted");
  });

  it("checks capacity BEFORE policy, so a full manual event stops queueing humans", () => {
    const full: AdmissionCohort = { admittedTotal: 100, admittedMale: 50 };
    expect(tierApplication(verified(), MANUAL, full)).toBe("waitlisted");
  });
});

describe("tierApplication — policies", () => {
  it("open admits any verified applicant", () => {
    expect(tierApplication(verified(), OPEN, EMPTY)).toBe("auto_approved");
  });

  it("open ignores the score entirely — it is not a gate under this policy", () => {
    expect(tierApplication(verified({ score: 1 }), OPEN, EMPTY)).toBe("auto_approved");
    expect(tierApplication(verified({ score: null }), OPEN, EMPTY)).toBe("auto_approved");
  });

  it("manual hands every verified applicant to a human, whatever they scored", () => {
    expect(tierApplication(verified({ score: 99 }), MANUAL, EMPTY)).toBe("pending_review");
    expect(tierApplication(verified({ score: 2 }), MANUAL, EMPTY)).toBe("pending_review");
  });

  it("scored splits on the two thresholds", () => {
    expect(tierApplication(verified({ score: 70 }), SCORED, EMPTY)).toBe("auto_approved");
    expect(tierApplication(verified({ score: 69 }), SCORED, EMPTY)).toBe("pending_review");
    expect(tierApplication(verified({ score: 50 }), SCORED, EMPTY)).toBe("pending_review");
    expect(tierApplication(verified({ score: 49 }), SCORED, EMPTY)).toBe("waitlisted");
  });

  it("routes a MISSING score to a human, never to the waitlist", () => {
    // A gap in our own data is not evidence about the applicant. Waitlisting
    // here would silently reject everyone seeded before eloSeedDetails existed.
    expect(tierApplication(verified({ score: null }), SCORED, EMPTY)).toBe("pending_review");
  });

  it("routes a misconfigured scored event to a human rather than waitlisting", () => {
    const noThresholds = { ...SCORED, autoApproveScore: null, reviewFloorScore: null };
    expect(tierApplication(verified({ score: 80 }), noThresholds, EMPTY)).toBe("pending_review");
  });
});

describe("passesRatioGate — the balancer", () => {
  const balanced: AdmissionEventRules = { ...OPEN, targetMaleShare: 0.5, ratioTolerance: 0.08 };

  it("does not gate below the minimum cohort", () => {
    // The property that stops the balancer deadlocking the event it balances:
    // the first applicant is 100%/0% of the admitted set by construction.
    const tiny: AdmissionCohort = { admittedTotal: RATIO_GATE_MIN_COHORT - 1, admittedMale: 0 };
    expect(passesRatioGate("male", balanced, tiny)).toBe(true);
    expect(tierApplication(verified(), balanced, EMPTY)).toBe("auto_approved");
  });

  it("stalls the overrepresented gender past tolerance", () => {
    const skewed: AdmissionCohort = { admittedTotal: 20, admittedMale: 12 };
    // 13/21 = 0.619, drift 0.119 > 0.08 and getting worse.
    expect(passesRatioGate("male", balanced, skewed)).toBe(false);
    expect(tierApplication(verified({ gender: "male" }), balanced, skewed)).toBe("pending_review");
  });

  it("NEVER waitlists on ratio — it downgrades to a human decision", () => {
    const skewed: AdmissionCohort = { admittedTotal: 20, admittedMale: 12 };
    expect(tierApplication(verified({ gender: "male" }), balanced, skewed)).not.toBe("waitlisted");
  });

  it("still admits the underrepresented gender from outside the band", () => {
    // The clause that makes the balancer able to correct itself: without it,
    // an already-skewed cohort blocks the very admissions that would fix it.
    const skewed: AdmissionCohort = { admittedTotal: 20, admittedMale: 16 }; // 0.8, far out
    expect(passesRatioGate("female", balanced, skewed)).toBe(true);
    expect(tierApplication(verified({ gender: "female" }), balanced, skewed)).toBe("auto_approved");
  });

  it("does not gate an unknown gender", () => {
    const skewed: AdmissionCohort = { admittedTotal: 20, admittedMale: 16 };
    expect(passesRatioGate(null, balanced, skewed)).toBe(true);
  });

  it("does not gate at all when the event sets no target", () => {
    const skewed: AdmissionCohort = { admittedTotal: 40, admittedMale: 40 };
    expect(passesRatioGate("male", OPEN, skewed)).toBe(true);
  });
});

describe("readAttractivenessScore", () => {
  it("prefers the frozen vision score", () => {
    expect(
      readAttractivenessScore({ eloScore: 500, eloSeededAt: new Date(), eloSeedDetails: { score: 73 } }),
    ).toBe(73);
  });

  it("inverts a SEEDED elo when details are missing", () => {
    // mapScoreToElo: 0..100 → 200..800, so 500 is the midpoint.
    expect(readAttractivenessScore({ eloScore: 500, eloSeededAt: new Date(), eloSeedDetails: null })).toBe(50);
    expect(readAttractivenessScore({ eloScore: 800, eloSeededAt: new Date(), eloSeedDetails: null })).toBe(100);
  });

  it("returns null for an UNSEEDED profile rather than inventing a median", () => {
    // The schema default is 500, which would invert to a confident-looking 50
    // — a fabricated measurement, and the one thing this function must not do.
    expect(readAttractivenessScore({ eloScore: 500, eloSeededAt: null, eloSeedDetails: null })).toBeNull();
  });

  it("ignores a malformed details blob", () => {
    expect(
      readAttractivenessScore({ eloScore: 500, eloSeededAt: null, eloSeedDetails: { score: "high" } }),
    ).toBeNull();
  });

  it("clamps a provider score that lands outside the band", () => {
    expect(
      readAttractivenessScore({ eloScore: null, eloSeededAt: null, eloSeedDetails: { score: 140 } }),
    ).toBe(100);
  });
});
