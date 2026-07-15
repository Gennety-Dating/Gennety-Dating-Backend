import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionData } from "@gennety/shared";
import { DEFAULT_SESSION, t } from "@gennety/shared";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    match: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    SMTP_HOST: "test",
    SMTP_PORT: 587,
    SMTP_USER: "test",
    SMTP_PASS: "test",
    OPENAI_API_KEY: "",
    CUSTOM_EMOJI_LIKE_ID: "",
    CUSTOM_EMOJI_DISLIKE_ID: "",
    WEBAPP_URL: "https://test.invalid/calendar",
  },
}));

vi.mock("./venue-negotiation.js", () => ({
  startVenueNegotiation: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@gennety/db";
import {
  generateProposalSlots,
  formatSlotLabel,
  buildCalendarKeyboard,
  startScheduling,
  handleSchedulePick,
  handleCalendarWebAppData,
  processCalendarSlotsUpdate,
  getCalendarState,
  CALENDAR_DAY_COUNT,
  CALENDAR_SLOT_COUNT,
  CALENDAR_TIME_SLOTS,
} from "./scheduler.js";
import { startVenueNegotiation } from "./venue-negotiation.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findUnique: MockFn; update: MockFn };
const mUser = prisma.user as unknown as { findUnique: MockFn };
const mStartVenue = startVenueNegotiation as unknown as MockFn;

function createApi() {
  let nextMessageId = 500;
  return {
    sendMessage: vi.fn().mockImplementation(async () => ({
      message_id: nextMessageId++,
    })),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createCtx(overrides: {
  session?: Partial<SessionData>;
  callbackData?: string;
  webAppData?: string;
  fromId?: number;
}) {
  const session: SessionData = {
    ...DEFAULT_SESSION,
    pendingPhotos: [],
    ...overrides.session,
  };
  return {
    session,
    from: { id: overrides.fromId ?? 2001 },
    chat: { id: overrides.fromId ?? 2001 },
    callbackQuery: overrides.callbackData ? { data: overrides.callbackData } : undefined,
    message: overrides.webAppData
      ? { web_app_data: { data: overrides.webAppData } }
      : undefined,
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    api: createApi(),
  } as any;
}

describe("scheduler: pure slot helpers", () => {
  it("generateProposalSlots returns 6 consecutive days with 6 time choices per day", () => {
    const slots = generateProposalSlots(new Date("2026-04-09T12:00:00Z"));
    expect(slots.length).toBe(CALENDAR_SLOT_COUNT);
    expect(CALENDAR_DAY_COUNT).toBe(6);
    expect(CALENDAR_TIME_SLOTS).toEqual([
      { hour: 17, minute: 0 },
      { hour: 17, minute: 30 },
      { hour: 18, minute: 0 },
      { hour: 18, minute: 30 },
      { hour: 19, minute: 0 },
      { hour: 19, minute: 30 },
    ]);

    for (let day = 0; day < CALENDAR_DAY_COUNT; day++) {
      const daySlots = slots.slice(
        day * CALENDAR_TIME_SLOTS.length,
        (day + 1) * CALENDAR_TIME_SLOTS.length,
      );
      expect(daySlots.length).toBe(CALENDAR_TIME_SLOTS.length);
      expect(daySlots.map((s) => [s.getHours(), s.getMinutes()])).toEqual(
        CALENDAR_TIME_SLOTS.map((s) => [s.hour, s.minute]),
      );
    }

    // Days are CONSECUTIVE (no Sun/Mon skip).
    for (let i = CALENDAR_TIME_SLOTS.length; i < slots.length; i += CALENDAR_TIME_SLOTS.length) {
      const dayDiff =
        (slots[i]!.getTime() - slots[i - CALENDAR_TIME_SLOTS.length]!.getTime()) /
        (24 * 60 * 60 * 1000);
      expect(Math.round(dayDiff)).toBe(1);
    }
  });

  it("lets tests request a smaller number of calendar days", () => {
    const slots = generateProposalSlots(new Date("2026-04-09T12:00:00Z"), 2);
    expect(slots.length).toBe(2 * CALENDAR_TIME_SLOTS.length);
  });

  it("formatSlotLabel yields a non-empty label", () => {
    const label = formatSlotLabel(new Date("2026-04-10T19:00:00Z"), "en");
    expect(label.length).toBeGreaterThan(0);
  });

  it("buildCalendarKeyboard emits a web_app button — NOT a plain URL button", () => {
    const kb = buildCalendarKeyboard("https://example.com/calendar?match=abc&lang=en", "en");
    const btn = kb.inline_keyboard[0]![0] as { web_app?: { url: string } };
    expect(btn.web_app?.url).toBe("https://example.com/calendar?match=abc&lang=en");
  });
});

describe("scheduler: startScheduling", () => {
  beforeEach(() => {
    // mockReset clears the queued `mockResolvedValueOnce` returns
    // (clearAllMocks only zaps call history) — important here because
    // some tests intentionally don't consume their mUser queue, and
    // a leftover would silently feed the next test.
    mMatch.findUnique.mockReset();
    mMatch.update.mockReset();
    mUser.findUnique.mockReset();
    mStartVenue.mockReset();
    mStartVenue.mockResolvedValue(undefined);
  });

  it("writes the proposed-time grid, clears any prior availability, pins iteration=3, and sends the calendar button to both Telegram users", async () => {
    mMatch.update.mockResolvedValue({});
    mMatch.findUnique.mockResolvedValue({
      calendarMessageIdA: null,
      calendarMessageIdB: null,
      userA: { telegramId: 1001n, language: "en" },
      userB: { telegramId: 1002n, language: "ru" },
    });

    const api = createApi();
    await startScheduling(api, "match-1");

    const updateArg = mMatch.update.mock.calls[0]![0] as {
      data: {
        schedulingIteration: number;
        proposedTimes: Date[];
        availableTimesA: Date[];
        availableTimesB: Date[];
      };
    };
    expect(updateArg.data.schedulingIteration).toBe(3);
    expect(updateArg.data.proposedTimes.length).toBe(CALENDAR_SLOT_COUNT);
    expect(updateArg.data.availableTimesA).toEqual([]);
    expect(updateArg.data.availableTimesB).toEqual([]);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "match-1" },
      data: { calendarMessageIdA: 500 },
    });
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "match-1" },
      data: { calendarMessageIdB: 501 },
    });
    // Per-user URL carries `&lang=` so the Mini App can render in their tongue.
    const sentUrls = api.sendMessage.mock.calls.map(
      (c: any[]) => (c[2] as { reply_markup: { inline_keyboard: any[][] } }).reply_markup.inline_keyboard[0][0].web_app.url,
    ) as string[];
    expect(sentUrls.some((u) => u.includes("lang=en"))).toBe(true);
    expect(sentUrls.some((u) => u.includes("lang=ru"))).toBe(true);
  });

  it("afterTicketGate uses the plain Calendar caption (no duplicate of the ticket celebration)", async () => {
    mMatch.update.mockResolvedValue({});
    mMatch.findUnique.mockResolvedValue({
      calendarMessageIdA: null,
      calendarMessageIdB: null,
      userA: { telegramId: 1001n, language: "en" },
      userB: { telegramId: 1002n, language: "en" },
    });

    const api = createApi();
    await startScheduling(api, "match-1", { afterTicketGate: true });

    const sentTexts: string[] = api.sendMessage.mock.calls.map((c: any[]) => c[1] as string);
    expect(sentTexts.every((txt: string) => txt === t("en", "matchScheduleAfterTicket"))).toBe(true);
    expect(sentTexts.some((txt: string) => txt === t("en", "matchScheduleIter3"))).toBe(false);
  });
});

describe("scheduler: handleSchedulePick (legacy callback fallback)", () => {
  beforeEach(() => {
    // mockReset clears the queued `mockResolvedValueOnce` returns
    // (clearAllMocks only zaps call history) — important here because
    // some tests intentionally don't consume their mUser queue, and
    // a leftover would silently feed the next test.
    mMatch.findUnique.mockReset();
    mMatch.update.mockReset();
    mUser.findUnique.mockReset();
    mStartVenue.mockReset();
    mStartVenue.mockResolvedValue(undefined);
  });

  it("acknowledges a stale `sched:pick:*` tap and re-delivers the calendar button instead of silently failing", async () => {
    const ctx = createCtx({
      session: { onboardingStep: "completed", language: "en" },
      callbackData: "sched:pick:match-1:0",
    });

    await handleSchedulePick(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyArgs = ctx.reply.mock.calls[0]!;
    const markup = (replyArgs[1] as { reply_markup: { inline_keyboard: any[][] } }).reply_markup;
    const btn = markup.inline_keyboard[0]![0] as { web_app?: { url: string } };
    expect(btn.web_app?.url).toContain("match=match-1");
    // Critically: we do NOT touch the DB on this fallback path.
    expect(mMatch.update).not.toHaveBeenCalled();
  });
});

describe("scheduler: processCalendarSlotsUpdate", () => {
  beforeEach(() => {
    // mockReset clears the queued `mockResolvedValueOnce` returns
    // (clearAllMocks only zaps call history) — important here because
    // some tests intentionally don't consume their mUser queue, and
    // a leftover would silently feed the next test.
    mMatch.findUnique.mockReset();
    mMatch.update.mockReset();
    mUser.findUnique.mockReset();
    mStartVenue.mockReset();
    mStartVenue.mockResolvedValue(undefined);
  });

  function mockMatchInState(overrides: {
    availableTimesA?: Date[];
    availableTimesB?: Date[];
    proposedTimes?: Date[];
    calendarMessageIdA?: number | null;
    calendarMessageIdB?: number | null;
  }) {
    mMatch.findUnique.mockResolvedValue({
      id: "match-1",
      userAId: "uid-A",
      userBId: "uid-B",
      status: "negotiating",
      proposedTimes: overrides.proposedTimes ?? [],
      availableTimesA: overrides.availableTimesA ?? [],
      availableTimesB: overrides.availableTimesB ?? [],
      calendarMessageIdA: overrides.calendarMessageIdA ?? null,
      calendarMessageIdB: overrides.calendarMessageIdB ?? null,
      userA: { telegramId: 1001n, language: "en" },
      userB: { telegramId: 1002n, language: "en" },
    });
  }

  it("rejects an ISO that's not on the proposedTimes allowlist (security boundary)", async () => {
    mockMatchInState({
      proposedTimes: [new Date("2026-05-01T19:00:00.000Z")],
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A", language: "en" });

    const api = createApi();
    const res = await processCalendarSlotsUpdate(api, 1001n, "match-1", [
      "2026-09-09T19:00:00.000Z",
    ]);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid-slot");
    expect(mMatch.update).not.toHaveBeenCalled();
  });

  it("locks in the *earliest* common slot and hands off to venue negotiation when both arrays now intersect", async () => {
    const early = new Date("2026-05-01T19:00:00.000Z");
    const middle = new Date("2026-05-02T19:00:00.000Z");
    const late = new Date("2026-05-03T19:00:00.000Z");
    // Peer already has [middle, late]. We submit [early, middle] — overlap is
    // {middle}; that's also the earliest common slot, so we agree on middle.
    mockMatchInState({
      proposedTimes: [early, middle, late],
      availableTimesA: [],
      availableTimesB: [middle, late],
      calendarMessageIdA: 71,
      calendarMessageIdB: 72,
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A", language: "en" });

    const api = createApi();
    const res = await processCalendarSlotsUpdate(api, 1001n, "match-1", [
      early.toISOString(),
      middle.toISOString(),
    ]);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.agreedTime).toBe(middle.toISOString());
    expect(mStartVenue).toHaveBeenCalledTimes(1);
    expect(api.deleteMessage).toHaveBeenCalledWith(1001, 71);
    expect(api.deleteMessage).toHaveBeenCalledWith(1002, 72);
    const [, matchId, agreedTime] = mStartVenue.mock.calls[0]!;
    expect(matchId).toBe("match-1");
    expect((agreedTime as Date).getTime()).toBe(middle.getTime());
  });

  it("uses the peer's post-write availability when both users save concurrently", async () => {
    const slot = new Date("2026-05-01T19:00:00.000Z");
    mockMatchInState({
      proposedTimes: [slot],
      availableTimesA: [],
      availableTimesB: [],
    });
    mMatch.findUnique.mockResolvedValueOnce({
      id: "match-1",
      userAId: "uid-A",
      userBId: "uid-B",
      status: "negotiating",
      proposedTimes: [slot],
      availableTimesA: [],
      availableTimesB: [],
      calendarMessageIdA: null,
      calendarMessageIdB: null,
      userA: { telegramId: 1001n, language: "en" },
      userB: { telegramId: 1002n, language: "en" },
    });
    mMatch.findUnique.mockResolvedValueOnce({
      status: "negotiating",
      availableTimesA: [slot],
      availableTimesB: [slot],
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A", language: "en" });

    const res = await processCalendarSlotsUpdate(
      createApi(),
      1001n,
      "match-1",
      [slot.toISOString()],
    );

    expect(res).toMatchObject({ ok: true, agreedTime: slot.toISOString() });
    expect(mStartVenue).toHaveBeenCalledOnce();
  });

  it("on the actor's first non-empty submission, DMs the peer (calendar button) AND sends the actor a confirmation receipt", async () => {
    const slot = new Date("2026-05-01T19:00:00.000Z");
    mockMatchInState({
      proposedTimes: [slot],
      availableTimesA: [],
      availableTimesB: [],
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A", language: "en" });

    const api = createApi();
    const res = await processCalendarSlotsUpdate(api, 1001n, "match-1", [
      slot.toISOString(),
    ]);

    expect(res.ok).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    // Both DM targets — peer (1002) + actor (1001) — fired exactly once.
    const targets = api.sendMessage.mock.calls.map((c: any[]) => c[0]).sort();
    expect(targets).toEqual([1001, 1002]);
    expect(mStartVenue).not.toHaveBeenCalled();
  });

  it("returns overlapCandidates and does NOT auto-lock when intersection has more than one slot", async () => {
    const a = new Date("2026-05-01T19:00:00.000Z");
    const b = new Date("2026-05-02T19:00:00.000Z");
    const c = new Date("2026-05-03T19:00:00.000Z");
    // Peer has [a, b, c]. Actor submits [a, b]. Intersection = [a, b] —
    // server must NOT pick the earliest; instead returns candidates so
    // the Mini App's confirm card surfaces them to the actor.
    mockMatchInState({
      proposedTimes: [a, b, c],
      availableTimesA: [],
      availableTimesB: [a, b, c],
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A", language: "en" });

    const api = createApi();
    const res = await processCalendarSlotsUpdate(api, 1001n, "match-1", [
      a.toISOString(),
      b.toISOString(),
    ]);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.agreedTime).toBeNull();
      expect(res.overlapCandidates).toEqual([a.toISOString(), b.toISOString()]);
      expect(res.bothPicked).toBe(true);
    }
    // Critical: no venue handoff when overlap is multi.
    expect(mStartVenue).not.toHaveBeenCalled();
    // No DMs in the multi-overlap path — actor is still in the Mini App
    // and the confirm card collapses to size 1 on the next POST.
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("collapses to single-overlap auto-lock on a follow-up POST with one of the candidates", async () => {
    const a = new Date("2026-05-01T19:00:00.000Z");
    const b = new Date("2026-05-02T19:00:00.000Z");
    // Peer has [a, b]. Actor (after multi-overlap card) re-POSTs just
    // [a] to commit it. Intersection = [a], single — auto-lock fires.
    mockMatchInState({
      proposedTimes: [a, b],
      availableTimesA: [a, b], // their previous multi-overlap submission
      availableTimesB: [a, b],
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A", language: "en" });

    const api = createApi();
    const res = await processCalendarSlotsUpdate(api, 1001n, "match-1", [
      a.toISOString(),
    ]);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.agreedTime).toBe(a.toISOString());
      expect(res.overlapCandidates).toEqual([]);
    }
    expect(mStartVenue).toHaveBeenCalledTimes(1);
  });

  it("when both sides have submitted but no shared slot exists, deletes the peer's stale card and sends a fresh one", async () => {
    const a = new Date("2026-05-01T19:00:00.000Z");
    const b = new Date("2026-05-02T19:00:00.000Z");
    const c = new Date("2026-05-03T19:00:00.000Z");
    // Peer has [c]. Actor submits [a, b] — no intersection.
    mockMatchInState({
      proposedTimes: [a, b, c],
      availableTimesA: [],
      availableTimesB: [c],
      calendarMessageIdB: 72,
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A", language: "en" });

    const api = createApi();
    const res = await processCalendarSlotsUpdate(api, 1001n, "match-1", [
      a.toISOString(),
      b.toISOString(),
    ]);

    expect(res.ok).toBe(true);
    // Delete the stale card + send a fresh, notifying message (not a silent edit)
    // so the peer sees "your partner changed the time" as the newest chat message.
    expect(api.deleteMessage).toHaveBeenCalledWith(1002, 72);
    expect(api.sendMessage).toHaveBeenCalledWith(
      1002,
      expect.stringContaining("countered with a different time"),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("sends a replacement calendar card when the stored message is gone", async () => {
    const a = new Date("2026-05-01T19:00:00.000Z");
    const b = new Date("2026-05-02T19:00:00.000Z");
    mockMatchInState({
      proposedTimes: [a, b],
      availableTimesA: [],
      availableTimesB: [b],
      calendarMessageIdB: 72,
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A", language: "en" });

    const api = createApi();
    api.editMessageText.mockRejectedValueOnce({
      description: "Bad Request: message to edit not found",
    });

    await processCalendarSlotsUpdate(api, 1001n, "match-1", [
      a.toISOString(),
    ]);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]![0]).toBe(1002);
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "match-1" },
      data: { calendarMessageIdB: 500 },
    });
  });

  it("does NOT re-DM the peer on a redundant re-save with the same set (idempotency)", async () => {
    const a = new Date("2026-05-01T19:00:00.000Z");
    const b = new Date("2026-05-02T19:00:00.000Z");
    const c = new Date("2026-05-03T19:00:00.000Z");
    // Actor previously submitted [a, b]; peer has [c]. No overlap.
    // Actor re-saves the SAME [a, b] — should NOT re-spam the peer with
    // "no overlap" DMs.
    mockMatchInState({
      proposedTimes: [a, b, c],
      availableTimesA: [a, b],
      availableTimesB: [c],
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A", language: "en" });

    const api = createApi();
    await processCalendarSlotsUpdate(api, 1001n, "match-1", [
      a.toISOString(),
      b.toISOString(),
    ]);

    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("does NOT re-DM the peer on a subsequent update (only the empty→non-empty transition triggers it)", async () => {
    const slot1 = new Date("2026-05-01T19:00:00.000Z");
    const slot2 = new Date("2026-05-02T19:00:00.000Z");
    mockMatchInState({
      proposedTimes: [slot1, slot2],
      availableTimesA: [slot1], // already non-empty
      availableTimesB: [],
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A", language: "en" });

    const api = createApi();
    await processCalendarSlotsUpdate(api, 1001n, "match-1", [
      slot1.toISOString(),
      slot2.toISOString(),
    ]);

    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("dedupes and sorts the submitted ISO array on disk", async () => {
    const a = new Date("2026-05-03T19:00:00.000Z");
    const b = new Date("2026-05-01T19:00:00.000Z");
    mockMatchInState({
      proposedTimes: [a, b],
      availableTimesA: [],
      availableTimesB: [], // peer empty so no overlap, no DM noise
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A", language: "en" });

    const api = createApi();
    await processCalendarSlotsUpdate(api, 1001n, "match-1", [
      a.toISOString(),
      b.toISOString(),
      a.toISOString(), // duplicate
    ]);

    const written = (mMatch.update.mock.calls[0]![0] as { data: { availableTimesA: Date[] } })
      .data.availableTimesA;
    expect(written.length).toBe(2);
    expect(written[0]!.getTime()).toBe(b.getTime()); // earliest first
    expect(written[1]!.getTime()).toBe(a.getTime());
  });

  it("rejects updates on a match that's no longer in the `negotiating` state", async () => {
    mMatch.findUnique.mockResolvedValueOnce({
      id: "match-1",
      userAId: "uid-A",
      userBId: "uid-B",
      status: "scheduled",
      proposedTimes: [],
      availableTimesA: [],
      availableTimesB: [],
      userA: { telegramId: 1001n, language: "en" },
      userB: { telegramId: 1002n, language: "en" },
    });

    const api = createApi();
    const res = await processCalendarSlotsUpdate(api, 1001n, "match-1", []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("wrong-state");
  });
});

describe("scheduler: getCalendarState", () => {
  beforeEach(() => {
    // mockReset clears the queued `mockResolvedValueOnce` returns
    // (clearAllMocks only zaps call history) — important here because
    // some tests intentionally don't consume their mUser queue, and
    // a leftover would silently feed the next test.
    mMatch.findUnique.mockReset();
    mMatch.update.mockReset();
    mUser.findUnique.mockReset();
    mStartVenue.mockReset();
    mStartVenue.mockResolvedValue(undefined);
  });

  it("returns mySlots / peerSlots from the requester's perspective and flags isFirstMover when peer is empty", async () => {
    const slot = new Date("2026-05-01T19:00:00.000Z");
    mMatch.findUnique.mockResolvedValueOnce({
      userAId: "uid-A",
      userBId: "uid-B",
      status: "negotiating",
      proposedTimes: [slot],
      availableTimesA: [slot],
      availableTimesB: [],
      agreedTime: null,
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });

    const res = await getCalendarState(1001n, "match-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mySlots).toEqual([slot.toISOString()]);
      expect(res.peerSlots).toEqual([]);
      expect(res.isFirstMover).toBe(true);
    }
  });

  it("flips mySlots / peerSlots correctly for user B", async () => {
    const slot = new Date("2026-05-01T19:00:00.000Z");
    mMatch.findUnique.mockResolvedValueOnce({
      userAId: "uid-A",
      userBId: "uid-B",
      status: "negotiating",
      proposedTimes: [slot],
      availableTimesA: [slot],
      availableTimesB: [],
      agreedTime: null,
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" });

    const res = await getCalendarState(1002n, "match-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mySlots).toEqual([]);
      expect(res.peerSlots).toEqual([slot.toISOString()]);
      // B sees A's slot — B is *not* the first mover.
      expect(res.isFirstMover).toBe(false);
    }
  });

  it("rejects callers who aren't part of the match (403 path)", async () => {
    mMatch.findUnique.mockResolvedValueOnce({
      userAId: "uid-A",
      userBId: "uid-B",
      status: "negotiating",
      proposedTimes: [],
      availableTimesA: [],
      availableTimesB: [],
      agreedTime: null,
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-other" });

    const res = await getCalendarState(9999n, "match-1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not-participant");
  });
});

describe("scheduler: handleCalendarWebAppData (legacy WS path)", () => {
  beforeEach(() => {
    // mockReset clears the queued `mockResolvedValueOnce` returns
    // (clearAllMocks only zaps call history) — important here because
    // some tests intentionally don't consume their mUser queue, and
    // a leftover would silently feed the next test.
    mMatch.findUnique.mockReset();
    mMatch.update.mockReset();
    mUser.findUnique.mockReset();
    mStartVenue.mockReset();
    mStartVenue.mockResolvedValue(undefined);
  });

  it("parses the new `pickedIsos` array shape", async () => {
    const slot = new Date("2026-05-01T19:00:00.000Z");
    mMatch.findUnique.mockResolvedValueOnce({
      id: "match-1",
      userAId: "uid-A",
      userBId: "uid-B",
      status: "negotiating",
      proposedTimes: [slot],
      availableTimesA: [],
      availableTimesB: [],
      userA: { telegramId: 1001n, language: "en" },
      userB: { telegramId: 1002n, language: "en" },
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A", language: "en" });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      fromId: 1001,
      webAppData: JSON.stringify({
        matchId: "match-1",
        pickedIsos: [slot.toISOString()],
      }),
    });

    await handleCalendarWebAppData(ctx);

    expect(mMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ availableTimesA: expect.any(Array) }),
      }),
    );
  });

  it("still accepts the legacy single-`pickedIso` shape from older bundles", async () => {
    const slot = new Date("2026-05-01T19:00:00.000Z");
    mMatch.findUnique.mockResolvedValueOnce({
      id: "match-1",
      userAId: "uid-A",
      userBId: "uid-B",
      status: "negotiating",
      proposedTimes: [slot],
      availableTimesA: [],
      availableTimesB: [],
      userA: { telegramId: 1001n, language: "en" },
      userB: { telegramId: 1002n, language: "en" },
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A", language: "en" });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      fromId: 1001,
      webAppData: JSON.stringify({ matchId: "match-1", pickedIso: slot.toISOString() }),
    });

    await handleCalendarWebAppData(ctx);
    expect(mMatch.update).toHaveBeenCalled();
  });

  it("ignores malformed JSON payloads", async () => {
    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      webAppData: "not json",
    });
    await handleCalendarWebAppData(ctx);
    expect(mMatch.findUnique).not.toHaveBeenCalled();
  });
});
