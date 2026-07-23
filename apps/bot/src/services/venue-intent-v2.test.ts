import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  env: {
    VENUE_INTENT_V2_ENABLED: true,
    VENUE_INTENT_V2_ROLLOUT_PERCENT: 0,
    VENUE_INTENT_V2_SHADOW_PERCENT: 100,
  },
}));

const matchFindUnique = vi.fn();
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
    $transaction: prismaTransaction,
  },
  Prisma: {},
}));

const callOpenAIJson = vi.fn();
vi.mock("./openai.js", () => ({
  callOpenAIJson: (...args: unknown[]) => callOpenAIJson(...args),
}));

const { interpretVenueIntent } = await import("./venue-intent-v2.js");

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
    expect(draft!.state).toBe("draft");
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
    expect(result!.state).toBe("confirmed");
    expect(result!.experiences).toEqual(["coffee_treats"]);
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
    expect(draft!.state).toBe("draft");
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
