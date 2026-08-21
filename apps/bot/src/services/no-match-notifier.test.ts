import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => {
  // The D10 pause runs its status CAS and its `starvationPausedAt` stamp inside
  // one `$transaction`, so the tx client here exposes the SAME mock functions as
  // the top-level client. That keeps every existing `mProfileUpdateMany`
  // assertion working whether the call came from `prisma` or from `tx`.
  const user = { findMany: vi.fn() };
  const match = { findFirst: vi.fn() };
  const noMatchNotice = { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() };
  const profile = { updateMany: vi.fn() };
  return {
    prisma: {
      user,
      match,
      noMatchNotice,
      profile,
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ user, match, noMatchNotice, profile }),
      ),
    },
  };
});

vi.mock("./ticket-discount.js", () => ({
  grantFamineDiscountIfEligible: vi.fn(),
}));

// D10: mocked as an independent collaborator (it has its own test file,
// account-status-transitions.test.ts) rather than extending the @gennety/db
// mock with the full CAS machinery it needs.
vi.mock("./account-status-transitions.js", () => ({
  transitionAccountStatus: vi.fn(),
}));

// §4.3: the app rail. Mocked rather than exercised — `push.ts` owns token
// lookup and APNs, and both have their own tests; what matters here is WHO it
// is called for and WHAT it carries.
vi.mock("./push.js", () => ({ sendPushToUser: vi.fn() }));

// The Rematch offer is a Telegram DM with a Stars button; mocked so the
// push-only cases below can assert it is not even attempted there, without
// dragging in env flags, the card renderer and InlineKeyboard.
vi.mock("../handlers/matching/rematch.js", () => ({
  sendRematchOfferIfEligible: vi.fn(),
}));

import { prisma } from "@gennety/db";
import {
  sendNoMatchNotices,
  getDropDate,
  NO_MATCH_PUSH_TYPE,
} from "./no-match-notifier.js";
import { grantFamineDiscountIfEligible } from "./ticket-discount.js";
import { transitionAccountStatus } from "./account-status-transitions.js";
import { sendPushToUser } from "./push.js";
import { sendRematchOfferIfEligible } from "../handlers/matching/rematch.js";
import { CADENCE, FAMINE_PAUSE_AFTER_DAYS } from "@gennety/shared";

type MockFn = ReturnType<typeof vi.fn>;
const mUserFindMany = (prisma.user as unknown as { findMany: MockFn }).findMany;
const mMatchFindFirst = (prisma.match as unknown as { findFirst: MockFn }).findFirst;
const mNoticeFindFirst = (prisma.noMatchNotice as unknown as { findFirst: MockFn }).findFirst;
const mNoticeCreate = (prisma.noMatchNotice as unknown as { create: MockFn }).create;
const mNoticeDeleteMany = (prisma.noMatchNotice as unknown as { deleteMany: MockFn }).deleteMany;
const mProfileUpdateMany = (prisma.profile as unknown as { updateMany: MockFn }).updateMany;
const mTransaction = (prisma as unknown as { $transaction: MockFn }).$transaction;
const mGrant = grantFamineDiscountIfEligible as unknown as MockFn;
const mTransition = transitionAccountStatus as unknown as MockFn;
const mPush = sendPushToUser as unknown as MockFn;
const mRematch = sendRematchOfferIfEligible as unknown as MockFn;

function makeApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

// Synchronous stub for the injectable chunk streamer: forwards the FINAL chunk
// to `api.sendMessage` so the existing call-count / body / failure assertions
// keep working, without real waits.
function makeStream() {
  return vi.fn(
    async (a: { sendMessage: MockFn }, chatId: number, chunks: string[]) => {
      await a.sendMessage(chatId, chunks[chunks.length - 1]);
      return undefined;
    },
  );
}

const NOW = new Date("2026-05-07T15:15:00Z"); // Thursday 18:15 Kyiv (UTC+3 summer)
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `computeTier` measures elapsed time from `dispatchedAt` to `dropDate`
 * (`getDropDate(now)` — floored to UTC midnight, NOT `now` itself), in units
 * of `CADENCE.famineNoticeIntervalMs` — the gap between NOTICES, not between
 * batches. A tier is therefore "which message in this streak is this", which
 * is what the tier copy claims ("second time in a row") and what makes
 * `famineDiscountMinTier` mean the same thing under any cadence.
 *
 * The interval is read from `CADENCE` rather than hardcoded so these anchors
 * stay correct if a run ever selects a different profile. It is 7 days in both
 * profiles today, so every expectation below holds under `daily` too — which is
 * precisely the property being protected.
 *
 * Each helper picks a `dispatchedAt` comfortably inside the target bucket (not
 * right on a boundary, which the flooring above would otherwise nudge into the
 * bucket below):
 *   tier 1 → elapsed ~1 interval
 *   tier 2 → elapsed ~2 intervals
 *   tier 3 → elapsed ~3 intervals
 */
function dispatchedForTier(tier: 1 | 2 | 3, now: Date = NOW): Date {
  const dropDate = getDropDate(now);
  const intervalsAgo = tier; // comfortably mid-bucket: exactly N intervals back
  return new Date(dropDate.getTime() - intervalsAgo * CADENCE.famineNoticeIntervalMs);
}

describe("getDropDate", () => {
  it("floors to UTC midnight of the same day", () => {
    expect(getDropDate(NOW).toISOString()).toBe("2026-05-07T00:00:00.000Z");
  });
});

describe("sendNoMatchNotices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mNoticeCreate.mockResolvedValue({});
    mNoticeDeleteMany.mockResolvedValue({ count: 1 });
    // Default: no prior notice on file — only read when mMatchFindFirst
    // resolves null (the "never matched" fallback anchor in computeTier).
    mNoticeFindFirst.mockResolvedValue(null);
    // Default: feature off / not granted (the grant self-gates on the flag).
    mGrant.mockResolvedValue({ granted: false });
    // D10 defaults: none of the tier-focused tests below reach
    // FAMINE_PAUSE_AFTER_DAYS, but a default is set anyway so a stray call
    // never throws "not a function" against an un-primed mock.
    mTransition.mockResolvedValue({ kind: "changed" });
    mProfileUpdateMany.mockResolvedValue({ count: 1 });
    // §4.3 defaults: APNs accepted it. Every fixture WITHOUT a `platform` is a
    // pre-column Telegram row, so the push leg isn't reached at all there.
    mPush.mockResolvedValue(true);
    mRematch.mockResolvedValue(false);
  });

  it("(D4) throttles candidate selection to famineNoticeIntervalMs, not the exact drop day", async () => {
    // The candidate query must exclude anyone notified more recently than
    // CADENCE.famineNoticeIntervalMs — this is what decouples "how often the
    // batch/cron fires" from "how often a starved user actually gets a DM"
    // (D4). Asserting on the query shape directly since the mocked Prisma
    // client doesn't evaluate `where` itself.
    mUserFindMany.mockResolvedValueOnce([]);

    await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

    const arg = mUserFindMany.mock.calls[0]![0] as {
      where: { AND: Array<Record<string, unknown>> };
    };
    const throttleClause = arg.where.AND.find(
      (c) => "noMatchNotices" in c,
    ) as { noMatchNotices: { none: { dropDate: { gte: Date } } } };
    expect(throttleClause).toBeDefined();
    const cutoff = throttleClause.noMatchNotices.none.dropDate.gte;
    const expectedCutoff = NOW.getTime() - CADENCE.famineNoticeIntervalMs;
    expect(Math.abs(cutoff.getTime() - expectedCutoff)).toBeLessThan(1000);
  });

  it("returns zero counts when no candidates are eligible", async () => {
    mUserFindMany.mockResolvedValueOnce([]);
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.notified).toBe(0);
    expect(result.tier1).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(mNoticeCreate).not.toHaveBeenCalled();
  });

  it("sends tier-1 message for a user with no matches ever and no prior notice (first-ever check)", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    mNoticeFindFirst.mockResolvedValueOnce(null); // no prior notice → anchors to dropDate itself
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.notified).toBe(1);
    expect(result.tier1).toBe(1);
    expect(result.tier2).toBe(0);
    expect(result.tier3plus).toBe(0);

    const [chatId, body] = api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(111);
    expect(body).toMatch(/quality bar/);
    // Streamed as a short 2-chunk reveal: a "thinking" lead beat, then the
    // full empathetic body (no `parse_mode` — the templates carry no Markdown).
    const chunks = stream.mock.calls[0]![2] as string[];
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatch(/pool/i);
    expect(chunks[1]).toMatch(/quality bar/);

    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 1, dropDate: getDropDate(NOW) },
    });
  });

  it("sends tier-1 for a user whose last match was dispatched under 2 intervals ago", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForTier(1) });
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.tier1).toBe(1);
    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 1, dropDate: getDropDate(NOW) },
    });
  });

  it("escalates to tier 2 once ~2 intervals have elapsed since the last match", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "ru" },
    ]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForTier(2) });
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.tier2).toBe(1);
    expect(result.tier1).toBe(0);

    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/второй раз подряд/i);

    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 2, dropDate: getDropDate(NOW) },
    });
  });

  it("buckets tier 3+ once ~3 or more intervals have elapsed since the last match", async () => {
    // Both comfortably under FAMINE_PAUSE_AFTER_DAYS (28) so the D10 pause
    // path doesn't take over — see the dedicated pause tests below for that
    // boundary specifically.
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "uk" },
      { id: "u2", telegramId: 222n, language: "en" },
    ]);
    mMatchFindFirst
      .mockResolvedValueOnce({ dispatchedAt: dispatchedForTier(3) }) // 21 days
      .mockResolvedValueOnce({ dispatchedAt: new Date(getDropDate(NOW).getTime() - 26 * DAY_MS) }); // still tier 3, further along
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.tier3plus).toBe(2);
    expect(result.tier1).toBe(0);
    expect(result.tier2).toBe(0);
    expect(result.paused).toBe(0);

    const [, body1] = api.sendMessage.mock.calls[0]!;
    const [, body2] = api.sendMessage.mock.calls[1]!;
    expect(body1).toMatch(/Знову чесно/);
    expect(body2).toMatch(/honest update/);
  });

  describe("D10: pool-exhaustion pause", () => {
    function dispatchedDaysAgo(days: number, now: Date = NOW): Date {
      return new Date(getDropDate(now).getTime() - days * DAY_MS);
    }

    it("pauses instead of sending another tier DM once FAMINE_PAUSE_AFTER_DAYS is reached", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "u1", telegramId: 111n, language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({
        dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS),
      });
      const api = makeApi();

      const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

      expect(result.paused).toBe(1);
      expect(result.tier1).toBe(0);
      expect(result.tier2).toBe(0);
      expect(result.tier3plus).toBe(0);
      expect(result.notified).toBe(1);

      // Pause is a plain send (states a fact), not the rich empathy stream.
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      const [, body] = api.sendMessage.mock.calls[0]!;
      expect(body).toMatch(/pausing your search/);

      // The CAS + the profile marker stamp both fired — and both ran against
      // the transaction client, not the bare prisma client (NOMATCH-2).
      expect(mTransition).toHaveBeenCalledWith(
        { id: "u1" },
        "pause",
        expect.anything(),
      );
      expect(mProfileUpdateMany).toHaveBeenCalledWith({
        where: { userId: "u1" },
        data: { starvationPausedAt: NOW },
      });
      expect(mTransaction).toHaveBeenCalledTimes(1);
    });

    it("does not grant the famine discount or offer Rematch on a pause", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "u1", telegramId: 111n, language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({
        dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS + 5),
      });
      const api = makeApi();

      await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

      expect(mGrant).not.toHaveBeenCalled();
    });

    it("falls back to the ordinary tier DM when the pause CAS loses a race", async () => {
      // Simulates the candidate having moved off `active` (moderation, a
      // manual pause/freeze) between candidate selection and this point.
      mUserFindMany.mockResolvedValueOnce([
        { id: "u1", telegramId: 111n, language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({
        dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS),
      });
      mTransition.mockResolvedValueOnce({ kind: "forbidden" });
      const api = makeApi();
      const stream = makeStream();

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      expect(result.paused).toBe(0);
      expect(result.tier3plus).toBe(1);
      expect(mProfileUpdateMany).not.toHaveBeenCalled();
      // Falls through to the ordinary rich stream, not the plain pause send.
      expect(stream).toHaveBeenCalled();
    });

    // NOMATCH-2 — the pause must never become a state the product cannot undo.
    // `autoResumeStarvedUsers` selects `paused AND starvationPausedAt != null`,
    // and this notifier only ever selects `active`, so a pause that lands
    // without its marker (or without its DM) is invisible to both sweeps: the
    // user is silently and permanently out of the pool.
    describe("NOMATCH-2: the pause is always reversible", () => {
      it("does not leave the account paused when the marker stamp fails", async () => {
        mUserFindMany.mockResolvedValueOnce([
          { id: "u1", telegramId: 111n, language: "en" },
        ]);
        mMatchFindFirst.mockResolvedValueOnce({
          dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS),
        });
        // The status CAS succeeds, the marker write blows up. Both are inside
        // one transaction, so the CAS must roll back with it.
        mProfileUpdateMany.mockRejectedValueOnce(new Error("db blip"));
        const api = makeApi();

        const result = await sendNoMatchNotices(
          api as never,
          NOW,
          0,
          makeStream() as never,
        );

        expect(result.paused).toBe(0);
        expect(result.failed).toBe(1);
        // Nothing claims the user was notified, and the notice row is undone
        // so the next run can retry the whole decision.
        expect(mNoticeDeleteMany).toHaveBeenCalled();

        // The load-bearing assertion. `transitionAccountStatus` is mocked, so
        // the rollback itself can't be observed here — what CAN be observed is
        // the property that guarantees it against a real database: the status
        // CAS ran on the transaction client, in the same transaction as the
        // marker write that just threw. Against the two-independent-writes
        // version this fails, because no transaction is opened at all.
        expect(mTransaction).toHaveBeenCalledTimes(1);
        expect(mTransition).toHaveBeenCalledWith(
          { id: "u1" },
          "pause",
          expect.anything(),
        );
      });

      it("resumes the account when the pause committed but the DM never landed", async () => {
        mUserFindMany.mockResolvedValueOnce([
          { id: "u1", telegramId: 111n, language: "en" },
        ]);
        mMatchFindFirst.mockResolvedValueOnce({
          dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS),
        });
        const api = makeApi();
        // The pause commits, then Telegram refuses the send (blocked bot, etc).
        api.sendMessage.mockRejectedValueOnce(new Error("bot was blocked"));

        const result = await sendNoMatchNotices(
          api as never,
          NOW,
          0,
          makeStream() as never,
        );

        expect(result.paused).toBe(0);
        expect(result.failed).toBe(1);
        // The account is put back so the next run re-evaluates and re-sends,
        // rather than stranding a user who was paused and never told.
        expect(mTransition).toHaveBeenCalledWith({ id: "u1" }, "resume");
        expect(mNoticeDeleteMany).toHaveBeenCalled();
      });

      it("does not attempt a resume when no pause was taken", async () => {
        mUserFindMany.mockResolvedValueOnce([
          { id: "u1", telegramId: 111n, language: "en" },
        ]);
        // Tier 3, comfortably short of the pause threshold.
        mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForTier(3) });
        const api = makeApi();
        const stream = makeStream();
        stream.mockRejectedValueOnce(new Error("send failed"));

        const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

        expect(result.failed).toBe(1);
        expect(mTransition).not.toHaveBeenCalled();
      });
    });

    it("never pauses a market-pending user, however long they've waited", async () => {
      mUserFindMany.mockResolvedValueOnce([
        {
          id: "u1",
          telegramId: 111n,
          language: "en",
          profile: { homeCityKey: "de:berlin", homeCity: "Berlin" },
        },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({
        dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS + 100),
      });
      const api = makeApi();

      const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

      expect(result.paused).toBe(0);
      expect(mTransition).not.toHaveBeenCalled();
      const [, body] = api.sendMessage.mock.calls[0]!;
      expect(body).toMatch(/Berlin/);
    });
  });

  it("never-matched user anchors to their earliest NoMatchNotice, not the Unix epoch", async () => {
    // Regression guard: before the "never matched" fallback anchor existed,
    // computeTier would measure elapsed time from `new Date(0)` for a user
    // with no dispatched match at all, producing an absurd tier (tens of
    // thousands of intervals) on their very first check. The fallback
    // anchors to their first-ever NoMatchNotice instead.
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    mNoticeFindFirst.mockResolvedValueOnce({
      dropDate: dispatchedForTier(2), // their famine streak started ~2 intervals ago
    });
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.tier2).toBe(1);
  });

  // §4.3: a negative id is no longer what makes this a skip — the absence of
  // BOTH rails is. This row claims no `platform`, so there is no app rail to
  // fall back to, and it stays the one case the service genuinely cannot
  // reach. No `NoMatchNotice` is written for it: that row is the anchor the
  // next tier is measured from, and a notice nobody received must not age a
  // famine streak.
  it("skips a user reachable on neither rail, without a DB write or a push", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "tg", telegramId: 555n, language: "en" },
      { id: "nowhere", telegramId: -42n, platform: null, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValue(null);
    mNoticeFindFirst.mockResolvedValue(null);
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.notified).toBe(1);
    expect(result.skipped).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(mPush).not.toHaveBeenCalled();
    expect(mNoticeCreate).toHaveBeenCalledTimes(1);
    expect(mNoticeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "tg" }) }),
    );
  });

  it("continues on send failure and reports the error", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
      { id: "u2", telegramId: 222n, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValue(null);
    mNoticeFindFirst.mockResolvedValue(null);
    const api = makeApi();
    const stream = makeStream();
    api.sendMessage
      .mockRejectedValueOnce(new Error("Telegram 403: blocked"))
      .mockResolvedValueOnce(undefined);

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.notified).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]!.userId).toBe("u1");
    expect(result.errors[0]!.error).toMatch(/403/);
    // Claims are persisted before the side effect so overlapping workers
    // cannot both send the same notice.
    expect(mNoticeCreate).toHaveBeenCalledTimes(2);
    expect(mNoticeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "u2" }) }),
    );
    // (NOMATCH-1) u1's send failed after its claim was made — the claim is
    // rolled back so a retry can find them again instead of a failed send
    // permanently masquerading as "notified".
    expect(mNoticeDeleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", dropDate: getDropDate(NOW) },
    });
    expect(mNoticeDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("(NOMATCH-1) does not roll back the claim when the send succeeds", async () => {
    mUserFindMany.mockResolvedValueOnce([{ id: "u1", telegramId: 111n, language: "en" }]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    mNoticeFindFirst.mockResolvedValueOnce(null);
    const api = makeApi();

    await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(mNoticeCreate).toHaveBeenCalledTimes(1);
    expect(mNoticeDeleteMany).not.toHaveBeenCalled();
  });

  it("(NOMATCH-1) skips (not fails) a user whose claim races another invocation", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: "en" },
      { id: "u2", telegramId: 222n, language: "en" },
    ]);
    mMatchFindFirst.mockResolvedValue(null);
    mNoticeFindFirst.mockResolvedValue(null);
    const raceError = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    mNoticeCreate.mockRejectedValueOnce(raceError).mockResolvedValueOnce({});
    const api = makeApi();

    const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    // u1 lost the claim race — skipped, not counted as a failure, and never
    // sent a message (an overlapping worker already owns that notice).
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.notified).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]![0]).toBe(222);
  });

  it("tier 1 never attempts the famine discount grant", async () => {
    mUserFindMany.mockResolvedValueOnce([{ id: "u1", telegramId: 111n, language: "en" }]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    mNoticeFindFirst.mockResolvedValueOnce(null);
    const api = makeApi();

    await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(mGrant).not.toHaveBeenCalled();
  });

  it("tier 2 grants the discount and appends the offer line to the DM", async () => {
    mUserFindMany.mockResolvedValueOnce([{ id: "u1", telegramId: 111n, language: "en" }]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForTier(2) }); // tier 2
    mGrant.mockResolvedValueOnce({ granted: true, pct: 77, expiresAt: new Date() });
    const api = makeApi();

    await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(mGrant).toHaveBeenCalledWith("u1");
    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/77% off/);
  });

  it("tier 2 with the feature off (grant returns granted:false) appends nothing", async () => {
    mUserFindMany.mockResolvedValueOnce([{ id: "u1", telegramId: 111n, language: "en" }]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForTier(2) }); // tier 2
    // default mGrant → { granted: false }
    const api = makeApi();

    await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

    expect(mGrant).toHaveBeenCalledWith("u1");
    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).not.toMatch(/% off/);
  });

  // Kyiv-only market gate (PRODUCT_SPEC §1.1/§3.1).
  it("tells a user in an unlaunched city the truth instead of a famine tier", async () => {
    mUserFindMany.mockResolvedValueOnce([
      {
        id: "u1",
        telegramId: 111n,
        language: "en",
        profile: { homeCityKey: "de:berlin", homeCity: "Berlin" },
      },
    ]);
    mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForTier(3) }); // would be tier 3 + a famine discount
    const api = makeApi();
    const stream = makeStream();

    const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(result.notified).toBe(1);
    // Plain send with the switch button, not the "we really looked" stream.
    expect(stream).not.toHaveBeenCalled();
    const [chatId, body, options] = api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(111);
    expect(body).toMatch(/Berlin/);
    expect(body).not.toMatch(/quality bar/);
    expect(JSON.stringify(options.reply_markup)).toContain("menu:city:switch");
    // No famine discount for a drop they were never in.
    expect(mGrant).not.toHaveBeenCalled();
    // The notice row still lands, so the drop stays idempotent.
    expect(mNoticeCreate).toHaveBeenCalledWith({
      data: { userId: "u1", tier: 3, dropDate: getDropDate(NOW) },
    });
  });

  it("keeps the ordinary famine copy for a user in a launched city", async () => {
    mUserFindMany.mockResolvedValueOnce([
      {
        id: "u1",
        telegramId: 111n,
        language: "en",
        profile: { homeCityKey: "ua:kyiv", homeCity: "Kyiv" },
      },
    ]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    mNoticeFindFirst.mockResolvedValueOnce(null);
    const api = makeApi();
    const stream = makeStream();

    await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    expect(stream).toHaveBeenCalled();
    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/quality bar/);
  });

  it("defaults to English when the user has no language set", async () => {
    mUserFindMany.mockResolvedValueOnce([
      { id: "u1", telegramId: 111n, language: null },
    ]);
    mMatchFindFirst.mockResolvedValueOnce(null);
    mNoticeFindFirst.mockResolvedValueOnce(null);
    const api = makeApi();
    const stream = makeStream();

    await sendNoMatchNotices(api as never, NOW, 0, stream as never);

    const [, body] = api.sendMessage.mock.calls[0]!;
    expect(body).toMatch(/quality bar/);
  });

  /**
   * §4.3 — "no match this drop" reaches the app.
   *
   * The same class of defect `pre-date-safety.ts` fixed in §5.4: one filter
   * (`telegramId <= 0n`) was answering two different questions — whether this
   * person should be told, and which rail can tell them. The candidate query
   * answers the first. `telegramReachable` / `pushReachable` answer the second,
   * per user, and `both` means both.
   */
  describe("§4.3: the app rail", () => {
    function dispatchedDaysAgo(days: number, now: Date = NOW): Date {
      return new Date(getDropDate(now).getTime() - days * DAY_MS);
    }

    it("pushes to a user on the app and sends them no DM", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "app", telegramId: -42n, platform: "mobile", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      mNoticeFindFirst.mockResolvedValueOnce(null);
      const api = makeApi();
      const stream = makeStream();

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      // Told, counted, and tiered exactly like anyone else — the rail is not
      // the product, it is the transport.
      expect(result.notified).toBe(1);
      expect(result.tier1).toBe(1);
      expect(result.skipped).toBe(0);
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
      expect(mPush).toHaveBeenCalledTimes(1);
      expect(mPush.mock.calls[0]![0]).toBe("app"); // internal id, not telegramId
      // The idempotency row still lands, so a re-run doesn't re-notify.
      expect(mNoticeCreate).toHaveBeenCalledWith({
        data: { userId: "app", tier: 1, dropDate: getDropDate(NOW) },
      });
    });

    it("DMs a Telegram user and sends them no push", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "tg", telegramId: 555n, platform: "telegram", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      mNoticeFindFirst.mockResolvedValueOnce(null);
      const api = makeApi();
      const stream = makeStream();

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      expect(result.notified).toBe(1);
      expect(stream).toHaveBeenCalledTimes(1);
      expect(mPush).not.toHaveBeenCalled();
    });

    it("carries both rails for a user on Telegram AND the app", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "both", telegramId: 777n, platform: "both", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      mNoticeFindFirst.mockResolvedValueOnce(null);
      const api = makeApi();
      const stream = makeStream();

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      expect(stream).toHaveBeenCalledTimes(1);
      expect(mPush).toHaveBeenCalledTimes(1);
      // One person, one notice — `notified` counts people, not messages.
      expect(result.notified).toBe(1);
      expect(mNoticeCreate).toHaveBeenCalledTimes(1);
    });

    it("keeps DMing a row older than the platform column", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "legacy", telegramId: 111n, platform: null, language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      mNoticeFindFirst.mockResolvedValueOnce(null);
      const api = makeApi();
      const stream = makeStream();

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      expect(result.notified).toBe(1);
      expect(stream).toHaveBeenCalledTimes(1);
      expect(mPush).not.toHaveBeenCalled();
    });

    // The silent half of the defect. `platform` missing from the SELECT does
    // not throw — it arrives `undefined`, which `telegramReachable` reads as
    // "pre-column row, assume Telegram" for EVERY candidate, so the whole app
    // side is addressed on a rail it cannot hear.
    it("selects platform in the candidate query", async () => {
      mUserFindMany.mockResolvedValueOnce([]);

      await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

      const arg = mUserFindMany.mock.calls[0]![0] as {
        select: Record<string, unknown>;
      };
      expect(arg.select.platform).toBe(true);
    });

    // The type is the client's routing key for the tap, and the payload's
    // shape is part of the frozen contract: there is no match, so there is
    // no `matchId` to carry.
    it("sends the type the client routes on, with no matchId", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "app", telegramId: -42n, platform: "mobile", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      mNoticeFindFirst.mockResolvedValueOnce(null);

      await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

      expect(NO_MATCH_PUSH_TYPE).toBe("match.none");
      const payload = mPush.mock.calls[0]![1] as { data: Record<string, unknown> };
      expect(payload.data).toEqual({ type: "match.none" });
      expect(payload.data).not.toHaveProperty("matchId");
    });

    // Direct analogue of the pre-date-safety guard: one rail's failure is not
    // allowed to cost the other rail, the claim, or the pause.
    it("survives a push failure without losing the DM or the claim", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "both", telegramId: 777n, platform: "both", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      mNoticeFindFirst.mockResolvedValueOnce(null);
      mPush.mockRejectedValueOnce(new Error("apns down"));
      const api = makeApi();
      const stream = makeStream();

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      expect(result.notified).toBe(1);
      expect(result.failed).toBe(0);
      expect(stream).toHaveBeenCalledTimes(1);
      expect(mNoticeDeleteMany).not.toHaveBeenCalled();
    });

    it("treats a false from the push as delivered-elsewhere when the DM landed", async () => {
      // No token / APNs unconfigured — `sendPushToUser` resolves `false`
      // rather than throwing. The person still heard it on Telegram, so the
      // notice is not rolled back and they are not re-notified next run.
      mUserFindMany.mockResolvedValueOnce([
        { id: "both", telegramId: 777n, platform: "both", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      mNoticeFindFirst.mockResolvedValueOnce(null);
      mPush.mockResolvedValueOnce(false);
      const api = makeApi();

      const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

      expect(result.notified).toBe(1);
      expect(result.failed).toBe(0);
      expect(mNoticeDeleteMany).not.toHaveBeenCalled();
    });

    it("counts a user as notified when the DM fails but the push lands", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "both", telegramId: 777n, platform: "both", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      mNoticeFindFirst.mockResolvedValueOnce(null);
      const api = makeApi();
      const stream = makeStream();
      stream.mockRejectedValueOnce(new Error("bot was blocked"));

      const result = await sendNoMatchNotices(api as never, NOW, 0, stream as never);

      expect(result.notified).toBe(1);
      expect(result.failed).toBe(0);
      expect(mPush).toHaveBeenCalledTimes(1);
      expect(mNoticeDeleteMany).not.toHaveBeenCalled();
    });

    // (NOMATCH-1) The other half of the rule: nothing arrived on ANY rail is
    // the same event the single-rail version called a failed send.
    it("rolls the claim back when the only rail the user has does not deliver", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "app", telegramId: -42n, platform: "mobile", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce(null);
      mNoticeFindFirst.mockResolvedValueOnce(null);
      mPush.mockResolvedValueOnce(false);
      const api = makeApi();

      const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

      expect(result.notified).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(0);
      expect(mNoticeDeleteMany).toHaveBeenCalledWith({
        where: { userId: "app", dropDate: getDropDate(NOW) },
      });
    });

    // (NOMATCH-2) An app-side user must not be paused by a notice they never
    // got, for exactly the reason a Telegram user must not: this notifier only
    // ever selects `active`, so it would never revisit them.
    it("resumes an app-side account paused by a push that never landed", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "app", telegramId: -42n, platform: "mobile", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({
        dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS),
      });
      mPush.mockResolvedValueOnce(false);

      const result = await sendNoMatchNotices(
        makeApi() as never,
        NOW,
        0,
        makeStream() as never,
      );

      expect(result.paused).toBe(0);
      expect(result.failed).toBe(1);
      expect(mTransition).toHaveBeenCalledWith({ id: "app" }, "resume");
      expect(mNoticeDeleteMany).toHaveBeenCalled();
    });

    it("pauses an app-side account when the push does land", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "app", telegramId: -42n, platform: "mobile", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({
        dispatchedAt: dispatchedDaysAgo(FAMINE_PAUSE_AFTER_DAYS),
      });
      const api = makeApi();

      const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

      expect(result.paused).toBe(1);
      expect(result.notified).toBe(1);
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(mPush).toHaveBeenCalledTimes(1);
      expect(mTransition).not.toHaveBeenCalledWith({ id: "app" }, "resume");
    });

    // The market-pending DM carries a city-switch button; the push cannot
    // carry a button (§5.2) and does not claim to. It is still sent: someone
    // on the app has to learn how the drop went the same as someone on
    // Telegram, and silence is not an answer.
    it("still tells a market-pending user on the app, on the one copy", async () => {
      mUserFindMany.mockResolvedValueOnce([
        {
          id: "app",
          telegramId: -42n,
          platform: "mobile",
          language: "en",
          profile: { homeCityKey: "de:berlin", homeCity: "Berlin" },
        },
      ]);
      mMatchFindFirst.mockResolvedValueOnce({ dispatchedAt: dispatchedForTier(3) });
      const api = makeApi();

      const result = await sendNoMatchNotices(api as never, NOW, 0, makeStream() as never);

      expect(result.notified).toBe(1);
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(mPush).toHaveBeenCalledTimes(1);
      expect(mPush.mock.calls[0]![1]).toMatchObject({
        data: { type: NO_MATCH_PUSH_TYPE },
      });
      // Still not in a drop, so still no famine discount and no pause.
      expect(mGrant).not.toHaveBeenCalled();
      expect(mTransition).not.toHaveBeenCalled();
      expect(mNoticeCreate).toHaveBeenCalledTimes(1);
    });

    // Rematch is a Telegram DM with a Stars button and has no app rail in v1.
    it("does not attempt the Rematch offer on the push-only rail", async () => {
      mUserFindMany.mockResolvedValueOnce([
        { id: "app", telegramId: -42n, platform: "mobile", language: "en" },
        { id: "tg", telegramId: 555n, platform: "telegram", language: "en" },
      ]);
      mMatchFindFirst.mockResolvedValue(null);
      mNoticeFindFirst.mockResolvedValue(null);

      await sendNoMatchNotices(makeApi() as never, NOW, 0, makeStream() as never);

      expect(mRematch).toHaveBeenCalledTimes(1);
      expect(mRematch.mock.calls[0]![1]).toBe("tg");
    });
  });
});
