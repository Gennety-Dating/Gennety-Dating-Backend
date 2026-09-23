import { SUPPORTED_LANGUAGES } from "@gennety/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks. `time_agreement_activities` is an in-memory table with the real key
// (match, user) and real compare-and-set `where`s, so the apply layer is tested
// against the same claim semantics Postgres gives it — a mock that answered
// `{ count: 1 }` to everything would pass a sync that double-starts a card.
// ---------------------------------------------------------------------------

interface Row {
  matchId: string;
  userId: string;
  phase: string;
  contentHash: string;
  partnerHash: string;
  startedAt: Date;
}
const table: Row[] = [];

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    const value = row[k as keyof Row];
    return v instanceof Date && value instanceof Date ? v.getTime() === value.getTime() : value === v;
  });
}

const taCreate = vi.fn(async ({ data }: { data: Row }) => {
  if (table.some((r) => r.matchId === data.matchId && r.userId === data.userId)) {
    throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  }
  table.push({ ...data });
  return data;
});
const taUpdateMany = vi.fn(
  async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
    const hit = table.filter((r) => matches(r, where));
    for (const r of hit) Object.assign(r, data);
    return { count: hit.length };
  },
);
const taDeleteMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
  const before = table.length;
  for (let i = table.length - 1; i >= 0; i--) if (matches(table[i]!, where)) table.splice(i, 1);
  return { count: before - table.length };
});
const taFindMany = vi.fn(
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
    match: { findUnique: matchFindUnique, update: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    liveActivityToken: { findUnique: tokenFindUnique },
    timeAgreementActivity: {
      create: taCreate,
      updateMany: taUpdateMany,
      deleteMany: taDeleteMany,
      findMany: taFindMany,
    },
  },
}));

vi.mock("../config.js", () => ({
  env: {
    WEBAPP_URL: "https://app.test",
    PRIME_TIME_ENABLED: false,
    PREMIUM_FEATURE_ENABLED: false,
    PRIME_TIME_SLOT_COUNT: 3,
    PRIME_TIME_STARS: 50,
  },
}));

// The service imports the scheduler for `isSlotSelectable` (the five-hour rule
// is the card's rule too). These two are what the scheduler drags in and this
// test has no business running.
vi.mock("../handlers/matching/venue-negotiation.js", () => ({
  startVenueNegotiation: vi.fn(),
}));
vi.mock("./peer-wait.js", () => ({ startPeerWaitShimmer: vi.fn() }));

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
  TIME_AGREEMENT_ATTRIBUTES_TYPE,
  decideTimeAgreementActivity,
  desiredTimeAgreementActivities,
  timeAgreementAlert,
  timeAgreementContentHash,
  timeAgreementPartnerHash,
  timeAgreementEndInput,
  timeAgreementStartInput,
  timeAgreementUpdateInput,
  syncTimeAgreementActivities,
  sweepTimeAgreementActivities,
} = await import("./time-agreement-activity.js");
type Desired = import("./time-agreement-activity.js").DesiredTimeAgreementActivity;
type Content = import("./time-agreement-activity.js").TimeAgreementContentState;

// ---------------------------------------------------------------------------
// Fixtures. Kyiv is UTC+3 in September, so 07:00Z is 10:00 local and the
// five-hour line falls at 12:00Z.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-09-23T07:00:00.000Z");
/** 13:00 Kyiv today — INSIDE the five-hour lead, so it counts for nothing. */
const SOON = new Date("2026-09-23T10:00:00.000Z");
/** 18:30 Kyiv today. */
const SLOT_A = new Date("2026-09-23T15:30:00.000Z");
/** 19:30 Kyiv today. */
const SLOT_B = new Date("2026-09-23T16:30:00.000Z");
/** 18:30 Kyiv tomorrow (a Thursday). */
const SLOT_C = new Date("2026-09-24T15:30:00.000Z");
const S = (d: Date) => Math.floor(d.getTime() / 1000);
const MATCH_ID = "22222222-2222-4222-8222-222222222222";

/**
 * A = ru, Kyiv; B = en, Warsaw — so every per-recipient choice (language, wall
 * clock) is visible in the assertions. Names are placeholders: a card string
 * binds to the partner attribute, never to one person.
 */
function match(over: Record<string, unknown> = {}) {
  return {
    id: MATCH_ID,
    status: "negotiating",
    proposedTimes: [SOON, SLOT_A, SLOT_B, SLOT_C],
    availableTimesA: [] as Date[],
    availableTimesB: [] as Date[],
    agreedTime: null as Date | null,
    userA: {
      id: "a",
      language: "ru",
      firstName: "[Имя партнёра]",
      gender: "female",
      profile: { timeZone: "Europe/Kyiv" },
    },
    userB: {
      id: "b",
      language: "en",
      firstName: "[Partner Name]",
      gender: "male",
      profile: { timeZone: "Europe/Warsaw" },
    },
    ...over,
  };
}

type M = Parameters<typeof desiredTimeAgreementActivities>[0];
const desired = (m: ReturnType<typeof match>, now = NOW) =>
  desiredTimeAgreementActivities(m as unknown as M, now);

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
  it("no grid yet: no card on either side", () => {
    const d = desired(match({ proposedTimes: [] }));
    expect(d.A.desired).toEqual({ kind: "none", resolution: null, finalContent: null });
    expect(d.B.desired).toEqual({ kind: "none", resolution: null, finalContent: null });
  });

  it("grid open but nobody has marked: no card — the calendar itself is the nudge", () => {
    const d = desired(match());
    expect(d.A.desired.kind).toBe("none");
    expect(d.B.desired.kind).toBe("none");
  });

  it("one side marked, the other nothing: waiting for me, partner for them", () => {
    const d = desired(match({ availableTimesA: [SLOT_A] }));

    expect(shown(d.A.desired)).toEqual({
      phase: "waiting",
      partnerFirstName: "[Partner Name]",
      partnerGender: "male",
      mySlots: [S(SLOT_A)],
      partnerSlots: [],
      agreedTime: null,
      timeZone: "Europe/Kyiv",
    });
    expect(shown(d.B.desired)).toEqual({
      phase: "partner",
      partnerFirstName: "[Имя партнёра]",
      partnerGender: "female",
      mySlots: [],
      partnerSlots: [S(SLOT_A)],
      agreedTime: null,
      timeZone: "Europe/Warsaw",
    });
  });

  it("sends at most two slots per side, earliest first", () => {
    const d = desired(match({ availableTimesA: [SLOT_C, SLOT_A, SLOT_B] }));
    expect(shown(d.A.desired).mySlots).toEqual([S(SLOT_A), S(SLOT_B)]);
    expect(shown(d.B.desired).partnerSlots).toEqual([S(SLOT_A), S(SLOT_B)]);
  });

  it("partnerSlots lists only the times I have NOT marked", () => {
    const d = desired(match({ availableTimesA: [SLOT_A, SLOT_C], availableTimesB: [SLOT_A] }));
    const b = shown(d.B.desired);
    expect(b.phase).toBe("partner");
    expect(b.partnerSlots).toEqual([S(SLOT_C)]);
    expect(b.mySlots).toEqual([S(SLOT_A)]);
    // A has nothing new from B and B is not empty-handed → no card for A.
    expect(d.A.desired.kind).toBe("none");
  });

  it("both sides with times the other lacks: both see partner", () => {
    const d = desired(match({ availableTimesA: [SLOT_A], availableTimesB: [SLOT_C] }));
    expect(shown(d.A.desired).partnerSlots).toEqual([S(SLOT_C)]);
    expect(shown(d.B.desired).partnerSlots).toEqual([S(SLOT_A)]);
  });

  it("an overlap waiting on the final pick puts nothing on the lock screen", () => {
    // Both marked the same two times: >1 shared, so nothing locked. Neither is
    // waiting (either can close it) and neither has a new time to look at — the
    // app is where that is settled, exactly as the venue board's /confirm is.
    const d = desired(match({ availableTimesA: [SLOT_A, SLOT_B], availableTimesB: [SLOT_A, SLOT_B] }));
    expect(d.A.desired.kind).toBe("none");
    expect(d.B.desired.kind).toBe("none");
  });

  it("a mark that slipped inside the five-hour lead stops counting", () => {
    // 13:00 Kyiv is 3 hours out at 10:00 Kyiv: the server would refuse it
    // (`slot-in-past`), so the card must not keep claiming it is on the table.
    const d = desired(match({ availableTimesA: [SOON] }));
    expect(d.A.desired.kind).toBe("none");
    expect(d.B.desired.kind).toBe("none");
    // The same mark an hour earlier, while it was still five hours out, counts.
    const earlier = new Date(SOON.getTime() - 6 * HOUR);
    expect(shown(desired(match({ availableTimesA: [SOON] }), earlier).A.desired).phase).toBe(
      "waiting",
    );
  });

  it("the time locked: both cards end as resolved, on the agreed time", () => {
    for (const status of ["negotiating_venue", "scheduled"]) {
      const d = desired(match({ status, agreedTime: SLOT_A, availableTimesA: [SLOT_A], availableTimesB: [SLOT_A] }));
      for (const side of [d.A, d.B]) {
        expect(side.desired.kind).toBe("none");
        if (side.desired.kind !== "none") continue;
        expect(side.desired.resolution).toBe("locked");
        expect(side.desired.finalContent).toMatchObject({
          phase: "match",
          agreedTime: S(SLOT_A),
          mySlots: [],
          partnerSlots: [],
        });
      }
    }
  });

  it("a match that is cancelled, expired or finished ends the card the plain way", () => {
    for (const status of ["cancelled", "expired", "completed"]) {
      const d = desired(match({ status, agreedTime: SLOT_A, availableTimesA: [SLOT_A] }));
      expect(d.A.desired).toEqual({ kind: "none", resolution: null, finalContent: null });
      expect(d.B.desired).toEqual({ kind: "none", resolution: null, finalContent: null });
    }
  });

  it("clips a very long partner name rather than trusting it", () => {
    const long = "Имя".repeat(60);
    const d = desired(match({ availableTimesA: [SLOT_A], userB: { ...match().userB, firstName: long } }));
    expect(shown(d.A.desired).partnerFirstName!.length).toBeLessThanOrEqual(80);
    const blank = desired(
      match({ availableTimesA: [SLOT_A], userB: { ...match().userB, firstName: "   " } }),
    );
    expect(shown(blank.A.desired).partnerFirstName).toBeNull();
  });

  it("a gender the card cannot draw is null, never passed through", () => {
    const d = desired(
      match({ availableTimesA: [SLOT_A], userB: { ...match().userB, gender: "other" } }),
    );
    expect(shown(d.A.desired).partnerGender).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Payloads — the exact ActivityKit contract the Swift struct decodes
// ---------------------------------------------------------------------------

const CONTENT_KEYS = [
  "phase",
  "partnerFirstName",
  "partnerGender",
  "mySlots",
  "partnerSlots",
  "agreedTime",
  "timeZone",
];

describe("payload builders", () => {
  const partnerContent = () => shown(desired(match({ availableTimesA: [SLOT_A, SLOT_C] })).B.desired);

  it("start: attributes-type, matchId attributes, every content key, an alert", () => {
    const content = partnerContent();
    const payload = buildLiveActivityStartPayload(
      timeAgreementStartInput(MATCH_ID, content, "en", NOW),
      NOW.getTime(),
    ) as { aps: Record<string, unknown> };

    expect(Object.keys(payload)).toEqual(["aps"]);
    expect(Object.keys(payload.aps).sort()).toEqual(
      ["alert", "attributes", "attributes-type", "content-state", "event", "timestamp"].sort(),
    );
    expect(payload.aps["attributes-type"]).toBe(TIME_AGREEMENT_ATTRIBUTES_TYPE);
    expect(payload.aps["attributes-type"]).toBe("TimeAgreementActivity");
    expect(payload.aps.attributes).toEqual({ matchId: MATCH_ID });
    expect(payload.aps.event).toBe("start");

    const state = payload.aps["content-state"] as Record<string, unknown>;
    expect(Object.keys(state)).toEqual(CONTENT_KEYS);
    expect(state).toEqual({
      phase: "partner",
      partnerFirstName: "[Имя партнёра]",
      partnerGender: "female",
      mySlots: [],
      partnerSlots: [S(SLOT_A), S(SLOT_C)],
      agreedTime: null,
      timeZone: "Europe/Warsaw",
    });
    for (const n of state.partnerSlots as number[]) expect(Number.isInteger(n)).toBe(true);
    // Warsaw is an hour behind Kyiv, and the slot is today THERE too.
    expect(payload.aps.alert).toEqual({
      title: "Picking a time",
      body: "[Имя партнёра] suggests 17:30",
    });
  });

  it("update: content, and an alert ONLY when one is passed", () => {
    const content = partnerContent();
    const quiet = buildLiveActivityPayload(timeAgreementUpdateInput(content, null), NOW.getTime()) as {
      aps: Record<string, unknown>;
    };
    expect(Object.keys(quiet.aps).sort()).toEqual(["content-state", "event", "timestamp"].sort());
    expect(quiet.aps.event).toBe("update");
    expect(Object.keys(quiet.aps["content-state"] as object)).toEqual(CONTENT_KEYS);

    const loud = buildLiveActivityPayload(
      timeAgreementUpdateInput(content, { title: "T", body: "B" }),
      NOW.getTime(),
    ) as { aps: Record<string, unknown> };
    expect(loud.aps.alert).toEqual({ title: "T", body: "B" });
  });

  it("end: a locked time lingers 15 minutes, a closed calendar leaves now", () => {
    const nowS = Math.floor(NOW.getTime() / 1000);
    const resolved = buildLiveActivityPayload(
      timeAgreementEndInput("resolved", null, NOW),
      NOW.getTime(),
    ) as { aps: Record<string, unknown> };
    expect(resolved.aps).toEqual({ timestamp: nowS, event: "end", "dismissal-date": nowS + 15 * 60 });

    const closed = buildLiveActivityPayload(
      timeAgreementEndInput("now", null, NOW),
      NOW.getTime(),
    ) as { aps: Record<string, unknown> };
    expect(closed.aps).toEqual({ timestamp: nowS, event: "end", "dismissal-date": nowS });
  });

  it("alerts: localized per recipient, in the RECIPIENT's zone, name only as the subject", () => {
    const toB = partnerContent();
    expect(timeAgreementAlert("en", toB, NOW).body).toBe("[Имя партнёра] suggests 17:30");

    // The same instant read on Kyiv time, in every language. Today → no weekday.
    const toA = { ...toB, timeZone: "Europe/Kyiv" };
    expect(timeAgreementAlert("ru", toA, NOW).body).toBe("[Имя партнёра] предлагает 18:30");
    expect(timeAgreementAlert("uk", toA, NOW).body).toBe("[Имя партнёра] пропонує 18:30");
    expect(timeAgreementAlert("de", toA, NOW).body).toBe("[Имя партнёра] schlägt 18:30 vor");
    expect(timeAgreementAlert("pl", toA, NOW).body).toBe("[Имя партнёра] proponuje 18:30");
    expect(timeAgreementAlert("ru", toA, NOW).title).toBe("Выбираем время");

    // Tomorrow → the weekday comes back.
    const tomorrow = { ...toA, partnerSlots: [S(SLOT_C)] };
    expect(timeAgreementAlert("ru", tomorrow, NOW).body).toBe("[Имя партнёра] предлагает чт 18:30");

    const waiting = shown(desired(match({ availableTimesA: [SLOT_A] })).A.desired);
    expect(timeAgreementAlert("ru", waiting, NOW).body).toBe(
      "Ждём, когда [Partner Name] ответит",
    );
    // No name to be the subject → the neutral twin, not a capitalised fallback
    // dropped into the middle of a sentence.
    expect(timeAgreementAlert("ru", { ...waiting, partnerFirstName: null }, NOW).body).toBe(
      "Ждём ответ по времени",
    );

    const locked = desired(match({ status: "scheduled", agreedTime: SLOT_A })).A.desired;
    if (locked.kind !== "none" || !locked.finalContent) throw new Error("expected final content");
    expect(timeAgreementAlert("ru", locked.finalContent, NOW).body).toBe("Время назначено: 18:30");
    expect(timeAgreementAlert("en", locked.finalContent, NOW).body).toBe("Time set: 18:30");
  });

  it("a nameless partner still gets a `partner` body", () => {
    const content = { ...shown(desired(match({ availableTimesA: [SLOT_A] })).B.desired), partnerFirstName: null };
    // B's card, so B's clock: Warsaw is an hour behind Kyiv.
    expect(timeAgreementAlert("ru", content, NOW).body).toBe("Твой мэтч предлагает 17:30");
  });

  it("stays far under Apple's silent 4096-byte ceiling in the worst case, in every language", () => {
    const worst = match({
      availableTimesA: [SLOT_A, SLOT_B, SLOT_C],
      userB: { ...match().userB, firstName: "Имя-Отчество".repeat(20) },
    });
    const content = shown(desired(worst).B.desired);
    for (const lang of SUPPORTED_LANGUAGES) {
      const bytes = Buffer.byteLength(
        JSON.stringify(buildLiveActivityStartPayload(timeAgreementStartInput(MATCH_ID, content, lang, NOW))),
      );
      expect(bytes).toBeLessThan(2048);
    }
  });
});

// ---------------------------------------------------------------------------
// Diff — start / update / end / nothing / restart, and what rings
// ---------------------------------------------------------------------------

describe("decideTimeAgreementActivity", () => {
  const waitingFor = (m = match({ availableTimesA: [SLOT_A] })) => desired(m).A.desired;
  const partnerFor = (m = match({ availableTimesA: [SLOT_A] })) => desired(m).B.desired;
  const record = (d: Desired, phase: string, startedAt = NOW) => ({
    phase,
    contentHash: timeAgreementContentHash(shown(d)),
    partnerHash: timeAgreementPartnerHash(shown(d)),
    startedAt,
  });

  it("nothing running + a card applies → start, and a start always rings", () => {
    const op = decideTimeAgreementActivity(null, waitingFor(), NOW);
    expect(op).toMatchObject({ op: "start", alert: true });
  });

  it("same content → nothing is re-sent", () => {
    const d = waitingFor();
    expect(decideTimeAgreementActivity(record(d, "waiting"), d, NOW)).toEqual({ op: "noop" });
  });

  it("the partner moved → update, and it rings", () => {
    const before = record(partnerFor(), "partner");
    const after = partnerFor(match({ availableTimesA: [SLOT_A, SLOT_C] }));
    const op = decideTimeAgreementActivity(before, after, NOW);
    expect(op).toMatchObject({ op: "update", alert: true });
  });

  it("I edited my OWN picks → update, silently", () => {
    // B is looking at A's SLOT_A either way; B added SLOT_B to their own set.
    const before = record(partnerFor(match({ availableTimesA: [SLOT_A] })), "partner");
    const after = partnerFor(match({ availableTimesA: [SLOT_A], availableTimesB: [SLOT_B] }));
    const op = decideTimeAgreementActivity(before, after, NOW);
    expect(op).toMatchObject({ op: "update", alert: false });
  });

  it("waiting → partner rings even if the partner's set is somehow unchanged", () => {
    const stored = { ...record(partnerFor(), "waiting") };
    const op = decideTimeAgreementActivity(stored, partnerFor(match({ availableTimesA: [SLOT_A, SLOT_C] })), NOW);
    expect(op).toMatchObject({ op: "update", alert: true });
  });

  it("a card that stops applying is ended: at once when closed, lingering when locked", () => {
    const d = waitingFor();
    expect(
      decideTimeAgreementActivity(record(d, "waiting"), { kind: "none", resolution: null, finalContent: null }, NOW),
    ).toEqual({ op: "end", dismiss: "now", finalContent: null, alert: false });
    expect(decideTimeAgreementActivity(null, { kind: "none", resolution: null, finalContent: null }, NOW)).toEqual({
      op: "noop",
    });
  });

  it("the END that carries the locked time rings only for the side that was WAITING", () => {
    const locked = desired(match({ status: "negotiating_venue", agreedTime: SLOT_A })).A.desired;
    const d = waitingFor();
    expect(decideTimeAgreementActivity(record(d, "waiting"), locked, NOW)).toMatchObject({
      op: "end",
      dismiss: "resolved",
      alert: true,
    });
    // The side whose last card said "your move" is the one that just tapped it.
    expect(decideTimeAgreementActivity(record(d, "partner"), locked, NOW)).toMatchObject({
      op: "end",
      alert: false,
    });
  });

  it("restarts a card that still applies after 7.5 hours — even with unchanged content", () => {
    const d = waitingFor();
    const at = (h: number) => new Date(NOW.getTime() - h * HOUR);
    expect(decideTimeAgreementActivity(record(d, "waiting", at(7.4)), d, NOW)).toEqual({ op: "noop" });
    expect(decideTimeAgreementActivity(record(d, "waiting", at(7.5)), d, NOW).op).toBe("restart");
    // …but a card that no longer applies is simply ended, not renewed.
    expect(
      decideTimeAgreementActivity(
        record(d, "waiting", at(9)),
        { kind: "none", resolution: null, finalContent: null },
        NOW,
      ).op,
    ).toBe("end");
  });
});

// ---------------------------------------------------------------------------
// Sync — the diff applied against the durable record
// ---------------------------------------------------------------------------

describe("syncTimeAgreementActivities", () => {
  const oneSided = () => match({ availableTimesA: [SLOT_A] });

  it("push-starts both sides with their own phase, language and clock, and records it", async () => {
    matchFindUnique.mockResolvedValue(oneSided());

    await syncTimeAgreementActivities(MATCH_ID, NOW);

    expect(sendLiveActivityStartToUser).toHaveBeenCalledTimes(2);
    const byUser = Object.fromEntries(sendLiveActivityStartToUser.mock.calls.map((c) => [c[0], c]));
    expect(byUser.a![1]).toBe("time_agreement");
    expect(byUser.a![2].contentState.phase).toBe("waiting");
    expect(byUser.a![2].contentState.timeZone).toBe("Europe/Kyiv");
    expect(byUser.a![2].alert).toEqual({
      title: "Выбираем время",
      body: "Ждём, когда [Partner Name] ответит",
    });
    expect(byUser.b![2].contentState.phase).toBe("partner");
    expect(byUser.b![2].contentState.timeZone).toBe("Europe/Warsaw");
    expect(byUser.b![2].alert).toEqual({
      title: "Picking a time",
      body: "[Имя партнёра] suggests 17:30",
    });
    expect(table.map((r) => [r.userId, r.phase]).sort()).toEqual([
      ["a", "waiting"],
      ["b", "partner"],
    ]);
  });

  it("skips a user with no push-to-start token — no row, no push", async () => {
    matchFindUnique.mockResolvedValue(oneSided());
    tokenFindUnique.mockResolvedValue(null);

    await syncTimeAgreementActivities(MATCH_ID, NOW);

    expect(sendLiveActivityStartToUser).not.toHaveBeenCalled();
    expect(table).toHaveLength(0);
  });

  it("releases the claim when APNs did not take the start, so the next write retries", async () => {
    matchFindUnique.mockResolvedValue(oneSided());
    sendLiveActivityStartToUser.mockResolvedValue(false);

    await syncTimeAgreementActivities(MATCH_ID, NOW);

    expect(table).toHaveLength(0);
  });

  it("identical state twice → one start per side, nothing on the second pass", async () => {
    matchFindUnique.mockResolvedValue(oneSided());

    await syncTimeAgreementActivities(MATCH_ID, NOW);
    await syncTimeAgreementActivities(MATCH_ID, NOW);

    expect(sendLiveActivityStartToUser).toHaveBeenCalledTimes(2);
    expect(sendLiveActivityUpdateToUser).not.toHaveBeenCalled();
  });

  it("two writes a moment apart never start a second card (per-match queue + row claim)", async () => {
    matchFindUnique.mockResolvedValue(oneSided());

    await Promise.all([
      syncTimeAgreementActivities(MATCH_ID, NOW),
      syncTimeAgreementActivities(MATCH_ID, NOW),
    ]);

    expect(sendLiveActivityStartToUser).toHaveBeenCalledTimes(2);
  });

  it("the partner's second time updates THIS card's token and rings", async () => {
    matchFindUnique.mockResolvedValue(oneSided());
    await syncTimeAgreementActivities(MATCH_ID, NOW);

    matchFindUnique.mockResolvedValue(match({ availableTimesA: [SLOT_A, SLOT_C] }));
    await syncTimeAgreementActivities(MATCH_ID, new Date(NOW.getTime() + 60_000));

    const b = sendLiveActivityUpdateToUser.mock.calls.find((c) => c[0] === "b")!;
    expect(b[1]).toBe("time_agreement");
    expect(b[2].event).toBe("update");
    expect(b[2].contentState.partnerSlots).toEqual([S(SLOT_A), S(SLOT_C)]);
    expect(b[2].alert).toEqual({ title: "Picking a time", body: "[Имя партнёра] suggests 17:30" });
    expect(b[3]).toEqual({ matchId: MATCH_ID, registeredSince: NOW });
    // A only widened her own set: her card redraws without a sound.
    const a = sendLiveActivityUpdateToUser.mock.calls.find((c) => c[0] === "a")!;
    expect(a[2].alert).toBeUndefined();
  });

  it("an undelivered update puts the old row back, so the sweep sends it again", async () => {
    matchFindUnique.mockResolvedValue(oneSided());
    await syncTimeAgreementActivities(MATCH_ID, NOW);
    const before = table.map((r) => `${r.phase}:${r.contentHash}:${r.partnerHash}`).sort();

    sendLiveActivityUpdateToUser.mockResolvedValue(false);
    matchFindUnique.mockResolvedValue(match({ availableTimesA: [SLOT_A, SLOT_C] }));
    await syncTimeAgreementActivities(MATCH_ID, NOW);
    expect(table.map((r) => `${r.phase}:${r.contentHash}:${r.partnerHash}`).sort()).toEqual(before);

    sendLiveActivityUpdateToUser.mockReset().mockResolvedValue(true);
    await sweepTimeAgreementActivities(NOW);
    expect(sendLiveActivityUpdateToUser).toHaveBeenCalledTimes(2);
  });

  it("ends both cards on the locked time — 15-minute linger, and only the waiting side hears it", async () => {
    matchFindUnique.mockResolvedValue(oneSided());
    await syncTimeAgreementActivities(MATCH_ID, NOW);
    expect(table.map((r) => r.phase).sort()).toEqual(["partner", "waiting"]);

    matchFindUnique.mockResolvedValue(
      match({ status: "negotiating_venue", agreedTime: SLOT_A, availableTimesB: [SLOT_A] }),
    );
    await syncTimeAgreementActivities(MATCH_ID, NOW);

    const ends = sendLiveActivityUpdateToUser.mock.calls.filter((c) => c[2].event === "end");
    expect(ends).toHaveLength(2);
    for (const call of ends) {
      expect(call[2].dismissalDate).toBe(Math.floor(NOW.getTime() / 1000) + 15 * 60);
      expect(call[2].contentState).toMatchObject({ phase: "match", agreedTime: S(SLOT_A) });
    }
    // A was waiting on B and did not act — she is the one told.
    const toA = ends.find((c) => c[0] === "a")!;
    expect(toA[2].alert).toEqual({ title: "Выбираем время", body: "Время назначено: 18:30" });
    expect(ends.find((c) => c[0] === "b")![2].alert).toBeUndefined();
    expect(table).toHaveLength(0);
  });

  it("ends both cards at once when the match is cancelled, and forgets them", async () => {
    matchFindUnique.mockResolvedValue(oneSided());
    await syncTimeAgreementActivities(MATCH_ID, NOW);

    matchFindUnique.mockResolvedValue(match({ status: "cancelled", availableTimesA: [SLOT_A] }));
    await sweepTimeAgreementActivities(NOW);

    const ends = sendLiveActivityUpdateToUser.mock.calls.filter((c) => c[2].event === "end");
    expect(ends).toHaveLength(2);
    expect(ends[0]![2].dismissalDate).toBe(Math.floor(NOW.getTime() / 1000));
    expect(ends[0]![2].alert).toBeUndefined();
    expect(table).toHaveLength(0);
  });

  it("the sweep ends a card whose only marked time has slipped inside the five-hour lead", async () => {
    // Started while 13:00 Kyiv was still five hours out…
    const early = new Date(SOON.getTime() - 6 * HOUR);
    matchFindUnique.mockResolvedValue(match({ availableTimesA: [SOON] }));
    await syncTimeAgreementActivities(MATCH_ID, early);
    expect(table).toHaveLength(2);

    // …and swept once it no longer is. No calendar write announced this.
    await sweepTimeAgreementActivities(NOW);

    expect(sendLiveActivityUpdateToUser.mock.calls.filter((c) => c[2].event === "end")).toHaveLength(2);
    expect(table).toHaveLength(0);
  });

  it("renews a card at 7.5 hours: end the old one, push-start a fresh one", async () => {
    matchFindUnique.mockResolvedValue(oneSided());
    await syncTimeAgreementActivities(MATCH_ID, NOW);
    sendLiveActivityStartToUser.mockClear();

    // Still inside the five-hour lead of nothing — SLOT_C is tomorrow evening.
    matchFindUnique.mockResolvedValue(match({ availableTimesA: [SLOT_C] }));
    const later = new Date(NOW.getTime() + 7.5 * HOUR);
    await sweepTimeAgreementActivities(later);

    expect(sendLiveActivityUpdateToUser.mock.calls.filter((c) => c[2].event === "end")).toHaveLength(2);
    expect(sendLiveActivityStartToUser).toHaveBeenCalledTimes(2);
    expect(table.every((r) => r.startedAt.getTime() === later.getTime())).toBe(true);
  });

  it("ends the cards of a match that is gone", async () => {
    table.push({
      matchId: MATCH_ID,
      userId: "a",
      phase: "waiting",
      contentHash: "h",
      partnerHash: "p",
      startedAt: NOW,
    });
    matchFindUnique.mockResolvedValue(null);

    await sweepTimeAgreementActivities(NOW);

    expect(sendLiveActivityUpdateToUser).toHaveBeenCalledWith(
      "a",
      "time_agreement",
      expect.objectContaining({ event: "end" }),
      { matchId: MATCH_ID },
    );
    expect(table).toHaveLength(0);
  });
});
