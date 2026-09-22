import { SUPPORTED_LANGUAGES } from "@gennety/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks. `venue_change_activities` is an in-memory table with the real key
// (match, user) and real compare-and-set `where`s, so the apply layer is tested
// against the same claim semantics Postgres gives it — a mock that answered
// `{ count: 1 }` to everything would pass a sync that double-starts a card.
// ---------------------------------------------------------------------------

interface Row {
  matchId: string;
  userId: string;
  phase: string;
  contentHash: string;
  startedAt: Date;
}
const table: Row[] = [];

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    const value = row[k as keyof Row];
    return v instanceof Date && value instanceof Date ? v.getTime() === value.getTime() : value === v;
  });
}

const vcaCreate = vi.fn(async ({ data }: { data: Row }) => {
  if (table.some((r) => r.matchId === data.matchId && r.userId === data.userId)) {
    throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  }
  table.push({ ...data });
  return data;
});
const vcaUpdateMany = vi.fn(
  async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
    const hit = table.filter((r) => matches(r, where));
    for (const r of hit) Object.assign(r, data);
    return { count: hit.length };
  },
);
const vcaDeleteMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
  const before = table.length;
  for (let i = table.length - 1; i >= 0; i--) if (matches(table[i]!, where)) table.splice(i, 1);
  return { count: before - table.length };
});
const vcaFindMany = vi.fn(
  async (args: { where?: { matchId?: string }; distinct?: string[] } = {}) => {
    const rows = table.filter((r) => !args.where?.matchId || r.matchId === args.where.matchId);
    if (args.distinct) {
      return [...new Set(rows.map((r) => r.matchId))].map((matchId) => ({ matchId }));
    }
    return rows.map((r) => ({ ...r }));
  },
);
const matchFindUnique = vi.fn();
const tokenFindUnique = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: matchFindUnique },
    liveActivityToken: { findUnique: tokenFindUnique },
    venueChangeActivity: {
      create: vcaCreate,
      updateMany: vcaUpdateMany,
      deleteMany: vcaDeleteMany,
      findMany: vcaFindMany,
    },
  },
}));

vi.mock("../config.js", () => ({
  env: {
    VENUE_CHANGE_FEATURE_ENABLED: true,
    VENUE_CHANGE_STARS: 150,
    WEBAPP_URL: "https://app.test",
  },
}));

const sendLiveActivityStartToUser = vi.fn();
const sendLiveActivityUpdateToUser = vi.fn();
vi.mock("./push.js", () => ({ sendLiveActivityStartToUser, sendLiveActivityUpdateToUser }));

// Real envelope builders (a copy would measure the copy), fake credentials.
vi.mock("./apns.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./apns.js")>();
  return { ...original, apnsConfigured: () => true };
});
const { buildLiveActivityPayload, buildLiveActivityStartPayload } = await import("./apns.js");

const {
  VENUE_CHANGE_ATTRIBUTES_TYPE,
  decideVenueChangeActivity,
  desiredVenueChangeActivities,
  venueChangeAlert,
  venueChangeContentHash,
  venueChangeEndInput,
  venueChangeStartInput,
  venueChangeUpdateInput,
  syncVenueChangeActivities,
  sweepVenueChangeActivities,
} = await import("./venue-change-activity.js");
type Desired = import("./venue-change-activity.js").DesiredVenueChangeActivity;
type Content = import("./venue-change-activity.js").VenueChangeContentState;
const { KEEP_KEY } = await import("../handlers/matching/venue-change.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-09-22T10:00:00.000Z");
const DATE_AT = new Date("2026-09-23T19:00:00.000Z");
const CUTOFF_S = Math.floor((DATE_AT.getTime() - 5 * HOUR) / 1000);
const AGREED_EXPIRES = new Date(NOW.getTime() + 12 * HOUR);
const AGREED_EXPIRES_S = Math.floor(AGREED_EXPIRES.getTime() / 1000);
const MATCH_ID = "11111111-1111-4111-8111-111111111111";

function like(key: string, name: string) {
  return {
    key,
    placeId: key,
    name,
    address: `${name} St`,
    lat: 50.451,
    lng: 30.521,
    mapsUri: null,
    category: "cafe",
    tier: "base",
    photoRef: null,
  };
}
const CAFE = like("p1", "Kyiv Food Market");
const PARK = like("p2", "Park Spot");
const BAR = like("p3", "Barista Bar");
const DECK = like("p4", "Roof Deck");
const TEA = like("p5", "Tea House");

/** A = Alina (female), B = Max (male) — a hetero pair, so the man pays. */
function match(over: Record<string, unknown> = {}) {
  return {
    id: MATCH_ID,
    status: "scheduled",
    agreedTime: DATE_AT,
    venueName: "Old Cafe",
    venueAddress: "Old St",
    venueLat: 50.45,
    venueLng: 30.52,
    venueGoogleMapsUri: null,
    venuePlaceId: "old",
    venuePhotoName: null,
    venueChangeStatus: null as string | null,
    venueChangeProposerId: null as string | null,
    venueChangeProposedAt: null,
    venueChangeExpiresAt: null as Date | null,
    venueChangeResolvedAt: null,
    venueChangeName: null as string | null,
    venueChangeAddress: null,
    venueChangeLat: null,
    venueChangeLng: null,
    venueChangeMapsUri: null,
    venueChangePlaceId: null,
    venueChangePhotoName: null,
    venueChangePaidById: null,
    venueChangePaidAt: null as Date | null,
    venueChangePayDeclinedAt: null,
    venueChangeOfferPaySentAt: null as Date | null,
    venueChangePingSentToAAt: null,
    venueChangePingSentToBAt: null,
    venueChangePingMsgIdA: null,
    venueChangePingMsgIdB: null,
    venueChangeExpressAt: null as Date | null,
    venueChangeTier: null,
    venueChangeCount: 0,
    venueLikesA: [] as unknown[],
    venueLikesB: [] as unknown[],
    userAId: "a",
    userBId: "b",
    userA: {
      id: "a",
      telegramId: -100n,
      platform: "mobile",
      language: "ru",
      theme: "dark",
      gender: "female",
      firstName: "Алина",
      universityDomain: null,
      premiumUntil: null,
      profile: { homeCityKey: "ua:kyiv" },
    },
    userB: {
      id: "b",
      telegramId: -200n,
      platform: "mobile",
      language: "en",
      theme: "dark",
      gender: "male",
      firstName: "Max",
      universityDomain: null,
      premiumUntil: null,
      profile: { homeCityKey: "ua:kyiv" },
    },
    ...over,
  };
}

function agreed(over: Record<string, unknown> = {}) {
  return match({
    venueChangeStatus: "agreed",
    venueChangeProposerId: "a",
    venueChangeExpiresAt: AGREED_EXPIRES,
    venueChangeName: "Kyiv Food Market",
    venueLikesA: [CAFE],
    venueLikesB: [CAFE],
    ...over,
  });
}

type M = Parameters<typeof desiredVenueChangeActivities>[0];
const desired = (m: ReturnType<typeof match>, now = NOW) =>
  desiredVenueChangeActivities(m as unknown as M, now);

function shown(d: Desired): Content {
  if (d.kind !== "show") throw new Error(`expected a card, got ${d.kind}`);
  return d.content;
}

beforeEach(() => {
  table.length = 0;
  matchFindUnique.mockReset();
  tokenFindUnique.mockReset().mockResolvedValue({ id: "start-token" });
  sendLiveActivityStartToUser.mockReset().mockResolvedValue(true);
  sendLiveActivityUpdateToUser.mockReset().mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Phase derivation — both sides, every state
// ---------------------------------------------------------------------------

describe("phase derivation", () => {
  it("no session: no card on either side", () => {
    const d = desired(match());
    expect(d.A.desired).toEqual({ kind: "none", resolution: null, finalContent: null });
    expect(d.B.desired).toEqual({ kind: "none", resolution: null, finalContent: null });
  });

  it("one side marked, the other nothing: waiting for me, partner for them", () => {
    const d = desired(match({ venueChangeStatus: "liking", venueChangeProposerId: "a", venueLikesA: [CAFE] }));

    expect(shown(d.A.desired)).toEqual({
      phase: "waiting",
      partnerFirstName: "Max",
      partnerGender: "male",
      myPickName: "Kyiv Food Market",
      myPickCount: 1,
      partnerPickNames: [],
      partnerPickCount: 0,
      agreedName: null,
      deadline: CUTOFF_S,
    });
    expect(shown(d.B.desired)).toEqual({
      phase: "partner",
      partnerFirstName: "Алина",
      partnerGender: "female",
      myPickName: null,
      myPickCount: 0,
      partnerPickNames: ["Kyiv Food Market"],
      partnerPickCount: 1,
      agreedName: null,
      deadline: CUTOFF_S,
    });
  });

  it("waiting names my pick only when there is exactly one", () => {
    const d = desired(match({ venueChangeStatus: "liking", venueLikesA: [CAFE, PARK] }));
    const a = shown(d.A.desired);
    expect(a.phase).toBe("waiting");
    expect(a.myPickName).toBeNull();
    expect(a.myPickCount).toBe(2);
  });

  it("partner lists only the marks I have NOT made — three names, the rest as a count", () => {
    const d = desired(
      match({
        venueChangeStatus: "liking",
        venueLikesA: [CAFE],
        venueLikesB: [CAFE, PARK, BAR, DECK, TEA],
      }),
    );
    const a = shown(d.A.desired);
    expect(a.phase).toBe("partner");
    expect(a.partnerPickNames).toEqual(["Park Spot", "Barista Bar", "Roof Deck"]);
    expect(a.partnerPickCount).toBe(4);
    expect(a.myPickName).toBe("Kyiv Food Market");
    // Every one of mine is also theirs → nothing new for B to look at, and B is
    // not waiting either (A has marks): no card.
    expect(d.B.desired.kind).toBe("none");
  });

  it("both sides with marks the other lacks: both see partner", () => {
    const d = desired(match({ venueChangeStatus: "liking", venueLikesA: [CAFE], venueLikesB: [PARK] }));
    expect(shown(d.A.desired).partnerPickNames).toEqual(["Park Spot"]);
    expect(shown(d.B.desired).partnerPickNames).toEqual(["Kyiv Food Market"]);
  });

  it("an overlap waiting on /confirm puts nothing on the lock screen", () => {
    const d = desired(match({ venueChangeStatus: "liking", venueLikesA: [CAFE, PARK], venueLikesB: [CAFE, PARK] }));
    expect(d.A.desired.kind).toBe("none");
    expect(d.B.desired.kind).toBe("none");
  });

  it("flags a partner whose only new mark is keeping the current place", () => {
    const keep = like(KEEP_KEY, "Old Cafe");
    const d = desired(match({ venueChangeStatus: "liking", venueLikesA: [CAFE], venueLikesB: [keep] }));
    const a = d.A.desired;
    expect(a.kind === "show" && a.partnerKeepOnly).toBe(true);
    expect(shown(a).partnerPickNames).toEqual(["Old Cafe"]);
  });

  it("agreed, he initiated: he has to pay (match), she waits on him (waiting + agreedName)", () => {
    const d = desired(agreed({ venueChangeProposerId: "b" }));
    expect(shown(d.B.desired)).toMatchObject({
      phase: "match",
      agreedName: "Kyiv Food Market",
      deadline: AGREED_EXPIRES_S,
      myPickName: null,
      myPickCount: 0,
      partnerPickNames: [],
      partnerPickCount: 0,
    });
    expect(shown(d.A.desired)).toMatchObject({
      phase: "waiting",
      agreedName: "Kyiv Food Market",
      deadline: AGREED_EXPIRES_S,
    });
  });

  it("agreed, she initiated: both hold a move (her pay-or-offer, his pay-or-decline)", () => {
    const d = desired(agreed());
    expect(shown(d.A.desired).phase).toBe("match");
    expect(shown(d.B.desired).phase).toBe("match");
  });

  it("priority: match beats waiting — her offer is sent (she is 'waiting') yet she can still pay", () => {
    const m = agreed({ venueChangeOfferPaySentAt: new Date(NOW.getTime() - HOUR) });
    const d = desired(m);
    expect(d.A.state.waiting).toBe(true);
    expect(d.A.state.myAction).toBe("pay_or_offer");
    expect(shown(d.A.desired).phase).toBe("match");
  });

  it("a hidden express mint freezes BOTH cards (hold), never ends or starts one", () => {
    const d = desired(agreed({ venueChangeExpressAt: NOW, venueLikesB: [] }));
    expect(d.A.desired).toEqual({ kind: "hold" });
    expect(d.B.desired).toEqual({ kind: "hold" });
  });

  it("settled: ends as resolved, lingering on the venue that now stands", () => {
    const d = desired(match({ venueChangeStatus: "settled", venueName: "Kyiv Food Market" }));
    for (const side of [d.A, d.B]) {
      expect(side.desired.kind).toBe("none");
      if (side.desired.kind !== "none") continue;
      expect(side.desired.resolution).toBe("settled");
      expect(side.desired.finalContent).toMatchObject({
        phase: "match",
        agreedName: "Kyiv Food Market",
        deadline: null,
      });
    }
  });

  it("lapsed: ends as resolved with its last look", () => {
    const d = desired(match({ venueChangeStatus: "lapsed", venueLikesA: [CAFE] }));
    expect(d.A.desired).toEqual({ kind: "none", resolution: "lapsed", finalContent: null });
  });

  it("closed board: past the T-5h cutoff, a live liking round ends at once", () => {
    const pastCutoff = new Date(DATE_AT.getTime() - 4 * HOUR);
    const d = desired(match({ venueChangeStatus: "liking", venueLikesA: [CAFE] }), pastCutoff);
    expect(d.A.desired).toEqual({ kind: "none", resolution: null, finalContent: null });
    expect(d.B.desired).toEqual({ kind: "none", resolution: null, finalContent: null });
  });

  it("closed board: a match that is no longer scheduled ends at once, whatever the columns say", () => {
    const d = desired(match({ status: "cancelled", venueChangeStatus: "settled", venueLikesA: [CAFE] }));
    expect(d.A.desired).toEqual({ kind: "none", resolution: null, finalContent: null });
  });

  it("agrees with venueChangeSideWaiting in every liking state", () => {
    const states = [
      { venueLikesA: [CAFE], venueLikesB: [] },
      { venueLikesA: [], venueLikesB: [PARK] },
      { venueLikesA: [CAFE], venueLikesB: [PARK] },
    ];
    for (const s of states) {
      const d = desired(match({ venueChangeStatus: "liking", ...s }));
      for (const side of [d.A, d.B]) {
        const isWaiting = side.desired.kind === "show" && side.desired.content.phase === "waiting";
        expect(isWaiting).toBe(side.state.waiting);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Payloads — the exact ActivityKit contract the Swift struct decodes
// ---------------------------------------------------------------------------

const CONTENT_KEYS = [
  "phase",
  "partnerFirstName",
  "partnerGender",
  "myPickName",
  "myPickCount",
  "partnerPickNames",
  "partnerPickCount",
  "agreedName",
  "deadline",
];

describe("payload builders", () => {
  const partnerContent = () =>
    shown(desired(match({ venueChangeStatus: "liking", venueLikesA: [CAFE, PARK] })).B.desired);

  it("start: attributes-type, matchId attributes, every content key, stale at the deadline", () => {
    const content = partnerContent();
    const payload = buildLiveActivityStartPayload(
      venueChangeStartInput(MATCH_ID, content, "ru", false),
      NOW.getTime(),
    ) as { aps: Record<string, unknown> };

    expect(Object.keys(payload)).toEqual(["aps"]);
    expect(Object.keys(payload.aps).sort()).toEqual(
      ["alert", "attributes", "attributes-type", "content-state", "event", "stale-date", "timestamp"].sort(),
    );
    expect(payload.aps["attributes-type"]).toBe(VENUE_CHANGE_ATTRIBUTES_TYPE);
    expect(payload.aps["attributes-type"]).toBe("VenueChangeActivity");
    expect(payload.aps.attributes).toEqual({ matchId: MATCH_ID });
    expect(payload.aps.event).toBe("start");
    expect(payload.aps["stale-date"]).toBe(CUTOFF_S);

    const state = payload.aps["content-state"] as Record<string, unknown>;
    expect(Object.keys(state)).toEqual(CONTENT_KEYS);
    expect(state).toEqual({
      phase: "partner",
      partnerFirstName: "Алина",
      partnerGender: "female",
      myPickName: null,
      myPickCount: 0,
      partnerPickNames: ["Kyiv Food Market", "Park Spot"],
      partnerPickCount: 2,
      agreedName: null,
      deadline: CUTOFF_S,
    });
    expect(Number.isInteger(state.deadline)).toBe(true);
    expect(payload.aps.alert).toEqual({ title: "Смена места", body: "Алина предлагает 2 места" });
  });

  it("update: content and stale-date, no attributes, no alert", () => {
    const content = partnerContent();
    const payload = buildLiveActivityPayload(venueChangeUpdateInput(content), NOW.getTime()) as {
      aps: Record<string, unknown>;
    };
    expect(Object.keys(payload.aps).sort()).toEqual(
      ["content-state", "event", "stale-date", "timestamp"].sort(),
    );
    expect(payload.aps.event).toBe("update");
    expect(Object.keys(payload.aps["content-state"] as object)).toEqual(CONTENT_KEYS);
  });

  it("end: a resolved round lingers 15 minutes, a closed board leaves now", () => {
    const nowS = Math.floor(NOW.getTime() / 1000);
    const resolved = buildLiveActivityPayload(venueChangeEndInput("resolved", null, NOW), NOW.getTime()) as {
      aps: Record<string, unknown>;
    };
    expect(resolved.aps).toEqual({ timestamp: nowS, event: "end", "dismissal-date": nowS + 15 * 60 });

    const closed = buildLiveActivityPayload(venueChangeEndInput("now", null, NOW), NOW.getTime()) as {
      aps: Record<string, unknown>;
    };
    expect(closed.aps).toEqual({ timestamp: nowS, event: "end", "dismissal-date": nowS });
  });

  it("alerts: localized per recipient, the partner only ever as the subject", () => {
    const one = shown(desired(match({ venueChangeStatus: "liking", venueLikesA: [CAFE] })).B.desired);
    expect(venueChangeAlert("en", one, false)).toEqual({
      title: "Venue change",
      body: "Алина suggests Kyiv Food Market",
    });
    const five = shown(
      desired(match({ venueChangeStatus: "liking", venueLikesA: [CAFE, PARK, BAR, DECK, TEA] })).B.desired,
    );
    expect(venueChangeAlert("ru", five, false).body).toBe("Алина предлагает 5 мест");
    expect(venueChangeAlert("uk", five, false).body).toBe("Алина пропонує 5 місць");
    expect(venueChangeAlert("pl", five, false).body).toBe("Алина proponuje 5 miejsc");
    expect(venueChangeAlert("de", five, false).body).toBe("Алина schlägt 5 Orte vor");

    const waiting = shown(desired(match({ venueChangeStatus: "liking", venueLikesA: [CAFE] })).A.desired);
    expect(venueChangeAlert("ru", waiting, false).body).toBe("Ждём ответ по месту");

    const matched = shown(desired(agreed()).A.desired);
    expect(venueChangeAlert("ru", matched, false).body).toBe("Общий выбор: Kyiv Food Market");

    const nameless = { ...one, partnerFirstName: null };
    expect(venueChangeAlert("ru", nameless, false).body).toBe("Твой мэтч предлагает Kyiv Food Market");

    const keep = { ...one, partnerPickNames: ["Old Cafe"] };
    expect(venueChangeAlert("ru", keep, true).body).toBe("Алина хочет оставить Old Cafe");
  });

  it("stays far under Apple's silent 4096-byte ceiling in the worst case, in every language", () => {
    const huge = (n: number) => like(`h${n}`, "Ресторан ".repeat(40) + n);
    const worst = match({
      venueChangeStatus: "liking",
      venueLikesA: [huge(1)],
      venueLikesB: [huge(2), huge(3), huge(4), huge(5), huge(6)],
      userB: { ...match().userB, firstName: "Анна-Мария".repeat(10) },
    });
    const content = shown(desired(worst).A.desired);
    for (const lang of SUPPORTED_LANGUAGES) {
      const bytes = Buffer.byteLength(
        JSON.stringify(buildLiveActivityStartPayload(venueChangeStartInput(MATCH_ID, content, lang, false))),
      );
      expect(bytes).toBeLessThan(2048);
    }
  });
});

// ---------------------------------------------------------------------------
// Diff — start / update / end / nothing / restart
// ---------------------------------------------------------------------------

describe("decideVenueChangeActivity", () => {
  const show = (): Desired => desired(match({ venueChangeStatus: "liking", venueLikesA: [CAFE] })).A.desired;
  const record = (d: Desired, startedAt = NOW) => ({
    phase: "waiting",
    contentHash: venueChangeContentHash(shown(d)),
    startedAt,
  });

  it("nothing running + a card applies → start", () => {
    expect(decideVenueChangeActivity(null, show(), NOW).op).toBe("start");
  });

  it("same content → nothing is re-sent", () => {
    const d = show();
    expect(decideVenueChangeActivity(record(d), d, NOW)).toEqual({ op: "noop" });
  });

  it("changed content → update", () => {
    const d = show();
    const other = desired(match({ venueChangeStatus: "liking", venueLikesA: [CAFE, PARK] })).A.desired;
    expect(decideVenueChangeActivity(record(d), other, NOW).op).toBe("update");
  });

  it("no longer applies → end; at once for a closed board, lingering for a resolved round", () => {
    const d = show();
    expect(
      decideVenueChangeActivity(record(d), { kind: "none", resolution: null, finalContent: null }, NOW),
    ).toEqual({ op: "end", dismiss: "now", finalContent: null });
    expect(
      decideVenueChangeActivity(record(d), { kind: "none", resolution: "lapsed", finalContent: null }, NOW),
    ).toMatchObject({ op: "end", dismiss: "resolved" });
    expect(decideVenueChangeActivity(null, { kind: "none", resolution: null, finalContent: null }, NOW)).toEqual({
      op: "noop",
    });
  });

  it("hold touches nothing, running or not", () => {
    expect(decideVenueChangeActivity(record(show()), { kind: "hold" }, NOW)).toEqual({ op: "noop" });
    expect(decideVenueChangeActivity(null, { kind: "hold" }, NOW)).toEqual({ op: "noop" });
  });

  it("restarts a card that still applies after 7.5 hours — even with unchanged content", () => {
    const d = show();
    const at = (h: number) => new Date(NOW.getTime() - h * HOUR);
    expect(decideVenueChangeActivity(record(d, at(7.4)), d, NOW)).toEqual({ op: "noop" });
    expect(decideVenueChangeActivity(record(d, at(7.5)), d, NOW).op).toBe("restart");
    // …but a card that no longer applies is simply ended, not renewed.
    expect(
      decideVenueChangeActivity(record(d, at(9)), { kind: "none", resolution: null, finalContent: null }, NOW).op,
    ).toBe("end");
  });
});

// ---------------------------------------------------------------------------
// Sync — the diff applied against the durable record
// ---------------------------------------------------------------------------

describe("syncVenueChangeActivities", () => {
  const liking = () => match({ venueChangeStatus: "liking", venueChangeProposerId: "a", venueLikesA: [CAFE] });

  it("push-starts both sides with their own phase and language, and records what it sent", async () => {
    matchFindUnique.mockResolvedValue(liking());

    await syncVenueChangeActivities(MATCH_ID, NOW);

    expect(sendLiveActivityStartToUser).toHaveBeenCalledTimes(2);
    const byUser = Object.fromEntries(sendLiveActivityStartToUser.mock.calls.map((c) => [c[0], c]));
    expect(byUser.a![1]).toBe("venue_change");
    expect(byUser.a![2].contentState.phase).toBe("waiting");
    expect(byUser.a![2].alert).toEqual({ title: "Смена места", body: "Ждём ответ по месту" });
    expect(byUser.b![2].contentState.phase).toBe("partner");
    expect(byUser.b![2].alert).toEqual({ title: "Venue change", body: "Алина suggests Kyiv Food Market" });
    expect(table.map((r) => [r.userId, r.phase]).sort()).toEqual([
      ["a", "waiting"],
      ["b", "partner"],
    ]);
  });

  it("skips a user with no push-to-start token — no row, no push", async () => {
    matchFindUnique.mockResolvedValue(liking());
    tokenFindUnique.mockResolvedValue(null);

    await syncVenueChangeActivities(MATCH_ID, NOW);

    expect(sendLiveActivityStartToUser).not.toHaveBeenCalled();
    expect(table).toHaveLength(0);
  });

  it("releases the claim when APNs did not take the start, so the next write retries", async () => {
    matchFindUnique.mockResolvedValue(liking());
    sendLiveActivityStartToUser.mockResolvedValue(false);

    await syncVenueChangeActivities(MATCH_ID, NOW);

    expect(table).toHaveLength(0);
  });

  it("identical state twice → one start per side, nothing on the second pass", async () => {
    matchFindUnique.mockResolvedValue(liking());

    await syncVenueChangeActivities(MATCH_ID, NOW);
    await syncVenueChangeActivities(MATCH_ID, NOW);

    expect(sendLiveActivityStartToUser).toHaveBeenCalledTimes(2);
    expect(sendLiveActivityUpdateToUser).not.toHaveBeenCalled();
  });

  it("two writes a moment apart never start a second card (per-match queue + row claim)", async () => {
    matchFindUnique.mockResolvedValue(liking());

    await Promise.all([syncVenueChangeActivities(MATCH_ID, NOW), syncVenueChangeActivities(MATCH_ID, NOW)]);

    expect(sendLiveActivityStartToUser).toHaveBeenCalledTimes(2);
  });

  it("updates through THIS card's token when the content moves", async () => {
    matchFindUnique.mockResolvedValue(liking());
    await syncVenueChangeActivities(MATCH_ID, NOW);

    matchFindUnique.mockResolvedValue(
      match({ venueChangeStatus: "liking", venueChangeProposerId: "a", venueLikesA: [CAFE, PARK] }),
    );
    const later = new Date(NOW.getTime() + 60_000);
    await syncVenueChangeActivities(MATCH_ID, later);

    expect(sendLiveActivityStartToUser).toHaveBeenCalledTimes(2);
    expect(sendLiveActivityUpdateToUser).toHaveBeenCalledTimes(2);
    const [userId, type, input, scope] = sendLiveActivityUpdateToUser.mock.calls[0]!;
    expect(type).toBe("venue_change");
    expect(input.event).toBe("update");
    expect(scope).toEqual({ matchId: MATCH_ID, registeredSince: NOW });
    expect(["a", "b"]).toContain(userId);
    const b = sendLiveActivityUpdateToUser.mock.calls.find((c) => c[0] === "b")!;
    expect(b[2].contentState.partnerPickNames).toEqual(["Kyiv Food Market", "Park Spot"]);
  });

  it("an undelivered update puts the old hash back, so the sweep sends it again", async () => {
    matchFindUnique.mockResolvedValue(liking());
    await syncVenueChangeActivities(MATCH_ID, NOW);
    const before = table.map((r) => r.contentHash).sort();

    sendLiveActivityUpdateToUser.mockResolvedValue(false);
    matchFindUnique.mockResolvedValue(
      match({ venueChangeStatus: "liking", venueChangeProposerId: "a", venueLikesA: [CAFE, PARK] }),
    );
    await syncVenueChangeActivities(MATCH_ID, NOW);
    expect(table.map((r) => r.contentHash).sort()).toEqual(before);

    sendLiveActivityUpdateToUser.mockReset().mockResolvedValue(true);
    await sweepVenueChangeActivities(NOW);
    expect(sendLiveActivityUpdateToUser).toHaveBeenCalledTimes(2);
  });

  it("ends both cards at once when the board closes, and forgets them", async () => {
    matchFindUnique.mockResolvedValue(liking());
    await syncVenueChangeActivities(MATCH_ID, NOW);

    const pastCutoff = new Date(DATE_AT.getTime() - 4 * HOUR);
    await sweepVenueChangeActivities(pastCutoff);

    const ends = sendLiveActivityUpdateToUser.mock.calls.filter((c) => c[2].event === "end");
    expect(ends).toHaveLength(2);
    expect(ends[0]![2].dismissalDate).toBe(Math.floor(pastCutoff.getTime() / 1000));
    expect(table).toHaveLength(0);
  });

  it("ends a settled round with a 15-minute linger on the new venue", async () => {
    matchFindUnique.mockResolvedValue(agreed({ venueChangeProposerId: "b" }));
    await syncVenueChangeActivities(MATCH_ID, NOW);
    expect(table).toHaveLength(2);

    matchFindUnique.mockResolvedValue(match({ venueChangeStatus: "settled", venueName: "Kyiv Food Market" }));
    await syncVenueChangeActivities(MATCH_ID, NOW);

    const ends = sendLiveActivityUpdateToUser.mock.calls.filter((c) => c[2].event === "end");
    expect(ends).toHaveLength(2);
    expect(ends[0]![2].dismissalDate).toBe(Math.floor(NOW.getTime() / 1000) + 15 * 60);
    expect(ends[0]![2].contentState).toMatchObject({ phase: "match", agreedName: "Kyiv Food Market", deadline: null });
    expect(table).toHaveLength(0);
  });

  it("renews a card at 7.5 hours: end the old one, push-start a fresh one", async () => {
    matchFindUnique.mockResolvedValue(liking());
    await syncVenueChangeActivities(MATCH_ID, NOW);
    sendLiveActivityStartToUser.mockClear();

    const later = new Date(NOW.getTime() + 7.5 * HOUR);
    await sweepVenueChangeActivities(later);

    expect(sendLiveActivityUpdateToUser.mock.calls.filter((c) => c[2].event === "end")).toHaveLength(2);
    expect(sendLiveActivityStartToUser).toHaveBeenCalledTimes(2);
    expect(table.every((r) => r.startedAt.getTime() === later.getTime())).toBe(true);
  });

  it("ends the cards of a match that is gone", async () => {
    table.push({ matchId: MATCH_ID, userId: "a", phase: "waiting", contentHash: "h", startedAt: NOW });
    matchFindUnique.mockResolvedValue(null);

    await sweepVenueChangeActivities(NOW);

    expect(sendLiveActivityUpdateToUser).toHaveBeenCalledWith(
      "a",
      "venue_change",
      expect.objectContaining({ event: "end" }),
      { matchId: MATCH_ID },
    );
    expect(table).toHaveLength(0);
  });
});
