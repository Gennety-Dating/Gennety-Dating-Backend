import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  env: {
    VENUE_INTENT_V2_ENABLED: true,
    VENUE_INTENT_V2_ROLLOUT_PERCENT: 0,
    VENUE_INTENT_V2_SHADOW_PERCENT: 100,
  },
}));

const matchFindUnique = vi.fn();
const profileFindUnique = vi.fn();
const txQueryRawUnsafe = vi.fn();
const txMatchFindUnique = vi.fn();
const txMatchUpdate = vi.fn();
const prismaTransaction = vi.fn(async (fn: (tx: unknown) => unknown) =>
  fn({
    $queryRawUnsafe: txQueryRawUnsafe,
    match: { findUnique: txMatchFindUnique, update: txMatchUpdate },
  }),
);

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: matchFindUnique },
    // Read by the departure-point gate (`services/venue-origin.ts`) to resolve
    // the caller's launched market.
    profile: { findUnique: profileFindUnique },
    $transaction: prismaTransaction,
  },
  Prisma: {},
}));

const callOpenAIJson = vi.fn();
vi.mock("./openai.js", () => ({
  callOpenAIJson: (...args: unknown[]) => callOpenAIJson(...args),
}));

const { interpretVenueIntent, hoursEvidenceAdmits } = await import("./venue-intent-v2.js");
const { isVenueOriginRefusal } = await import("./venue-origin.js");

/**
 * `interpretVenueIntent` returns an intent OR a departure-point refusal. These
 * tests assert on the intent branch, so narrow once here rather than repeating
 * the guard — and fail loudly if a case ever starts returning the refusal.
 */
function asIntent(value: Awaited<ReturnType<typeof interpretVenueIntent>>) {
  if (!value || isVenueOriginRefusal(value)) {
    throw new Error(`expected an intent, got ${JSON.stringify(value)}`);
  }
  return value;
}

const MATCH_ID = "11111111-1111-1111-1111-111111111111";
const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ORIGIN = { lat: 50.45, lng: 30.52, address: "Khreshchatyk" };

function baseMatch(overrides: Record<string, unknown> = {}) {
  return {
    id: MATCH_ID,
    userAId: USER_A,
    userBId: USER_B,
    status: "negotiating_venue",
    venueIntentA: null,
    venueIntentB: null,
    venueSelectionError: null,
    ...overrides,
  };
}

function confirmedIntent(overrides: Record<string, unknown> = {}) {
  return {
    rawText: "quiet cafe",
    experiences: ["coffee_treats"],
    ambiences: ["quiet"],
    formats: ["seated"],
    hardConstraints: {
      dietary: [],
      alcoholFree: false,
      stepFree: false,
      setting: null,
      maxPrice: null,
      maxCommuteKm: 8,
    },
    parserConfidence: 0.9,
    parserVersion: "venue-intent-v2",
    state: "confirmed",
    origin: ORIGIN,
    interpretedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    manualConfirmationRequired: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every participant is a Kyiv account unless a test says otherwise, so the
  // departure-point gate passes for the shared `ORIGIN` (Khreshchatyk).
  profileFindUnique.mockResolvedValue({ homeCityKey: "ua:kyiv" });
  callOpenAIJson.mockResolvedValue({
    experiences: ["coffee_treats"],
    ambiences: ["quiet"],
    formats: ["seated"],
    confidence: 0.8,
  });
});

describe("interpretVenueIntent (VENUE-1)", () => {
  it("writes a fresh draft when nothing is stored yet for this side", async () => {
    matchFindUnique.mockResolvedValue(baseMatch());
    txMatchFindUnique.mockResolvedValue({ venueIntentA: null, venueIntentB: null });

    const draft = await interpretVenueIntent(MATCH_ID, USER_A, "quiet cafe please", ORIGIN);

    expect(draft).not.toBeNull();
    expect(asIntent(draft).state).toBe("draft");
    expect(txQueryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("FOR UPDATE"),
      MATCH_ID,
    );
    expect(txMatchUpdate).toHaveBeenCalledTimes(1);
    const updateArg = txMatchUpdate.mock.calls[0]![0];
    expect(updateArg.where).toEqual({ id: MATCH_ID });
    expect(updateArg.data.venueIntentA.state).toBe("draft");
  });

  it("does NOT overwrite an already-confirmed own-side intent, and returns it unchanged", async () => {
    const existing = confirmedIntent();
    matchFindUnique.mockResolvedValue(baseMatch({ venueIntentA: existing }));
    // Re-read inside the lock sees the same confirmed value.
    txMatchFindUnique.mockResolvedValue({ venueIntentA: existing, venueIntentB: null });

    const result = await interpretVenueIntent(MATCH_ID, USER_A, "actually let's do drinks", ORIGIN);

    expect(result).not.toBeNull();
    expect(asIntent(result).state).toBe("confirmed");
    expect(asIntent(result).experiences).toEqual(["coffee_treats"]);
    // The critical assertion: no write happened, so the confirmed intent
    // cannot have been reverted to a draft.
    expect(txMatchUpdate).not.toHaveBeenCalled();
  });

  it("still writes a draft for OWN side when the OTHER side is confirmed (guard is per-side)", async () => {
    const partnerConfirmed = confirmedIntent();
    matchFindUnique.mockResolvedValue(baseMatch({ venueIntentB: partnerConfirmed }));
    txMatchFindUnique.mockResolvedValue({ venueIntentA: null, venueIntentB: partnerConfirmed });

    const draft = await interpretVenueIntent(MATCH_ID, USER_A, "quiet cafe please", ORIGIN);

    expect(draft).not.toBeNull();
    expect(asIntent(draft).state).toBe("draft");
    expect(txMatchUpdate).toHaveBeenCalledTimes(1);
    const updateArg = txMatchUpdate.mock.calls[0]![0];
    // Only the caller's own side (A) is written — partner's confirmed B is untouched.
    expect(updateArg.data.venueIntentA).toBeDefined();
    expect(updateArg.data.venueIntentB).toBeUndefined();
  });

  it("returns null when the match is not in negotiating_venue (no lock/transaction taken)", async () => {
    matchFindUnique.mockResolvedValue(baseMatch({ status: "scheduled" }));

    const result = await interpretVenueIntent(MATCH_ID, USER_A, "quiet cafe please", ORIGIN);

    expect(result).toBeNull();
    expect(prismaTransaction).not.toHaveBeenCalled();
  });

  it("returns null for a non-participant", async () => {
    matchFindUnique.mockResolvedValue(baseMatch());

    const result = await interpretVenueIntent(MATCH_ID, "not-a-participant", "quiet cafe please", ORIGIN);

    expect(result).toBeNull();
  });
});

describe("interpretVenueIntent — departure-point gate (PRODUCT_SPEC §3.7)", () => {
  const BERLIN = { lat: 52.525, lng: 13.369, address: "Berlin Hauptbahnhof" };

  it("refuses an origin outside the caller's market and writes nothing", async () => {
    matchFindUnique.mockResolvedValue(baseMatch());

    const result = await interpretVenueIntent(MATCH_ID, USER_A, "quiet cafe please", BERLIN);

    expect(isVenueOriginRefusal(result)).toBe(true);
    if (!isVenueOriginRefusal(result)) throw new Error("expected a refusal");
    expect(result.market.city).toBe("Kyiv");
    // The refusal is decided before the OpenAI call and before the row lock, so
    // a bad pin costs neither a token nor a transaction.
    expect(callOpenAIJson).not.toHaveBeenCalled();
    expect(prismaTransaction).not.toHaveBeenCalled();
  });

  it("does not gate when the caller's dating city is not a launched market", async () => {
    // A legacy account: blocking someone over a gap in OUR data is never right.
    profileFindUnique.mockResolvedValue({ homeCityKey: "de:berlin" });
    matchFindUnique.mockResolvedValue(baseMatch());
    txMatchFindUnique.mockResolvedValue({ venueIntentA: null, venueIntentB: null });

    const result = await interpretVenueIntent(MATCH_ID, USER_A, "quiet cafe please", BERLIN);

    expect(asIntent(result).state).toBe("draft");
  });

  it("does not gate a call that carries no origin at all", async () => {
    matchFindUnique.mockResolvedValue(baseMatch());
    txMatchFindUnique.mockResolvedValue({ venueIntentA: null, venueIntentB: null });

    const result = await interpretVenueIntent(MATCH_ID, USER_A, "quiet cafe please", null);

    expect(asIntent(result).state).toBe("draft");
    expect(profileFindUnique).not.toHaveBeenCalled();
  });
});

describe("hoursEvidenceAdmits (PRODUCT_SPEC §3.7 — hours evidence)", () => {
  // A Tuesday, 18:00 Kyiv. Inside a 10:00–20:00 schedule, outside a 09:00–17:00 one.
  const SLOT = new Date("2026-08-11T15:00:00Z");
  const KYIV_OFFSET = 180;
  const OPEN_10_TO_20 = {
    periods: [
      { open: { day: 2, hour: 10, minute: 0 }, close: { day: 2, hour: 20, minute: 0 } },
    ],
  };
  const OPEN_09_TO_17 = {
    periods: [
      { open: { day: 2, hour: 9, minute: 0 }, close: { day: 2, hour: 17, minute: 0 } },
    ],
  };

  // The whole reason this function is exported. Google publishes no hours for a
  // street or an embankment, so without the mark these rows sit in the catalog
  // looking healthy and are never assigned — which is exactly what happened to
  // six Kyiv parks. If this test ever fails, every one of them goes dark again.
  it("admits an hourless public space that the operator marked always_open", () => {
    expect(
      hoursEvidenceAdmits(
        { hoursConfidence: "always_open", openingHours: null, utcOffsetMinutes: KYIV_OFFSET },
        SLOT,
      ),
    ).toBe(true);
  });

  it("refuses the same venue when nobody marked it", () => {
    for (const hoursConfidence of ["unknown", "provider", null]) {
      expect(
        hoursEvidenceAdmits(
          { hoursConfidence, openingHours: null, utcOffsetMinutes: KYIV_OFFSET },
          SLOT,
        ),
      ).toBe(false);
    }
  });

  // always_open means always — the mark is only ever put on somewhere that has
  // no closing time, so a stray schedule must not be able to override it.
  it("keeps admitting an always_open venue even against a closed schedule", () => {
    expect(
      hoursEvidenceAdmits(
        { hoursConfidence: "always_open", openingHours: OPEN_09_TO_17, utcOffsetMinutes: KYIV_OFFSET },
        SLOT,
      ),
    ).toBe(true);
  });

  // operator_confirmed clears the evidence bar but still honours the schedule —
  // it is for a venue whose hours we trust and did not get from Places.
  it("honours a recorded schedule for operator_confirmed", () => {
    const row = { hoursConfidence: "operator_confirmed", utcOffsetMinutes: KYIV_OFFSET };
    expect(hoursEvidenceAdmits({ ...row, openingHours: OPEN_10_TO_20 }, SLOT)).toBe(true);
    expect(hoursEvidenceAdmits({ ...row, openingHours: OPEN_09_TO_17 }, SLOT)).toBe(false);
    // ...and admits it with no schedule at all, unlike an unmarked row.
    expect(hoursEvidenceAdmits({ ...row, openingHours: null }, SLOT)).toBe(true);
  });

  it("falls through to the recorded schedule for an ordinary provider row", () => {
    const row = { hoursConfidence: "provider", utcOffsetMinutes: KYIV_OFFSET };
    expect(hoursEvidenceAdmits({ ...row, openingHours: OPEN_10_TO_20 }, SLOT)).toBe(true);
    expect(hoursEvidenceAdmits({ ...row, openingHours: OPEN_09_TO_17 }, SLOT)).toBe(false);
  });

  // A schedule we cannot place on a wall clock is not evidence.
  it("refuses a schedule with no timezone offset", () => {
    expect(
      hoursEvidenceAdmits(
        { hoursConfidence: "provider", openingHours: OPEN_10_TO_20, utcOffsetMinutes: null },
        SLOT,
      ),
    ).toBe(false);
  });
});
