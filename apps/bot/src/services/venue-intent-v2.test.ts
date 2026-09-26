import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultVenueHardConstraints, t } from "@gennety/shared";

const testEnv = vi.hoisted(() => ({
  VENUE_INTENT_V2_ENABLED: true,
  VENUE_INTENT_V2_ROLLOUT_PERCENT: 0,
  VENUE_INTENT_V2_SHADOW_PERCENT: 100,
}));

vi.mock("../config.js", () => ({ env: testEnv }));

const matchFindUnique = vi.fn();
const matchFindMany = vi.fn();
const matchUpdate = vi.fn();
const matchUpdateMany = vi.fn();
const curatedFindMany = vi.fn();
const selectionLogCreate = vi.fn();
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
    match: {
      findUnique: matchFindUnique,
      findMany: matchFindMany,
      update: matchUpdate,
      updateMany: matchUpdateMany,
    },
    curatedVenue: { findMany: curatedFindMany },
    venueSelectionLog: { create: selectionLogCreate },
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

// The selection pipeline's side doors, stubbed so a finalize can run offline.
// No Bot API: the in-chat status shimmer and the chat notices stand down, and
// the pair is reached through the push the mobile-side fixtures use instead.
vi.mock("../public/server.js", () => ({ getBotApi: () => null }));
vi.mock("./weather.js", () => ({ fetchWeatherForecast: vi.fn().mockResolvedValue(null) }));
const sendPushToUser = vi.fn();
vi.mock("./push.js", () => ({ sendPushToUser: (...args: unknown[]) => sendPushToUser(...args) }));
const notifyFounderVenueSelectionFailure = vi.fn();
vi.mock("./founder-notify.js", () => ({
  notifyFounderVenueSelectionFailure: (...args: unknown[]) => notifyFounderVenueSelectionFailure(...args),
}));
const returnLapsedVenueStageToCalendar = vi.fn();
vi.mock("./venue-time-lapse.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./venue-time-lapse.js")>()),
  returnLapsedVenueStageToCalendar: (...args: unknown[]) => returnLapsedVenueStageToCalendar(...args),
}));

const {
  interpretVenueIntent,
  confirmVenueIntent,
  hoursEvidenceAdmits,
  decidePlacesSweep,
  chooseHubFallback,
  tryFinalizeVenueIntentV2,
  retryDueVenueSelections,
} = await import("./venue-intent-v2.js");
type HubCandidateRow = Parameters<typeof chooseHubFallback>[0][number];
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

/** Every match in this file is shadow traffic unless a test opts into live. */
function goLive(): void {
  testEnv.VENUE_INTENT_V2_ROLLOUT_PERCENT = 100;
}

afterEach(() => {
  testEnv.VENUE_INTENT_V2_ROLLOUT_PERCENT = 0;
});

beforeEach(() => {
  vi.clearAllMocks();
  matchUpdateMany.mockResolvedValue({ count: 1 });
  curatedFindMany.mockResolvedValue([]);
  selectionLogCreate.mockResolvedValue({});
  sendPushToUser.mockResolvedValue(true);
  notifyFounderVenueSelectionFailure.mockResolvedValue(undefined);
  returnLapsedVenueStageToCalendar.mockResolvedValue(true);
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
    txMatchFindUnique.mockResolvedValue({ status: "negotiating_venue", venueIntentA: null, venueIntentB: null });

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
    txMatchFindUnique.mockResolvedValue({ status: "negotiating_venue", venueIntentA: existing, venueIntentB: null });

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
    txMatchFindUnique.mockResolvedValue({ status: "negotiating_venue", venueIntentA: null, venueIntentB: partnerConfirmed });

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

  it("does not write if the match closes after the initial read but before the row lock", async () => {
    matchFindUnique.mockResolvedValue(baseMatch());
    txMatchFindUnique.mockResolvedValue({ status: "cancelled", venueIntentA: null, venueIntentB: null });

    const result = await interpretVenueIntent(MATCH_ID, USER_A, "quiet cafe please", ORIGIN);

    expect(result).toBeNull();
    expect(txMatchUpdate).not.toHaveBeenCalled();
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
    txMatchFindUnique.mockResolvedValue({ status: "negotiating_venue", venueIntentA: null, venueIntentB: null });

    const result = await interpretVenueIntent(MATCH_ID, USER_A, "quiet cafe please", BERLIN);

    expect(asIntent(result).state).toBe("draft");
  });

  it("does not gate a call that carries no origin at all", async () => {
    matchFindUnique.mockResolvedValue(baseMatch());
    txMatchFindUnique.mockResolvedValue({ status: "negotiating_venue", venueIntentA: null, venueIntentB: null });

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

/**
 * The hub fallback (2026-09-11) — where a pair goes instead of the
 * `no_candidates` dead end. It may drop the pair's taste, never the venue's
 * fitness for two strangers: open at the slot, a Maps link, the quality floor.
 */
describe("chooseHubFallback — the no_candidates dead end", () => {
  // A Tuesday, 18:00 Kyiv — the same slot the hours-evidence tests use.
  const SLOT = new Date("2026-08-11T15:00:00Z");
  const CENTRE = { lat: 50.4501, lng: 30.5234 };
  const MIDPOINT = { lat: 50.45, lng: 30.52 };
  const context = { agreedTime: SLOT, midpoint: MIDPOINT, centre: CENTRE };
  const OPEN_09_TO_17 = {
    periods: [{ open: { day: 2, hour: 9, minute: 0 }, close: { day: 2, hour: 17, minute: 0 } }],
  };

  function row(overrides: Partial<HubCandidateRow> = {}): HubCandidateRow {
    return {
      id: "central",
      name: "Central cafe",
      address: "Khreshchatyk 1",
      // ~50 m from the market centre.
      lat: 50.4505,
      lng: 30.5238,
      googleMapsUri: "https://maps.google.com/?cid=1",
      placeId: "place-central",
      category: "cafe",
      tier: "base",
      priority: 2,
      rating: 4.6,
      userRatingCount: 900,
      priceLevel: "PRICE_LEVEL_MODERATE",
      facetTags: [],
      hardCapabilities: [],
      vibeTags: [],
      hoursConfidence: "always_open",
      openingHours: null,
      utcOffsetMinutes: 180,
      photoRefs: [],
      isHubFallback: false,
      ...overrides,
    };
  }

  it("returns null when the city has nothing eligible", () => {
    expect(chooseHubFallback([], context)).toBeNull();
    expect(chooseHubFallback([row({ googleMapsUri: null })], context)).toBeNull();
  });

  it("always prefers the pinned hub over a closer, better-rated unpinned cafe", () => {
    const pinned = row({ id: "pinned", lat: 50.4486, lng: 30.5133, rating: 4.5, isHubFallback: true });
    const better = row({ id: "better", rating: 4.9, priority: 1 });
    expect(chooseHubFallback([better, pinned], context)?.id).toBe("pinned");
  });

  it("never sends a pair to a pinned hub that is closed at the slot", () => {
    const closed = row({
      id: "pinned-closed",
      isHubFallback: true,
      hoursConfidence: "provider",
      openingHours: OPEN_09_TO_17,
    });
    const open = row({ id: "open" });
    expect(chooseHubFallback([closed, open], context)?.id).toBe("open");
  });

  it("picks the pinned hub nearest the pair's midpoint when a city pins several", () => {
    const rightBank = row({ id: "right-bank", lat: 50.4486, lng: 30.5133, isHubFallback: true });
    const leftBank = row({ id: "left-bank", lat: 50.4613, lng: 30.6384, isHubFallback: true });
    expect(chooseHubFallback([leftBank, rightBank], context)?.id).toBe("right-bank");
    const leftMidpoint = { ...context, midpoint: { lat: 50.46, lng: 30.63 } };
    expect(chooseHubFallback([leftBank, rightBank], leftMidpoint)?.id).toBe("left-bank");
  });

  it("without a pin, takes the most central eligible cafe over a better one across town", () => {
    const acrossTown = row({ id: "across-town", lat: 50.51, lng: 30.6, rating: 4.9, priority: 1 });
    const central = row({ id: "central" });
    expect(chooseHubFallback([acrossTown, central], context)?.id).toBe("central");
  });

  it("prefers a cafe to a restaurant in the same spot", () => {
    const restaurant = row({ id: "restaurant", category: "restaurant", priority: 1 });
    const cafe = row({ id: "cafe" });
    expect(chooseHubFallback([restaurant, cafe], context)?.id).toBe("cafe");
  });

  it("keeps the quality floor — a badly rated cafe is never the hub, pinned or not", () => {
    const bad = row({ id: "bad", rating: 3.1, isHubFallback: true });
    expect(chooseHubFallback([bad], context)).toBeNull();
  });
});

/**
 * The Places spend gate.
 *
 * Google Places is the documented FALLBACK to the first-party `curated_venues`
 * base, and until 2026-09-04 this path ignored that: it counted the eligible
 * curated rows into `curatedEligible` and then ran the search anyway, up to
 * three categories, on every single assignment — the most expensive request
 * this product can issue, spent to widen a pool that already held ~186 venues
 * in Kyiv.
 *
 * The distinctions between the three SKIPS are load-bearing, not cosmetic: one
 * of them is an infra alarm, one is terminal, and one is reversible. Collapsing
 * any two of them either re-spends the money or mislabels the failure.
 */
describe("decidePlacesSweep — the Places spend gate", () => {
  const base = {
    hasApiKey: true,
    liveSearchEnabled: true,
    reachable: true,
    curatedEligible: 0,
    threshold: 12,
  };

  it("searches when the curated pool is too thin to choose from", () => {
    expect(decidePlacesSweep({ ...base, curatedEligible: 11 })).toBe("search");
  });

  it("skips the search once the curated pool reaches the threshold", () => {
    // The whole saving, in one assertion. A Kyiv pair sits here.
    expect(decidePlacesSweep({ ...base, curatedEligible: 12 })).toBe("skip-curated-deep");
    expect(decidePlacesSweep({ ...base, curatedEligible: 200 })).toBe("skip-curated-deep");
  });

  it("treats threshold 0 as 'never search'", () => {
    // The operator's off switch: a market whose catalog is trusted completely.
    expect(decidePlacesSweep({ ...base, threshold: 0 })).toBe("skip-curated-deep");
  });

  it("reports a missing key as the provider being unavailable", () => {
    // The ONLY skip that may become `provider_unavailable` — which is the
    // failure reason that schedules a retry and pages the founder.
    expect(decidePlacesSweep({ ...base, hasApiKey: false })).toBe("skip-provider-unavailable");
  });

  it("reports the demo runtime the same way, since it has no provider of its own", () => {
    // Demo inherits production's PLACES_API_KEY through its generated .env, so
    // the denial is code-owned (`demo/config.ts`) rather than key-shaped.
    expect(decidePlacesSweep({ ...base, liveSearchEnabled: false })).toBe(
      "skip-provider-unavailable",
    );
  });

  it("does NOT call unreachable origins a provider failure", () => {
    // Two origins no venue can sit between is a geometric fact about the pair.
    // Labelling it `provider_unavailable` bought three retries of an
    // impossibility and pointed the alarm at Google.
    expect(decidePlacesSweep({ ...base, reachable: false })).toBe("skip-unreachable");
  });

  it("ranks the reasons so a real outage is never hidden behind a full catalog", () => {
    // A deep pool plus no key must still say "no key": the caller reverses
    // `skip-curated-deep` when nothing ranks, and reversing it into a sweep
    // that cannot run would spin.
    expect(
      decidePlacesSweep({ ...base, hasApiKey: false, curatedEligible: 500 }),
    ).toBe("skip-provider-unavailable");
  });
});

// ---------------------------------------------------------------------------
// Finalization: a lapsed date (A13-H5) and a selection that cannot finish (A13-H6)
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;

/** Both sides confirmed from a mobile client, so the pair is reachable by push. */
function finalizeRow(overrides: Record<string, unknown> = {}) {
  const user = (id: string) => ({
    id,
    telegramId: 0n,
    platform: "mobile",
    language: "en",
    theme: "dark",
    universityDomain: null,
    profile: { homeCityKey: "ua:kyiv" },
  });
  return {
    id: MATCH_ID,
    status: "negotiating_venue",
    agreedTime: new Date(Date.now() + 24 * HOUR),
    venueIntentA: confirmedIntent(),
    venueIntentB: confirmedIntent(),
    userA: user(USER_A),
    userB: user(USER_B),
    ...overrides,
  };
}

describe("finalizeVenueIntentV2 — a date that ran out of runway (A13-H5)", () => {
  it("REGRESSION: sends a live pair back to the calendar instead of selecting a venue for a passed time", async () => {
    goLive();
    matchFindUnique.mockResolvedValue(finalizeRow({ agreedTime: new Date(Date.now() - HOUR) }));

    await tryFinalizeVenueIntentV2(MATCH_ID);

    expect(returnLapsedVenueStageToCalendar).toHaveBeenCalledWith(MATCH_ID);
    // No search was bought and nothing was locked.
    expect(curatedFindMany).not.toHaveBeenCalled();
    expect(matchUpdateMany).not.toHaveBeenCalled();
  });

  it("leaves a shadow run's lapse to the authoritative legacy path", async () => {
    matchFindUnique.mockResolvedValue(finalizeRow({ agreedTime: new Date(Date.now() - HOUR) }));

    await tryFinalizeVenueIntentV2(MATCH_ID);

    expect(returnLapsedVenueStageToCalendar).not.toHaveBeenCalled();
    expect(curatedFindMany).not.toHaveBeenCalled();
  });

  it("refuses a confirmation for a date without runway, and writes nothing", async () => {
    goLive();
    matchFindUnique.mockResolvedValue(
      baseMatch({
        agreedTime: new Date(Date.now() + 5 * 60_000),
        venueIntentA: confirmedIntent({ state: "draft", confirmedAt: null }),
      }),
    );

    const result = await confirmVenueIntent(MATCH_ID, USER_A, {
      experiences: ["coffee_treats"],
      ambiences: ["quiet"],
      formats: ["seated"],
      hardConstraints: defaultVenueHardConstraints(),
      origin: ORIGIN,
    });

    expect(result).toBeNull();
    expect(matchUpdate).not.toHaveBeenCalled();
    expect(returnLapsedVenueStageToCalendar).toHaveBeenCalledWith(MATCH_ID);
  });
});

describe("finalizeVenueIntentV2 — a selection that cannot finish (A13-H6)", () => {
  it("REGRESSION: a run that throws is recorded as a failed attempt with a bounded retry, not lost", async () => {
    goLive();
    matchFindUnique
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce({ ...finalizeRow(), venueSelectionAttempts: 0 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(tryFinalizeVenueIntentV2(MATCH_ID)).resolves.toBeUndefined();

    expect(matchUpdateMany).toHaveBeenCalledTimes(1);
    const write = matchUpdateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: { venueSelectionAttempts: number; venueSelectionError: string; venueSelectionNextRetryAt: Date | null };
    };
    expect(write.where).toEqual({ id: MATCH_ID, status: "negotiating_venue", venueSelectionAttempts: 0 });
    expect(write.data.venueSelectionAttempts).toBe(1);
    expect(write.data.venueSelectionError).toBe("selection_failed");
    expect(write.data.venueSelectionNextRetryAt).toBeInstanceOf(Date);
    // Not terminal yet: nobody is disturbed.
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(notifyFounderVenueSelectionFailure).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("after the last attempt: no retry, the pair is told how to try again, the founder is alerted", async () => {
    goLive();
    matchFindUnique
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce({ ...finalizeRow(), venueSelectionAttempts: 2 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await tryFinalizeVenueIntentV2(MATCH_ID);

    const write = matchUpdateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(write.data).toMatchObject({ venueSelectionAttempts: 3, venueSelectionNextRetryAt: null });
    expect(sendPushToUser).toHaveBeenCalledTimes(2);
    expect(sendPushToUser.mock.calls[0]![1]).toMatchObject({ body: t("en", "venueSelectionFailedRetry") });
    expect(notifyFounderVenueSelectionFailure).toHaveBeenCalledWith(MATCH_ID, "selection_failed", 3);
    errors.mockRestore();
  });

  it("a terminal provider failure with no hub open leaves no retry and tells the pair what to do", async () => {
    goLive();
    const previousKey = process.env.PLACES_API_KEY;
    delete process.env.PLACES_API_KEY;
    matchFindUnique
      .mockResolvedValueOnce(finalizeRow())
      .mockResolvedValueOnce({ venueSelectionAttempts: 2 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await tryFinalizeVenueIntentV2(MATCH_ID);
    } finally {
      if (previousKey !== undefined) process.env.PLACES_API_KEY = previousKey;
      warn.mockRestore();
    }

    const write = matchUpdateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // Guarded on the stage, so a run that outlived it plants nothing.
    expect(write.where).toEqual({ id: MATCH_ID, status: "negotiating_venue" });
    expect(write.data).toMatchObject({
      venueSelectionAttempts: 3,
      venueSelectionError: "provider_unavailable",
      venueSelectionNextRetryAt: null,
    });
    expect(sendPushToUser.mock.calls[0]![1]).toMatchObject({ body: t("en", "venueSelectionFailedRetry") });
    expect(notifyFounderVenueSelectionFailure).toHaveBeenCalledWith(MATCH_ID, "provider_unavailable", 3);
  });

  it("tells nobody when the row left the venue stage while the search ran", async () => {
    goLive();
    const previousKey = process.env.PLACES_API_KEY;
    delete process.env.PLACES_API_KEY;
    matchFindUnique
      .mockResolvedValueOnce(finalizeRow())
      .mockResolvedValueOnce({ venueSelectionAttempts: 2 });
    matchUpdateMany.mockResolvedValue({ count: 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await tryFinalizeVenueIntentV2(MATCH_ID);
    } finally {
      if (previousKey !== undefined) process.env.PLACES_API_KEY = previousKey;
      warn.mockRestore();
    }

    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(notifyFounderVenueSelectionFailure).not.toHaveBeenCalled();
  });

  it("never messages a shadow pair about a V2 failure — their flow is the legacy one", async () => {
    const previousKey = process.env.PLACES_API_KEY;
    delete process.env.PLACES_API_KEY;
    matchFindUnique
      .mockResolvedValueOnce(finalizeRow())
      .mockResolvedValueOnce({ venueSelectionAttempts: 2 });

    try {
      await tryFinalizeVenueIntentV2(MATCH_ID);
    } finally {
      if (previousKey !== undefined) process.env.PLACES_API_KEY = previousKey;
    }

    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(notifyFounderVenueSelectionFailure).toHaveBeenCalledTimes(1);
  });

  it("claims a due retry before running it, so a run that writes nothing cannot hog the sweep", async () => {
    const due = new Date(Date.now() - 60_000);
    matchFindMany.mockResolvedValue([{ id: MATCH_ID, venueSelectionNextRetryAt: due }]);
    // The run finds nothing to do (the row is gone) and writes nothing.
    matchFindUnique.mockResolvedValue(null);

    expect(await retryDueVenueSelections()).toBe(1);

    expect(matchUpdateMany).toHaveBeenCalledWith({
      where: { id: MATCH_ID, status: "negotiating_venue", venueSelectionNextRetryAt: due },
      data: { venueSelectionNextRetryAt: null },
    });
  });

  it("skips a retry another process already claimed", async () => {
    matchFindMany.mockResolvedValue([{ id: MATCH_ID, venueSelectionNextRetryAt: new Date() }]);
    matchUpdateMany.mockResolvedValue({ count: 0 });

    expect(await retryDueVenueSelections()).toBe(0);
    expect(matchFindUnique).not.toHaveBeenCalled();
  });
});
